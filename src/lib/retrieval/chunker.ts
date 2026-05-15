/**
 * Phase 1: Semantic chunker.
 *
 * Splits a narrative document's per-page text into ~300-token chunks with
 * single-sentence overlap, preserving page boundaries. Each chunk records
 * the page range it covers so retrieval citations resolve back to a page
 * number the user can click through to.
 *
 * v1 limitations (improved in Phase 4 when layout-aware parsing lands):
 *   - Page text is collapsed whitespace (unpdf default), so paragraph
 *     structure isn't preserved. We chunk by sentences instead.
 *   - Heading detection is currently null. Phase 4's Markdown output will
 *     populate it so passages know "Risk Factors" vs "Liquidity" etc.
 *   - Token counting is approximate (chars/4). Good enough for chunk-size
 *     control; the embedding cost is what actually matters and that's
 *     billed by real tokens server-side.
 *
 * Algorithm:
 *   1. Sentence-segment each page (regex on sentence-ending punctuation).
 *   2. Flatten into a stream of (sentence, page) tuples.
 *   3. Greedy fill: start a chunk, add sentences until token budget is
 *      reached, then finalize. The first sentence of chunk N+1 is the
 *      last sentence of chunk N — single-sentence overlap.
 *   4. For each chunk record min/max page numbers and approximate token count.
 */

export interface ChunkInput {
  /** Per-page raw text. Index = pageNum - 1. */
  pageTexts: string[];
}

export interface SemanticChunk {
  /** 0-based ordinal within the document. */
  chunkIndex: number;
  /** Concatenated sentence text — what gets embedded and shown as the cited passage. */
  text: string;
  /** Approximate token count (chars/4). */
  tokenCount: number;
  /** 1-based inclusive page range this chunk spans. */
  pageStart: number;
  pageEnd: number;
  /** Best-effort byte offset within the global concatenated text (chunks may overlap). */
  charOffset: number;
  /** Always null in v1 — populated by Phase 4's layout-aware parser. */
  heading: string | null;
}

const DEFAULT_TARGET_TOKENS = 300;
const DEFAULT_OVERLAP_SENTENCES = 1;
const APPROX_CHARS_PER_TOKEN = 4;

// ── Sentence segmentation (Markdown-aware) ──

interface PageSentence {
  text: string;
  page: number;
  /** Nearest preceding Markdown heading (H1/H2/H3) at the time this sentence appeared. */
  heading: string | null;
}

function splitToSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10 && s.length <= 600);
}

/**
 * Walk per-page text, splitting on paragraph boundaries first (vision output
 * is Markdown so blank lines separate paragraphs), then sentences within
 * each paragraph. Tracks the most recent Markdown heading as each sentence
 * is emitted so chunks inherit section context.
 */
function flattenSentences(pageTexts: string[]): PageSentence[] {
  const out: PageSentence[] = [];
  let currentHeading: string | null = null;
  const headingRe = /^(#{1,3})\s+(.+)$/;

  pageTexts.forEach((pt, idx) => {
    if (!pt) return;
    const page = idx + 1;
    // Split on paragraph boundaries (blank lines). Each paragraph is then
    // either a heading line, a list, a table, or a prose paragraph that
    // gets sentence-split.
    const paragraphs = pt.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);

    for (const para of paragraphs) {
      // Heading line — update context, do NOT emit as a sentence.
      const headingMatch = para.match(headingRe);
      if (headingMatch) {
        currentHeading = headingMatch[2].trim();
        continue;
      }
      // Markdown table or list block — emit as a single "sentence" so the
      // chunker keeps it together instead of fragmenting rows.
      if (/^\|.*\|$/m.test(para) || /^(?:[-*]|\d+\.)\s+/m.test(para)) {
        if (para.length >= 10 && para.length <= 1200) {
          out.push({ text: para.replace(/\s+/g, " "), page, heading: currentHeading });
        }
        continue;
      }
      // Prose paragraph — split into sentences.
      for (const s of splitToSentences(para)) {
        out.push({ text: s, page, heading: currentHeading });
      }
    }
  });

  return out;
}

function approxTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / APPROX_CHARS_PER_TOKEN));
}

// ── Public chunker ───────────────────────────────────────

export interface ChunkerOptions {
  targetTokens?: number;
  overlapSentences?: number;
}

export function semanticChunk(
  input: ChunkInput,
  opts: ChunkerOptions = {}
): SemanticChunk[] {
  const targetTokens = opts.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlapSentences = opts.overlapSentences ?? DEFAULT_OVERLAP_SENTENCES;

  const sentences = flattenSentences(input.pageTexts);
  if (sentences.length === 0) return [];

  const chunks: SemanticChunk[] = [];
  let buffer: PageSentence[] = [];
  let bufferTokens = 0;
  let charOffset = 0;
  let chunkIndex = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.map((s) => s.text).join(" ");
    const pageStart = Math.min(...buffer.map((s) => s.page));
    const pageEnd = Math.max(...buffer.map((s) => s.page));
    // Pick the most common non-null heading among the chunk's sentences.
    // Ties resolved in favor of the first one observed.
    const headingCounts = new Map<string, number>();
    for (const s of buffer) {
      if (s.heading) headingCounts.set(s.heading, (headingCounts.get(s.heading) ?? 0) + 1);
    }
    let heading: string | null = null;
    let bestCount = 0;
    for (const [h, c] of headingCounts) {
      if (c > bestCount) {
        heading = h;
        bestCount = c;
      }
    }
    chunks.push({
      chunkIndex,
      text,
      tokenCount: approxTokens(text),
      pageStart,
      pageEnd,
      charOffset,
      heading,
    });
    chunkIndex++;
    charOffset += text.length;
  };

  for (const sent of sentences) {
    const sentTokens = approxTokens(sent.text);
    // If adding this sentence would exceed the budget AND buffer already has
    // content, finalize the chunk and start a new one (with overlap).
    if (bufferTokens + sentTokens > targetTokens && buffer.length > 0) {
      flush();
      // Carry the last N sentences into the new buffer for overlap.
      const overlap = buffer.slice(-overlapSentences);
      buffer = [...overlap];
      bufferTokens = buffer.reduce((acc, s) => acc + approxTokens(s.text), 0);
    }
    buffer.push(sent);
    bufferTokens += sentTokens;
  }
  flush();

  return chunks;
}

/**
 * Diagnostic: useful when tuning chunk size or debugging coverage gaps.
 */
export function chunkStats(chunks: SemanticChunk[]): {
  count: number;
  avgTokens: number;
  minTokens: number;
  maxTokens: number;
  totalTokens: number;
  pageSpan: { min: number; max: number };
} {
  if (chunks.length === 0) {
    return {
      count: 0, avgTokens: 0, minTokens: 0, maxTokens: 0, totalTokens: 0,
      pageSpan: { min: 0, max: 0 },
    };
  }
  const tokens = chunks.map((c) => c.tokenCount);
  return {
    count: chunks.length,
    avgTokens: Math.round(tokens.reduce((a, b) => a + b, 0) / chunks.length),
    minTokens: Math.min(...tokens),
    maxTokens: Math.max(...tokens),
    totalTokens: tokens.reduce((a, b) => a + b, 0),
    pageSpan: {
      min: Math.min(...chunks.map((c) => c.pageStart)),
      max: Math.max(...chunks.map((c) => c.pageEnd)),
    },
  };
}
