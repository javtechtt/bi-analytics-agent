/**
 * Phase 2: Document store.
 *
 * Two-tier cache for DocumentExtraction objects:
 *   - In-memory (per-server-instance) for hot reads during a session.
 *   - Supabase `documents` table for cross-restart persistence.
 *
 * Important: `extraction.pageTexts` lives in the Supabase JSONB column but
 * is NEVER returned to the browser by the parse route — it's only consumed
 * server-side by the extractor. The store therefore distinguishes between:
 *
 *   - `getDocumentForExtraction(id, userId)` → full extraction WITH pageTexts.
 *     Use when running the LLM extractor.
 *
 *   - `stripServerOnlyFields(extraction)` → safe-for-client copy.
 *     Use before sending to React state or over HTTP.
 *
 * All API access is gated by Clerk user_id at the route layer; the store
 * trusts callers to pass an authenticated user_id.
 */

import { createServerSupabase } from "@/lib/supabase/server";
import type { DocumentExtraction, DocumentType } from "./types";

interface CachedRecord {
  documentId: string;
  userId: string;
  sessionId: string | null;
  fileId: string | null;
  fileName: string;
  type: DocumentType;
  extraction: DocumentExtraction;
  updatedAt: number;
}

const CACHE_TTL_MS = 15 * 60_000; // 15 minutes
const memCache = new Map<string, CachedRecord>();

function isFresh(rec: CachedRecord): boolean {
  return Date.now() - rec.updatedAt < CACHE_TTL_MS;
}

// ── Public API ───────────────────────────────────────────

export interface SaveDocumentInput {
  documentId: string;
  userId: string;
  sessionId: string | null;
  fileId: string | null;
  fileName: string;
  extraction: DocumentExtraction;
}

/**
 * Insert a new documents row. Returns the documentId. Idempotent on
 * documentId — re-saving updates the row (used when extraction completes).
 */
export async function saveDocument(input: SaveDocumentInput): Promise<string> {
  const sb = createServerSupabase();
  const { documentId, userId, sessionId, fileId, fileName, extraction } = input;

  const { error } = await sb
    .from("documents")
    .upsert({
      id: documentId,
      file_id: fileId,
      session_id: sessionId,
      user_id: userId,
      type: extraction.type,
      subtype: extraction.subtype ?? null,
      language: extraction.language,
      classifier_confidence: extraction.classifierConfidence,
      status: "ready",
      extraction: { ...extraction, documentId, sourceFileName: fileName },
      overall_confidence: extraction.confidence,
      grounding_ratio: extraction.groundingRatio,
      error: null,
    });

  if (error) {
    console.error("[documents/store] save error:", error);
    throw new Error(`Failed to save document: ${error.message}`);
  }

  memCache.set(documentId, {
    documentId,
    userId,
    sessionId,
    fileId,
    fileName,
    type: extraction.type,
    extraction,
    updatedAt: Date.now(),
  });

  return documentId;
}

/**
 * Fetch a document including its server-only fields (pageTexts).
 * Authenticated by user_id — returns null if not found OR not owned.
 */
export async function getDocumentForExtraction(
  documentId: string,
  userId: string
): Promise<CachedRecord | null> {
  const cached = memCache.get(documentId);
  if (cached && cached.userId === userId && isFresh(cached)) return cached;

  const sb = createServerSupabase();
  const { data, error } = await sb
    .from("documents")
    .select("id, file_id, session_id, user_id, extraction")
    .eq("id", documentId)
    .eq("user_id", userId)
    .single();

  if (error || !data) return null;

  const extraction = data.extraction as DocumentExtraction & { sourceFileName?: string };
  const record: CachedRecord = {
    documentId: data.id,
    userId: data.user_id,
    sessionId: data.session_id,
    fileId: data.file_id,
    fileName: extraction.sourceFileName ?? "(unknown)",
    type: extraction.type,
    extraction,
    updatedAt: Date.now(),
  };
  memCache.set(documentId, record);
  return record;
}

/**
 * Aggressive normalization for fuzzy filename matching. Strips ALL
 * non-alphanumeric characters (parens, brackets, spaces, hyphens, etc.).
 * Used only as a last-resort fallback when exact/substring matching fails,
 * typically because the agent received a sanitized version of the name.
 */
function fuzzyNameKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.]+/g, "");
}

/**
 * Resolve a documentId by filename within a user's scope. Used by tool
 * handlers when the voice agent passes file_name instead of document_id.
 *
 * Match precedence: exact (case-insensitive) → substring → fuzzy
 * (alphanumeric-only). The fuzzy fallback protects against drift between
 * the persisted name and the name the agent received after sanitization.
 */
export async function findDocumentByFileName(
  fileName: string,
  userId: string
): Promise<CachedRecord | null> {
  const lower = fileName.toLowerCase();
  const fuzzy = fuzzyNameKey(fileName);

  // Search cache first
  for (const rec of memCache.values()) {
    if (rec.userId !== userId || !isFresh(rec)) continue;
    if (rec.fileName.toLowerCase() === lower) return rec;
  }

  const sb = createServerSupabase();
  const { data, error } = await sb
    .from("documents")
    .select("id, file_id, session_id, user_id, extraction")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error || !data) return null;

  type Row = (typeof data)[number];
  const buildRecord = (row: Row, extraction: DocumentExtraction & { sourceFileName?: string }): CachedRecord => ({
    documentId: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    fileId: row.file_id,
    fileName: extraction.sourceFileName ?? "(unknown)",
    type: extraction.type,
    extraction,
    updatedAt: Date.now(),
  });

  // 1. Exact (case-insensitive) match.
  for (const row of data) {
    const extraction = row.extraction as DocumentExtraction & { sourceFileName?: string };
    if (extraction?.sourceFileName?.toLowerCase() === lower) {
      const rec = buildRecord(row, extraction);
      memCache.set(row.id, rec);
      return rec;
    }
  }

  // 2. Substring match (either direction).
  for (const row of data) {
    const extraction = row.extraction as DocumentExtraction & { sourceFileName?: string };
    const name = (extraction?.sourceFileName ?? "").toLowerCase();
    if (!name) continue;
    if (name.includes(lower) || lower.includes(name)) {
      const rec = buildRecord(row, extraction);
      memCache.set(row.id, rec);
      return rec;
    }
  }

  // 3. Fuzzy (alphanumeric-only) match — last resort.
  for (const row of data) {
    const extraction = row.extraction as DocumentExtraction & { sourceFileName?: string };
    const name = extraction?.sourceFileName ?? "";
    if (fuzzyNameKey(name) === fuzzy) {
      const rec = buildRecord(row, extraction);
      memCache.set(row.id, rec);
      return rec;
    }
  }

  return null;
}

/**
 * Update an existing document's extraction (e.g. after lazy facts extraction).
 */
export async function updateDocumentExtraction(
  documentId: string,
  userId: string,
  next: DocumentExtraction
): Promise<void> {
  const sb = createServerSupabase();
  const cached = memCache.get(documentId);

  const { error } = await sb
    .from("documents")
    .update({
      extraction: {
        ...next,
        documentId,
        sourceFileName: cached?.fileName ?? "(unknown)",
      },
      overall_confidence: next.confidence,
      grounding_ratio: next.groundingRatio,
      status: "ready",
    })
    .eq("id", documentId)
    .eq("user_id", userId);

  if (error) {
    console.error("[documents/store] update error:", error);
    throw new Error(`Failed to update document: ${error.message}`);
  }

  if (cached) {
    cached.extraction = next;
    cached.updatedAt = Date.now();
  }
}

/**
 * Strip server-only fields before sending a DocumentExtraction to the
 * client over HTTP. The raw page text and any internal scratch fields
 * stay server-side.
 */
export function stripServerOnlyFields(extraction: DocumentExtraction): DocumentExtraction {
  const { pageTexts: _omit, ...safe } = extraction as DocumentExtraction & { pageTexts?: string[] };
  void _omit;
  return safe;
}

/**
 * Look up the active session id for a user. Mirrors the convention used by
 * /api/workspace/sessions to find the most recently active session. Returns
 * null if the user has no session yet.
 */
export async function findActiveSessionId(userId: string): Promise<string | null> {
  const sb = createServerSupabase();
  const { data } = await sb
    .from("sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}
