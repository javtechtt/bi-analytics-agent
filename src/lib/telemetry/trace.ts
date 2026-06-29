/**
 * Phase 0: Tracing + telemetry persistence.
 *
 * One user request = one trace_id. Every LLM call inside that request gets
 * the same trace_id so we can reconstruct the full chain in Postgres.
 *
 * trace_id flows through async code via AsyncLocalStorage — call sites in
 * extractor/composer/classifier/verifier don't need to thread it manually.
 * The tool execute route opens a trace at the top of a request; everything
 * below inherits it.
 *
 * Persistence is non-blocking. If the insert fails we log and continue —
 * telemetry must never block the user-facing path.
 *
 * Design constraint: NEVER store full prompts or responses here. We store
 * sizes (char counts) only. Full payloads in trace tables explode storage
 * and leak user data into logs.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getSql, toJsonb } from "@/lib/db";
import { computeCostUsd } from "./cost";

// ── Trace context ────────────────────────────────────────

export interface TraceContext {
  traceId: string;
  toolCallId?: string;
  sessionId?: string | null;
  userId?: string | null;
  documentId?: string | null;
  /** Eval-only — set when the runner orchestrates a call. */
  evalRunId?: string;
  evalQuestionId?: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/** Read the current trace context, if any. */
export function currentTrace(): TraceContext | undefined {
  return traceStorage.getStore();
}

/** Run a function within a trace context. Nested calls inherit. */
export function withTrace<T>(ctx: Partial<TraceContext> & { traceId?: string }, fn: () => T): T {
  const parent = traceStorage.getStore();
  const merged: TraceContext = {
    traceId: ctx.traceId ?? parent?.traceId ?? randomUUID(),
    toolCallId: ctx.toolCallId ?? parent?.toolCallId,
    sessionId: ctx.sessionId ?? parent?.sessionId ?? null,
    userId: ctx.userId ?? parent?.userId ?? null,
    documentId: ctx.documentId ?? parent?.documentId ?? null,
    evalRunId: ctx.evalRunId ?? parent?.evalRunId,
    evalQuestionId: ctx.evalQuestionId ?? parent?.evalQuestionId,
  };
  return traceStorage.run(merged, fn);
}

// ── Tool call lifecycle ──────────────────────────────────

export interface BeginToolCallInput {
  toolName: string;
  args?: Record<string, unknown>;
}

export interface ToolCallHandle {
  id: string;
  traceId: string;
}

/**
 * Open a tool_calls row at the start of a tool invocation. Returns a handle
 * that endToolCall consumes. Wrap the rest of the tool body in withTrace
 * with `toolCallId: handle.id` so child LLM calls link back.
 */
export async function beginToolCall(input: BeginToolCallInput): Promise<ToolCallHandle> {
  const ctx = currentTrace();
  const traceId = ctx?.traceId ?? randomUUID();
  const id = randomUUID();
  try {
    const sql = getSql();
    await sql`
      insert into tool_calls (
        id, trace_id, session_id, document_id, user_id, tool_name, args,
        status, eval_run_id, eval_question_id
      ) values (
        ${id}, ${traceId}, ${ctx?.sessionId ?? null}, ${ctx?.documentId ?? null},
        ${ctx?.userId ?? null}, ${input.toolName}, ${toJsonb(input.args ?? null)}::jsonb,
        'pending', ${ctx?.evalRunId ?? null}, ${ctx?.evalQuestionId ?? null}
      )
    `;
  } catch (err) {
    console.warn("[telemetry/trace] beginToolCall insert failed:", err instanceof Error ? err.message : err);
  }
  return { id, traceId };
}

export interface EndToolCallInput {
  handle: ToolCallHandle;
  status: "success" | "error" | "timeout";
  durationMs: number;
  resultSummary?: Record<string, unknown>;
  error?: string;
  totalCostUsd?: number | null;
}

export async function endToolCall(input: EndToolCallInput): Promise<void> {
  try {
    const sql = getSql();
    await sql`
      update tool_calls set
        status = ${input.status},
        completed_at = now(),
        duration_ms = ${input.durationMs},
        result_summary = ${toJsonb(input.resultSummary ?? null)}::jsonb,
        error = ${input.error ?? null},
        total_cost_usd = ${input.totalCostUsd ?? null}
      where id = ${input.handle.id}
    `;
  } catch (err) {
    console.warn("[telemetry/trace] endToolCall update failed:", err instanceof Error ? err.message : err);
  }
}

// ── LLM call recording ───────────────────────────────────

export interface RecordLlmCallInput {
  operation: string;            // "extract_chunk", "compose_answer", "classify", "verify", "embed", "rerank"
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  status?: "success" | "error" | "timeout";
  error?: string;
  promptChars?: number;
  responseChars?: number;
}

/**
 * Track in-flight telemetry inserts so test/eval code can wait for them to
 * settle before querying the table. Production code never awaits this set
 * directly — inserts remain fire-and-forget so the user-facing path is never
 * slowed by a telemetry stall.
 */
const pendingWrites = new Set<Promise<unknown>>();

