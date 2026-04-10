import Papa from "papaparse";
import * as XLSX from "xlsx";

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
  let numericCount = 0;
  let dateCount = 0;
  let sampleCount = 0;

  for (const v of values.slice(0, 100)) {
    if (v == null || String(v).trim() === "") continue;
    sampleCount++;
    const s = String(v).trim().replace(/,/g, ""); // strip formatting commas
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
  };
}

function buildTextPreview(
  name: string,
  fileType: string,
  columns: string[],
  rows: Row[],
  totalRows: number,
  sheetName?: string
): string {
  const header = sheetName
    ? `--- Sheet: ${sheetName} (${totalRows} rows) ---`
    : `File: ${name}\nType: ${fileType}\nColumns: ${columns.join(", ")}\nTotal rows: ${totalRows}`;

  const preview = rows.slice(0, MAX_PREVIEW_ROWS);
  const previewText = preview
    .map((row) =>
      columns.map((c) => {
        const v = row[c];
        return `${c}: ${v ?? ""}`;
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

// ── PDF parser ───────────────────────────────────────────

async function parsePDF(buffer: Buffer, name: string): Promise<ParseResult> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text: rawText } = await extractText(pdf, { mergePages: true });
  const pageCount = pdf.numPages;
  await pdf.destroy();

  const cleaned = rawText.replace(/\s+/g, " ").trim();

  return {
    text: truncate(`File: ${name}\nType: PDF\nPages: ${pageCount}\n\nContent:\n${cleaned}`),
    summary: `${name} — PDF with ${pageCount} page(s), ${cleaned.split(/\s+/).length} words`,
    parsedData: { columns: [], columnTypes: {}, rows: [], totalRows: 0 },
  };
}

// ── Route handler ────────────────────────────────────────

export async function POST(request: Request) {
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
