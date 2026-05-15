/**
 * Phase 1: Reranker.
 *
 * Takes the top-K passages from vector retrieval (k=12-20) and reorders /
 * trims them to the most relevant top-N (n=4-6) before the answer composer
 * sees them. Necessary because:
 *
 *   - Embedding-based retrieval has false positives — semantically similar
 *     passages that don't actually answer the question.
 *   - The answer composer's quality scales with retrieval precision more
 *     than recall. Three on-point passages > ten loosely related ones.
 *
 * Implementation (v1): single `gpt-4o-mini` call with structured output.
 * Pros: 1 API call (~1s), cheap, simple. Cons: less precise than per-passage
 * logprobs scoring. If Phase 1 eval shows reranker is a weak link we can
 * swap in a logprobs-based scorer without changing this module's public API.
 *
 * Failure mode: if reranking errors (API down, timeout, malformed output),
 * the caller falls back to similarity-sorted top-N from the input list.
 * Reranker is precision polish, not a critical path.
 */

import { openai } from "@/lib/openai/client";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { instrumented } from "@/lib/telemetry/trace";
import type { Passage } from "./retrieve";
import { MODELS } from "@/lib/models";

const RERANK_MODEL = MODELS.reranker;
const DEFAULT_TOP_N = 6;
const PASSAGE_SNIPPET_CHARS = 400;     // chars per passage sent to the ranker; keeps context tight

const RerankResponseSchema = z.object({
  /** Passage chunk_index values in descending relevance order. */
  rankedIndices: z.array(z.number().int().nonnegative()),
  /** One short sentence justifying the top pick. For telemetry / debug. */
  topReasoning: z.string(),
});

export interface RerankInput {
  query: string;
  passages: Passage[];
  /** How many top passages to return after reranking. */
  topN?: number;
}

export interface RerankResult {
  /** Passages in reranked relevance order, length ≤ topN. */
  passages: Passage[];
  /** Whether the LLM ranker actually ran (true) or we fell back to similarity (false). */
  rerankerRan: boolean;
  reasoning?: string;
}

export async function rerankPassages(input: RerankInput): Promise<RerankResult> {
  const { query, passages } = input;
  const topN = input.topN ?? DEFAULT_TOP_N;

  if (passages.length === 0) {
    return { passages: [], rerankerRan: false };
  }
  // If we already have ≤ topN passages, there's nothing to rerank.
  if (passages.length <= topN) {
    return { passages: [...passages], rerankerRan: false };
  }

  // Build snippet list — chunk_index is the addressable id.
  const snippetList = passages
    .map((p) => `[index=${p.chunkIndex}] ${truncate(p.text, PASSAGE_SNIPPET_CHARS)}`)
    .join("\n\n");

  const systemPrompt = `You are a retrieval reranker. Given a question and a list of candidate passages from a document, return the passages ordered from MOST to LEAST relevant for answering the question.

Rules:
- "Relevant" = the passage contains information that DIRECTLY helps answer the question (not just tangentially related).
- Return passage INDICES (the numbers in [index=N]) in descending relevance order.
- Include ALL input indices in your output — even if some are weakly relevant.
- The top index should be the single most useful passage if forced to pick one.
- If two passages are equally relevant, the one with more specific information ranks higher.`;

  const userPrompt = `Question: ${query}

Candidate passages (numbered with [index=N]):

${snippetList}

Return the rankedIndices array in descending relevance order.`;

  const client = openai();

  try {
    const completion = await instrumented(
      "rerank",
      RERANK_MODEL,
      () =>
        client.chat.completions.parse({
          model: RERANK_MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: zodResponseFormat(RerankResponseSchema, "rerank"),
        }),
      { promptChars: systemPrompt.length + userPrompt.length }
    );

    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) {
      return fallback(passages, topN, "reranker returned no parsed content");
    }

    const indexMap = new Map<number, Passage>();
    for (const p of passages) indexMap.set(p.chunkIndex, p);

    const reranked: Passage[] = [];
    for (const idx of parsed.rankedIndices) {
      const p = indexMap.get(idx);
      if (p && !reranked.includes(p)) reranked.push(p);
      if (reranked.length >= topN) break;
    }

    // Defensive: if the model hallucinated indices and we ended up with too
    // few, top up from similarity order.
    if (reranked.length < topN) {
      for (const p of passages) {
        if (!reranked.includes(p)) reranked.push(p);
        if (reranked.length >= topN) break;
      }
    }

    return {
      passages: reranked,
      rerankerRan: true,
      reasoning: parsed.topReasoning,
    };
  } catch (err) {
    return fallback(
      passages,
      topN,
      `reranker error: ${err instanceof Error ? err.message : "unknown"}`
    );
  }
}

function fallback(passages: Passage[], topN: number, reason: string): RerankResult {
  console.warn(`[rerank] falling back to similarity order: ${reason}`);
  return {
    passages: [...passages].sort((a, b) => b.similarity - a.similarity).slice(0, topN),
    rerankerRan: false,
    reasoning: reason,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
