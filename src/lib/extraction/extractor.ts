/**
 * Phase 2: LLM-driven schema-guided extraction.
 *
 * Takes a chunk of narrative text + a document type + an optional focus,
 * sends it to OpenAI with the ExtractionResultSchema as a structured-output
 * format, and returns a typed ExtractionResult. Strict rules:
 *
 *   - The LLM MUST cite verbatim source text for every fact, entity, metric,
 *     and timeline event. The validators downstream will reject any whose
 *     citation doesn't appear in the source.
 *   - Temperature is low (0.1) to keep extractions deterministic.
 *   - The model is the cheap fast tier (gpt-4o-mini). Phase 3 may swap in
 *     gpt-4.1 for higher-stakes documents.
 *
 * This module makes ONE LLM call per chunk. The narrative adapter / query
 * tool decides how to chunk (page-based for short docs, multi-page for long).
 */

import { zodResponseFormat } from "openai/helpers/zod";
import { openai } from "@/lib/openai/client";
import {
  ExtractionResultSchema,
  type ExtractionResult,
  type ExtractedMetric,
} from "./schemas";
import type { DocumentType } from "@/lib/documents/types";
import { instrumented } from "@/lib/telemetry/trace";
import { MODELS } from "@/lib/models";

const EXTRACTION_MODEL = MODELS.extraction;
const EXTRACTION_TEMPERATURE = 0.1;

export type ExtractionFocus =
  | "general"
  | "risks"
  | "parties"
  | "dates"
  | "metrics"
  | "obligations";

/**
 * One pre-segmented sentence from the document chunk. The extractor presents
 * these to the LLM as a numbered list so the model can ONLY cite a real
 * sentence boundary — not a free-text substring that might be unrelated.
 */
export interface SegmentedSentence {
  /** 1-indexed sentence number across the entire chunk (display id). */
  index: number;
  page: number;
  text: string;
}

export interface ExtractChunkInput {
  documentType: DocumentType;
  text: string;
  /** Inclusive page range this chunk covers, if known. */
  pageRange?: { from: number; to: number };
  focus?: ExtractionFocus;
  /**
   * Optional pre-computed sentence segmentation. When provided, the LLM is
   * shown a numbered sentence list and must copy citations verbatim from
   * one of those sentences. When omitted, the extractor falls back to the
   * raw-chunk format used in Phase 2.
   */
  sentences?: SegmentedSentence[];
}

// ── Sentence segmentation ────────────────────────────────

/**
 * Split a chunk into pre-numbered sentences. Page boundaries are detected
 * via the [PAGE N] markers the query orchestrator injects when chunking.
 * Conservative: skips sentences shorter than 10 chars (likely headers or
 * artifacts) and longer than 600 chars (likely an unsplit paragraph that
 * would be a poor citation target anyway).
 */
export function segmentChunkIntoSentences(chunkText: string): SegmentedSentence[] {
  const sentences: SegmentedSentence[] = [];
  let currentPage = 1;
  let nextIndex = 1;

  // Split on [PAGE N] markers, preserving the page numbers.
  // The result of split with a capture group: [before, page1, content1, page2, content2, ...]
  const parts = chunkText.split(/\[PAGE\s+(\d+)\]/);

  for (let i = 0; i < parts.length; i++) {
    const isPageMarker = i > 0 && i % 2 === 1;
    if (isPageMarker) {
      const p = parseInt(parts[i], 10);
      if (!Number.isNaN(p)) currentPage = p;
      continue;
    }
    const content = parts[i];
    if (!content || !content.trim()) continue;

    for (const sent of splitToSentences(content)) {
      sentences.push({
        index: nextIndex++,
        page: currentPage,
        text: sent,
      });
    }
  }

  return sentences;
}

function splitToSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    // Split on sentence boundaries: . ! ? followed by whitespace + capital letter, opening quote, or paren.
    .split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10 && s.length <= 600);
}

const FOCUS_GUIDANCE: Record<ExtractionFocus, string> = {
  general:
    "Extract everything notable: parties, key dates, important metrics, obligations, risks, and any factual claims.",
  risks:
    "Prioritize risks, exposures, contingencies, penalties, default conditions, and adverse events. Capture supporting context as facts.",
  parties:
    "Prioritize all named parties (people, organizations, accounts) and their roles in the document.",
  dates:
    "Prioritize dated events, deadlines, effective dates, expiration dates, and milestones. Populate `timeline` thoroughly.",
  metrics:
    "Prioritize numeric metrics with their period, unit, and source text. Treat dollar amounts, percentages, counts, and ratios as metrics.",
  obligations:
    "Prioritize obligations, commitments, covenants, deliverables, and required actions. Capture each as a fact with type='obligation'.",
};

