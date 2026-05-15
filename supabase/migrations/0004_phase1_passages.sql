-- Phase 1 — RAG Foundation
--
-- Enables pgvector and creates the `passages` table that backs all
-- retrieval-augmented Q&A. Adds a per-document feature flag (`has_passages`)
-- so the realtime routing layer can decide whether to use the new
-- `query_document_v2` tool or fall back to the legacy `query_document`.
--
-- This migration is ADDITIVE:
--   - DOES NOT modify the existing documents, scenes, files, sessions,
--     messages, charts, or dashboards tables.
--   - DOES NOT alter the legacy extraction.facts cache — it stays valid
--     for documents that haven't been embedded yet.
--   - Old uploads route through legacy query_document until backfilled.
--
-- RLS: enabled with no policies. Same convention as the rest of the schema —
-- only the service-role client (used by API routes + scripts) can read/write.
-- The anon key is denied, which is what keeps user data isolated since
-- NEXT_PUBLIC_SUPABASE_ANON_KEY ships to browsers.

create extension if not exists vector;
create extension if not exists "pgcrypto";

-- ── passages ─────────────────────────────────────────────

create table if not exists public.passages (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.documents(id) on delete cascade,
  user_id       text not null,                    -- denormalized for fast user-scoped filtering
  chunk_index   integer not null,                 -- 0-based ordering within the document
  page_start    integer,                          -- 1-based; null if unknown
  page_end      integer,                          -- inclusive; null if unknown
  text          text not null,                    -- the verbatim chunk text (passages can quote each other but here we store source verbatim)
  heading       text,                             -- nearest containing heading from the parsed Markdown, if any
  char_offset   integer,                          -- byte offset within the full document text — used to reassemble original order
  token_count   integer,                          -- approximate token count for the chunk
  embedding     vector(1536) not null,            -- text-embedding-3-small dimensions
  created_at    timestamptz not null default now(),
  unique (document_id, chunk_index)
);

-- Standard btree lookups
create index if not exists idx_passages_document_id on public.passages (document_id);
create index if not exists idx_passages_user_id     on public.passages (user_id);

-- HNSW vector index for cosine distance. HNSW gives much better recall
-- than ivfflat at our scale (10s to 1000s of passages per document).
-- m=16, ef_construction=64 are the safer defaults; can tune up if recall
-- on niche jargon underperforms after Phase 1 dogfood.
create index if not exists idx_passages_embedding
  on public.passages
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

alter table public.passages enable row level security;

-- ── documents.has_passages feature flag ──────────────────

alter table public.documents
  add column if not exists has_passages boolean not null default false;

create index if not exists idx_documents_has_passages
  on public.documents (has_passages)
  where has_passages = true;

-- ── Retrieval RPC ────────────────────────────────────────
--
-- Cosine-distance lookup scoped to a single document. Returns the top-k
-- passages ordered by similarity. Uses the HNSW index automatically.
-- Note: pgvector's <=> operator is cosine DISTANCE (0 = identical, 2 = opposite).
-- We expose similarity = 1 - distance for caller-friendly scoring.

create or replace function public.match_passages(
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
language sql
stable
as $$
  select
    p.id           as passage_id,
    p.chunk_index,
    p.page_start,
    p.page_end,
    p.text,
    p.heading,
    1 - (p.embedding <=> p_query_embedding)::double precision as similarity
  from public.passages p
  where p.document_id = p_document_id
    and p.user_id     = p_user_id
  order by p.embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- ── Helper view: per-document passage stats ──────────────

create or replace view public.document_passage_stats as
select
  d.id                       as document_id,
  d.has_passages,
  count(p.id)                as passage_count,
  sum(p.token_count)         as total_tokens,
  min(p.created_at)          as first_embedded_at,
  max(p.created_at)          as last_embedded_at
from public.documents d
left join public.passages p on p.document_id = d.id
group by d.id, d.has_passages;
