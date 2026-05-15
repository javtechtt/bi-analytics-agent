// ── Database row types ──────────────────────────────────

export interface DbUser {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbSession {
  id: string;
  user_id: string;
  title: string;
  output_mode: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbFile {
  id: string;
  session_id: string;
  user_id: string;
  name: string;
  size: number;
  size_label: string;
  mime_type: string | null;
  status: string;
  storage_path: string | null;
  content: string | null;
  summary: string | null;
  parsed_data: unknown;
  error: string | null;
  created_at: string;
}

export interface DbMessage {
  id: string;
  session_id: string;
  external_id: string;
  role: string;
  content: string;
  timestamp: number;
  created_at: string;
}

export interface DbChart {
  id: string;
  session_id: string;
  external_id: string;
  chart_type: string;
  title: string;
  chart_data: unknown;
  x_label: string | null;
  y_label: string | null;
  series: unknown;
  coverage: string | null;
  data_summary: string | null;
  position: number;
  created_at: string;
}

export interface DbDashboard {
  id: string;
  session_id: string;
  title: string;
  subtitle: string | null;
  kpis: unknown;
  charts: unknown;
  insights: unknown;
  risks: unknown;
  opportunities: unknown;
  drilldowns: unknown;
  created_at: string;
  updated_at: string;
}

/**
 * Phase 1: row type for the new `documents` table. Lives alongside `files`;
 * `file_id` links them. Phase 1 doesn't write rows here yet — Phase 2's
 * extraction service will populate it. Defined now so the schema is typed
 * end-to-end and consumers in later phases can land without further changes.
 */
export interface DbDocument {
  id: string;
  file_id: string | null;
  session_id: string;
  user_id: string;
  type: string;                          // DocumentType (see lib/documents/types.ts)
  subtype: string | null;
  language: string;
  classifier_confidence: number;
  status: string;                        // pending | classifying | extracting | ready | error
  extraction: unknown;                   // DocumentExtraction as JSONB
  overall_confidence: number;
  grounding_ratio: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

// ── Mappers: DB rows → client types ─────────────────────

import type { UploadedFile, ParsedData, Message } from "@/lib/types";
import type { ChartConfig } from "@/lib/useRealtimeSession";

export function dbFileToClient(f: DbFile): UploadedFile {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    sizeLabel: f.size_label,
    type: f.mime_type ?? "",
    status: f.status as "parsing" | "ready" | "error",
    content: f.content ?? undefined,
    summary: f.summary ?? undefined,
    parsedData: f.parsed_data as ParsedData | undefined,
    error: f.error ?? undefined,
  };
}

export function dbMessageToClient(m: DbMessage): Message {
  return {
    id: m.external_id,
    role: m.role as "user" | "assistant",
    content: m.content,
    timestamp: m.timestamp,
  };
}

export function dbChartToClient(c: DbChart): ChartConfig {
  return {
    id: c.external_id,
    chart_type: c.chart_type as ChartConfig["chart_type"],
    title: c.title,
    data: c.chart_data as Array<Record<string, string | number>>,
    x_label: c.x_label ?? undefined,
    y_label: c.y_label ?? undefined,
    series: c.series as string[] | undefined,
    coverage: c.coverage ?? undefined,
    dataSummary: c.data_summary ?? undefined,
  };
}
