/**
 * Phase 2: Vision PDF adapter.
 *
 * Handles multi-column / table-heavy / image-dominant PDFs by leveraging
 * OpenAI's native PDF file-input support in the Chat Completions API.
 * We upload the PDF as a file resource, then ask GPT-4o to convert it to
 * clean Markdown with explicit page markers and table-preserved structure.
 *
 * Why this approach instead of per-page PDF.js + canvas rendering:
 *
 *   - No native dependencies (node-canvas / @napi-rs/canvas have platform-
 *     specific binaries that often break on Windows or in Docker).
 *   - No PDF.js worker setup foot-gun.
 *   - One API call per document instead of N (lower latency).
 *   - The model sees the full document context, so cross-page reading order
 *     (e.g. tables spanning pages) is preserved better.
 *
 * Trade-offs:
 *
 *   - The model's PDF reader is opaque — we trust it to give us reading
 *     order. For most business docs this is fine; the cost of being wrong
 *     is lower-quality Markdown which the chunker can still process.
 *   - Cost is higher than text-layer (≈ $0.03-$0.30 per doc, depending on
 *     page count and content density). The strategy router decides when
 *     that cost is worth paying.
 *   - Very long PDFs (>200 pages) may exceed model context. We log a
 *     warning and accept partial output; Phase 4 will add chunked vision.
 *
 * Output shape matches the existing narrative adapter (DocumentExtraction
 * with pageTexts and "none" tables), so downstream RAG + chunker work
 * unchanged.
 */

import { openai } from "@/lib/openai/client";
import { toFile } from "openai/uploads";
import { instrumented } from "@/lib/telemetry/trace";
import type {
  DocumentExtraction,
  DocumentSection,
} from "@/lib/documents/types";
import type { ClassificationResult } from "../classifier";
import { MODELS } from "@/lib/models";
import { splitPdf } from "../pdf-split";
import { emitProgress } from "@/lib/telemetry/progress";

const VISION_MODEL = MODELS.vision;
const MAX_PREVIEW_CHARS = 8000;

// OpenAI's PDF file-input has a ~256k input-token ceiling. We chunk
// proactively at 80 pages/chunk (~120k tokens — comfortable headroom).
// PDFs at or below this threshold go through a single call (cheaper, lower
// latency). Above it, we split + parallelize.
const VISION_SINGLE_CALL_MAX_PAGES = 80;
const VISION_CHUNK_PAGES = 80;
const VISION_CHUNK_CONCURRENCY = 3;            // parallel vision calls; respects OpenAI tier-1 rate limits
const VISION_HARD_PAGE_CEILING = 1000;          // sanity — past this, refuse rather than blow $$
const VISION_HARD_BYTE_CEILING = 60 * 1024 * 1024; // 60 MB — Files API hard limit-friendly

const VISION_SYSTEM_PROMPT = `You are a PDF-to-Markdown converter. You receive a PDF file and return a single clean Markdown document.

RULES — follow these literally:

1. For EACH page of the source PDF, emit a marker on its own line in this exact format: <<PAGE N>> where N is the 1-indexed page number. Do this BEFORE the content of that page.

2. Preserve reading order. For multi-column layouts, render left column first, then right column (or follow the visual flow the document intends).

3. Render headings with proper Markdown levels (# / ## / ###) based on visual hierarchy.

4. Render TABLES as Markdown tables (| pipe | format |). Tables spanning multiple pages should still be emitted as a single coherent table when possible — preserve column structure across the page break.

5. Render lists as Markdown bullet or numbered lists.

6. STRIP page headers and footers (running titles, page numbers at the bottom).

7. STRIP decorative content (logos, watermarks). Keep figure captions and image alt text when present.

8. Preserve quotes, footnotes (inline as parenthetical), and citations.

9. Do NOT summarize, paraphrase, or invent content. Faithful transcription only.

10. Output STRICTLY the Markdown — no preamble like "Here is the converted document".`;

const VISION_USER_PROMPT = `Convert the attached PDF to clean Markdown following the rules. Remember: emit "<<PAGE N>>" markers before each page's content.`;

export interface VisionPdfAdapterInput {
  buffer: Buffer;
  fileName: string;
  classification: ClassificationResult;
  /** Page count from the strategy router's positional pass; saves a second pdfjs read. */
  pageCount: number;
}

