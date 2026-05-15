/**
 * Phase 2: query_document orchestrator.
 *
 * Glue between the tool handler and the extraction pipeline. Flow:
 *
 *   1. Resolve documentId from file_name via the store (user-scoped).
 *   2. If facts have not been extracted yet, run the lazy pipeline:
 *        chunk pageTexts → extract each → reconcile → validate.
 *      Persist the validated extraction back to the documents row.
 *   3. Compose a short spoken-style answer from grounded facts only.
 *   4. Return the answer plus the structured data the visual layer needs.
 *
 * This module is the integration point — Phase 3's visual composer can
 * consume the same `documentResponse` shape returned here.
 */

import {
  getDocumentForExtraction,
  findDocumentByFileName,
  updateDocumentExtraction,
} from "@/lib/documents/store";
import {
  extractChunk,
  segmentChunkIntoSentences,
  type ExtractionFocus,
  type SegmentedSentence,
} from "./extractor";
import type { ExtractionResult } from "./schemas";
import { reconcile } from "./reconciler";
import { validateExtraction } from "./validators";
import { composeAnswer, type SuggestedVisualKind } from "./composer";
import type { DocumentExtraction, Fact, Metric, TimelineEvent, Entity, SourceSpan } from "@/lib/documents/types";

const PAGES_PER_CHUNK = 3;       // 3 pages ≈ 3-6k chars — well within model context
const MAX_CHUNKS = 12;            // hard cap so a 100-page contract doesn't spend $5 per query

export interface QueryDocumentInput {
  userId: string;
  fileName: string;
  question: string;
  focus?: ExtractionFocus;
}

export interface QueryDocumentResult {
  /** Spoken text the realtime agent reads back. */
  result: string;
  /** Structured payload the visual layer consumes (Phase 3). */
  documentResponse: {
    answer: string;
    facts: Fact[];
    metrics: Metric[];
    timeline: TimelineEvent[];
    entities: Entity[];
    /** Full span registry — Phase 3 composer uses this to render source citations. */
    spans: Record<string, SourceSpan>;
    citations: Array<{ spanId: string; page?: number; text: string }>;
    confidence: "high" | "medium" | "low";
    suggestedVisuals: SuggestedVisualKind[];
    /** Document type echoed back so the client bridge knows which composer rules apply. */
    documentType: string;
    /** Original focus echoed back so the client bridge can pick the right scene intent. */
    focus?: ExtractionFocus;
  };
}

export async function runQueryDocument(
  input: QueryDocumentInput
): Promise<QueryDocumentResult> {
  const { userId, fileName, question, focus } = input;

  // 1. Resolve the document.
  let record = await findDocumentByFileName(fileName, userId);
  if (!record) {
    throw new Error(
      `No document found matching "${fileName}". Make sure the file is uploaded and finished parsing.`
    );
  }

  // 2. Lazy extraction if needed.
  // Re-load via getDocumentForExtraction to ensure we have pageTexts (the
  // findByFileName path returns whatever's in the JSONB column, which includes pageTexts).
  const full = await getDocumentForExtraction(record.documentId, userId);
  if (!full) {
    throw new Error(`Document ${record.documentId} disappeared mid-query.`);
  }
  record = full;

  const ex = record.extraction;
  const hasFacts =
    (ex.facts?.length ?? 0) > 0 ||
    (ex.metrics?.length ?? 0) > 0 ||
    (ex.timeline?.length ?? 0) > 0;

  if (!hasFacts) {
    if (!ex.pageTexts || ex.pageTexts.length === 0) {
      throw new Error(
        "This document has no extractable text and no facts to query. (Likely a scanned PDF — OCR support arrives in Phase 5.)"
      );
    }

    console.log(
      `[query_document] First query for ${fileName} — running extraction (${ex.pageTexts.length} pages)`
    );

    const validated = await runExtraction(ex, focus);
    // Update the cached extraction in place.
    ex.facts = validated.facts;
    ex.metrics = validated.metrics;
    ex.timeline = validated.timeline;
    ex.spans = validated.spans;
    ex.groundingRatio = validated.groundingRatio;
    ex.confidence = blendConfidence(ex.confidence, validated.groundingRatio);

    // Persist back. Failures here log but don't block the answer.
    try {
      await updateDocumentExtraction(record.documentId, userId, ex);
    } catch (persistErr) {
      console.warn("[query_document] persistence failed:", persistErr);
    }
  }

  // 3. Filter to grounded material and (optionally) by focus.
  const grounded = filterByGrounding(ex, focus);

  // 4. Compose the spoken answer.
  const composed = await composeAnswer({
    question,
    focus,
    facts: grounded.facts,
    metrics: grounded.metrics,
    timeline: grounded.timeline,
    spans: ex.spans,
    documentType: ex.type,
  });

  // 5. Build the response payload.
  const citations = composed.citedSpanIds
    .map((sid) => ex.spans[sid])
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .map((s) => ({ spanId: s.id, page: s.page, text: s.text }));

  const spokenResult = formatSpokenResult(composed.answer, composed.confidence, ex);

  return {
    result: spokenResult,
    documentResponse: {
      answer: composed.answer,
      facts: grounded.facts,
      metrics: grounded.metrics,
      timeline: grounded.timeline,
      entities: ex.entities ?? [],
      spans: ex.spans,
      citations,
      confidence: composed.confidence,
      suggestedVisuals: composed.suggestedVisuals,
      documentType: ex.type,
      focus,
    },
  };
}

