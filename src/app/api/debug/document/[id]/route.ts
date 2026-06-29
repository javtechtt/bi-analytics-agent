/**
 * Polish phase: debug endpoint.
 *
 * GET /api/debug/document/[id]
 *
 * Returns a snapshot of everything we know about a document — useful when
 * a query is misbehaving and you want to confirm:
 *
 *   - Did embedding actually run? How many passages? What page span?
 *   - What did recent tool_calls look like on this doc? Did they error?
 *   - Where is the cost going? Which model/operation dominated?
 *
 * Auth model: the document's owner. There is no admin role — userId from
 * Clerk auth must match the document's user_id (filtered in every query).
 *
 * Body shape is JSON for easy curl/jq inspection. Passage text is truncated
 * to 200 chars per row to keep payloads small; the full passage text is
 * available via direct DB query if needed.
 */

import { auth } from "@clerk/nextjs/server";
import { getSql } from "@/lib/db";

type RouteContext = { params: Promise<{ id: string }> };

const PASSAGE_TEXT_PREVIEW_CHARS = 200;
const RECENT_TOOL_CALLS_LIMIT = 20;
const PASSAGE_SAMPLE_LIMIT = 50;

interface DocRow {
  id: string;
  file_id: string | null;
  session_id: string | null;
  type: string;
  subtype: string | null;
  language: string;
  status: string;
  has_passages: boolean;
  overall_confidence: string | number | null;
  grounding_ratio: string | number | null;
  classifier_confidence: string | number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  extraction: {
    extractionMethod?: string;
    type?: string;
    subtype?: string;
    sourceFileName?: string;
    confidence?: number;
    groundingRatio?: number;
    pageTexts?: unknown[];
    facts?: unknown[];
    entities?: unknown[];
    metrics?: unknown[];
  } | null;
}

