/**
 * Phase 1: query_document_v2 orchestrator.
 *
 * Glue between the tool handler and the RAG pipeline. Flow:
 *
 *   1. Resolve documentId from file_name via the existing store.
 *   2. Verify has_passages = true. If not, return a structured "fall back
 *      to legacy" signal — the tool handler / routing guard decides what
 *      to do (return error, or auto-fallback to query_document).
 *   3. Retrieve top-K passages (default 12).
 *   4. Rerank to top-N (default 6).
 *   5. Compose answer with gpt-4.1 over the reranked passages.
 *   6. Return structured response for the voice agent + visual layer.
 *
 * NO eager fact extraction here. NO sentence segmentation. The answer is
 * grounded in the actual retrieved passage text the composer reads.
 */

import { findDocumentByFileName } from "@/lib/documents/store";
import { retrievePassages, type Passage } from "./retrieve";
import { rerankPassages } from "./rerank";
import { composeAnswerFromPassages, type AnswerFocus, type ChartableData } from "./answer";
import { verifyAnswer } from "@/lib/extraction/verifier";
import { planQuestionComplexity } from "@/lib/reasoning/plan";
import { runComplexAnswer } from "@/lib/reasoning/orchestrator";
import { emitProgress } from "@/lib/telemetry/progress";

const DEFAULT_RETRIEVAL_K = 12;
const DEFAULT_RERANK_TOP_N = 6;

export interface QueryDocumentV2Input {
  userId: string;
  fileName: string;
  question: string;
  focus?: AnswerFocus;
  /** Override top-K for retrieval. Default 12. */
  retrievalK?: number;
  /** Override top-N after rerank. Default 6. Set null to skip reranking. */
  rerankTopN?: number | null;
}

export interface QueryDocumentV2Result {
  /** Spoken text the realtime agent reads back. */
  result: string;
  /** Structured payload the visual layer consumes. */
  documentResponse: {
    answer: string;
    /** All retrieved + reranked passages, in relevance order.
     *  For complex (multi-step) answers this is the union of reranked
     *  passages across every sub-question. */
    passages: Array<{
      passageId: string;
      chunkIndex: number;
      pageStart: number | null;
      pageEnd: number | null;
      text: string;
      heading: string | null;
      similarity: number;
    }>;
    /** Subset of `passages` actually used in the answer. */
    citations: Array<{
      passageId: string;
      chunkIndex: number;
      page: number | null;
      pageEnd: number | null;
      text: string;
    }>;
    confidence: "high" | "medium" | "low";
    suggestedVisuals: string[];
    documentType: string;
    focus?: string;
    rerankerRan: boolean;
    caveat?: string;
    /** Structured numeric data the composer extracted, or null when the
     *  answer is purely qualitative. Drives KPI cards + (when kind !=
     *  "kpi_only") a chart in the scene composer. */
    chartable?: ChartableData;
    /** Phase 6 — "simple" = single retrieve+compose; "complex" = decomposed
     *  into sub-questions and synthesized with the reasoning model. */
    reasoningMode: "simple" | "complex";
    /** Phase 6 — only set when reasoningMode === "complex". */
    subQuestions?: string[];
    /** Phase 6 — only set when reasoningMode === "complex". Useful for
     *  diagnosing partial-failure complex answers. */
    subAnswersCompleted?: number;
  };
}

export class FallbackToLegacyError extends Error {
  constructor(public readonly fileName: string, public readonly reason: string) {
    super(
      `query_document_v2 cannot serve "${fileName}": ${reason}. ` +
      `Routing layer should fall back to legacy query_document.`
    );
    this.name = "FallbackToLegacyError";
  }
}

