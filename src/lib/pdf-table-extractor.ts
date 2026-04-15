/**
 * PDF Table Extractor — Positional Analysis
 *
 * Reconstructs table structure from pre-extracted positioned text items.
 * The caller (parse route) handles pdfjs interaction and passes plain
 * PositionedItem objects — no pdfjs imports happen in this module.
 */

type Row = Record<string, string | number | null>;

export interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
}

interface PositionedRow {
  y: number;
  items: PositionedItem[];
  page: number;
}

export interface ExtractedTable {
  columns: string[];
  rows: Row[];
  confidence: number;
}

// ── Phase 2: Cluster items into rows by y-position ───────

function clusterIntoRows(items: PositionedItem[]): PositionedRow[] {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return b.y - a.y;
  });

  const avgHeight = sorted.reduce((sum, it) => sum + Math.abs(it.height), 0) / sorted.length;
  const yTolerance = Math.max(avgHeight * 0.6, 2);

  const rows: PositionedRow[] = [];
  let currentRow: PositionedItem[] = [sorted[0]];
  let currentY = sorted[0].y;
  let currentPage = sorted[0].page;

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    if (item.page === currentPage && Math.abs(item.y - currentY) < yTolerance) {
      currentRow.push(item);
    } else {
      currentRow.sort((a, b) => a.x - b.x);
      rows.push({ y: currentY, items: currentRow, page: currentPage });
      currentRow = [item];
      currentY = item.y;
      currentPage = item.page;
    }
  }

  if (currentRow.length > 0) {
    currentRow.sort((a, b) => a.x - b.x);
    rows.push({ y: currentY, items: currentRow, page: currentPage });
  }

  return rows;
}

// ── Phase 3: Detect column boundaries ────────────────────

function detectColumnBoundaries(rows: PositionedRow[], minRows: number = 3): number[] | null {
  if (rows.length < minRows) return null;

  const allXPositions: number[] = [];
  for (const row of rows) {
    for (const item of row.items) {
      allXPositions.push(item.x);
    }
  }

  if (allXPositions.length === 0) return null;

  const quantized = allXPositions.map((x) => Math.round(x / 3) * 3);

  const freq = new Map<number, number>();
  for (const x of quantized) {
    freq.set(x, (freq.get(x) ?? 0) + 1);
  }

  const threshold = Math.max(rows.length * 0.4, minRows);
  let candidates = Array.from(freq.entries())
    .filter(([, count]) => count >= threshold)
    .map(([x]) => x)
    .sort((a, b) => a - b);

  if (candidates.length < 2) return null;

  const merged: number[] = [candidates[0]];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i] - merged[merged.length - 1] > 8) {
      merged.push(candidates[i]);
    }
  }

  return merged.length >= 2 ? merged : null;
}

// ── Phase 4: Identify header row ─────────────────────────

function isNumericToken(str: string): boolean {
  const cleaned = str.replace(/[$,%()\s-]/g, "");
  return cleaned.length > 0 && !isNaN(Number(cleaned));
}

function assignItemsToCols(items: PositionedItem[], colBounds: number[]): string[] {
  const cells: string[] = Array(colBounds.length).fill("");

  for (const item of items) {
    let colIdx = colBounds.length - 1;
    for (let c = 0; c < colBounds.length - 1; c++) {
      const mid = (colBounds[c] + colBounds[c + 1]) / 2;
      if (item.x < mid) {
        colIdx = c;
        break;
      }
    }
    cells[colIdx] = cells[colIdx] ? `${cells[colIdx]} ${item.str}` : item.str;
  }

  return cells;
}

function findHeaderIndex(rows: PositionedRow[], colBounds: number[]): number {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = assignItemsToCols(rows[i].items, colBounds);
    const nonEmpty = cells.filter((c) => c.length > 0);
    if (nonEmpty.length < 2) continue;

    const numericCount = nonEmpty.filter((c) => isNumericToken(c)).length;
    const numericRatio = numericCount / nonEmpty.length;

    if (numericRatio < 0.3 && nonEmpty.length >= colBounds.length * 0.6) {
      let dataRowCount = 0;
      for (let j = i + 1; j < Math.min(i + 5, rows.length); j++) {
        const dataCells = assignItemsToCols(rows[j].items, colBounds);
        if (dataCells.filter((c) => c.length > 0).length >= 2) dataRowCount++;
      }
      if (dataRowCount >= 2) return i;
    }
  }

  return -1;
}

