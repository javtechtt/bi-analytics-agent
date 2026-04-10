type Row = Record<string, string | number | null>;

interface ParsedData {
  columns: string[];
  columnTypes: Record<string, "numeric" | "text" | "date">;
  rows: Row[];
  totalRows: number;
}

// ── Profile dataset ──────────────────────────────────────

function profileDataset(data: ParsedData, fileName: string): string {
  if (data.rows.length === 0) {
    return `No data found in "${fileName}".`;
  }

  const lines: string[] = [
    `Dataset: ${fileName}`,
    `Rows: ${data.totalRows}`,
    `Columns: ${data.columns.length}`,
    "",
  ];

  for (const col of data.columns) {
    const type = data.columnTypes[col] ?? "text";
    const values = data.rows.map((r) => r[col]).filter((v) => v != null && v !== "");
    const nullCount = data.rows.length - values.length;
    const unique = new Set(values.map(String)).size;

    const parts = [`  ${col} (${type}):`];
    parts.push(`    Non-null: ${values.length}/${data.rows.length}`);
    parts.push(`    Unique: ${unique}`);

    if (type === "numeric") {
      const nums = values.map(Number).filter((n) => !isNaN(n));
      if (nums.length > 0) {
        const sorted = nums.sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        const mean = sum / sorted.length;
        const median =
          sorted.length % 2 === 0
            ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
            : sorted[Math.floor(sorted.length / 2)];
        parts.push(`    Min: ${sorted[0]}, Max: ${sorted[sorted.length - 1]}`);
        parts.push(`    Mean: ${mean.toFixed(2)}, Median: ${median.toFixed(2)}`);
        parts.push(`    Sum: ${sum.toFixed(2)}`);
      }
    } else {
      const sample = values.slice(0, 5).map(String);
      parts.push(`    Sample: ${sample.join(", ")}`);
    }

    if (nullCount > 0) parts.push(`    Nulls: ${nullCount}`);
    lines.push(parts.join("\n"));
  }

  // Sample rows so the model can see actual data
  const sampleRows = data.rows.slice(0, 5);
  if (sampleRows.length > 0) {
    lines.push("");
    lines.push(`Sample data (first ${sampleRows.length} rows):`);
    for (const row of sampleRows) {
      lines.push(
        "  " + data.columns.map((c) => `${c}: ${row[c] ?? ""}`).join(" | ")
      );
    }
  }

  return lines.join("\n");
}

// ── Run analysis ─────────────────────────────────────────

interface AnalysisArgs {
  operation: "filter" | "group_by" | "sort" | "top_n";
  column?: string;
  value?: string;
  group_by_column?: string;
  aggregation?: "sum" | "count" | "avg" | "min" | "max";
  sort_order?: "asc" | "desc";
}

function validateColumn(col: string | undefined, data: ParsedData, opName: string): string | null {
  if (!col) return `Error: 'column' is required for ${opName}.`;
  if (!data.columns.includes(col)) {
    // Case-insensitive fallback
    const match = data.columns.find((c) => c.toLowerCase() === col.toLowerCase());
    if (match) return null; // will be resolved by caller
    return `Column "${col}" not found. Available columns: ${data.columns.join(", ")}`;
  }
  return null;
}

function resolveColumn(col: string, data: ParsedData): string {
  if (data.columns.includes(col)) return col;
  return data.columns.find((c) => c.toLowerCase() === col.toLowerCase()) ?? col;
}

