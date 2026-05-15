/**
 * Phase 1: Embedding pipeline.
 *
 * Embeds chunks for a document with `text-embedding-3-small` and persists
 * them to the `passages` table. On success, flips `documents.has_passages`
 * to true so the routing layer prefers `query_document_v2` for this doc.
 *
 * Idempotent: re-embedding the same document deletes existing passages
 * first. Use this for "re-embed after content changes" or "re-embed under
 * a different model/dimension."
 *
 * Non-blocking by default at the upload path — the parse route calls this
 * with `await` but expects it to be quick (typical 30-page doc: ~3-5s).
 * For very long documents (Scotiabank 13MB / 200+ pages) it can take 30s+;
 * Phase 7's SSE streaming will surface progress to the voice agent.
 */

import { createServerSupabase } from "@/lib/supabase/server";
import { instrumented } from "@/lib/telemetry/trace";
import { semanticChunk, chunkStats } from "./chunker";
import type { DocumentExtraction } from "@/lib/documents/types";
import { MODELS } from "@/lib/models";
import { openai } from "@/lib/openai/client";

const EMBED_MODEL = MODELS.embedding;
const EMBED_DIM = MODELS.embeddingDim;     // must match passages.embedding vector(N)
const BATCH_SIZE = 96;                  // OpenAI accepts up to ~2048 inputs per call; 96 is conservative + fast
const MAX_CHUNK_INPUT_CHARS = 8000;     // safety: truncate any pathologically long chunk before embedding

export interface EmbedDocumentInput {
  documentId: string;
  userId: string;
  /** The extraction object that came back from the narrative adapter.
   *  Must contain `pageTexts`. */
  extraction: DocumentExtraction;
}

export interface EmbedDocumentResult {
  passageCount: number;
  totalTokens: number;
  durationMs: number;
}

export async function embedDocument(input: EmbedDocumentInput): Promise<EmbedDocumentResult> {
  const t0 = Date.now();
  const { documentId, userId, extraction } = input;

  const pageTexts = extraction.pageTexts ?? [];
  if (pageTexts.length === 0) {
    throw new Error(
      `embedDocument: no pageTexts on extraction for document ${documentId}. ` +
      `Embedding requires a narrative adapter run.`
    );
  }

  // 1. Chunk
  const chunks = semanticChunk({ pageTexts });
  const stats = chunkStats(chunks);
  console.log(
    `[embed] ${documentId}: ${chunks.length} chunks ` +
    `(avg ${stats.avgTokens} tok, range ${stats.minTokens}-${stats.maxTokens}, ` +
    `pages ${stats.pageSpan.min}-${stats.pageSpan.max})`
  );

  if (chunks.length === 0) {
    throw new Error(`embedDocument: chunker produced 0 chunks for ${documentId}`);
  }

  // 2. Embed in batches
  const vectors = await embedTexts(chunks.map((c) => c.text));

  if (vectors.length !== chunks.length) {
    throw new Error(
      `embedDocument: vector count mismatch — got ${vectors.length} embeddings for ${chunks.length} chunks`
    );
  }

  // 3. Persist (transactional in spirit: delete old, insert new)
  const sb = createServerSupabase();
  const { error: deleteErr } = await sb
    .from("passages")
    .delete()
    .eq("document_id", documentId);
  if (deleteErr) {
    throw new Error(`embedDocument: failed to clear old passages — ${deleteErr.message}`);
  }

  // Bulk insert. Supabase's batch insert handles up to ~1000 rows per call;
  // we cap at 500 to stay under PostgREST payload limits.
  const rows = chunks.map((c, i) => ({
    document_id: documentId,
    user_id: userId,
    chunk_index: c.chunkIndex,
    page_start: c.pageStart,
    page_end: c.pageEnd,
    text: c.text,
    heading: c.heading,
    char_offset: c.charOffset,
    token_count: c.tokenCount,
    embedding: vectors[i],
  }));

  const INSERT_BATCH = 500;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const slice = rows.slice(i, i + INSERT_BATCH);
    const { error: insertErr } = await sb.from("passages").insert(slice);
    if (insertErr) {
      throw new Error(`embedDocument: passages insert failed at batch ${i} — ${insertErr.message}`);
    }
  }

  // 4. Flip the feature flag.
  const { error: flagErr } = await sb
    .from("documents")
    .update({ has_passages: true })
    .eq("id", documentId)
    .eq("user_id", userId);
  if (flagErr) {
    console.warn(
      `[embed] ${documentId}: passages inserted but has_passages flip failed — ${flagErr.message}`
    );
  }

  const durationMs = Date.now() - t0;
  console.log(
    `[embed] ${documentId}: done — ${chunks.length} passages, ${stats.totalTokens} tokens, ${durationMs}ms`
  );

  return {
    passageCount: chunks.length,
    totalTokens: stats.totalTokens,
    durationMs,
  };
}

// ── Embedding API (re-usable for query-time embedding too) ──

/**
 * Embed an arbitrary list of texts. Returns vectors in input order.
 * Used both for chunk embedding at upload time and for query embedding
 * at retrieval time.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const client = openai("embedding");
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) =>
      t.length > MAX_CHUNK_INPUT_CHARS ? t.slice(0, MAX_CHUNK_INPUT_CHARS) : t
    );
    const totalChars = batch.reduce((acc, t) => acc + t.length, 0);

    const response = await instrumented(
      "embed",
      EMBED_MODEL,
      () =>
        client.embeddings.create({
          model: EMBED_MODEL,
          input: batch,
          dimensions: EMBED_DIM,
        }),
      { promptChars: totalChars }
    );

    for (const item of response.data) {
      out.push(item.embedding);
    }
  }

  return out;
}

/** Embed a single query string. Convenience wrapper. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  if (!vec) throw new Error("embedQuery: no embedding returned");
  return vec;
}