export interface VisionPdfAdapterResult {
  text: string;
  summary: string;
  parsedData: import("@/lib/types").ParsedData;
  extraction: DocumentExtraction;
}

export async function runVisionPdfAdapter(
  input: VisionPdfAdapterInput
): Promise<VisionPdfAdapterResult> {
  const { buffer, fileName, classification, pageCount } = input;

  // Sanity guards — these are truly unreasonable inputs, not the routine
  // "too big for one call" case (Phase 4 splits those).
  if (pageCount > VISION_HARD_PAGE_CEILING) {
    throw new Error(
      `vision-pdf: ${pageCount} pages exceeds hard ceiling of ${VISION_HARD_PAGE_CEILING}`
    );
  }
  if (buffer.length > VISION_HARD_BYTE_CEILING) {
    throw new Error(
      `vision-pdf: ${(buffer.length / 1024 / 1024).toFixed(1)} MB exceeds hard ceiling of ${(VISION_HARD_BYTE_CEILING / 1024 / 1024).toFixed(0)} MB`
    );
  }

  let pageTexts: string[];
  let rawMarkdownLength = 0;

  if (pageCount <= VISION_SINGLE_CALL_MAX_PAGES) {
    // Fast path: one call, no splitting.
    console.log(
      `[vision-pdf] ${fileName}: single-call path (${pageCount} pages, ${(buffer.length / 1024 / 1024).toFixed(1)} MB)`
    );
    emitProgress("phase", `Reading ${pageCount} pages with vision…`);
    const md = await runVisionSingleCall(buffer, fileName, pageCount);
    rawMarkdownLength = md.length;
    pageTexts = splitMarkdownByPage(md, pageCount);
  } else {
    // Chunked path: split, parallelize, stitch.
    console.log(
      `[vision-pdf] ${fileName}: chunked path (${pageCount} pages > ${VISION_SINGLE_CALL_MAX_PAGES}; splitting into ${VISION_CHUNK_PAGES}-page chunks)`
    );
    const chunks = await splitPdf(buffer, { pagesPerChunk: VISION_CHUNK_PAGES });
    console.log(
      `[vision-pdf] ${fileName}: ${chunks.length} chunks (pages: ${chunks.map((c) => `${c.startPage}-${c.endPage}`).join(", ")})`
    );
    emitProgress(
      "phase",
      `Splitting ${pageCount} pages into ${chunks.length} chunks; reading with vision…`
    );

    // Construct a chunk filename that PRESERVES the .pdf extension at the
    // end. The original filename ends in ".pdf" — appending "#p1-80" puts
    // ".pdf" in the middle, which causes OpenAI's Files API to detect MIME
    // type as "None" and reject the chat-completion file_id reference.
    // Fix: strip ".pdf", inject the page-range marker, re-append ".pdf".
    const baseName = fileName.replace(/\.pdf$/i, "");
    const chunkName = (chunk: { startPage: number; endPage: number }) =>
      `${baseName}_p${chunk.startPage}-${chunk.endPage}.pdf`;

    // Run chunks in parallel batches.
    pageTexts = Array.from({ length: pageCount }, () => "");
    for (let i = 0; i < chunks.length; i += VISION_CHUNK_CONCURRENCY) {
      const batch = chunks.slice(i, i + VISION_CHUNK_CONCURRENCY);
      const batchStart = Date.now();
      const results = await Promise.allSettled(
        batch.map((chunk) =>
          runVisionSingleCall(chunk.buffer, chunkName(chunk), chunk.pageCount)
            .then((md) => ({ chunk, md }))
        )
      );
      for (const settled of results) {
        if (settled.status !== "fulfilled") {
          console.warn(`[vision-pdf] chunk failed: ${settled.reason instanceof Error ? settled.reason.message : settled.reason}`);
          continue;
        }
        const { chunk, md } = settled.value;
        rawMarkdownLength += md.length;
        // Markdown's <<PAGE N>> markers are LOCAL to the chunk (1..pageCount).
        // Shift by chunk.startPage - 1 so they land in absolute page slots.
        const local = splitMarkdownByPage(md, chunk.pageCount);
        for (let p = 0; p < local.length; p++) {
          const absoluteIdx = chunk.startPage - 1 + p;
          if (absoluteIdx < pageTexts.length) pageTexts[absoluteIdx] = local[p];
        }
      }
      const batchNum = Math.floor(i / VISION_CHUNK_CONCURRENCY) + 1;
      const totalBatches = Math.ceil(chunks.length / VISION_CHUNK_CONCURRENCY);
      const batchSecs = ((Date.now() - batchStart) / 1000).toFixed(1);
      console.log(
        `[vision-pdf] ${fileName}: batch ${batchNum}/${totalBatches} done in ${batchSecs}s`
      );
      // Surface chunk progress to the upload UI. Use absolute chunk count
      // (out of N total chunks) — clearer than "batch X of Y" when the
      // user is staring at the upload spinner.
      const chunksProcessed = Math.min(i + batch.length, chunks.length);
      emitProgress(
        "info",
        `Read ${chunksProcessed}/${chunks.length} chunks (${batchSecs}s)…`
      );
    }
  }

  const sections = buildSections(pageTexts.join("\n\n"), pageTexts);
  const filledPages = pageTexts.filter((p) => p.length > 0).length;
  console.log(
    `[vision-pdf] ${fileName}: parsed ${filledPages}/${pageCount} pages of Markdown (${rawMarkdownLength} chars total)`
  );

  // If literally nothing came back (e.g. all chunks rejected, model produced
  // empty content, etc.), throw so the universal parser falls back to the
  // text-layer narrative adapter. Persisting an empty vision-ocr extraction
  // would set has_passages=false and silently regress the doc to legacy
  // query_document, which is the exact failure mode we just fixed.
  if (filledPages === 0) {
    throw new Error(
      `vision-pdf: ${fileName}: all ${pageCount} pages came back empty — no usable content extracted`
    );
  }

  const previewText = buildPreview(pageTexts);
  const totalChars = pageTexts.reduce((acc, p) => acc + p.length, 0);
  const summary = `${fileName} — ${classification.type} (${pageCount} pages, ${totalChars.toLocaleString()} chars, vision-parsed)`;

  const warnings: string[] = [];
  const blankPages = pageCount - filledPages;
  if (blankPages > pageCount * 0.2) {
    warnings.push(`${blankPages} of ${pageCount} pages came back empty — vision parse may be incomplete.`);
  }

  const extraction: DocumentExtraction = {
    documentId: "",                              // stamped by caller
    type: classification.type,
    subtype: classification.subtype,
    language: classification.language,
    sections,
    pageTexts,
    tables: [],
    facts: [],
    metrics: [],
    entities: [],
    timeline: [],
    spans: {},
    confidence: 0.65,
    groundingRatio: 1.0,
    classifierConfidence: classification.confidence,
    extractionMethod: "vision-ocr",
    pageCount,
    warnings,
  };

  const parsedData = {
    columns: [],
    columnTypes: {} as Record<string, "numeric" | "text" | "date">,
    rows: [],
    totalRows: 0,
    extractionMethod: "none" as const,
  };

  return {
    text: `File: ${fileName}\nType: ${classification.type}\nPages: ${pageCount}\nParsed via: vision\n\nPreview:\n${previewText}`,
    summary,
    parsedData,
    extraction,
  };
}