// ── Extraction sub-flow ──────────────────────────────────

const CHUNK_CONCURRENCY = 4;       // simultaneous OpenAI calls per batch
const PER_CHUNK_TIMEOUT_MS = 25_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

async function runExtraction(
  ex: DocumentExtraction,
  focus: ExtractionFocus | undefined
): Promise<ReturnType<typeof validateExtraction>> {
  const pageTexts = ex.pageTexts ?? [];
  const chunks = chunkPages(pageTexts, PAGES_PER_CHUNK).slice(0, MAX_CHUNKS);

  // Pre-segment each chunk into numbered sentences ONCE. The same list
  // goes to the extractor (so the LLM cites by sentence) and to the
  // validator (so we mechanically reject citations that don't match a
  // real sentence). This is the central change behind precise citations.
  const segmentedChunks = chunks.map((chunk) => ({
    ...chunk,
    sentences: segmentChunkIntoSentences(chunk.text),
  }));

  const totalSentences = segmentedChunks.reduce((acc, c) => acc + c.sentences.length, 0);
  const t0 = Date.now();
  console.log(
    `[query_document] Extraction starting: ${chunks.length} chunks, concurrency=${CHUNK_CONCURRENCY}, focus=${focus ?? "general"}, sentences=${totalSentences}`
  );

  // Run chunks in parallel BATCHES of CHUNK_CONCURRENCY. Promise.allSettled
  // makes us tolerant of partial failures — a single stuck chunk doesn't
  // block the rest, and we still reconcile what we got.
  const chunkResults: ExtractionResult[] = [];
  for (let i = 0; i < segmentedChunks.length; i += CHUNK_CONCURRENCY) {
    const batch = segmentedChunks.slice(i, i + CHUNK_CONCURRENCY);
    const batchStart = Date.now();
    const settled = await Promise.allSettled(
      batch.map((chunk) =>
        withTimeout(
          extractChunk({
            documentType: ex.type,
            text: chunk.text,
            sentences: chunk.sentences,
            pageRange: chunk.range,
            focus: focus ?? "general",
          }),
          PER_CHUNK_TIMEOUT_MS,
          `chunk ${chunk.range.from}-${chunk.range.to}`
        )
      )
    );
    settled.forEach((s, idx) => {
      const chunk = batch[idx];
      if (s.status === "fulfilled") {
        chunkResults.push(s.value);
      } else {
        const reason = s.reason instanceof Error ? s.reason.message : String(s.reason);
        console.warn(
          `[query_document] Chunk pages ${chunk.range.from}-${chunk.range.to} failed: ${reason}`
        );
      }
    });
    console.log(
      `[query_document] Batch ${Math.floor(i / CHUNK_CONCURRENCY) + 1}/${Math.ceil(chunks.length / CHUNK_CONCURRENCY)} done in ${((Date.now() - batchStart) / 1000).toFixed(1)}s`
    );
  }

  console.log(
    `[query_document] All chunks done in ${((Date.now() - t0) / 1000).toFixed(1)}s — reconciling ${chunkResults.length}/${chunks.length} successful`
  );

  const reconciled = reconcile(chunkResults);
  const fullText = pageTexts.join("\n\n");
  // Strict-mode validation: pass the union of all chunk sentences so
  // citations are only accepted when they match a real sentence.
  const allSentences: SegmentedSentence[] = segmentedChunks.flatMap((c) => c.sentences);
  const validated = validateExtraction(reconciled, fullText, allSentences);
  console.log(
    `[query_document] Validation: grounded=${validated.counts.grounded}, partial=${validated.counts.partial}, unverified=${validated.counts.unverified} (ratio=${(validated.groundingRatio * 100).toFixed(0)}%)`
  );
  return validated;
}