// ── Phase 5: Extract cell values ─────────────────────────

function parseValue(str: string): string | number | null {
  if (!str || str.trim() === "") return null;
  const trimmed = str.trim();
  const cleaned = trimmed.replace(/[$,]/g, "").replace(/^\((.+)\)$/, "-$1");
  const num = Number(cleaned);
  if (!isNaN(num) && cleaned !== "") return num;
  if (trimmed.endsWith("%")) {
    const pctNum = Number(trimmed.slice(0, -1).replace(/,/g, ""));
    if (!isNaN(pctNum)) return pctNum;
  }
  return trimmed;
}

function extractTableFromRegion(
  rows: PositionedRow[],
  colBounds: number[],
  headerIdx: number
): ExtractedTable | null {
  const headerCells = assignItemsToCols(rows[headerIdx].items, colBounds);
  const columns = headerCells.map((c, i) => c.trim() || `Column_${i + 1}`);

  const dataRows: Row[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = assignItemsToCols(rows[i].items, colBounds);
    const nonEmpty = cells.filter((c) => c.length > 0).length;
    if (nonEmpty < 2) continue;

    const row: Row = {};
    for (let c = 0; c < columns.length; c++) {
      row[columns[c]] = parseValue(cells[c]);
    }
    dataRows.push(row);
  }

  if (dataRows.length < 2) return null;

  // Confidence scoring
  let confidence = 0;
  confidence += Math.min(columns.length / 5, 0.3);
  confidence += Math.min(dataRows.length / 10, 0.3);
  const avgItemsPerRow = rows.slice(headerIdx + 1).reduce(
    (sum, r) => sum + r.items.length, 0
  ) / Math.max(rows.length - headerIdx - 1, 1);
  confidence += Math.min(avgItemsPerRow / columns.length, 0.2);
  const totalCells = dataRows.length * columns.length;
  const filledCells = dataRows.reduce(
    (sum, r) => sum + columns.filter((c) => r[c] != null).length, 0
  );
  confidence += (filledCells / Math.max(totalCells, 1)) * 0.2;

  return { columns, rows: dataRows, confidence: Math.min(confidence, 1) };
}

// ── Main extraction (receives pre-extracted items) ───────

export function extractTablesFromItems(items: PositionedItem[]): ExtractedTable[] {
  try {
    if (items.length < 10) {
      console.log("[pdf-table] Too few text items:", items.length);
      return [];
    }

    const rows = clusterIntoRows(items);
    if (rows.length < 4) {
      console.log("[pdf-table] Too few rows:", rows.length);
      return [];
    }

    console.log(`[pdf-table] ${items.length} text items → ${rows.length} rows`);

    const colBounds = detectColumnBoundaries(rows);
    if (!colBounds) {
      console.log("[pdf-table] No consistent column boundaries found");
      return [];
    }

    console.log(`[pdf-table] Detected ${colBounds.length} column boundaries`);

    const headerIdx = findHeaderIndex(rows, colBounds);
    if (headerIdx < 0) {
      console.log("[pdf-table] No header row found");
      return [];
    }

    console.log(`[pdf-table] Header at row ${headerIdx}: ${assignItemsToCols(rows[headerIdx].items, colBounds).join(" | ")}`);

    const table = extractTableFromRegion(rows, colBounds, headerIdx);
    if (!table) {
      console.log("[pdf-table] Failed to extract table data");
      return [];
    }

    console.log(`[pdf-table] Extracted: ${table.columns.length} cols, ${table.rows.length} rows, confidence: ${table.confidence.toFixed(2)}`);

    return [table];
  } catch (err) {
    console.error("[pdf-table] Extraction error:", err instanceof Error ? err.message : err);
    return [];
  }
}