/**
 * Wait for all currently-pending telemetry writes to complete. Used by the
 * eval runner before reading cost rollups; not used in production paths.
 */
export async function settlePendingWrites(): Promise<void> {
  if (pendingWrites.size === 0) return;
  await Promise.allSettled([...pendingWrites]);
}

/**
 * Register an in-flight telemetry write so `settlePendingWrites` can wait
 * on it. Exposed for other telemetry modules (e.g. progress events) that
 * want their fire-and-forget inserts to participate in the same settlement
 * set as `recordLlmCall`.
 */
export function registerPendingWrite(p: Promise<unknown>): void {
  pendingWrites.add(p);
  p.finally(() => pendingWrites.delete(p));
}

/**
 * Record one LLM call. Reads trace context from AsyncLocalStorage so callers
 * don't need to pass trace_id. Non-blocking — failures here never propagate.
 *
 * Returns the computed cost so the caller can aggregate. The actual DB
 * insert is registered in `pendingWrites` so callers that need accurate
 * post-query rollups (eval, debug endpoints) can `await settlePendingWrites()`
 * before reading.
 */
export async function recordLlmCall(input: RecordLlmCallInput): Promise<number | null> {
  const ctx = currentTrace();
  const cost = computeCostUsd(input.model, input.inputTokens, input.outputTokens);
  if (!ctx?.traceId) {
    // No trace open — record-and-forget without DB write. Cost still returned.
    return cost;
  }
  const write = (async () => {
    try {
      const sql = getSql();
      // total_tokens is a generated column — never insert it.
      await sql`
        insert into llm_calls (
          trace_id, tool_call_id, operation, model, input_tokens, output_tokens,
          cost_usd, latency_ms, status, error, prompt_chars, response_chars
        ) values (
          ${ctx.traceId}, ${ctx.toolCallId ?? null}, ${input.operation}, ${input.model},
          ${input.inputTokens}, ${input.outputTokens}, ${cost}, ${input.latencyMs},
          ${input.status ?? "success"}, ${input.error ?? null},
          ${input.promptChars ?? null}, ${input.responseChars ?? null}
        )
      `;
    } catch (err) {
      console.warn("[telemetry/trace] recordLlmCall insert failed:", err instanceof Error ? err.message : err);
    }
  })();
  pendingWrites.add(write);
  write.finally(() => pendingWrites.delete(write));
  return cost;
}

/**
 * Sum cost of all LLM calls within a specific trace. The eval runner calls
 * this after settlePendingWrites() to get reliable per-question cost.
 */
export async function totalCostForTraceId(traceId: string): Promise<number | null> {
  try {
    const sql = getSql();
    const data = (await sql`
      select cost_usd from llm_calls where trace_id = ${traceId}
    `) as Array<{ cost_usd: string | number | null }>;
    if (!data) return null;
    let total = 0;
    let any = false;
    for (const row of data) {
      if (row.cost_usd != null) {
        total += Number(row.cost_usd);
        any = true;
      }
    }
    return any ? Number(total.toFixed(6)) : null;
  } catch {
    return null;
  }
}

// ── Convenience: instrument an OpenAI chat-completion call ──

/**
 * Wrap an OpenAI chat-completion-style call with telemetry. Returns whatever
 * the call returned. Reads usage from the response if present.
 *
 * Usage:
 *   const completion = await instrumented("extract_chunk", "gpt-4.1", () =>
 *     client.chat.completions.parse({ model: "gpt-4.1", messages, ... })
 *   );
 */
export async function instrumented<T extends { usage?: { prompt_tokens?: number; completion_tokens?: number } | null }>(
  operation: string,
  model: string,
  fn: () => Promise<T>,
  opts?: { promptChars?: number }
): Promise<T> {
  const t0 = Date.now();
  let status: "success" | "error" | "timeout" = "success";
  let err: string | undefined;
  let result: T | undefined;
  try {
    result = await fn();
    return result;
  } catch (caught) {
    status = "error";
    err = caught instanceof Error ? caught.message : String(caught);
    throw caught;
  } finally {
    const latencyMs = Date.now() - t0;
    const usage = result?.usage ?? undefined;
    void recordLlmCall({
      operation,
      model,
      inputTokens: usage?.prompt_tokens ?? null,
      outputTokens: usage?.completion_tokens ?? null,
      latencyMs,
      status,
      error: err,
      promptChars: opts?.promptChars,
      responseChars: undefined,
    });
  }
}

// ── Convenience: aggregate cost over a trace ─────────────

/**
 * Sum cost of all LLM calls within a trace. Used by tool execute to write
 * total_cost_usd on the tool_calls row.
 */
export async function totalCostForToolCall(toolCallId: string): Promise<number | null> {
  try {
    const sql = getSql();
    const data = (await sql`
      select cost_usd from llm_calls where tool_call_id = ${toolCallId}
    `) as Array<{ cost_usd: string | number | null }>;
    if (!data) return null;
    let total = 0;
    let any = false;
    for (const row of data) {
      if (row.cost_usd != null) {
        total += Number(row.cost_usd);
        any = true;
      }
    }
    return any ? Number(total.toFixed(6)) : null;
  } catch {
    return null;
  }
}