function runAnalysis(data: ParsedData, fileName: string, args: AnalysisArgs): string {
  if (data.rows.length === 0) return `No data found in "${fileName}".`;

  switch (args.operation) {
    case "filter": {
      const col = args.column ? resolveColumn(args.column, data) : undefined;
      const colErr = validateColumn(col, data, "filter");
      if (colErr) return colErr;

      const filtered = data.rows.filter((r) => {
        const val = String(r[col!] ?? "").toLowerCase();
        return val.includes((args.value ?? "").toLowerCase());
      });
      return `Filter: ${col} contains "${args.value}"\nMatched: ${filtered.length}/${data.rows.length} rows\n\n${formatRows(filtered.slice(0, 20), data.columns)}`;
    }

    case "group_by": {
      const groupCol = resolveColumn(args.group_by_column ?? args.column ?? "", data);
      const groupErr = validateColumn(groupCol, data, "group_by");
      if (groupErr) return groupErr;

      const aggCol = args.column && args.column !== groupCol
        ? resolveColumn(args.column, data)
        : undefined;
      const agg = args.aggregation ?? "count";

      if (aggCol && agg !== "count") {
        const type = data.columnTypes[aggCol];
        if (type !== "numeric") {
          return `Cannot ${agg} column "${aggCol}" — it's ${type}, not numeric. Try aggregation: "count" instead.`;
        }
      }

      const groups = new Map<string, number[]>();
      for (const row of data.rows) {
        const key = String(row[groupCol] ?? "(null)");
        if (!groups.has(key)) groups.set(key, []);
        if (aggCol) {
          const v = Number(row[aggCol]);
          if (!isNaN(v)) groups.get(key)!.push(v);
        } else {
          groups.get(key)!.push(1);
        }
      }

      const results: { group: string; value: number }[] = [];
      for (const [key, vals] of groups) {
        let result: number;
        switch (agg) {
          case "sum": result = vals.reduce((a, b) => a + b, 0); break;
          case "count": result = vals.length; break;
          case "avg": result = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0; break;
          case "min": result = vals.length > 0 ? Math.min(...vals) : 0; break;
          case "max": result = vals.length > 0 ? Math.max(...vals) : 0; break;
        }
        results.push({ group: key, value: result });
      }

      results.sort((a, b) => b.value - a.value);
      const output = results
        .slice(0, 25)
        .map((r) => `  ${r.group}: ${r.value.toFixed(2)}`)
        .join("\n");

      return `Group by: ${groupCol}\nAggregation: ${agg}${aggCol ? ` of ${aggCol}` : ""}\nGroups: ${results.length}\n\n${output}`;
    }

    case "sort": {
      const col = args.column ? resolveColumn(args.column, data) : undefined;
      const colErr = validateColumn(col, data, "sort");
      if (colErr) return colErr;

      const order = args.sort_order ?? "desc";
      const isNumeric = data.columnTypes[col!] === "numeric";
      const sorted = [...data.rows].sort((a, b) => {
        if (isNumeric) {
          const va = Number(a[col!]);
          const vb = Number(b[col!]);
          return order === "asc" ? va - vb : vb - va;
        }
        return order === "asc"
          ? String(a[col!] ?? "").localeCompare(String(b[col!] ?? ""))
          : String(b[col!] ?? "").localeCompare(String(a[col!] ?? ""));
      });
      return `Sorted by: ${col} (${order})\n\n${formatRows(sorted.slice(0, 20), data.columns)}`;
    }

    case "top_n": {
      const col = args.column ? resolveColumn(args.column, data) : undefined;
      const colErr = validateColumn(col, data, "top_n");
      if (colErr) return colErr;

      const n = Math.min(parseInt(args.value ?? "10", 10), 100);
      if (data.columnTypes[col!] !== "numeric") {
        return `Cannot rank by "${col}" — it's ${data.columnTypes[col!]}, not numeric. Try a numeric column like: ${data.columns.filter((c) => data.columnTypes[c] === "numeric").join(", ") || "none available"}`;
      }

      const sorted = [...data.rows].sort((a, b) => Number(b[col!]) - Number(a[col!]));
      return `Top ${n} by ${col}:\n\n${formatRows(sorted.slice(0, n), data.columns)}`;
    }

    default:
      return `Unknown operation: ${args.operation}. Available: filter, group_by, sort, top_n`;
  }
}

function formatRows(rows: Row[], columns: string[]): string {
  if (rows.length === 0) return "(no matching rows)";
  return rows
    .map((r) =>
      columns
        .map((c) => `${c}: ${r[c] ?? ""}`)
        .join(" | ")
    )
    .join("\n");
}

// ── Chart data limits ────────────────────────────────────

const MAX_CHART_POINTS = 100;

// ── Route handler ────────────────────────────────────────

