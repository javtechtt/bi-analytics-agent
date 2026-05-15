/**
 * Phase 1: Retrieval.
 *
 * Embeds a question, asks pgvector for the top-K most similar passages
 * within a document (user-scoped), returns them ordered by similarity.
 *
 * The caller (query_document_v2) optionally reranks the top-K down to a
 * tighter set before sending to the answer composer. The composer reads
 * the actual passage text — there is NO eager fact extraction in this path.
 */

import { createServerSupabase } from "@/lib/supabase/server";
import { embedQuery } from "./embed";

const DEFAULT_K = 12;

export interface Passage {
  passageId: string;
  chunkIndex: number;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
  heading: string | null;
  /** Cosine similarity in [0, 1]. Higher = more relevant. */
  similarity: number;
}

export interface RetrievalInput {
  documentId: string;
  userId: string;
  query: string;
  /** How many top passages to return. Defaults to 12. */
  k?: number;
}

export interface RetrievalResult {
  passages: Passage[];
  /** Approximate cost of the query embedding (the RPC itself is free). */
  embedCostUsd: number | null;
}

export async function retrievePassages(input: RetrievalInput): Promise<RetrievalResult> {
  const { documentId, userId, query } = input;
  const k = input.k ?? DEFAULT_K;

  if (!query || query.trim().length === 0) {
    throw new Error("retrievePassages: empty query");
  }

  // 1. Embed the question.
  const queryEmbedding = await embedQuery(query);

  // 2. RPC into pgvector for cosine top-K.
  const sb = createServerSupabase();
  const { data, error } = await sb.rpc("match_passages", {
    p_document_id: documentId,
    p_user_id: userId,
    p_query_embedding: queryEmbedding as unknown as string,   // supabase-js accepts arrays for vector via implicit cast
    p_match_count: k,
  });

  if (error) {
    throw new Error(`retrievePassages: RPC failed — ${error.message}`);
  }
  if (!data || !Array.isArray(data)) {
    return { passages: [], embedCostUsd: null };
  }

  type RpcRow = {
    passage_id: string;
    chunk_index: number;
    page_start: number | null;
    page_end: number | null;
    text: string;
    heading: string | null;
    similarity: number;
  };

  const passages: Passage[] = (data as RpcRow[]).map((row) => ({
    passageId: row.passage_id,
    chunkIndex: row.chunk_index,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    text: row.text,
    heading: row.heading,
    similarity: row.similarity,
  }));

  return { passages, embedCostUsd: null };
}

/**
 * Format passages for inclusion in an LLM prompt. Each passage is preceded
 * by an addressable id (`[P12 p.3-4]`) the answer composer must cite from.
 *
 * Page format follows the same convention as the existing extractor's
 * sentence list: `[P<chunkIndex> p.<pageStart>-<pageEnd>]` followed by the
 * verbatim passage text.
 */
export function formatPassagesForPrompt(passages: Passage[]): string {
  return passages
    .map((p) => {
      const pageLabel = formatPageRange(p.pageStart, p.pageEnd);
      const heading = p.heading ? ` § ${p.heading}` : "";
      return `[P${p.chunkIndex}${pageLabel}${heading}]\n${p.text}`;
    })
    .join("\n\n");
}

function formatPageRange(start: number | null, end: number | null): string {
  if (start == null) return "";
  if (end == null || end === start) return ` p.${start}`;
  return ` p.${start}-${end}`;
}
