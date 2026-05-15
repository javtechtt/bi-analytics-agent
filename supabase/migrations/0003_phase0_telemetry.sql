-- Phase 0 — Evaluation Harness & Observability
--
-- Adds two telemetry tables that every subsequent phase will write to:
--
--   tool_calls — one row per tool invocation (e.g. query_document,
--                create_chart, compose_visual_scene). Wraps the lifetime
--                of an entire tool call including its child LLM calls.
--
--   llm_calls  — one row per OpenAI API call. Linked to a tool_call via
--                tool_call_id, but can also exist standalone (e.g. eval
--                scoring calls outside tool execution).
--
-- These tables drive the eval runner and the per-query cost dashboard.
-- RLS is enabled with no policies; only the service-role client (used by
-- the eval script and the API routes) can read/write — matching the
-- existing convention on documents/scenes/passages.

create extension if not exists "pgcrypto";

-- ── tool_calls ───────────────────────────────────────────

create table if not exists public.tool_calls (
  id            uuid primary key default gen_random_uuid(),
  trace_id      uuid not null,                       -- links a chain of work; one user request = one trace
  session_id    uuid references public.sessions(id) on delete set null,
  document_id   uuid references public.documents(id) on delete set null,
  user_id       text,
  tool_name     text not null,                       -- e.g. "query_document_v2", "create_chart"
  args          jsonb,                               -- tool input arguments (sanitized)
  status        text not null default 'pending',    -- pending | success | error | timeout
  result_summary jsonb,                              -- abbreviated tool result (no raw text dumps)
  error         text,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  duration_ms   integer,
  total_cost_usd numeric(10, 6),                     -- sum of child llm_calls
  -- Eval-only fields (null in production, set by eval harness)
  eval_run_id   uuid,
  eval_question_id text,
  eval_score    numeric(4, 3),
  eval_notes    text
);

create index if not exists idx_tool_calls_trace_id    on public.tool_calls (trace_id);
create index if not exists idx_tool_calls_session_id  on public.tool_calls (session_id);
create index if not exists idx_tool_calls_document_id on public.tool_calls (document_id);
create index if not exists idx_tool_calls_user_id     on public.tool_calls (user_id);
create index if not exists idx_tool_calls_tool_name   on public.tool_calls (tool_name);
create index if not exists idx_tool_calls_started_at  on public.tool_calls (started_at desc);
create index if not exists idx_tool_calls_eval_run_id on public.tool_calls (eval_run_id) where eval_run_id is not null;

alter table public.tool_calls enable row level security;

-- ── llm_calls ────────────────────────────────────────────

create table if not exists public.llm_calls (
  id              uuid primary key default gen_random_uuid(),
  trace_id        uuid not null,
  tool_call_id    uuid references public.tool_calls(id) on delete cascade,
  operation       text not null,                     -- e.g. "extract_chunk", "compose_answer", "classify", "verify", "embed", "rerank"
  model           text not null,                     -- e.g. "gpt-4.1", "gpt-4o-mini"
  input_tokens    integer,
  output_tokens   integer,
  total_tokens    integer generated always as (coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) stored,
  cost_usd        numeric(10, 6),
  latency_ms      integer not null,
  status          text not null default 'success',   -- success | error | timeout
  error           text,
  -- Sanitized prompt/response metadata. NEVER store full document text here —
  -- it explodes table size and leaks user data into logs. Store sizes only.
  prompt_chars    integer,
  response_chars  integer,
  created_at      timestamptz not null default now()
);

create index if not exists idx_llm_calls_trace_id     on public.llm_calls (trace_id);
create index if not exists idx_llm_calls_tool_call_id on public.llm_calls (tool_call_id);
create index if not exists idx_llm_calls_model        on public.llm_calls (model);
create index if not exists idx_llm_calls_operation    on public.llm_calls (operation);
create index if not exists idx_llm_calls_created_at   on public.llm_calls (created_at desc);

alter table public.llm_calls enable row level security;

-- ── Helper view: cost rollup per tool call ───────────────

create or replace view public.tool_call_costs as
select
  tc.id              as tool_call_id,
  tc.trace_id,
  tc.tool_name,
  tc.duration_ms,
  count(lc.id)       as llm_call_count,
  sum(lc.input_tokens)  as total_input_tokens,
  sum(lc.output_tokens) as total_output_tokens,
  sum(lc.cost_usd)      as computed_cost_usd,
  tc.total_cost_usd     as recorded_cost_usd,
  tc.started_at
from public.tool_calls tc
left join public.llm_calls lc on lc.tool_call_id = tc.id
group by tc.id, tc.trace_id, tc.tool_name, tc.duration_ms, tc.total_cost_usd, tc.started_at;
