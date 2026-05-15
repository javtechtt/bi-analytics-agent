/**
 * Phase 2: Narrative adapter.
 *
 * Handles native-text PDFs that are NOT primarily tables — contracts,
 * reports, memos, policies, financial statements. The pipeline:
 *
 *   1. Use unpdf to extract per-page text (text layer only — no OCR).
 *   2. Heuristically detect sections within each page (numbered headings,
 *      ALL-CAPS titles, "Section X" patterns).
 *   3. Return a DocumentExtraction with:
 *        - `sections`     populated from the heuristic detector
 *        - `pageTexts`    full per-page text for the lazy extractor
 *        - `facts`/`metrics`/`entities`/`timeline` EMPTY — populated
 *          on first `query_document` call via the extractor service.
 *
 * No LLM call happens here. Upload stays fast. Heavy schema-guided
 * extraction is deferred until the user actually asks a question.
 */

import type {
  DocumentExtraction,
  DocumentSection,
} from "@/lib/documents/types";
import type { ClassificationResult } from "../classifier";

const MAX_PREVIEW_CHARS = 8000;

export interface NarrativeAdapterInput {
  buffer: Buffer;
  fileName: string;
  classification: ClassificationResult;
}

export interface NarrativeAdapterResult {
  /** Truncated preview shown in the file panel — NOT sent to the voice model. */
  text: string;
  summary: string;
  /** Stub ParsedData — narrative docs don't have rows/columns. Kept so the
   *  legacy parse-route response shape is preserved for clients that
   *  destructure it. */
  parsedData: import("@/lib/types").ParsedData;
  extraction: DocumentExtraction;
}

// ── PDF text extraction ──────────────────────────────────

async function extractPageTexts(buffer: Buffer): Promise<{
  pages: string[];
  pageCount: number;
}> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const pageCount = pdf.numPages;
  const pages: string[] = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push(text);
  }

  await pdf.destroy();
  return { pages, pageCount };
}

// ── Section detection (heuristic) ────────────────────────

const HEADING_PATTERNS: RegExp[] = [
  /^(?:section|article|chapter|part)\s+[ivxlcdm0-9]+/i,    // "Section 1", "Article IV"
  /^\d+(\.\d+)*\s+[A-Z]/,                                   // "1.2 Definitions"
  /^[A-Z][A-Z\s]{4,60}$/,                                   // "TERMS AND CONDITIONS"
  /^(introduction|overview|summary|background|scope|definitions|terms|conditions|risks|obligations|payment|termination|signatures)[.:\s]?$/i,
];

function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 100) return false;
  return HEADING_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Build sections from the per-page text. For each page, scan the first
 * few lines to find a heading; if none is found, the page itself becomes
 * one "Page N" section. Cheap, deterministic, good enough for Phase 2.
 */
function detectSections(pageTexts: string[]): DocumentSection[] {
  const sections: DocumentSection[] = [];
  pageTexts.forEach((pageText, idx) => {
    const page = idx + 1;
    if (!pageText) return;

    const lines = pageText
      .split(/(?<=[.!?])\s+(?=[A-Z])/)
      .map((s) => s.trim())
      .filter(Boolean);

    // Find the first plausible heading in the first ~8 lines
    let heading: string | null = null;
    for (const line of lines.slice(0, 8)) {
      if (looksLikeHeading(line)) {
        heading = line.length > 80 ? line.slice(0, 80) + "…" : line;
        break;
      }
    }

    sections.push({
      id: `section_p${page}`,
      heading: heading ?? `Page ${page}`,
      text: pageText,
      page,
    });
  });
  return sections;
}

// ── Summary / preview ────────────────────────────────────

function buildPreview(pageTexts: string[]): string {
  const joined = pageTexts.join("\n\n").slice(0, MAX_PREVIEW_CHARS);
  return joined.length === MAX_PREVIEW_CHARS
    ? joined + `\n\n[...truncated]`
    : joined;
}

// ── Public adapter API ───────────────────────────────────

export async function runNarrativeAdapter(
  input: NarrativeAdapterInput
): Promise<NarrativeAdapterResult> {
  const { buffer, fileName, classification } = input;

  if (!fileName.toLowerCase().endsWith(".pdf")) {
    throw new Error(
      `Narrative adapter currently only supports native-text PDFs. Got: ${fileName}`
    );
  }

  const { pages, pageCount } = await extractPageTexts(buffer);

  if (pages.every((p) => !p)) {
    // Empty text layer — this is likely a scanned PDF. Phase 5 (OCR) territory.
    throw new Error(
      "PDF has no extractable text layer — likely a scanned document. OCR support is not yet available."
    );
  }

  const sections = detectSections(pages);
  const previewText = buildPreview(pages);
  const totalChars = pages.reduce((sum, p) => sum + p.length, 0);

  const summary = `${fileName} — ${classification.type} (${pageCount} pages, ${totalChars.toLocaleString()} chars)`;

  const extraction: DocumentExtraction = {
    documentId: "",                              // stamped by caller
    type: classification.type,
    subtype: classification.subtype,
    language: classification.language,
    sections,
    pageTexts: pages,                            // server-side only — stripped before client response
    tables: [],
    facts: [],                                   // populated lazily by query_document
    metrics: [],
    entities: [],
    timeline: [],
    spans: {},
    confidence: 0.4,                             // narrative is inherently more uncertain than tabular
    groundingRatio: 1.0,                         // no facts yet, vacuously grounded
    classifierConfidence: classification.confidence,
    extractionMethod: "narrative-pdf",
    pageCount,
    warnings: [],
  };

  // Phase 2 keeps the legacy parsedData stub so /api/files/parse's
  // response shape doesn't break for clients that destructure it.
  const parsedData = {
    columns: [],
    columnTypes: {} as Record<string, "numeric" | "text" | "date">,
    rows: [],
    totalRows: 0,
    extractionMethod: "none" as const,
  };

  return {
    text: `File: ${fileName}\nType: ${classification.type}\nPages: ${pageCount}\n\nPreview:\n${previewText}`,
    summary,
    parsedData,
    extraction,
  };
}
