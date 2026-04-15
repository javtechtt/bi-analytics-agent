-- BI Analytics Agent — Supabase Schema
-- Run this in the Supabase SQL Editor to set up the database.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users (synced from Clerk on first API call)
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  display_name TEXT,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

-- Sessions (analysis sessions = files + messages + charts + dashboard)
CREATE TABLE sessions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT 'Untitled Session',
  output_mode  TEXT NOT NULL DEFAULT 'executive',
  is_active    BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_sessions_user ON sessions(user_id, updated_at DESC);

-- Files (metadata + parsedData in JSONB, blob in Supabase Storage)
CREATE TABLE files (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  size_label   TEXT NOT NULL,
  mime_type    TEXT,
  status       TEXT NOT NULL DEFAULT 'ready',
  storage_path TEXT,
  content      TEXT,
  summary      TEXT,
  parsed_data  JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_files_session ON files(session_id);
CREATE INDEX idx_files_user ON files(user_id);

-- Messages (conversation transcript)
CREATE TABLE messages (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  timestamp    BIGINT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);

-- Charts
CREATE TABLE charts (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  chart_type   TEXT NOT NULL,
  title        TEXT NOT NULL,
  chart_data   JSONB NOT NULL,
  x_label      TEXT,
  y_label      TEXT,
  series       JSONB,
  coverage     TEXT,
  data_summary TEXT,
  position     INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_charts_session ON charts(session_id);

-- Dashboards (one per session max)
CREATE TABLE dashboards (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id    UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  kpis          JSONB NOT NULL DEFAULT '[]',
  charts        JSONB NOT NULL DEFAULT '[]',
  insights      JSONB NOT NULL DEFAULT '[]',
  risks         JSONB NOT NULL DEFAULT '[]',
  opportunities JSONB NOT NULL DEFAULT '[]',
  drilldowns    JSONB DEFAULT '[]',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id)
);

-- RLS enabled (all access via service role in API routes)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE charts ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboards ENABLE ROW LEVEL SECURITY;