export async function runQueryDocumentV2(
  input: QueryDocumentV2Input
): Promise<QueryDocumentV2Result> {
  const { userId, fileName, question, focus } = input;
  const k = input.retrievalK ?? DEFAULT_RETRIEVAL_K;
  const topN = input.rerankTopN === null ? null : input.rerankTopN ?? DEFAULT_RERANK_TOP_N;

  // 1. Resolve the document.
  emitProgress("phase", `Looking up ${fileName}…`);
  const record = await findDocumentByFileName(fileName, userId);
  if (!record) {
    throw new Error(
      `No document found matching "${fileName}". Make sure the file is uploaded and finished parsing.`
    );
  }
  const documentType = record.extraction.type;

  // 2. Phase 6: classify the question. Cheap upfront LLM call decides
  //    whether to run the standard retrieve→compose path or fan out into
  //    sub-questions and synthesize. The planner failing falls open to
  //    "simple" — the existing path is always safe.
  emitProgress("phase", "Planning the approach…");
  const plan = await planQuestionComplexity({ question, documentType });
  console.log(
    `[query_document_v2] planner: ${plan.complexity}` +
      (plan.complexity === "complex"
        ? ` (${plan.subQuestions.length} sub-Qs)`
        : "") +
      ` — ${plan.reasoning}`
  );

  // 3. Decide which path to run. The complex path is tried only when the
  //    planner asks for it; on any failure we drop through to the simple
  //    path so the user still gets an answer. We pre-resolve the orchestrator
  //    result into a holder so the rest of the function works with one shape.
  type ComposedShape = {
    answer: string;
    citedPassages: Passage[];
    confidence: "high" | "medium" | "low";
    caveat?: string;
    chartable?: ChartableData;
  };

  let composed: ComposedShape;
  let ranked: Passage[];
  let rerankerRan = false;
  let reasoningMode: "simple" | "complex" = "simple";
  let subQuestionsRun: string[] | undefined;
  let subAnswersCompleted: number | undefined;

  // Attempt the complex path first when requested.
  let complexHolder:
    | { ranked: Passage[]; composed: ComposedShape; subAnswersCompleted: number }
    | null = null;
  if (plan.complexity === "complex") {
    emitProgress(
      "phase",
      `Breaking the question into ${plan.subQuestions.length} parts…`
    );
    try {
      const complex = await runComplexAnswer({
        userId,
        documentId: record.documentId,
        question,
        subQuestions: plan.subQuestions,
        focus,
        documentType,
      });
      console.log(
        `[query_document_v2] complex: ${complex.subAnswersCompleted}/${complex.subAnswersAttempted} sub-answers completed, ${complex.allPassages.length} unique passages, ${complex.citedPassages.length} cited`
      );
      complexHolder = {
        ranked: complex.allPassages,
        composed: {
          answer: complex.answer,
          citedPassages: complex.citedPassages,
          confidence: complex.confidence,
          caveat: complex.caveat,
          chartable: complex.chartable,
        },
        subAnswersCompleted: complex.subAnswersCompleted,
      };
      emitProgress(
        "info",
        `Synthesizing across ${complex.subAnswersCompleted} sub-answers…`
      );
    } catch (err) {
      console.warn(
        `[query_document_v2] complex path failed — falling back to simple: ${err instanceof Error ? err.message : err}`
      );
      emitProgress("warn", "Falling back to single-pass retrieval…");
      // complexHolder stays null — fall through to simple below.
    }
  }

  if (complexHolder) {
    ranked = complexHolder.ranked;
    composed = complexHolder.composed;
    rerankerRan = true; // sub-questions ran rerank individually
    reasoningMode = "complex";
    subQuestionsRun = plan.subQuestions;
    subAnswersCompleted = complexHolder.subAnswersCompleted;
  } else {
    // Simple path — single retrieve → rerank → compose.
    emitProgress("phase", "Searching the document for relevant passages…");
    const { passages: retrieved } = await retrievePassages({
      documentId: record.documentId,
      userId,
      query: question,
      k,
    });

    if (retrieved.length === 0) {
      throw new FallbackToLegacyError(
        fileName,
        "no passages indexed for this document"
      );
    }

    console.log(
      `[query_document_v2] ${fileName}: retrieved ${retrieved.length} passages ` +
        `(similarity top=${retrieved[0]?.similarity.toFixed(3)}, ` +
        `bottom=${retrieved[retrieved.length - 1]?.similarity.toFixed(3)})`
    );

    if (topN == null) {
      ranked = retrieved;
    } else {
      emitProgress("info", `Ranking ${retrieved.length} passages by relevance…`);
      const rerankResult = await rerankPassages({ query: question, passages: retrieved, topN });
      ranked = rerankResult.passages;
      rerankerRan = rerankResult.rerankerRan;
      if (rerankerRan) {
        console.log(
          `[query_document_v2] reranked ${retrieved.length} → ${ranked.length} ` +
            `(top: ${ranked[0]?.chunkIndex})`
        );
      }
    }

    emitProgress("phase", "Composing the answer…");
    composed = await composeAnswerFromPassages({
      question,
      passages: ranked,
      focus,
      documentType,
    });
  }

  // 5b. Phase 5: verifier pass. Cheap gpt-4o-mini judge call asking "does
  //     this answer follow from the cited passages?" If unsupported, we
  //     downgrade confidence and append a caveat so the voice agent hedges.
  //     We do NOT retry composition here — Phase 5 v1 is a flag, not a
  //     correction loop. Phase 6+ may add retries on `unsupported` outcomes.
  let effectiveConfidence: "high" | "medium" | "low" = composed.confidence;
  let effectiveCaveat = composed.caveat;
  if (composed.citedPassages.length > 0) {
    emitProgress("phase", "Verifying the answer against the citations…");
    const verdict = await verifyAnswer({
      question,
      answer: composed.answer,
      citedPassages: composed.citedPassages,
      documentType,
    });
    console.log(
      `[query_document_v2] verifier: supports=${verdict.supports} category=${verdict.category}` +
        (verdict.verifierFailed ? " (verifier_failed — passing through)" : "") +
        ` — ${verdict.reasoning}`
    );
    if (!verdict.supports && !verdict.verifierFailed) {
      // Downgrade reported confidence and surface the verifier's reasoning
      // as the caveat. The voice agent will hedge accordingly.
      if (verdict.category === "unsupported") {
        effectiveConfidence = "low";
      } else if (effectiveConfidence === "high") {
        // partial → step down one level from high
        effectiveConfidence = "medium";
      }
      const verifierNote = `verifier flagged: ${verdict.reasoning}`;
      effectiveCaveat = effectiveCaveat
        ? `${effectiveCaveat}; ${verifierNote}`
        : verifierNote;
      emitProgress("warn", "Adding a caveat — answer is only partially supported.");
    }
  }

  // 6. Build response.
  const citationRows = composed.citedPassages.map((p) => ({
    passageId: p.passageId,
    chunkIndex: p.chunkIndex,
    page: p.pageStart,
    pageEnd: p.pageEnd,
    text: p.text,
  }));

  const passageRows = ranked.map((p) => ({
    passageId: p.passageId,
    chunkIndex: p.chunkIndex,
    pageStart: p.pageStart,
    pageEnd: p.pageEnd,
    text: p.text,
    heading: p.heading,
    similarity: p.similarity,
  }));

  const suggestedVisuals = pickSuggestedVisuals(focus, documentType, effectiveConfidence);

  const spokenResult = formatSpokenResult(composed.answer, effectiveConfidence, effectiveCaveat);

  return {
    result: spokenResult,
    documentResponse: {
      answer: composed.answer,
      passages: passageRows,
      citations: citationRows,
      confidence: effectiveConfidence,
      suggestedVisuals,
      documentType,
      focus,
      rerankerRan,
      caveat: effectiveCaveat,
      chartable: composed.chartable,
      reasoningMode,
      subQuestions: subQuestionsRun,
      subAnswersCompleted,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────

function pickSuggestedVisuals(
  focus: AnswerFocus | undefined,
  documentType: string,
  confidence: "high" | "medium" | "low"
): string[] {
  // Phase 1 v1: simple visual suggestions. Phase 5 (entities) and Phase 6
  // (multi-step reasoning) enable richer scenes.
  const out = new Set<string>(["summary_card", "doc_preview"]);
  if (focus === "risks") out.add("risk_panel");
  if (focus === "dates") out.add("timeline");
  if (focus === "parties") out.add("entity_card");
  if (focus === "metrics" && confidence !== "low") out.add("kpi");
  if (["contract", "policy"].includes(documentType)) out.add("entity_card");
  return [...out];
}

function formatSpokenResult(
  answer: string,
  confidence: "high" | "medium" | "low",
  caveat?: string
): string {
  const toneGuidance =
    confidence === "high"
      ? "Speak assertively. State findings as facts."
      : confidence === "medium"
        ? "Speak with slight caution. Mention any notable gaps briefly."
        : "Be transparent — say what's uncertain and avoid claiming unverified facts.";
  const lines = [answer];
  if (caveat) lines.push(`(Caveat: ${caveat})`);
  lines.push("");
  lines.push(`Confidence: ${confidence}`);
  lines.push(`Tone: ${toneGuidance}`);
  return lines.join("\n");
}
