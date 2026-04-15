import Papa from "papaparse";
import * as XLSX from "xlsx";
import { auth } from "@clerk/nextjs/server";

const MAX_TEXT_LENGTH = 8000;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_PREVIEW_ROWS = 30;

type Row = Record<string, string | number | null>;

function truncate(text: string, max = MAX_TEXT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n[...truncated, ${text.length - max} more characters]`;
}

// ── Type inference ───────────────────────────────────────

function inferColumnType(values: unknown[]): "numeric" | "text" | "date" {
  // Sample at least min(1000, 10%) of the dataset — not just the first rows
  const sampleSize = Math.min(1000, Math.max(100, Math.ceil(values.length * 0.1)));
  let sample: unknown[];

  if (values.length <= sampleSize) {
    sample = values;
  } else {
    // Random sample to avoid first-row bias
    sample = [];
    const step = values.length / sampleSize;
    for (let i = 0; i < sampleSize; i++) {
      sample.push(values[Math.floor(i * step)]);
    }
  }

  let numericCount = 0;
  let dateCount = 0;
  let sampleCount = 0;

  for (const v of sample) {
    if (v == null || String(v).trim() === "") continue;
    sampleCount++;
    const s = String(v).trim().replace(/,/g, "");
    if (!isNaN(Number(s)) && s !== "") numericCount++;
    if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) dateCount++;
  }

  if (sampleCount === 0) return "text";
  if (dateCount / sampleCount > 0.7) return "date";
  if (numericCount / sampleCount > 0.7) return "numeric";
  return "text";
}

function coerceValue(val: unknown, type: "numeric" | "text" | "date"): string | number | null {
  if (val == null || String(val).trim() === "") return null;
  if (type === "numeric") {
    const cleaned = String(val).trim().replace(/,/g, "");
    const n = Number(cleaned);
    return isNaN(n) ? String(val) : n;
  }
  return String(val);
}

// ── Structured parsing result ────────────────────────────

interface ParseResult {
  text: string;
  summary: string;
  parsedData: {
    columns: string[];
    columnTypes: Record<string, "numeric" | "text" | "date">;
    rows: Row[];
    totalRows: number;
    extractionMethod?: "positional" | "heuristic" | "none";
  };
}

// ── Column name sanitization ─────────────────────────────

const SAFE_COLUMN_PATTERN = /^[a-zA-Z0-9_\s\-\.\/%()\[\]]+$/;

function sanitizeColumnName(raw: string): string {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (SAFE_COLUMN_PATTERN.test(trimmed)) return trimmed;
  // Strip unsafe characters, keep alphanumeric + basic punctuation
  return trimmed.replace(/[^a-zA-Z0-9_\s\-\.\/%()\[\]]/g, "").trim() || "unnamed";
}

function sanitizeValue(val: unknown): string {
  if (val == null) return "";
  const s = String(val);
  // Escape characters that could be interpreted as prompt directives
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .slice(0, 500); // Cap individual cell length
}

function buildTextPreview(
  name: string,
  fileType: string,
  columns: string[],
  rows: Row[],
  totalRows: number,
  sheetName?: string
): string {
  const safeColumns = columns.map(sanitizeColumnName);

  const header = sheetName
    ? `Sheet: ${sanitizeValue(sheetName)} (${totalRows} rows)`
    : `File: ${sanitizeValue(name)}\nType: ${fileType}\nColumns: ${safeColumns.join(", ")}\nTotal rows: ${totalRows}`;

  const preview = rows.slice(0, MAX_PREVIEW_ROWS);
  const previewText = preview
    .map((row) =>
      safeColumns.map((c, i) => {
        const origCol = columns[i];
        const v = row[origCol];
        return `${c}: ${sanitizeValue(v)}`;
      }).join(" | ")
    )
    .join("\n");

  return `${header}\n\nData (first ${Math.min(MAX_PREVIEW_ROWS, totalRows)} rows):\n${previewText}`;
}

// ── CSV parser ───────────────────────────────────────────

function parseCSV(buffer: Buffer, name: string): ParseResult {
  const csv = buffer.toString("utf-8");
  const result = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rawRows = result.data as Record<string, unknown>[];
  const columns = (result.meta.fields ?? []).filter((h) => h.trim() !== "");

  // Infer types
  const columnTypes: Record<string, "numeric" | "text" | "date"> = {};
  for (const col of columns) {
    columnTypes[col] = inferColumnType(rawRows.map((r) => r[col]));
  }

  // Coerce values
  const rows: Row[] = rawRows.map((r) => {
    const row: Row = {};
    for (const col of columns) {
      row[col] = coerceValue(r[col], columnTypes[col]);
    }
    return row;
  });

  const text = truncate(
    buildTextPreview(name, "CSV", columns, rows, rows.length)
  );

  const summary = `${name} — CSV with ${rows.length} rows and ${columns.length} columns (${columns.slice(0, 5).join(", ")}${columns.length > 5 ? "…" : ""})`;

  return {
    text,
    summary,
    parsedData: { columns, columnTypes, rows, totalRows: rows.length },
  };
}

// ── Excel parser ─────────────────────────────────────────

function parseExcel(buffer: Buffer, name: string): ParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const allColumns: string[] = [];
  const allColumnTypes: Record<string, "numeric" | "text" | "date"> = {};
  const allRows: Row[] = [];
  const parts: string[] = [`File: ${name}`, `Type: Excel`, `Sheets: ${workbook.SheetNames.join(", ")}`];
  const sheetSummaries: string[] = [];
  let totalRows = 0;

  for (const sheetName of workbook.SheetNames.slice(0, 3)) {
    const sheet = workbook.Sheets[sheetName];
    const csvString = XLSX.utils.sheet_to_csv(sheet);
    const parsed = Papa.parse(csvString, { header: true, skipEmptyLines: true });
    const rawRows = parsed.data as Record<string, unknown>[];
    const columns = (parsed.meta.fields ?? []).filter((h) => h.trim() !== "");

    if (columns.length === 0 || rawRows.length === 0) {
      sheetSummaries.push(`${sheetName} (empty)`);
      continue;
    }

    // Filter fully-blank rows
    const validRaw = rawRows.filter((row) =>
      columns.some((h) => {
        const v = row[h];
        return v != null && String(v).trim() !== "";
      })
    );

    // Infer types for this sheet
    const sheetTypes: Record<string, "numeric" | "text" | "date"> = {};
    for (const col of columns) {
      sheetTypes[col] = inferColumnType(validRaw.map((r) => r[col]));
    }

    // Coerce values
    const rows: Row[] = validRaw.map((r) => {
      const row: Row = {};
      for (const col of columns) {
        row[col] = coerceValue(r[col], sheetTypes[col]);
      }
      return row;
    });

    // Merge into combined dataset (first sheet is primary)
    if (allColumns.length === 0) {
      allColumns.push(...columns);
      Object.assign(allColumnTypes, sheetTypes);
    }
    allRows.push(...rows);
    totalRows += rows.length;

    parts.push(buildTextPreview(name, "Excel", columns, rows, rows.length, sheetName));
    sheetSummaries.push(`${sheetName} (${rows.length} rows, ${columns.length} cols)`);
  }

  return {
    text: truncate(parts.join("\n")),
    summary: `${name} — Excel with ${workbook.SheetNames.length} sheet(s): ${sheetSummaries.join("; ")}`,
    parsedData: {
      columns: allColumns,
      columnTypes: allColumnTypes,
      rows: allRows,
      totalRows,
    },
  };
}

// ── Column normalization / business alias mapping ────────

const COLUMN_ALIASES: Record<string, string[]> = {
  revenue: ["revenue", "gross revenue", "total revenue", "sales revenue", "sales", "gross sales", "total sales", "income", "turnover"],
  net_revenue: ["net revenue", "net sales", "net income"],
  profit: ["profit", "gross profit", "net profit", "net income", "earnings", "margin"],
  cost: ["cost", "total cost", "costs", "expense", "expenses", "cogs", "cost of goods"],
  quantity: ["quantity", "qty", "units", "units sold", "unit sold", "volume", "count"],
  price: ["price", "unit price", "selling price", "avg price", "average price"],
  discount: ["discount", "discount rate", "disc", "rebate"],
  category: ["category", "product category", "item category", "type", "product type", "segment"],
  product: ["product", "product name", "item", "item name", "sku"],
  region: ["region", "area", "territory", "location", "geography", "geo"],
  date: ["date", "order date", "sale date", "transaction date", "period"],
  month: ["month", "months"],
  quarter: ["quarter", "qtr"],
  year: ["year", "fiscal year", "fy"],
  customer: ["customer", "customer name", "client", "buyer", "account"],
};

function normalizeColumnName(raw: string): string {
  const cleaned = raw
    .replace(/[^\w\s]/g, "") // remove punctuation
    .replace(/\s+/g, " ")   // collapse whitespace
    .trim()
    .toLowerCase();

  // Check each alias group
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.includes(cleaned)) {
      // Return a clean title-cased version
      return canonical.charAt(0).toUpperCase() + canonical.slice(1).replace(/_/g, " ");
    }
  }

  // No alias match — just clean up the original
  return raw.replace(/\s+/g, " ").trim();
}

function normalizeColumns(
  columns: string[],
  columnTypes: Record<string, "numeric" | "text" | "date">,
  rows: Row[]
): { columns: string[]; columnTypes: Record<string, "numeric" | "text" | "date">; rows: Row[] } {
  const nameMap: Record<string, string> = {};
  const newColumns: string[] = [];
  const newTypes: Record<string, "numeric" | "text" | "date"> = {};

  for (const col of columns) {
    let normalized = normalizeColumnName(col);
    // Deduplicate
    if (newColumns.includes(normalized)) {
      normalized = `${normalized} (${col})`;
    }
    nameMap[col] = normalized;
    newColumns.push(normalized);
    newTypes[normalized] = columnTypes[col] ?? "text";
  }

  // Check if any names actually changed
  const changed = columns.some((c) => nameMap[c] !== c);
  if (!changed) return { columns, columnTypes, rows };

  // Remap rows
  const newRows = rows.map((r) => {
    const newRow: Row = {};
    for (const col of columns) {
      newRow[nameMap[col]] = r[col];
    }
    return newRow;
  });

  console.log("[normalize] Column mapping:", nameMap);
  return { columns: newColumns, columnTypes: newTypes, rows: newRows };
}

// ── PDF parser ───────────────────────────────────────────

async function parsePDF(buffer: Buffer, name: string): Promise<ParseResult> {
  const { extractTablesFromItems } = await import("@/lib/pdf-table-extractor");
  const { getDocumentProxy, extractText } = await import("unpdf");

  const pdfData = new Uint8Array(buffer);
  const pdf = await getDocumentProxy(pdfData);
  const pageCount = pdf.numPages;

  // Phase 1: collect positioned text items from each page (done here, not in extractor)
  const items: Array<{ str: string; x: number; y: number; width: number; height: number; page: number }> = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    for (const item of content.items) {
      if (!("str" in item) || !item.str || item.str.trim() === "") continue;
      const t = item.transform as number[];
      if (Math.abs(t[1]) > 0.1 || Math.abs(t[2]) > 0.1) continue; // skip rotated

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

  console.log(`[pdf-parse] ${name}: ${items.length} positioned text items from ${pageCount} pages`);

  // Phase 2-5: extract tables from positioned items (pure data, no pdfjs imports)
  const tables = extractTablesFromItems(items);

  if (tables.length > 0 && tables[0].confidence > 0.2) {
    const best = tables[0];

    const rawTypes: Record<string, "numeric" | "text" | "date"> = {};
    for (const col of best.columns) {
      rawTypes[col] = inferColumnType(best.rows.map((r) => r[col]));
    }

    const { columns, columnTypes, rows } = normalizeColumns(best.columns, rawTypes, best.rows);

    const coercedRows = rows.map((r) => {
      const row: Row = {};
      for (const col of columns) {
        row[col] = coerceValue(r[col], columnTypes[col]);
      }
      return row;
    });

    await pdf.destroy();

    const text = truncate(
      buildTextPreview(name, "PDF (table extracted)", columns, coercedRows, coercedRows.length)
    );

    const summary = `${name} — PDF with ${pageCount} page(s), ${coercedRows.length} rows extracted, ${columns.length} columns (${columns.slice(0, 5).join(", ")}${columns.length > 5 ? "…" : ""})`;

    console.log(`[pdf-parse] ${name}: extracted ${columns.length} columns, ${coercedRows.length} rows (confidence: ${best.confidence.toFixed(2)})`);
    console.log(`[pdf-parse] Columns: ${columns.join(", ")}`);
    if (coercedRows.length > 0) {
      console.log(`[pdf-parse] Sample row:`, coercedRows[0]);
    }

    return {
      text,
      summary,
      parsedData: { columns, columnTypes, rows: coercedRows, totalRows: coercedRows.length, extractionMethod: "positional" },
    };
  }

  // Fallback: no table detected — return raw text for context
  const { text: rawText } = await extractText(pdf, { mergePages: true });
  await pdf.destroy();

  const cleaned = rawText.replace(/\s+/g, " ").trim();
  console.log(`[pdf-parse] ${name}: no tables detected (${tables.length} candidates, best confidence: ${tables[0]?.confidence.toFixed(2) ?? "n/a"})`);

  return {
    text: truncate(`File: ${name}\nType: PDF\nPages: ${pageCount}\n\nContent:\n${cleaned}`),
    summary: `${name} — PDF with ${pageCount} page(s), text extracted (no data tables found)`,
    parsedData: { columns: [], columnTypes: {}, rows: [], totalRows: 0, extractionMethod: "none" },
  };
}

// ── Route handler ────────────────────────────────────────

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
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

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const name = file.name.toLowerCase();

    let result: ParseResult;

    if (name.endsWith(".csv")) {
      result = parseCSV(buffer, file.name);
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      try {
        result = parseExcel(buffer, file.name);
      } catch (xlErr) {
        console.error("[files/parse] Excel parse error:", xlErr);
        return Response.json(
          { error: "Could not read Excel file — it may be corrupted or password-protected." },
          { status: 422 }
        );
      }
    } else if (name.endsWith(".pdf")) {
      result = await parsePDF(buffer, file.name);
    } else {
      return Response.json(
        { error: "Unsupported file type. Supported: CSV, Excel (.xlsx/.xls), PDF." },
        { status: 400 }
      );
    }

    console.log(
      `[files/parse] ${file.name} → ${result.parsedData.columns.length} cols, ${result.parsedData.totalRows} rows`
    );

    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parse failed";
    console.error("[files/parse] Error:", message);
    return Response.json({ error: `Failed to parse file: ${message}` }, { status: 500 });
  }
}
