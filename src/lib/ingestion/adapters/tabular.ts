/**
 * Tabular adapter — Phase 1.
 *
 * This adapter is responsible for all spreadsheet-like input: CSV, XLSX/XLS,
 * and PDFs whose primary content is extractable tables. It is the ONLY
 * production adapter wired up in Phase 1; future adapters (narrative,
 * vision/OCR, docx, pptx) plug into the same `universalParse` orchestrator
 * via the classifier's `suggestedAdapter` field.
 *
 * Architectural contract:
 *   - The legacy `ParsedData` shape returned here MUST remain byte-identical
 *     to what the original `src/app/api/files/parse/route.ts` produced.
 *     Downstream tools (profile_dataset, run_analysis, create_chart,
 *     generate_dashboard, recommend_actions) consume it directly and rely
 *     on its literal field values — especially the `extractionMethod` enum
 *     ("positional" | "heuristic" | "none" | undefined) which is read by
 *     the confidence scorer in tools/execute/route.ts.
 *   - The new `DocumentExtraction` is produced ALONGSIDE the legacy parsed
 *     data. It contains the same tabular content wrapped as a DocumentTable,
 *     plus empty stubs for Phase 2+ facts/entities/spans/timeline.
 *
 * The CSV, Excel, and PDF parser bodies below were lifted verbatim from
 * the original parse route during the Phase 1 refactor. Do not modify them
 * here without verifying that the existing spreadsheet flow still produces
 * identical output — the voice agent's behavior is sensitive to the exact
 * preview/summary text.
 */

import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { ParsedData } from "@/lib/types";
import type {
  DocumentExtraction,
  DocumentTable,
  ExtractionMethod,
} from "@/lib/documents/types";
import type { ClassificationResult } from "../classifier";

// ── Constants (lifted verbatim from parse/route.ts) ──────

const MAX_TEXT_LENGTH = 8000;
const MAX_PREVIEW_ROWS = 30;
const SAFE_COLUMN_PATTERN = /^[a-zA-Z0-9_\s\-\.\/%()\[\]]+$/;

type Row = Record<string, string | number | null>;

// ── Type inference (verbatim) ────────────────────────────