function chunkPages(
  pageTexts: string[],
  pagesPerChunk: number
): Array<{ text: string; range: { from: number; to: number } }> {
  const chunks: Array<{ text: string; range: { from: number; to: number } }> = [];
  for (let i = 0; i < pageTexts.length; i += pagesPerChunk) {
    const slice = pageTexts.slice(i, i + pagesPerChunk);
    if (slice.length === 0) continue;
    const text = slice
      .map((t, idx) => `[PAGE ${i + idx + 1}]\n${t}`)
      .join("\n\n");
    chunks.push({
      text,
      range: { from: i + 1, to: Math.min(i + pagesPerChunk, pageTexts.length) },
    });
  }
  return chunks;
}

// ── Filtering and confidence helpers ─────────────────────

function filterByGrounding(
  ex: DocumentExtraction,
  focus: ExtractionFocus | undefined
): { facts: Fact[]; metrics: Metric[]; timeline: TimelineEvent[] } {
  // Grounded only for spoken answers.
  let facts = ex.facts.filter((f) => f.verificationStatus === "grounded");
  let metrics = ex.metrics.filter((m) => m.confidence >= 0.5);
  let timeline = ex.timeline ?? [];

  if (focus && focus !== "general") {
    const wanted = focusToFactTypes(focus);
    if (wanted) facts = facts.filter((f) => wanted.includes(f.type));
    if (focus === "metrics") {
      // metrics already kept above
      facts = facts.filter((f) => f.type === "metric");
    } else if (focus !== "dates") {
      // timeline mostly relevant for date focus
      timeline = [];
    } else {
      metrics = [];
    }
  }

  return { facts, metrics, timeline };
}

function focusToFactTypes(focus: ExtractionFocus): Fact["type"][] | null {
  switch (focus) {
    case "risks":       return ["risk"];
    case "parties":     return ["party"];
    case "dates":       return ["date"];
    case "metrics":     return ["metric"];
    case "obligations": return ["obligation"];
    default:            return null;
  }
}

function blendConfidence(prior: number, groundingRatio: number): number {
  // 60/40 mix: base extraction confidence + observed grounding ratio.
  return Math.min(1, Math.max(0, 0.4 * prior + 0.6 * groundingRatio));
}

// ── Spoken result formatting ─────────────────────────────

function formatSpokenResult(
  answer: string,
  confidence: "high" | "medium" | "low",
  ex: DocumentExtraction
): string {
  // Mirror the existing confidence channel used by the tabular tools so the
  // realtime system prompt's confidence calibration applies uniformly.
  const ratioPct = (ex.groundingRatio * 100).toFixed(0);
  const guidance =
    confidence === "high"
      ? "Speak assertively. State findings as facts."
      : confidence === "medium"
        ? "Speak with slight caution. Mention any notable gaps briefly."
        : "Be transparent — say what's uncertain and avoid claiming unverified facts.";

  return [
    answer,
    "",
    `Confidence: ${confidence} (grounding ratio: ${ratioPct}%)`,
    `Tone: ${guidance}`,
  ].join("\n");
}
