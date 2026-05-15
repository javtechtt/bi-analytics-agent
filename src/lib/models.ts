/**
 * Mini Phase 3 — Central model configuration.
 *
 * Every callsite that talks to OpenAI imports its model from here instead
 * of hardcoding a string. Each role has an env override so we can A/B-test
 * model swaps without touching code — just set the env var, restart, re-run
 * the eval.
 *
 * Why a flat object instead of a class or factory:
 *
 *   - Module-load evaluation means callsites see the configured value
 *     deterministically for the process lifetime. No race conditions, no
 *     need to thread context.
 *   - Trivial to mock in tests (just override `MODELS` at the module level).
 *   - A/B testing in eval: `OPENAI_RAG_ANSWER_MODEL=o4-mini npm run eval`
 *
 * Constraints worth knowing:
 *
 *   - The `embedding` model dimension is wired into the `passages.embedding
 *     vector(1536)` column in migration 0004. Swapping `text-embedding-3-
 *     small` (1536-d) for `text-embedding-3-large` (3072-d) WILL break
 *     pgvector inserts. To upgrade, change the dimension here AND alter the
 *     column type in a new migration.
 *
 *   - The `vision` model must be multimodal AND support OpenAI's PDF
 *     file-input content type. Today that's `gpt-4o` and `gpt-4.1` (with
 *     vision). Don't point this at `gpt-4o-mini` — vision quality drops.
 *
 *   - The `reasoning` model is the only one expected to add multi-second
 *     latency per call. Use only for question decomposition (Phase 6).
 */

export const MODELS = {
  // ── Narrative Q&A (the hot path) ──
  /** Phase 1 RAG answer composer. Runs once per query_document_v2 call.
   *  This is the user-perceived quality dial; keep on a frontier model. */
  ragAnswer: process.env.OPENAI_RAG_ANSWER_MODEL ?? "gpt-4.1",

  /** Reranker — scores retrieved passages for relevance before answering. */
  reranker: process.env.OPENAI_RERANKER_MODEL ?? "gpt-4o-mini",

  // ── Document ingestion ──
  /** Tier 2 LLM classifier — refines PDF document type after extraction. */
  classifier: process.env.OPENAI_CLASSIFIER_MODEL ?? "gpt-4o-mini",

  /** Vision PDF → Markdown converter. MUST be multimodal AND PDF-file-
   *  input-capable. */
  vision: process.env.OPENAI_VISION_MODEL ?? "gpt-4o",

  /** Embedding model. Dimension MUST match the vector column in 0004_passages.sql. */
  embedding: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
  /** Embedding dimension. Change in tandem with the model AND the migration. */
  embeddingDim: parseInt(process.env.OPENAI_EMBEDDING_DIM ?? "1536", 10),

  // ── Legacy v1 pipeline (still serves un-embedded docs) ──
  /** Schema-guided fact extractor (legacy v1). Used only when a document
   *  has no passages (e.g. tabular doc someone queried via query_document). */
  extraction: process.env.OPENAI_EXTRACTION_MODEL ?? "gpt-4o-mini",

  /** Legacy v1 answer composer (operates on fact graph). */
  composer: process.env.OPENAI_COMPOSER_MODEL ?? "gpt-4o-mini",

  // ── Reserved for upcoming phases ──
  /** LLM-as-judge verifier — Phase 5. */
  verifier: process.env.OPENAI_VERIFIER_MODEL ?? "gpt-4o-mini",

  /** Reasoning model for the final synthesis on complex (decomposed) questions
   *  — Phase 6. Reasoning models take temperature=1, max_completion_tokens
   *  instead of max_tokens, and accept reasoning_effort. */
  reasoning: process.env.OPENAI_REASONING_MODEL ?? "o4-mini",

  /** Planner that classifies a question as simple or complex and (when
   *  complex) decomposes it into sub-questions — Phase 6. Decomposition
   *  quality matters: a bad split wastes the entire complex path. Keep on
   *  a frontier instruction-following model. */
  reasoningPlanner: process.env.OPENAI_REASONING_PLANNER_MODEL ?? "gpt-4.1",

  // ── Eval / observability ──
  /** Judge model used by the eval harness to score answer correctness. */
  judge: process.env.OPENAI_JUDGE_MODEL ?? "gpt-4o-mini",
} as const;

export type ModelKey = keyof typeof MODELS;

/** Convenience: log the currently-active model config at server start. */
export function describeModelConfig(): string {
  return Object.entries(MODELS)
    .map(([k, v]) => `  ${k.padEnd(14)} ${v}`)
    .join("\n");
}
