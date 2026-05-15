-- Phase 1 — Universal Document Architecture
--
-- Additive migration. Creates a new `documents` table that lives alongside
-- the existing `files` table. Phase 1 does NOT write to this table yet —
-- Phase 2's extraction service will populate it. The table is created now
-- so the schema is stable end-to-end and Phase 2 can land without further
-- migration work.
--
-- This migration:
--   - DOES NOT modify `files`, `sessions`, `messages`, `charts`,
--     `dashboards`, or any existing table.
--   - DOES NOT remove or rename any column.
--   - Is safe to re-run (`if not exists` everywhere).
--
-- RLS: enabled with no policies. The project's API routes use the
-- service-role Supabase client (see src/lib/supabase/server.ts) which
-- bypasses RLS by design, so API access keeps working. With RLS on and
-- no policies declared, the anon key cannot read or write `documents`
-- directly via PostgREST. Since NEXT_PUBLIC_SUPABASE_ANON_KEY is exposed
-- to browsers, this denial is what keeps the table safe.

create extension if not exists "pgcrypto";

create table if not exists public.documents (
  id                    uuid primary key default gen_random_uuid(),
  file_id               uuid references public.files(id) on delete cascade,
  session_id            uuid references public.sessions(id) on delete cascade,
  user_id               text not null,                    -- Clerk user id (string)
  type                  text not null,                    -- DocumentType enum (see lib/documents/types.ts)
  subtype               text,
  language              text not null default 'en',
  classifier_confidence numeric not null default 0,
  status                text not null default 'ready',    -- pending | classifying | extracting | ready | error
  extraction            jsonb,                            -- DocumentExtraction object
  overall_confidence    numeric not null default 0,
  grounding_ratio       numeric not null default 1,
  error                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_documents_file_id    on public.documents (file_id);
create index if not exists idx_documents_session_id on public.documents (session_id);
create index if not exists idx_documents_user_id    on public.documents (user_id);
create index if not exists idx_documents_type       on public.documents (type);

-- updated_at trigger
create or replace function public.documents_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_documents_updated_at on public.documents;
create trigger trg_documents_updated_at
  before update on public.documents
  for each row execute function public.documents_set_updated_at();

-- Enable RLS. No policies declared → anon key is denied; service role bypasses.
alter table public.documents enable row level security;