const DOCUMENT_TYPE_GUIDANCE: Partial<Record<DocumentType, string>> = {
  contract:
    "This is a CONTRACT. Identify parties, effective dates, termination clauses, payment terms, penalties, indemnification, and material obligations.",
  policy:
    "This is a POLICY document. Identify scope, governed parties, required practices, exceptions, and enforcement mechanisms.",
  report:
    "This is a REPORT. Identify the reporting period, key metrics, trends, conclusions, and any flagged risks or recommendations.",
  memo:
    "This is a MEMO. Identify the author, recipients, subject, key decisions or recommendations, and supporting rationale.",
  financial_statement:
    "This is a FINANCIAL STATEMENT. Extract every metric with its period, line item, and value. Capture material risks or accounting notes as facts.",
};

function buildSystemPrompt(useSentenceList: boolean): string {
  const grounding = useSentenceList
    ? `1. GROUNDING (STRICT — citations are mechanically verified):
   - The document chunk has been pre-segmented into a numbered SENTENCE LIST.
   - Every fact, entity, metric, and timeline event's source.text MUST be COPIED VERBATIM from exactly ONE sentence in that list.
   - You may include a leading reference like "[S12]" at the start of source.text, OR omit it; either way the verbatim sentence body MUST follow.
   - If you cannot find a SPECIFIC sentence that directly supports a claim, OMIT the fact. Do NOT cite a different sentence as a stand-in. Do NOT cite a sentence that mentions the right entity but states something else.
   - Down-stream validation will REJECT any fact whose source.text does not exactly match one of the numbered sentences (after normalization for whitespace and punctuation).`
    : `1. GROUNDING: Every fact, entity, metric, and timeline event MUST include a "source" object whose "text" field is a VERBATIM substring of the document chunk. Copy the text exactly — same words, same punctuation, same case. Do NOT paraphrase, summarize, or splice text from different parts of the chunk.`;

  return `You are an extraction engine for business documents. You read a document chunk and produce a strictly structured JSON object matching the provided schema.

CRITICAL RULES — violations cause facts to be rejected by automated validators:

${grounding}

2. RELEVANCE OVER COVERAGE: A fact's source MUST be the sentence that DIRECTLY states or supports it. If a fact says "Acme paid $2M in 2023", the source MUST be the sentence stating that payment — not a different sentence elsewhere that merely mentions Acme or 2023. When in doubt, OMIT. Half a dozen well-grounded facts are far more useful than thirty weakly-grounded ones.

3. ATOMIC DECOMPOSITION FOR IMPLIED CLAIMS: If a conclusion is implied by combining several statements (e.g., "growth accelerated" from "revenue rose 30%" + "the prior year saw 10%"), do NOT emit one vague fact citing one sentence. Instead, emit MULTIPLE atomic facts, each citing its own supporting sentence. The downstream answer composer will synthesize the implication across them.

4. NO INVENTION: If you can't find a precise supporting sentence for a claim, do NOT include it. Empty arrays are valid and expected.

5. ONE FACT, ONE SOURCE: Each fact gets its OWN source sentence. Do not reuse one sentence as the source for multiple unrelated facts.

6. PAGE NUMBERS: Set source.page to the page where the cited sentence appears (the sentence list shows each sentence's page).

7. NUMERIC METRICS: "valueText" should appear EXACTLY in the cited sentence (e.g., "$2.4M", "2,400,000", "47%"). If the sentence doesn't literally contain the value, do not emit it as a metric.

8. ENTITY RESOLUTION: For entities, "canonicalName" is the most complete/formal name in the chunk; "aliases" lists shorter variants. Source MUST be where the entity is introduced or most clearly described.

9. ROLES & OBLIGATIONS: For contracts/policies, parties get a "role" if stated. Obligations get a "subject" identifying who owes what. The source sentence MUST contain the role/obligation language.

10. SCOPE: Stay within the chunk. Do NOT speculate about other parts of the document.

Output STRICT JSON only — no prose, no markdown, no comments.`;
}