export async function POST(request: Request) {
  let body: {
    tool?: string;
    args?: Record<string, unknown>;
    fileContent?: string;
    fileName?: string;
    parsedData?: ParsedData;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { tool, args = {}, fileContent, fileName, parsedData } = body;

  if (!tool || typeof tool !== "string") {
    return Response.json({ error: "Missing or invalid 'tool'" }, { status: 400 });
  }

  console.log(`[tools/execute] ${tool}${fileName ? ` on ${fileName}` : ""}`);

  try {
    switch (tool) {
      case "profile_dataset": {
        // Prefer structured data, fall back to legacy text parsing
        const data = parsedData ?? legacyParse(fileContent, fileName);
        if (!data) {
          return Response.json(
            { error: `Cannot profile: no data available for "${fileName ?? "unknown"}"` },
            { status: 400 }
          );
        }
        const result = profileDataset(data, fileName ?? "unknown");
        return Response.json({ result });
      }

      case "run_analysis": {
        const data = parsedData ?? legacyParse(fileContent, fileName);
        if (!data) {
          return Response.json(
            { error: `Cannot analyze: no data available for "${fileName ?? "unknown"}"` },
            { status: 400 }
          );
        }
        const analysisArgs: AnalysisArgs = {
          operation: (args.operation as AnalysisArgs["operation"]) ?? "filter",
          column: args.column as string | undefined,
          value: args.value as string | undefined,
          group_by_column: args.group_by_column as string | undefined,
          aggregation: args.aggregation as AnalysisArgs["aggregation"],
          sort_order: args.sort_order as AnalysisArgs["sort_order"],
        };
        const result = runAnalysis(data, fileName ?? "unknown", analysisArgs);
        return Response.json({ result });
      }

      case "generate_visual": {
        const chartType = args.chart_type as string | undefined;
        const title = args.title as string | undefined;
        const rawData = args.data;

        if (!chartType || !title) {
          return Response.json({ error: "Missing chart_type or title" }, { status: 400 });
        }

        if (!Array.isArray(rawData) || rawData.length === 0) {
          return Response.json({ error: "Missing or empty data array" }, { status: 400 });
        }

        // Validate, coerce, and limit data points
        const data = (rawData as Array<Record<string, unknown>>)
          .slice(0, MAX_CHART_POINTS)
          .map((d) => ({
            label: String(d.label ?? ""),
            value: Number(d.value ?? 0),
            ...(d.x != null ? { x: Number(d.x) } : {}),
            ...(d.y != null ? { y: Number(d.y) } : {}),
            // Preserve additional series fields
            ...extractSeriesFields(d),
          }));

        const chartConfig = {
          chart_type: chartType,
          title,
          data,
          x_label: (args.x_label as string) ?? undefined,
          y_label: (args.y_label as string) ?? undefined,
          series: (args.series as string[]) ?? undefined,
        };

        const truncMsg = rawData.length > MAX_CHART_POINTS
          ? ` (showing ${MAX_CHART_POINTS} of ${rawData.length} points)`
          : "";

        return Response.json({
          result: `Chart generated: ${title} (${chartType})${truncMsg}`,
          chart: chartConfig,
        });
      }

      default:
        return Response.json({ error: `Unknown tool: ${tool}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed";
    console.error(`[tools/execute] ${tool} error:`, message);
    return Response.json({ error: message }, { status: 500 });
  }
}

// Extract any additional numeric fields as series data (e.g. revenue, profit)
function extractSeriesFields(d: Record<string, unknown>): Record<string, number> {
  const reserved = new Set(["label", "value", "x", "y"]);
  const extra: Record<string, number> = {};
  for (const [k, v] of Object.entries(d)) {
    if (reserved.has(k)) continue;
    const n = Number(v);
    if (!isNaN(n)) extra[k] = n;
  }
  return extra;
}

// Legacy fallback: parse the old text format for backwards compatibility
function legacyParse(content?: string, _fileName?: string): ParsedData | null {
  if (!content) return null;

  const lines = content.split("\n").filter((l) => l.trim());
  const rows: Row[] = [];
  let columns: string[] = [];

  // Try to extract columns from metadata
  const colMatch = content.match(/Columns: (.+)/);
  if (colMatch) {
    columns = colMatch[1].split(", ").map((c) => c.trim());
  }

  for (const line of lines) {
    if (!line.includes(": ") || /^(File|Type|Columns|Total|Sheet|Data \()/.test(line) || line.startsWith("---")) {
      continue;
    }
    const pairs = line.split(" | ");
    const row: Row = {};
    for (const pair of pairs) {
      const colonIdx = pair.indexOf(": ");
      if (colonIdx > 0) {
        const key = pair.slice(0, colonIdx).trim();
        const val = pair.slice(colonIdx + 2).trim();
        const num = Number(val.replace(/,/g, ""));
        row[key] = val === "" ? null : isNaN(num) ? val : num;
      }
    }
    if (Object.keys(row).length > 0) rows.push(row);
  }

  if (rows.length === 0) return null;

  if (columns.length === 0 && rows.length > 0) {
    columns = Object.keys(rows[0]);
  }

  const columnTypes: Record<string, "numeric" | "text" | "date"> = {};
  for (const col of columns) {
    const vals = rows.map((r) => r[col]).filter((v) => v != null);
    const numCount = vals.filter((v) => typeof v === "number").length;
    columnTypes[col] = numCount > vals.length * 0.7 ? "numeric" : "text";
  }

  return { columns, columnTypes, rows, totalRows: rows.length };
}
