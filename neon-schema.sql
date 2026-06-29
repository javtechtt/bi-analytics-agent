-- BI Analytics Agent — Neon Postgres schema (single file)
--
-- Run this ONCE against your Neon database (SQL editor in the Neon console,
-- or `psql "$DATABASE_URL" -f neon-schema.sql`). It is idempotent — safe to
-- re-run. This replaces the old Supabase setup (supabase-schema.sql + the
-- supabase/migrations/*.sql files), consolidated and de-Supabase'd:
--
--   - No `enable row level security`: there is no PostgREST/anon path on Neon.
--     The app scopes every query by user_id in the WHERE clause already.
--   - uuid_generate_v4()  → gen_random_uuid()  (pgcrypto, no uuid-ossp needed).
--   - pgvector for RAG retrieval (passages.embedding + match_passages()).

create extension if not exists pgcrypto;
create extension if not exists vector;

-- ── users (synced from Clerk on first API call) ──────────
create table if not exists users (
  id           text primary key,
  email        text,
  display_name text,
  avatar_url   text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- ── sessions ─────────────────────────────────────────────
create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      text not null references users(id) on delete cascade,
  title        text not null default 'Untitled Session',
  output_mode  text not null default 'executive',
  is_active    boolean default true,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create index if not exists idx_sessions_user on sessions(user_id, updated_at desc);

-- ── files ────────────────────────────────────────────────
create table if not exists files (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references sessions(id) on delete cascade,
  user_id      text not null references users(id) on delete cascade,
  name         text not null,
  size         integer not null,
  size_label   text not null,
  mime_type    text,
  status       text not null default 'ready',
  storage_path text,
  content      text,
  summary      text,
  parsed_data  jsonb,
  error        text,
  created_at   timestamptz default now()
);
create index if not exists idx_files_session on files(session_id);
create index if not exists idx_files_user on files(user_id);

-- ── messages ─────────────────────────────────────────────
create table if not exists messages (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references sessions(id) on delete cascade,
  external_id  text not null,
  role         text not null,
  content      text not null default '',
  timestamp    bigint not null,
  created_at   timestamptz default now()
);
create index if not exists idx_messages_session on messages(session_id, timestamp);

-- ── charts ───────────────────────────────────────────────
create table if not exists charts (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references sessions(id) on delete cascade,
  external_id  text not null,
  chart_type   text not null,
  title        text not null,
  chart_data   jsonb not null,
  x_label      text,
  y_label      text,
  series       jsonb,
  coverage     text,
  data_summary text,
  position     integer default 0,
  created_at   timestamptz default now()
);
create index if not exists idx_charts_session on charts(session_id);

-- ── dashboards (one per session max) ─────────────────────
create table if not exists dashboards (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references sessions(id) on delete cascade,
  title         text not null,
  subtitle      text,
  kpis          jsonb not null default '[]',
  charts        jsonb not null default '[]',
  insights      jsonb not null default '[]',
  risks         jsonb not null default '[]',
  opportunities jsonb not null default '[]',
  drilldowns    jsonb default '[]',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique(session_id)
);

-- ── documents (universal document architecture) ──────────
create table if not exists documents (
  id                    uuid primary key default gen_random_uuid(),
  file_id               uuid references files(id) on delete cascade,
  session_id            uuid references sessions(id) on delete cascade,
  user_id               text not null,
  type                  text not null,
  subtype               text,
  language              text not null default 'en',
  classifier_confidence numeric not null default 0,
  status                text not null default 'ready',
  extraction            jsonb,
  overall_confidence    numeric not null default 0,
  grounding_ratio       numeric not null default 1,
  error                 text,
  has_passages          boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_documents_file_id      on documents (file_id);
create index if not exists idx_documents_session_id   on documents (session_id);
create index if not exists idx_documents_user_id      on documents (user_id);
create index if not exists idx_documents_type         on documents (type);
create index if not exists idx_documents_has_passages on documents (has_passages) where has_passages = true;

create or replace function documents_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_documents_updated_at on documents;
create trigger trg_documents_updated_at
  before update on documents
  for each row execute function documents_set_updated_at();

-- ── scenes ───────────────────────────────────────────────
create table if not exists scenes (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid references sessions(id) on delete cascade,
  document_id  uuid references documents(id) on delete set null,
  user_id      text not null,
  title        text not null,
  layout       text not null,
  fragments    jsonb not null default '[]'::jsonb,
  caption      text,
  confidence   numeric,
  drilldowns   jsonb default '[]'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists idx_scenes_session_id  on scenes (session_id);
create index if not exists idx_scenes_document_id on scenes (document_id);
create index if not exists idx_scenes_user_id     on scenes (user_id);
create index if not exists idx_scenes_created_at  on scenes (created_at desc);

-- ── tool_calls (telemetry) ───────────────────────────────
create table if not exists tool_calls (
  id            uuid primary key default gen_random_uuid(),
  trace_id      uuid not null,
  session_id    uuid references sessions(id) on delete set null,
  document_id   uuid references documents(id) on delete set null,
  user_id       text,
  tool_name     text not null,
  args          jsonb,
  status        text not null default 'pending',
  result_summary jsonb,
  error         text,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  duration_ms   integer,
  total_cost_usd numeric(10, 6),
  eval_run_id   uuid,
  eval_question_id text,
  eval_score    numeric(4, 3),
  eval_notes    text
);
create index if not exists idx_tool_calls_trace_id    on tool_calls (trace_id);
create index if not exists idx_tool_calls_session_id  on tool_calls (session_id);
create index if not exists idx_tool_calls_document_id on tool_calls (document_id);
create index if not exists idx_tool_calls_user_id     on tool_calls (user_id);
create index if not exists idx_tool_calls_tool_name   on tool_calls (tool_name);
create index if not exists idx_tool_calls_started_at  on tool_calls (started_at desc);
create index if not exists idx_tool_calls_eval_run_id on tool_calls (eval_run_id) where eval_run_id is not null;

-- ── llm_calls (telemetry) ────────────────────────────────
create table if not exists llm_calls (
  id              uuid primary key default gen_random_uuid(),
  trace_id        uuid not null,
  tool_call_id    uuid references tool_calls(id) on delete cascade,
  operation       text not null,
  model           text not null,
  input_tokens    integer,
  output_tokens   integer,
  total_tokens    integer generated always as (coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) stored,
  cost_usd        numeric(10, 6),
  latency_ms      integer not null,
  status          text not null default 'success',
  error           text,
  prompt_chars    integer,
  response_chars  integer,
  created_at      timestamptz not null default now()
);
create index if not exists idx_llm_calls_trace_id     on llm_calls (trace_id);
create index if not exists idx_llm_calls_tool_call_id on llm_calls (tool_call_id);
create index if not exists idx_llm_calls_model        on llm_calls (model);
create index if not exists idx_llm_calls_operation    on llm_calls (operation);
create index if not exists idx_llm_calls_created_at   on llm_calls (created_at desc);

-- ── passages (RAG / pgvector) ────────────────────────────
create table if not exists passages (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references documents(id) on delete cascade,
  user_id       text not null,
  chunk_index   integer not null,
  page_start    integer,
  page_end      integer,
  text          text not null,
  heading       text,
  char_offset   integer,
  token_count   integer,
  embedding     vector(1536) not null,
  created_at    timestamptz not null default now(),
  unique (document_id, chunk_index)
);
create index if not exists idx_passages_document_id on passages (document_id);
create index if not exists idx_passages_user_id     on passages (user_id);
create index if not exists idx_passages_embedding
  on passages using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ── tool_progress (live progress events) ─────────────────
create table if not exists tool_progress (
  id          uuid primary key default gen_random_uuid(),
  trace_id    uuid not null,
  user_id     text not null,
  kind        text not null check (kind in ('phase', 'info', 'warn')),
  message     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_tool_progress_trace on tool_progress (trace_id, created_at);
create index if not exists idx_tool_progress_user  on tool_progress (user_id, created_at desc);

-- ── match_passages: cosine top-k within one document ─────
-- pgvector's <=> is cosine DISTANCE (0 = identical). We return
-- similarity = 1 - distance for caller-friendly scoring.
create or replace function match_passages(
  p_document_id uuid,
  p_user_id     text,
  p_query_embedding vector(1536),
  p_match_count int default 12
)
returns table (
  passage_id   uuid,
  chunk_index  integer,
  page_start   integer,
  page_end     integer,
  text         text,
  heading      text,
  similarity   double precision
)
language sql stable as $$
  select
    p.id           as passage_id,
    p.chunk_index,
    p.page_start,
    p.page_end,
    p.text,
    p.heading,
    1 - (p.embedding <=> p_query_embedding)::double precision as similarity
  from passages p
  where p.document_id = p_document_id
    and p.user_id     = p_user_id
  order by p.embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- ── helper views (eval / debug) ──────────────────────────
create or replace view document_passage_stats as
select
  d.id                       as document_id,
  d.has_passages,
  count(p.id)                as passage_count,
  sum(p.token_count)         as total_tokens,
  min(p.created_at)          as first_embedded_at,
  max(p.created_at)          as last_embedded_at
from documents d
left join passages p on p.document_id = d.id
group by d.id, d.has_passages;

create or replace view tool_call_costs as
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
from tool_calls tc
left join llm_calls lc on lc.tool_call_id = tc.id
group by tc.id, tc.trace_id, tc.tool_name, tc.duration_ms, tc.total_cost_usd, tc.started_at;