function buildUserPrompt(input: ExtractChunkInput): string {
  const focusInstruction =
    FOCUS_GUIDANCE[input.focus ?? "general"] ?? FOCUS_GUIDANCE.general;
  const typeInstruction =
    DOCUMENT_TYPE_GUIDANCE[input.documentType] ?? "Treat this as a generic business document.";

  const pageHeader = input.pageRange
    ? `(Pages ${input.pageRange.from}–${input.pageRange.to})\n\n`
    : "";

  // When pre-segmented sentences are provided, present them as a numbered
  // list. The LLM must cite from this list verbatim. Otherwise, fall back
  // to the raw chunk text (legacy path).
  if (input.sentences && input.sentences.length > 0) {
    const numbered = input.sentences
      .map((s) => `[S${s.index} p.${s.page}] ${s.text}`)
      .join("\n");
    return `${typeInstruction}

Focus for this extraction: ${focusInstruction}

${pageHeader}The chunk has been pre-segmented into ${input.sentences.length} numbered sentences. Each line has the form "[S<n> p.<page>] <sentence body>". When citing a source, the source.text field MUST be exactly the body of one of these sentences (you do not need to repeat the "[Sn p.X]" prefix). The source.page field MUST match the page number shown for that sentence.

---BEGIN NUMBERED SENTENCES---
${numbered}
---END NUMBERED SENTENCES---

Extract everything matching the schema. Remember: cite ONLY from the numbered list above. If no listed sentence supports a claim, omit the claim — do not substitute.`;
  }

  return `${typeInstruction}

Focus for this extraction: ${focusInstruction}

${pageHeader}---BEGIN DOCUMENT CHUNK---
${input.text}
---END DOCUMENT CHUNK---

Extract everything matching the schema. Remember: verbatim sources only, no invention.`;
}

/**
 * Run the LLM extraction on a single chunk. Returns the schema-validated
 * result. Throws if the model fails to produce valid JSON — caller decides
 * whether to retry or drop the chunk.
 */
export async function extractChunk(input: ExtractChunkInput): Promise<ExtractionResult> {
  const client = openai();

  const useSentenceList = !!(input.sentences && input.sentences.length > 0);
  const systemPrompt = buildSystemPrompt(useSentenceList);
  const userPrompt = buildUserPrompt(input);

  const completion = await instrumented(
    "extract_chunk",
    EXTRACTION_MODEL,
    () =>
      client.chat.completions.parse({
        model: EXTRACTION_MODEL,
        temperature: EXTRACTION_TEMPERATURE,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: zodResponseFormat(ExtractionResultSchema, "extraction"),
      }),
    { promptChars: systemPrompt.length + userPrompt.length }
  );

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error("Extraction returned no parsed content");
  }
  return parsed;
}

// ── Numeric normalization for metric values ──────────────

/**
 * Parse a metric's `valueText` ("$2.4M", "2,400,000", "(1,200)", "47%") into
 * a normalized number. Returns null if parsing fails — caller treats the
 * metric as unverified.
 *
 * Conventions:
 *   - "(N)" is treated as negative (accounting parenthesis convention).
 *   - "K" → ×1,000, "M" → ×1,000,000, "B" → ×1,000,000,000.
 *   - "%" is kept as-is (47% → 47, not 0.47). Caller knows from unit.
 *   - Commas as thousands separators are stripped.
 */
export function parseNumericValue(valueText: string): number | null {
  if (!valueText) return null;
  let s = valueText.trim();

  // Accounting negatives: (1,234) → -1234
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    sign = -sign;
    s = s.slice(1);
  }

  // Strip currency and whitespace
  s = s.replace(/[\s$£€¥]/g, "");

  // Suffix scaling
  let scale = 1;
  const suffix = s.slice(-1).toUpperCase();
  if (suffix === "K") { scale = 1_000; s = s.slice(0, -1); }
  else if (suffix === "M") { scale = 1_000_000; s = s.slice(0, -1); }
  else if (suffix === "B") { scale = 1_000_000_000; s = s.slice(0, -1); }
  else if (s.toLowerCase().endsWith("million")) { scale = 1_000_000; s = s.slice(0, -7); }
  else if (s.toLowerCase().endsWith("billion")) { scale = 1_000_000_000; s = s.slice(0, -7); }
  else if (s.toLowerCase().endsWith("thousand")) { scale = 1_000; s = s.slice(0, -8); }

  // Percent: keep magnitude, drop sign char
  if (s.endsWith("%")) s = s.slice(0, -1);

  // Commas as thousands separator
  s = s.replace(/,/g, "");

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return sign * n * scale;
}

/**
 * Best-effort numeric normalization wrapper that returns the metric augmented
 * with the parsed number. Callers use this when persisting metrics.
 */
export function normalizeMetric(m: ExtractedMetric): {
  metric: ExtractedMetric;
  numericValue: number | null;
} {
  return { metric: m, numericValue: parseNumericValue(m.valueText) };
}
