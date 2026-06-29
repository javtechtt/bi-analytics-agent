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

import { getSql, toJsonb } from "@/lib/db";
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
  const sql = getSql();
  const { documentId, userId, sessionId, fileId, fileName, extraction } = input;

  try {
    // Idempotent on the documentId PK. On conflict we update everything
    // EXCEPT has_passages, so re-saving an extraction never clears the
    // embedding flag the retrieval layer set.
    await sql`
      insert into documents (
        id, file_id, session_id, user_id, type, subtype, language,
        classifier_confidence, status, extraction, overall_confidence,
        grounding_ratio, error
      ) values (
        ${documentId}, ${fileId}, ${sessionId}, ${userId}, ${extraction.type},
        ${extraction.subtype ?? null}, ${extraction.language},
        ${extraction.classifierConfidence}, 'ready',
        ${toJsonb({ ...extraction, documentId, sourceFileName: fileName })}::jsonb,
        ${extraction.confidence}, ${extraction.groundingRatio}, ${null}
      )
      on conflict (id) do update set
        file_id = excluded.file_id,
        session_id = excluded.session_id,
        user_id = excluded.user_id,
        type = excluded.type,
        subtype = excluded.subtype,
        language = excluded.language,
        classifier_confidence = excluded.classifier_confidence,
        status = excluded.status,
        extraction = excluded.extraction,
        overall_confidence = excluded.overall_confidence,
        grounding_ratio = excluded.grounding_ratio,
        error = excluded.error
    `;
  } catch (err) {
    console.error("[documents/store] save error:", err);
    throw new Error(
      `Failed to save document: ${err instanceof Error ? err.message : String(err)}`
    );
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

  const sql = getSql();
  const rows = (await sql`
    select id, file_id, session_id, user_id, extraction
    from documents
    where id = ${documentId} and user_id = ${userId}
    limit 1
  `) as Array<{
    id: string;
    file_id: string | null;
    session_id: string | null;
    user_id: string;
    extraction: unknown;
  }>;
  const data = rows[0];
  if (!data) return null;

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

  const sql = getSql();
  type Row = {
    id: string;
    file_id: string | null;
    session_id: string | null;
    user_id: string;
    extraction: unknown;
  };
  let data: Row[];
  try {
    data = (await sql`
      select id, file_id, session_id, user_id, extraction
      from documents
      where user_id = ${userId}
      order by created_at desc
      limit 50
    `) as Row[];
  } catch {
    return null;
  }
  if (!data || data.length === 0) return null;
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
  const sql = getSql();
  const cached = memCache.get(documentId);

  try {
    await sql`
      update documents set
        extraction = ${toJsonb({
          ...next,
          documentId,
          sourceFileName: cached?.fileName ?? "(unknown)",
        })}::jsonb,
        overall_confidence = ${next.confidence},
        grounding_ratio = ${next.groundingRatio},
        status = 'ready'
      where id = ${documentId} and user_id = ${userId}
    `;
  } catch (err) {
    console.error("[documents/store] update error:", err);
    throw new Error(
      `Failed to update document: ${err instanceof Error ? err.message : String(err)}`
    );
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
  const sql = getSql();
  const rows = (await sql`
    select id from sessions
    where user_id = ${userId} and is_active = true
    order by updated_at desc
    limit 1
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}
