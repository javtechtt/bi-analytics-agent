/**
 * Phase 2: PDF parsing strategy router.
 *
 * Decides per-PDF whether the existing text-layer adapter (fast, free) or
 * the new vision adapter (slow, costs ~$0.03-0.30 per doc, much higher
 * fidelity on multi-column / table-heavy / image-heavy layouts) should run.
 *
 * Routing heuristics (all derived from positional text-layer data we'd
 * extract anyway):
 *
 *   - LOW TEXT DENSITY: average chars per page < 800.
 *     Suggests scanned content or image-heavy report where text-layer
 *     extraction grabs only labels/captions and misses body.
 *
 *   - MULTI-COLUMN: at least 30% of pages have ≥2 strong x-position
 *     clusters covering ≥70% of items. Multi-column reading order is
 *     mangled by text-layer flattening; vision sees the columns visually.
 *
 *   - VERY SPARSE: < 30 text items per page on average.
 *     Hints at image-dominant or scanned pages.
 *
 * Env override (testing/debug):
 *   PARSING_STRATEGY=vision  → force vision regardless of heuristics
 *   PARSING_STRATEGY=text    → force text-layer regardless
 *   (unset / "auto")         → use heuristics
 *
 * Returns the decision PLUS the positional items (so the chosen adapter
 * can reuse them and avoid a second pdfjs parse).
 */

export interface PdfStrategyDecision {
  strategy: "text" | "vision";
  pageCount: number;
  /** Human-readable reasons for the decision — surfaces in telemetry. */
  reasons: string[];
  /** Per-page metrics computed during analysis. */
  metrics: {
    avgCharsPerPage: number;
    avgItemsPerPage: number;
    multiColumnRatio: number;
  };
  /** Cached positional items so the chosen adapter doesn't re-parse the PDF. */
  positionedItems: PositionedItem[];
}

export interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

// ── Heuristic thresholds ─────────────────────────────────

const LOW_CHARS_PER_PAGE = 800;
const VERY_SPARSE_ITEMS_PER_PAGE = 30;
const MULTI_COLUMN_PAGE_RATIO = 0.30;          // ≥30% of pages must be multi-column
const COLUMN_CLUSTER_MIN_COVERAGE = 0.70;       // clusters must cover ≥70% of items on the page
const COLUMN_CLUSTER_X_TOLERANCE = 30;          // points; items within this x-distance count as same column
const COLUMN_MIN_CLUSTERS = 2;                  // need at least 2 distinct column clusters

// ── Public entry point ──────────────────────────────────

export async function decidePdfStrategy(buffer: Buffer): Promise<PdfStrategyDecision> {
  // Env override always wins
  const forced = (process.env.PARSING_STRATEGY ?? "auto").toLowerCase();
  if (forced === "vision" || forced === "text") {
    const { items, pageCount } = await extractPositionedItems(buffer);
    return {
      strategy: forced as "vision" | "text",
      pageCount,
      reasons: [`forced by PARSING_STRATEGY=${forced}`],
      metrics: computeMetrics(items, pageCount),
      positionedItems: items,
    };
  }

  const { items, pageCount } = await extractPositionedItems(buffer);
  const metrics = computeMetrics(items, pageCount);
  const reasons: string[] = [];

  // Aggregate page-level multi-column detection.
  const itemsByPage = new Map<number, PositionedItem[]>();
  for (const it of items) {
    if (!itemsByPage.has(it.page)) itemsByPage.set(it.page, []);
    itemsByPage.get(it.page)!.push(it);
  }

  let multiColumnPages = 0;
  for (const [, pageItems] of itemsByPage) {
    if (isMultiColumn(pageItems)) multiColumnPages++;
  }
  metrics.multiColumnRatio = pageCount > 0 ? multiColumnPages / pageCount : 0;

  // Apply heuristics.
  let shouldVision = false;
  if (metrics.avgCharsPerPage < LOW_CHARS_PER_PAGE) {
    shouldVision = true;
    reasons.push(`low text density (${metrics.avgCharsPerPage.toFixed(0)} chars/page < ${LOW_CHARS_PER_PAGE})`);
  }
  if (metrics.avgItemsPerPage < VERY_SPARSE_ITEMS_PER_PAGE) {
    shouldVision = true;
    reasons.push(`very sparse (${metrics.avgItemsPerPage.toFixed(0)} items/page < ${VERY_SPARSE_ITEMS_PER_PAGE})`);
  }
  if (metrics.multiColumnRatio >= MULTI_COLUMN_PAGE_RATIO) {
    shouldVision = true;
    reasons.push(`multi-column layout (${(metrics.multiColumnRatio * 100).toFixed(0)}% of pages)`);
  }

  if (!shouldVision) {
    reasons.push(
      `single-column, dense text (${metrics.avgCharsPerPage.toFixed(0)} chars/page, ${metrics.avgItemsPerPage.toFixed(0)} items/page) — text-layer is sufficient`
    );
  }

  return {
    strategy: shouldVision ? "vision" : "text",
    pageCount,
    reasons,
    metrics,
    positionedItems: items,
  };
}

