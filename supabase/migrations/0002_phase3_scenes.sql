-- Phase 3 — Visual Composition Engine
--
-- Additive migration. Creates the `scenes` table that the new
-- compose_visual_scene tool optionally persists to. Phase 3 keeps scenes
-- primarily in client memory; persistence is a defensive nice-to-have so
-- that Phase 4 / 5 can support reload and cross-session continuity.
--
-- This migration:
--   - DOES NOT modify `files`, `sessions`, `messages`, `charts`,
--     `dashboards`, `documents`, or any existing table.
--   - DOES NOT remove or rename any column.
--   - Is safe to re-run (`if not exists` everywhere).
--
-- RLS: enabled with no policies. Same convention as the `documents` table
-- — service-role API access only, anon key denied via PostgREST. The API
-- routes enforce per-user filtering.

create extension if not exists "pgcrypto";

create table if not exists public.scenes (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid references public.sessions(id) on delete cascade,
  document_id  uuid references public.documents(id) on delete set null,
  user_id      text not null,
  title        text not null,
  layout       text not null,                       -- spotlight | grid | split | stack | dashboard
  fragments    jsonb not null default '[]'::jsonb,
  caption      text,
  confidence   numeric,
  drilldowns   jsonb default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idx_scenes_session_id  on public.scenes (session_id);
create index if not exists idx_scenes_document_id on public.scenes (document_id);
create index if not exists idx_scenes_user_id     on public.scenes (user_id);
create index if not exists idx_scenes_created_at  on public.scenes (created_at desc);

-- Enable RLS. No policies declared → anon key is denied; service role bypasses.
alter table public.scenes enable row level security;
