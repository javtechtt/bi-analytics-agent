/**
 * Phase 9: Progress polling endpoint.
 *
 * GET /api/tools/progress/[traceId]?since=<ISO>
 *
 * Returns tool_progress rows for the given trace, scoped to the authenticated
 * user, optionally filtered to events newer than `since`.
 *
 * The client polls this every ~500ms while a long tool is in flight,
 * passing the timestamp of the last seen row as `since` so the response
 * only contains new events.
 *
 * Why polling not SSE: SSE on Vercel serverless requires keeping a function
 * invocation alive for the lifetime of the stream — eats minutes per query.
 * Polling with a short interval against a cheap indexed Postgres read is
 * simpler, plays nice with stateless deploys, and the perceived latency
 * gap (~500ms) is far below what the user notices.
 *
 * Auth: must be logged in. Rows are filtered by `user_id`, so a user can
 * only see their own progress events. The trace_id alone is not a secret —
 * but mismatching user_id returns nothing.
 */

import { auth } from "@clerk/nextjs/server";
import { createServerSupabase } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ traceId: string }> };

const MAX_ROWS_PER_POLL = 100;

export async function GET(request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { traceId } = await context.params;
  if (!traceId) {
    return Response.json({ error: "traceId required" }, { status: 400 });
  }

  const url = new URL(request.url);
  const since = url.searchParams.get("since");

  const sb = createServerSupabase();
  let q = sb
    .from("tool_progress")
    .select("id, kind, message, created_at")
    .eq("trace_id", traceId)
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(MAX_ROWS_PER_POLL);

  if (since) {
    // Use gt rather than gte so the cursor advances cleanly — the row at
    // exactly `since` was already delivered last poll.
    q = q.gt("created_at", since);
  }

  const { data, error } = await q;
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({
    events: (data ?? []).map((row) => ({
      id: row.id,
      kind: row.kind as "phase" | "info" | "warn",
      message: row.message,
      createdAt: row.created_at,
    })),
  });
}