function inferColumnType(values: unknown[]): "numeric" | "text" | "date" {
  const sampleSize = Math.min(1000, Math.max(100, Math.ceil(values.length * 0.1)));
  let sample: unknown[];

  if (values.length <= sampleSize) {
    sample = values;
  } else {
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

// ── Text preview / sanitization (verbatim) ───────────────

function truncate(text: string, max = MAX_TEXT_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n[...truncated, ${text.length - max} more characters]`;
}

function sanitizeColumnName(raw: string): string {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (SAFE_COLUMN_PATTERN.test(trimmed)) return trimmed;
  return trimmed.replace(/[^a-zA-Z0-9_\s\-\.\/%()\[\]]/g, "").trim() || "unnamed";
}

function sanitizeValue(val: unknown): string {
  if (val == null) return "";
  const s = String(val);
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .slice(0, 500);
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

// ── Column normalization (verbatim) ──────────────────────

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
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.includes(cleaned)) {
      return canonical.charAt(0).toUpperCase() + canonical.slice(1).replace(/_/g, " ");
    }
  }

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
    if (newColumns.includes(normalized)) {
      normalized = `${normalized} (${col})`;
    }
    nameMap[col] = normalized;
    newColumns.push(normalized);
    newTypes[normalized] = columnTypes[col] ?? "text";
  }

  const changed = columns.some((c) => nameMap[c] !== c);
  if (!changed) return { columns, columnTypes, rows };

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

// ── Per-format parsers (verbatim) ────────────────────────

interface CoreParseResult {
  text: string;
  summary: string;
  parsedData: ParsedData;
}

function parseCSV(buffer: Buffer, name: string): CoreParseResult {
  const csv = buffer.toString("utf-8");
  const result = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const rawRows = result.data as Record<string, unknown>[];
  const columns = (result.meta.fields ?? []).filter((h) => h.trim() !== "");

  const columnTypes: Record<string, "numeric" | "text" | "date"> = {};
  for (const col of columns) {
    columnTypes[col] = inferColumnType(rawRows.map((r) => r[col]));
  }

  const rows: Row[] = rawRows.map((r) => {
    const row: Row = {};
    for (const col of columns) {
      row[col] = coerceValue(r[col], columnTypes[col]);
    }
    return row;
  });

  const text = truncate(buildTextPreview(name, "CSV", columns, rows, rows.length));
  const summary = `${name} — CSV with ${rows.length} rows and ${columns.length} columns (${columns.slice(0, 5).join(", ")}${columns.length > 5 ? "…" : ""})`;

  return {
    text,
    summary,
    parsedData: { columns, columnTypes, rows, totalRows: rows.length },
  };
}

function parseExcel(buffer: Buffer, name: string): CoreParseResult {
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

    const validRaw = rawRows.filter((row) =>
      columns.some((h) => {
        const v = row[h];
        return v != null && String(v).trim() !== "";
      })
    );

    const sheetTypes: Record<string, "numeric" | "text" | "date"> = {};
    for (const col of columns) {
      sheetTypes[col] = inferColumnType(validRaw.map((r) => r[col]));
    }

    const rows: Row[] = validRaw.map((r) => {
      const row: Row = {};
      for (const col of columns) {
        row[col] = coerceValue(r[col], sheetTypes[col]);
      }
      return row;
    });

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

async function parsePDF(buffer: Buffer, name: string): Promise<CoreParseResult> {
  const { extractTablesFromItems } = await import("@/lib/pdf-table-extractor");
  const { getDocumentProxy, extractText } = await import("unpdf");

  const pdfData = new Uint8Array(buffer);
  const pdf = await getDocumentProxy(pdfData);
  const pageCount = pdf.numPages;

  const items: Array<{ str: string; x: number; y: number; width: number; height: number; page: number }> = [];

  for (let p = 1; p <= pageCount; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    for (const item of content.items) {
      if (!("str" in item) || !item.str || item.str.trim() === "") continue;
      const t = item.transform as number[];
      if (Math.abs(t[1]) > 0.1 || Math.abs(t[2]) > 0.1) continue;

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

    const text = truncate(buildTextPreview(name, "PDF (table extracted)", columns, coercedRows, coercedRows.length));
    const summary = `${name} — PDF with ${pageCount} page(s), ${coercedRows.length} rows extracted, ${columns.length} columns (${columns.slice(0, 5).join(", ")}${columns.length > 5 ? "…" : ""})`;

    console.log(`[pdf-parse] ${name}: extracted ${columns.length} columns, ${coercedRows.length} rows (confidence: ${best.confidence.toFixed(2)})`);
    console.log(`[pdf-parse] Columns: ${columns.join(", ")}`);
    if (coercedRows.length > 0) {
      console.log(`[pdf-parse] Sample row:`, coercedRows[0]);
    }

    return {
      text,
      summary,
      parsedData: {
        columns,
        columnTypes,
        rows: coercedRows,
        totalRows: coercedRows.length,
        extractionMethod: "positional",
      },
    };
  }

  const { text: rawText } = await extractText(pdf, { mergePages: true });
  await pdf.destroy();

  const cleaned = rawText.replace(/\s+/g, " ").trim();
  console.log(`[pdf-parse] ${name}: no tables detected (${tables.length} candidates, best confidence: ${tables[0]?.confidence.toFixed(2) ?? "n/a"})`);

  return {
    text: truncate(`File: ${name}\nType: PDF\nPages: ${pageCount}\n\nContent:\n${cleaned}`),
    summary: `${name} — PDF with ${pageCount} page(s), text extracted (no data tables found)`,
    parsedData: {
      columns: [],
      columnTypes: {},
      rows: [],
      totalRows: 0,
      extractionMethod: "none",
    },
  };
}

// ── Public adapter API ───────────────────────────────────

export interface TabularAdapterInput {
  buffer: Buffer;
  fileName: string;
  classification: ClassificationResult;
}

export interface TabularAdapterResult {
  text: string;
  summary: string;
  /** Legacy shape — consumed unchanged by existing tools. */
  parsedData: ParsedData;
  /** New universal representation. */
  extraction: DocumentExtraction;
}

/**
 * Run the tabular adapter. Routes by file extension (the classifier already
 * confirmed this is a tabular format) and produces both the legacy ParsedData
 * and the new DocumentExtraction.
 *
 * Throws if the file extension is not one of csv/xlsx/xls/pdf — but the
 * universal parser and the parse route both gate on extension before calling
 * here, so this is a defensive check.
 */
export async function runTabularAdapter(
  input: TabularAdapterInput
): Promise<TabularAdapterResult> {
  const { buffer, fileName, classification } = input;
  const lower = fileName.toLowerCase();

  let core: CoreParseResult;
  let extractionMethod: ExtractionMethod;
  const warnings: string[] = [];

  if (lower.endsWith(".csv")) {
    core = parseCSV(buffer, fileName);
    extractionMethod = "tabular-csv";
  } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    core = parseExcel(buffer, fileName);
    extractionMethod = "tabular-xlsx";
  } else if (lower.endsWith(".pdf")) {
    core = await parsePDF(buffer, fileName);
    if (core.parsedData.extractionMethod === "none") {
      extractionMethod = "none";
      warnings.push(
        "No tables detected in PDF. Narrative content extraction is not yet implemented (Phase 2)."
      );
    } else {
      extractionMethod = "tabular-pdf-positional";
    }
  } else {
    throw new Error(`Tabular adapter received unsupported file: ${fileName}`);
  }

  // Wrap the parsed table as a DocumentTable. When no rows came back
  // (PDF with no tables), `tables` stays empty — Phase 2's narrative adapter
  // will populate `sections` and `facts` for these documents instead.
  const tables: DocumentTable[] = core.parsedData.rows.length > 0
    ? [{ name: fileName, data: core.parsedData, sourcePage: 1 }]
    : [];

  // Phase 1 confidence mirrors the existing heuristic in
  // tools/execute/route.ts:computeConfidence so the two stay in lockstep.
  // (The new confidence does NOT replace that one yet — it lives on the
  // extraction object for future-phase consumers.)
  let confidence: number;
  if (extractionMethod === "none") {
    confidence = 0.05;
  } else if (extractionMethod === "tabular-pdf-positional") {
    confidence = 0.55;
  } else {
    confidence = 0.85;
  }

  const extraction: DocumentExtraction = {
    documentId: "",                           // assigned by caller when persisting
    type: classification.type,
    subtype: classification.subtype,
    language: classification.language,
    tables,
    facts: [],                                // populated by Phase 2+ adapters
    metrics: [],
    entities: [],
    spans: {},
    confidence,
    groundingRatio: 1.0,                      // vacuously grounded — no facts to verify yet
    classifierConfidence: classification.confidence,
    extractionMethod,
    warnings,
  };

  return {
    text: core.text,
    summary: core.summary,
    parsedData: core.parsedData,
    extraction,
  };
}