/**
 * Run one vision call on a PDF buffer. Returns raw Markdown.
 * Used by both the single-call fast path and each chunk of the chunked path.
 */
async function runVisionSingleCall(
  buffer: Buffer,
  label: string,
  pageCount: number
): Promise<string> {
  const client = openai("vision");
  console.log(
    `[vision-pdf] ${label}: uploading ${(buffer.length / 1024 / 1024).toFixed(2)} MB (${pageCount} pages)`
  );
  const file = await client.files.create({
    file: await toFile(buffer, label, { type: "application/pdf" }),
    purpose: "user_data",
  });
  try {
    const completion = await instrumented(
      "vision_pdf_to_markdown",
      VISION_MODEL,
      () =>
        client.chat.completions.create({
          model: VISION_MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: VISION_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                ({ type: "file", file: { file_id: file.id } } as unknown) as
                  | { type: "text"; text: string }
                  | { type: "image_url"; image_url: { url: string } },
                { type: "text", text: VISION_USER_PROMPT },
              ],
            },
          ],
        }),
      { promptChars: VISION_SYSTEM_PROMPT.length + VISION_USER_PROMPT.length }
    );
    const markdown = completion.choices[0]?.message.content ?? "";
    if (!markdown) throw new Error(`vision-pdf: ${label} returned empty content`);
    return markdown;
  } finally {
    await client.files.delete(file.id).catch((err) => {
      console.warn(
        `[vision-pdf] failed to delete uploaded file ${file.id}: ${err instanceof Error ? err.message : err}`
      );
    });
  }
}

