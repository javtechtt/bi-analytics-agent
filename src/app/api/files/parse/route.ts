/**
 * /api/files/parse — file ingestion endpoint.
 *
 * Phase 2 update:
 *   - Persists a `documents` row server-side for every successful parse.
 *     The documentId is generated here and returned in the response so
 *     the client can store it on UploadedFile and the voice agent can
 *     resolve queries via filename → documentId.
 *   - Strips server-only fields (`extraction.pageTexts`) from the JSON
 *     response — raw page text never leaves the server.
 *   - Documents row write is non-blocking: if it fails (e.g. no active
 *     session), the parse still returns 200 with the extraction. We log
 *     and continue so transient persistence failures don't break uploads.
 *
 * Phase 1 contract preserved exactly:
 *   - Response still includes `{ text, summary, parsedData, extraction, classification }`.
 *   - Extension allow-list, 50 MB cap, 422 Excel error, 413 size error all unchanged.
 */

import { auth } from "@clerk/nextjs/server";
import {
  universalParse,
  UnsupportedDocumentTypeError,
} from "@/lib/ingestion/universal-parser";
import {
  saveDocument,
  stripServerOnlyFields,
  findActiveSessionId,
} from "@/lib/documents/store";
import { embedDocument } from "@/lib/retrieval/embed";
import { withTrace } from "@/lib/telemetry/trace";
import { emitProgress } from "@/lib/telemetry/progress";

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = [".csv", ".xlsx", ".xls", ".pdf"];

function hasSupportedExtension(lowerName: string): boolean {
  return SUPPORTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Phase 9 — client may pass a trace_id so it can poll
  // /api/tools/progress/[traceId] while we parse. Without one, this still
  // works — emitProgress just no-ops because the trace context has no
  // traceId to tag rows with. Same convention the tools/execute route uses.
  const incomingTraceId = request.headers.get("x-trace-id") ?? undefined;

  return await withTrace({ traceId: incomingTraceId, userId }, async () => {
  try {
    emitProgress("phase", "Reading file…");
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return Response.json(
        { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 50 MB.` },
        { status: 413 }
      );
    }

    const lowerName = file.name.toLowerCase();
    if (!hasSupportedExtension(lowerName)) {
      return Response.json(
        { error: "Unsupported file type. Supported: CSV, Excel (.xlsx/.xls), PDF." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Pre-allocate the documentId so the extraction object carries it.
    const documentId = crypto.randomUUID();

    emitProgress("phase", `Analyzing ${file.name}…`);
    let result;
    try {
      result = await universalParse({
        buffer,
        fileName: file.name,
        mime: file.type,
        size: file.size,
        documentId,
      });
    } catch (innerErr) {
      if (
        (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) &&
        !(innerErr instanceof UnsupportedDocumentTypeError)
      ) {
        console.error("[files/parse] Excel parse error:", innerErr);
        return Response.json(
          { error: "Could not read Excel file — it may be corrupted or password-protected." },
          { status: 422 }
        );
      }

      if (innerErr instanceof UnsupportedDocumentTypeError) {
        return Response.json({ error: innerErr.message }, { status: 400 });
      }

      throw innerErr;
    }

    emitProgress("phase", "Saving document…");
    // Persist documents row — non-blocking on failure.
    try {
      const sessionId = await findActiveSessionId(userId);
      await saveDocument({
        documentId,
        userId,
        sessionId,
        fileId: null,                     // linked later when /api/workspace/files inserts the file row
        fileName: file.name,
        extraction: result.extraction,
      });
    } catch (persistErr) {
      console.warn(
        `[files/parse] Documents persistence failed for ${file.name}:`,
        persistErr instanceof Error ? persistErr.message : persistErr
      );
      // Continue — the in-memory cache from saveDocument may or may not have populated;
      // query_document can still work via the response shape the client holds.
    }

    // Phase 1 + Phase 2: embed any document that has pageTexts, regardless
    // of Tier 2's type classification. The capability (extracted narrative
    // content) matters, not the label. This prevents the "Tier 2 reclassified
    // vision output as table_pdf so we skipped embedding" bug.
    let hasPassages = false;
    if (
      result.extraction.pageTexts &&
      result.extraction.pageTexts.length > 0
    ) {
      try {
        emitProgress(
          "phase",
          `Embedding ${result.extraction.pageTexts.length} pages for retrieval…`
        );
        const embedResult = await embedDocument({
          documentId,
          userId,
          extraction: result.extraction,
        });
        hasPassages = true;
        console.log(
          `[files/parse] ${file.name} embedded: ${embedResult.passageCount} passages, ${embedResult.totalTokens} tokens, ${embedResult.durationMs}ms`
        );
      } catch (embedErr) {
        emitProgress("warn", "Embedding failed — falling back to legacy query path.");
        console.warn(
          `[files/parse] Embedding failed for ${file.name} (legacy query_document will serve this doc):`,
          embedErr instanceof Error ? embedErr.message : embedErr
        );
      }
    }
    emitProgress("phase", "Done.");

    console.log(
      `[files/parse] ${file.name} → ${result.parsedData.columns.length} cols, ` +
      `${result.parsedData.totalRows} rows ` +
      `(type=${result.classification.type}, method=${result.extraction.extractionMethod}, ` +
      `conf=${result.extraction.confidence.toFixed(2)}, docId=${documentId})`
    );

    return Response.json({
      text: result.text,
      summary: result.summary,
      parsedData: result.parsedData,
      extraction: stripServerOnlyFields(result.extraction),    // pageTexts removed
      classification: result.classification,
      documentId,
      hasPassages,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parse failed";
    console.error("[files/parse] Error:", message);
    emitProgress("warn", `Parse failed: ${message}`);
    return Response.json({ error: `Failed to parse file: ${message}` }, { status: 500 });
  }
  });
}
