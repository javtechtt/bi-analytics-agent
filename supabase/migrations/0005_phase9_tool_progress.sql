-- Phase 9 — Voice UX: tool progress events
--
-- Stores fine-grained progress events emitted during a long-running tool
-- invocation. The client subscribes (via polling) and renders the messages
-- into a "progress skeleton" scene so the user is never staring at a black
-- screen while the agent is silent.
--
-- Row lifecycle:
--   1. Tool route opens a trace with a client-supplied trace_id.
--   2. Tool body calls `emitProgress(kind, message)` at key milestones
--      (planner verdict, retrieval done, composition done, verify done).
--   3. Client polls `/api/tools/progress/[traceId]?since=<cursor>` every
--      ~500ms, renders new rows into the skeleton.
--   4. When the tool POST returns, client stops polling and replaces the
--      skeleton with the real scene.
--
-- Rows are short-lived (useful only during the request) but we keep them
-- for debugging — a per-document/per-trace view in /api/debug/document/[id]
-- could surface them later. No TTL in v1; volume is modest.
--
-- RLS: same convention as the rest of the schema — enabled with no policies,
-- which denies anon access. Only the service-role client (used by API
-- routes) reads/writes. The /api/tools/progress endpoint filters by userId
-- in the application layer.

create table if not exists public.tool_progress (
  id          uuid primary key default gen_random_uuid(),
  trace_id    uuid not null,
  user_id     text not null,                    -- denormalized for fast user-scoped polling
  -- "phase"    = a high-level milestone (e.g. "retrieving", "composing")
  -- "info"     = an informational sub-message under the current phase
  -- "warn"     = something noteworthy but non-fatal (e.g. "verifier flagged")
  kind        text not null check (kind in ('phase', 'info', 'warn')),
  message     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_tool_progress_trace
  on public.tool_progress (trace_id, created_at);

create index if not exists idx_tool_progress_user
  on public.tool_progress (user_id, created_at desc);

alter table public.tool_progress enable row level security;
