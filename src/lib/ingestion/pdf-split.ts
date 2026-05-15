/**
 * Phase 4: PDF page splitter.
 *
 * Splits a PDF buffer into a series of smaller PDFs, each containing a
 * contiguous page range. Used by the vision adapter to bypass OpenAI's
 * ~256k input-token limit on full-PDF file inputs — a 364-page annual
 * report becomes 5 chunks of ≤80 pages each.
 *
 * Pure JS via `pdf-lib`. No native deps. Streams pages by reference where
 * possible, so memory usage stays proportional to a single chunk, not the
 * whole document.
 *
 * Returned chunks are self-contained PDFs (re-uploadable to OpenAI), each
 * tagged with its starting page number relative to the original document
 * so the vision adapter can stitch results back together with correct page
 * markers.
 */

import { PDFDocument } from "pdf-lib";

export interface PdfChunk {
  /** Bytes of the chunk PDF — uploadable to OpenAI Files API. */
  buffer: Buffer;
  /** Page number in the ORIGINAL document where this chunk starts (1-indexed). */
  startPage: number;
  /** Page number in the ORIGINAL document where this chunk ends (1-indexed, inclusive). */
  endPage: number;
  /** Number of pages in this chunk. */
  pageCount: number;
}

export interface SplitOptions {
  /** Target pages per chunk. */
  pagesPerChunk: number;
  /** Hard cap on number of chunks produced. Pages beyond this are dropped
   *  with a warning. Default 12 — at 80 pages/chunk that handles ~960 pages. */
  maxChunks?: number;
}

const DEFAULT_MAX_CHUNKS = 12;

/**
 * Split a PDF buffer into N-page chunks.
 *
 * For a 236-page PDF with pagesPerChunk=80 → 3 chunks:
 *   { startPage: 1,   endPage: 80,  pageCount: 80 }
 *   { startPage: 81,  endPage: 160, pageCount: 80 }
 *   { startPage: 161, endPage: 236, pageCount: 76 }
 *
 * If the PDF fits in a single chunk (pageCount <= pagesPerChunk), returns
 * a single chunk identical to the input.
 */
export async function splitPdf(
  buffer: Buffer,
  opts: SplitOptions
): Promise<PdfChunk[]> {
  const { pagesPerChunk } = opts;
  const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;

  if (pagesPerChunk <= 0) {
    throw new Error("splitPdf: pagesPerChunk must be > 0");
  }

  const source = await PDFDocument.load(buffer, { ignoreEncryption: false });
  const totalPages = source.getPageCount();

  // Fast path: no splitting needed.
  if (totalPages <= pagesPerChunk) {
    return [
      {
        buffer,
        startPage: 1,
        endPage: totalPages,
        pageCount: totalPages,
      },
    ];
  }

  const chunks: PdfChunk[] = [];
  let chunkIdx = 0;
  for (let start = 1; start <= totalPages; start += pagesPerChunk) {
    if (chunkIdx >= maxChunks) {
      console.warn(
        `[pdf-split] hit maxChunks=${maxChunks}; dropping pages ${start}-${totalPages}`
      );
      break;
    }
    const end = Math.min(start + pagesPerChunk - 1, totalPages);
    const pageIndices: number[] = [];
    for (let p = start; p <= end; p++) pageIndices.push(p - 1); // 0-indexed for pdf-lib

    const chunkDoc = await PDFDocument.create();
    const copied = await chunkDoc.copyPages(source, pageIndices);
    for (const p of copied) chunkDoc.addPage(p);

    const chunkBytes = await chunkDoc.save({ useObjectStreams: true });
    chunks.push({
      buffer: Buffer.from(chunkBytes),
      startPage: start,
      endPage: end,
      pageCount: end - start + 1,
    });
    chunkIdx++;
  }

  return chunks;
}
