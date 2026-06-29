/**
 * Phase 9: Progress event emission.
 *
 * `emitProgress(kind, message)` writes a `tool_progress` row tagged with the
 * current trace_id + user_id. The client polls these rows to render a live
 * "skeleton" scene while the tool runs.
 *
 * Design constraints:
 *
 *   - **Non-blocking**: insert is fire-and-forget. We never want a progress
 *     write to slow the user-facing path. Failures are logged and dropped.
 *
 *   - **Trace-context driven**: reads `currentTrace()`. Callers don't pass
 *     trace_id or user_id explicitly. If no trace context is open, the
 *     emit is a no-op — handy for unit tests that exercise tool bodies
 *     without a wrapping trace.
 *
 *   - **Tracked for settlement**: like `recordLlmCall`, the insert promise
 *     is registered with the existing `pendingWrites` set so eval/test
 *     code can `await settlePendingWrites()` before asserting. Production
 *     code never waits.
 *
 *   - **Cheap to call**: budget ~50 emits per tool call. At 500ms client
 *     polling cadence the user sees rapid updates, but the DB load is
 *     trivial (single insert, no read).
 */

import { getSql } from "@/lib/db";
import { currentTrace, registerPendingWrite } from "./trace";

export type ProgressKind = "phase" | "info" | "warn";

/**
 * Emit one progress event for the currently-open trace. No-op when no trace
 * context is open. Returns immediately — the DB insert happens in the
 * background.
 */
export function emitProgress(kind: ProgressKind, message: string): void {
  const ctx = currentTrace();
  if (!ctx?.traceId || !ctx.userId) {
    // No trace open OR no user scope — without those we can't tag the row
    // safely. Skip silently; callers that want loud failures should assert
    // their trace setup, not rely on this.
    return;
  }
  const write = (async () => {
    try {
      const sql = getSql();
      await sql`
        insert into tool_progress (trace_id, user_id, kind, message)
        values (${ctx.traceId}, ${ctx.userId}, ${kind}, ${message})
      `;
    } catch (err) {
      console.warn(
        "[telemetry/progress] insert failed (continuing):",
        err instanceof Error ? err.message : err
      );
    }
  })();
  registerPendingWrite(write);
}