// ── Markdown post-processing ─────────────────────────────

/**
 * Split a Markdown blob into per-page chunks based on `<<PAGE N>>` markers.
 * If markers are missing or inconsistent, returns a single-page array with
 * all content on page 1 (better than throwing).
 */
function splitMarkdownByPage(markdown: string, pageCount: number): string[] {
  const pages: string[] = Array.from({ length: pageCount }, () => "");
  const pattern = /<<PAGE\s+(\d+)\s*>>/gi;

  let match: RegExpExecArray | null;
  let lastIdx = 0;
  let lastPage = -1;

  while ((match = pattern.exec(markdown)) !== null) {
    if (lastPage >= 0) {
      const slice = markdown.slice(lastIdx, match.index).trim();
      if (lastPage >= 0 && lastPage < pages.length) pages[lastPage] = slice;
    }
    lastPage = parseInt(match[1], 10) - 1;
    lastIdx = match.index + match[0].length;
  }
  if (lastPage >= 0 && lastPage < pages.length) {
    pages[lastPage] = markdown.slice(lastIdx).trim();
  }

  // Fallback: if NO markers found, put everything on page 1.
  if (pages.every((p) => p.length === 0) && markdown.trim().length > 0) {
    pages[0] = markdown.trim();
  }

  return pages;
}

/**
 * Derive document sections from the Markdown by walking the heading tree.
 * Phase 2 v1 keeps this lightweight — one section per top-level heading.
 * Phase 5 (entities) and Phase 6 (reasoning) consume sections for
 * cross-section answers, so getting a reasonable section list out now pays
 * off later.
 */
function buildSections(markdown: string, pageTexts: string[]): DocumentSection[] {
  const sections: DocumentSection[] = [];
  // Find all H1/H2 headings and their content up to the next H1/H2.
  const headingRe = /^(#{1,2})\s+(.+)$/gm;
  let lastIdx = 0;
  let lastHeading: string | null = null;
  let lastPage: number | undefined;

  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(markdown)) !== null) {
    if (lastHeading !== null) {
      const text = markdown.slice(lastIdx, match.index).trim();
      if (text.length > 0) {
        sections.push({
          id: `section_${sections.length}`,
          heading: lastHeading,
          text,
          page: lastPage,
        });
      }
    }
    lastHeading = match[2].trim();
    lastIdx = match.index + match[0].length;
    lastPage = guessPageForOffset(match.index, markdown, pageTexts);
  }
  if (lastHeading !== null) {
    const text = markdown.slice(lastIdx).trim();
    if (text.length > 0) {
      sections.push({
        id: `section_${sections.length}`,
        heading: lastHeading,
        text,
        page: lastPage,
      });
    }
  }
  return sections;
}

function guessPageForOffset(offset: number, markdown: string, pageTexts: string[]): number | undefined {
  // Find the nearest preceding <<PAGE N>> marker.
  const before = markdown.slice(0, offset);
  const matches = [...before.matchAll(/<<PAGE\s+(\d+)\s*>>/gi)];
  if (matches.length === 0) {
    // No marker yet — assume page 1 (or unknown).
    return pageTexts.length > 0 ? 1 : undefined;
  }
  return parseInt(matches[matches.length - 1][1], 10);
}

function buildPreview(pageTexts: string[]): string {
  const joined = pageTexts.filter((p) => p.length > 0).join("\n\n");
  return joined.length <= MAX_PREVIEW_CHARS
    ? joined
    : joined.slice(0, MAX_PREVIEW_CHARS) + `\n\n[...truncated]`;
}
