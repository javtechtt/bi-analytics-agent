/**
 * Golden eval — shared types.
 *
 * Each question is one row in evals/golden/*.json. The eval runner loads
 * every JSON file, filters by category if requested, and scores each
 * question against the live system.
 *
 * Phase 0 covers narrative tools only (query_document, compose_visual_scene).
 * Phase 1 will expand to tabular tools when the tabular path is being
 * modified by the rebuild.
 */

export type EvalTool = "query_document" | "compose_visual_scene";

export type EvalFocus =
  | "general"
  | "risks"
  | "parties"
  | "dates"
  | "metrics"
  | "obligations";

export interface GoldenQuestion {
  /** Unique id, e.g. "case-studies-q01". */
  id: string;
  /** Path relative to evals/fixtures/, e.g. "case-studies.pdf". */
  fixture: string;
  /** Which tool to invoke. */
  tool: EvalTool;
  /** Free-text category for filtering and reporting. */
  category: string;
  /** Question text. */
  question: string;
  /** Optional focus passed to the tool. */
  focus?: EvalFocus;
  /** Substrings the answer SHOULD contain (case-insensitive, all required). */
  expectedAnswerContains?: string[];
  /** Substrings the answer should NOT contain — used to bait hallucinations. */
  expectedAnswerExcludes?: string[];
  /** Page numbers cited should overlap with at least one of these. */
  expectedCitationPages?: number[];
  /** Expected minimum confidence label. */
  expectedMinConfidence?: "high" | "medium" | "low";
  /** Max latency budget. Failing this doesn't fail the answer but marks the question as slow. */
  maxLatencyMs?: number;
  /** Max cost budget. */
  maxCostUsd?: number;
}

export interface ScoreBreakdown {
  /** Tool returned without throwing. */
  toolSucceeded: boolean;
  /** All expectedAnswerContains substrings found. */
  containsPass: boolean;
  containsMissing: string[];
  /** No expectedAnswerExcludes substrings found. */
  excludesPass: boolean;
  excludesViolations: string[];
  /** Citation overlaps with expectedCitationPages. */
  citationPass: boolean;
  citationActualPages: number[];
  /** Confidence at or above expected minimum. */
  confidencePass: boolean;
  actualConfidence?: "high" | "medium" | "low";
  /** LLM judge score in [0, 1]. */
  judgeScore: number;
  judgeReasoning: string;
  /** Latency within budget. */
  latencyPass: boolean;
  actualLatencyMs: number;
  /** Cost within budget. */
  costPass: boolean;
  actualCostUsd: number | null;
  /** Phase 6 — "simple" or "complex" if the v2 path ran. Undefined if the
   *  query fell back to legacy query_document (no planner in that path). */
  reasoningMode?: "simple" | "complex";
  /** Phase 6 — sub-questions actually executed (complex mode only). */
  subQuestions?: string[];
  /** Phase 6 — how many sub-answers succeeded out of attempted. */
  subAnswersCompleted?: number;
}

export interface QuestionResult {
  question: GoldenQuestion;
  score: number;                    // overall in [0, 1]
  breakdown: ScoreBreakdown;
  answer: string;
  error?: string;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  totalQuestions: number;
  skipped: number;
  results: QuestionResult[];
  aggregate: {
    overallAccuracy: number;
    judgeAccuracy: number;
    containsPassRate: number;
    excludesPassRate: number;
    citationPassRate: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    totalCostUsd: number;
    avgCostUsd: number;
    /** Phase 6 — fraction of questions routed through the complex path. */
    complexRoutingRate: number;
  };
}