export async function GET(_request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const sql = getSql();

  // 1. Document metadata — also serves as ownership check.
  let doc: DocRow | undefined;
  try {
    const rows = (await sql`
      select id, file_id, session_id, type, subtype, language, status,
             has_passages, overall_confidence, grounding_ratio,
             classifier_confidence, error, created_at, updated_at, extraction
      from documents
      where id = ${id} and user_id = ${userId}
      limit 1
    `) as DocRow[];
    doc = rows[0];
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "query failed" },
      { status: 500 }
    );
  }
  if (!doc) {
    return Response.json({ error: "Document not found" }, { status: 404 });
  }

  // Strip the heavy fields from extraction — we surface metadata only.
  // pageTexts can be hundreds of KB and is server-only by design.
  const extractionMeta = doc.extraction
    ? {
        extractionMethod: doc.extraction.extractionMethod,
        type: doc.extraction.type,
        subtype: doc.extraction.subtype,
        sourceFileName: doc.extraction.sourceFileName,
        confidence: doc.extraction.confidence,
        groundingRatio: doc.extraction.groundingRatio,
        pageCount: doc.extraction.pageTexts?.length ?? 0,
        factCount: doc.extraction.facts?.length ?? 0,
        entityCount: doc.extraction.entities?.length ?? 0,
        metricCount: doc.extraction.metrics?.length ?? 0,
      }
    : null;

  // 2. Passage stats + sample.
  const countRows = (await sql`
    select count(*)::int as count from passages
    where document_id = ${id} and user_id = ${userId}
  `) as Array<{ count: number }>;
  const passageCount = countRows[0]?.count ?? 0;

  const passageSample = (await sql`
    select id, chunk_index, page_start, page_end, heading, text, token_count
    from passages
    where document_id = ${id} and user_id = ${userId}
    order by chunk_index asc
    limit ${PASSAGE_SAMPLE_LIMIT}
  `) as Array<{
    chunk_index: number;
    page_start: number | null;
    page_end: number | null;
    heading: string | null;
    text: string;
    token_count: number | null;
  }>;

  const passages = passageSample.map((p) => ({
    chunkIndex: p.chunk_index,
    pageStart: p.page_start,
    pageEnd: p.page_end,
    heading: p.heading,
    textPreview:
      p.text.length > PASSAGE_TEXT_PREVIEW_CHARS
        ? p.text.slice(0, PASSAGE_TEXT_PREVIEW_CHARS) + "…"
        : p.text,
    tokenCount: p.token_count,
  }));

  // Roll up token totals + page span across ALL passages (not just sample).
  const passageRollupRows = (await sql`
    select page_start, page_end, token_count from passages
    where document_id = ${id} and user_id = ${userId}
  `) as Array<{ page_start: number | null; page_end: number | null; token_count: number | null }>;

  let totalTokens = 0;
  let minPage: number | null = null;
  let maxPage: number | null = null;
  for (const row of passageRollupRows) {
    if (row.token_count) totalTokens += row.token_count;
    if (row.page_start != null) {
      minPage = minPage == null ? row.page_start : Math.min(minPage, row.page_start);
    }
    if (row.page_end != null) {
      maxPage = maxPage == null ? row.page_end : Math.max(maxPage, row.page_end);
    }
  }

  // 3. Recent tool_calls for this document.
  const toolCalls = (await sql`
    select id, trace_id, tool_name, status, duration_ms, total_cost_usd, error, args, created_at
    from tool_calls
    where document_id = ${id} and user_id = ${userId}
    order by created_at desc
    limit ${RECENT_TOOL_CALLS_LIMIT}
  `) as Array<{
    id: string;
    trace_id: string;
    tool_name: string;
    status: string;
    duration_ms: number | null;
    total_cost_usd: string | number | null;
    error: string | null;
    args: unknown;
    created_at: string;
  }>;

  // 4. LLM call cost rollup across this document's tool_calls.
  const toolCallIds = toolCalls.map((t) => t.id);
  let llmRollup: Array<{
    operation: string;
    model: string;
    callCount: number;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }> = [];

  if (toolCallIds.length > 0) {
    const llmRows = (await sql`
      select operation, model, cost_usd, input_tokens, output_tokens
      from llm_calls
      where tool_call_id = any(${toolCallIds}::uuid[])
    `) as Array<{
      operation: string;
      model: string;
      cost_usd: string | number | null;
      input_tokens: number | null;
      output_tokens: number | null;
    }>;

    const grouped = new Map<
      string,
      {
        operation: string;
        model: string;
        callCount: number;
        totalCostUsd: number;
        totalInputTokens: number;
        totalOutputTokens: number;
      }
    >();
    for (const row of llmRows) {
      const key = `${row.operation}::${row.model}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.callCount += 1;
        existing.totalCostUsd += Number(row.cost_usd ?? 0);
        existing.totalInputTokens += row.input_tokens ?? 0;
        existing.totalOutputTokens += row.output_tokens ?? 0;
      } else {
        grouped.set(key, {
          operation: row.operation,
          model: row.model,
          callCount: 1,
          totalCostUsd: Number(row.cost_usd ?? 0),
          totalInputTokens: row.input_tokens ?? 0,
          totalOutputTokens: row.output_tokens ?? 0,
        });
      }
    }
    llmRollup = Array.from(grouped.values()).sort(
      (a, b) => b.totalCostUsd - a.totalCostUsd
    );
  }

  return Response.json({
    document: {
      id: doc.id,
      fileId: doc.file_id,
      sessionId: doc.session_id,
      type: doc.type,
      subtype: doc.subtype,
      language: doc.language,
      status: doc.status,
      hasPassages: doc.has_passages,
      overallConfidence: doc.overall_confidence,
      groundingRatio: doc.grounding_ratio,
      classifierConfidence: doc.classifier_confidence,
      error: doc.error,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      extraction: extractionMeta,
    },
    passageStats: {
      count: passageCount,
      totalTokens,
      pageRange: minPage != null && maxPage != null ? { min: minPage, max: maxPage } : null,
    },
    passages,
    recentToolCalls: toolCalls.map((t) => ({
      id: t.id,
      traceId: t.trace_id,
      toolName: t.tool_name,
      status: t.status,
      durationMs: t.duration_ms,
      totalCostUsd: t.total_cost_usd != null ? Number(t.total_cost_usd) : null,
      error: t.error,
      args: t.args,
      createdAt: t.created_at,
    })),
    llmCostRollup: llmRollup,
  });
}