// ── PDF positional extraction (shared with tabular adapter) ──

async function extractPositionedItems(buffer: Buffer): Promise<{ items: PositionedItem[]; pageCount: number }> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const pageCount = pdf.numPages;
  const items: PositionedItem[] = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item) || !item.str || item.str.trim() === "") continue;
      const t = item.transform as number[];
      if (Math.abs(t[1]) > 0.1 || Math.abs(t[2]) > 0.1) continue;   // skip rotated
      items.push({
        str: item.str.trim(),
        x: t[4],
        y: t[5],
        width: item.width,
        height: item.height,
        page: p,
      });
    }
  }
  await pdf.destroy();
  return { items, pageCount };
}

// ── Metrics ──────────────────────────────────────────────

function computeMetrics(
  items: PositionedItem[],
  pageCount: number
): PdfStrategyDecision["metrics"] {
  if (pageCount === 0) {
    return { avgCharsPerPage: 0, avgItemsPerPage: 0, multiColumnRatio: 0 };
  }
  const totalChars = items.reduce((acc, it) => acc + it.str.length, 0);
  return {
    avgCharsPerPage: totalChars / pageCount,
    avgItemsPerPage: items.length / pageCount,
    multiColumnRatio: 0,   // filled in by caller
  };
}

// ── Multi-column detection ──────────────────────────────

function isMultiColumn(pageItems: PositionedItem[]): boolean {
  if (pageItems.length < 20) return false;

  // Quantize x to tolerance buckets, count items per bucket.
  const bucketSize = COLUMN_CLUSTER_X_TOLERANCE;
  const counts = new Map<number, number>();
  for (const it of pageItems) {
    const bucket = Math.round(it.x / bucketSize) * bucketSize;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  // Find peaks: buckets with > 5% of page items.
  const minPeakSize = Math.max(5, pageItems.length * 0.05);
  const peaks = Array.from(counts.entries())
    .filter(([, count]) => count >= minPeakSize)
    .sort((a, b) => a[0] - b[0]);

  if (peaks.length < COLUMN_MIN_CLUSTERS) return false;

  // Merge peaks that are within 2× the tolerance (likely same column).
  const merged: Array<{ x: number; count: number }> = [];
  for (const [x, count] of peaks) {
    const last = merged[merged.length - 1];
    if (last && x - last.x < bucketSize * 2) {
      last.count += count;
      last.x = (last.x * (last.count - count) + x * count) / last.count;
    } else {
      merged.push({ x, count });
    }
  }

  if (merged.length < COLUMN_MIN_CLUSTERS) return false;

  // Coverage check: top N clusters should cover ≥70% of items.
  const topClusters = merged.sort((a, b) => b.count - a.count).slice(0, COLUMN_MIN_CLUSTERS + 1);
  const covered = topClusters.reduce((acc, c) => acc + c.count, 0);
  return covered / pageItems.length >= COLUMN_CLUSTER_MIN_COVERAGE;
}
