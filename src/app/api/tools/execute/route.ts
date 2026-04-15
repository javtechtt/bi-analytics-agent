type Row = Record<string, string | number | null>;

interface ParsedData {
  columns: string[];
  columnTypes: Record<string, "numeric" | "text" | "date">;
  rows: Row[];
  totalRows: number;
  extractionMethod?: "positional" | "heuristic" | "none";
}

// ── Confidence scoring ──────────────────────────────────

type ConfidenceLevel = "high" | "medium" | "low";

interface ConfidenceResult {
  score: number;          // 0–1
  level: ConfidenceLevel;
  factors: string[];      // human-readable reasons
  guidance: string;       // tone instruction for the assistant
}

function computeConfidence(
  data: ParsedData,
  metricCol?: string,
  groupCol?: string,
  wasAutoResolved?: boolean
): ConfidenceResult {
  let score = 0;
  const factors: string[] = [];

  // 1. Extraction reliability (0–0.25)
  const method = data.extractionMethod ?? "heuristic";
  if (method === "positional") {
    // CSV and Excel parsed natively get no extractionMethod, so they're "heuristic" by default
    // PDF positional extraction is good but not perfect
    score += 0.20;
    factors.push("PDF positional extraction");
  } else if (method === "none") {
    score += 0.05;
    factors.push("no structured data extracted");
  } else {
    // CSV/Excel — direct parsing, highest reliability
    score += 0.25;
  }

  // 2. Sample size (0–0.25)
  if (data.totalRows >= 100) {
    score += 0.25;
  } else if (data.totalRows >= 20) {
    score += 0.18;
    factors.push(`small dataset (${data.totalRows} rows)`);
  } else if (data.totalRows >= 5) {
    score += 0.10;
    factors.push(`very small dataset (${data.totalRows} rows)`);
  } else {
    score += 0.03;
    factors.push(`tiny dataset (${data.totalRows} rows) — treat with caution`);
  }

  // 3. Data completeness — null ratio (0–0.20)
  if (metricCol) {
    const metricValues = data.rows.map((r) => r[metricCol]);
    const nullCount = metricValues.filter((v) => v == null || v === "").length;
    const nullRatio = nullCount / Math.max(data.rows.length, 1);
    if (nullRatio < 0.05) {
      score += 0.20;
    } else if (nullRatio < 0.15) {
      score += 0.12;
      factors.push(`${(nullRatio * 100).toFixed(0)}% missing values in ${metricCol}`);
    } else {
      score += 0.05;
      factors.push(`${(nullRatio * 100).toFixed(0)}% missing values in ${metricCol} — results may be skewed`);
    }
  } else {
    score += 0.15;
  }

  // 4. Schema clarity (0–0.15)
  if (metricCol && data.columnTypes[metricCol] === "numeric") {
    score += 0.15;
  } else if (metricCol) {
    score += 0.05;
    factors.push(`metric "${metricCol}" is not clearly numeric`);
  } else {
    score += 0.10;
  }

  // 5. Metric resolution certainty (0–0.15)
  if (wasAutoResolved) {
    score += 0.05;
    factors.push("metric/grouping was auto-resolved (not an exact match)");
  } else {
    score += 0.15;
  }

  score = Math.min(score, 1);

  let level: ConfidenceLevel;
  let guidance: string;

  if (score >= 0.75) {
    level = "high";
    guidance = "Speak assertively. State findings as facts. No hedging needed.";
  } else if (score >= 0.45) {
    level = "medium";
    guidance = "Speak with slight caution. Use phrases like 'the data suggests' or 'based on what I see here'. Mention any notable data gaps briefly.";
  } else {
    level = "low";
    guidance = "Be transparent about limitations. Say 'take this with a grain of salt' or 'this is a rough picture'. Suggest the user verify or provide better data.";
  }

  return { score, level, factors, guidance };
}

function formatConfidenceForAssistant(conf: ConfidenceResult): string {
  const lines = [
    `\nConfidence: ${conf.level} (${(conf.score * 100).toFixed(0)}%)`,
    `Tone: ${conf.guidance}`,
  ];
  if (conf.factors.length > 0) {
    lines.push(`Factors: ${conf.factors.join("; ")}`);
  }
  return lines.join("\n");
}

// ── Column resolution ────────────────────────────────────

// ── Semantic alias groups for metric resolution ──────────
const METRIC_ALIASES: Record<string, string[]> = {
  money: ["revenue", "net revenue", "gross revenue", "sales", "total sales", "income", "turnover", "amount", "total amount"],
  profit: ["profit", "gross profit", "net profit", "earnings", "margin", "net income"],
  cost: ["cost", "total cost", "costs", "expense", "expenses", "cogs"],
  quantity: ["quantity", "qty", "units", "units sold", "volume", "count"],
  price: ["price", "unit price", "selling price", "avg price"],
};

function resolveColumn(col: string, data: ParsedData): string | null {
  // Exact match
  if (data.columns.includes(col)) return col;
  // Case-insensitive match
  const ciMatch = data.columns.find((c) => c.toLowerCase() === col.toLowerCase());
  if (ciMatch) return ciMatch;
  // Partial match
  const partial = data.columns.find((c) => c.toLowerCase().includes(col.toLowerCase()));
  if (partial) return partial;
  // Reverse partial (column name contains query)
  const reverse = data.columns.find((c) => col.toLowerCase().includes(c.toLowerCase()) && c.length > 2);
  if (reverse) return reverse;

  // Semantic alias resolution: "money" → best revenue-like column
  const colLower = col.toLowerCase();
  for (const [concept, aliases] of Object.entries(METRIC_ALIASES)) {
    // Check if the query matches a concept or an alias
    const isMatch = concept === colLower || aliases.some((a) => a === colLower || colLower.includes(a) || a.includes(colLower));
    if (isMatch) {
      // Find a column in the dataset that matches any alias in this group
      for (const alias of aliases) {
        const found = data.columns.find((c) => c.toLowerCase() === alias || c.toLowerCase().includes(alias));
        if (found) {
          console.log(`[resolve] Semantic match: "${col}" → "${found}" (via ${concept} aliases)`);
          return found;
        }
      }
    }
  }

  return null;
}

function validateColumn(col: string | undefined, data: ParsedData, paramName: string): string | null {
  if (!col) return `Missing '${paramName}'. Available columns: ${data.columns.join(", ")}`;
  if (!resolveColumn(col, data)) {
    return `Column "${col}" not found. Available columns: ${data.columns.join(", ")}`;
  }
  return null;
}

// ── Profile dataset ──────────────────────────────────────

function profileDataset(data: ParsedData, fileName: string): string {
  if (data.rows.length === 0) return `No data found in "${fileName}".`;

  const lines: string[] = [
    `Dataset: ${fileName}`,
    `Rows: ${data.totalRows}`,
    `Columns: ${data.columns.length}`,
    "",
  ];

  for (const col of data.columns) {
    const type = data.columnTypes[col] ?? "text";
    const allValues = data.rows.map((r) => r[col]);
    const nonNull = allValues.filter((v) => v != null && v !== "");
    const nullCount = data.rows.length - nonNull.length;
    const unique = new Set(nonNull.map(String)).size;
    const completeness = ((nonNull.length / Math.max(data.rows.length, 1)) * 100).toFixed(0);

    const parts = [`  ${col} (${type}):`];
    parts.push(`    Completeness: ${completeness}% (${nonNull.length}/${data.rows.length})`);
    parts.push(`    Unique: ${unique}`);

    if (type === "numeric") {
      const nums = nonNull.map(Number).filter((n) => !isNaN(n));
      const nonNumericCount = nonNull.length - nums.length;
      const numericConsistency = ((nums.length / Math.max(nonNull.length, 1)) * 100).toFixed(0);

      if (nums.length > 0) {
        const sorted = nums.sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        const mean = sum / sorted.length;
        const median =
          sorted.length % 2 === 0
            ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
            : sorted[Math.floor(sorted.length / 2)];
        parts.push(`    Numeric consistency: ${numericConsistency}% (${nums.length} numeric of ${nonNull.length} non-null)`);
        parts.push(`    Min: ${sorted[0]}, Max: ${sorted[sorted.length - 1]}`);
        parts.push(`    Mean: ${mean.toFixed(2)}, Median: ${median.toFixed(2)}`);
        parts.push(`    Sum: ${sum.toFixed(2)}`);
        if (nonNumericCount > 0) {
          parts.push(`    ⚠ ${nonNumericCount} non-numeric values will be excluded from aggregations`);
        }
      } else {
        parts.push(`    ⚠ Column typed as numeric but contains no valid numbers`);
      }
    } else {
      const sample = nonNull.slice(0, 5).map(String);
      parts.push(`    Sample: ${sample.join(", ")}`);
    }

    if (nullCount > 0) parts.push(`    Nulls: ${nullCount} (${((nullCount / data.rows.length) * 100).toFixed(0)}%)`);
    lines.push(parts.join("\n"));
  }

  const sampleRows = data.rows.slice(0, 5);
  if (sampleRows.length > 0) {
    lines.push("");
    lines.push(`Sample data (first ${sampleRows.length} rows):`);
    for (const row of sampleRows) {
      lines.push("  " + data.columns.map((c) => `${c}: ${row[c] ?? ""}`).join(" | "));
    }
  }

  // Confidence assessment
  const conf = computeConfidence(data);
  lines.push(formatConfidenceForAssistant(conf));

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

function runAnalysis(data: ParsedData, fileName: string, args: AnalysisArgs): string {
  if (data.rows.length === 0) return `No data found in "${fileName}".`;

  const metricCol = args.column ? resolveColumn(args.column, data) : undefined;
  const conf = computeConfidence(data, metricCol ?? undefined);
  const confText = formatConfidenceForAssistant(conf);

  function withConfidence(result: string): string {
    return result + confText;
  }

  switch (args.operation) {
    case "filter": {
      const col = args.column ? resolveColumn(args.column, data) : null;
      const colErr = validateColumn(col ?? args.column, data, "column");
      if (colErr) return colErr;

      const filtered = data.rows.filter((r) => {
        const val = String(r[col!] ?? "").toLowerCase();
        return val.includes((args.value ?? "").toLowerCase());
      });
      return withConfidence(`Filter: ${col} contains "${args.value}"\nMatched: ${filtered.length}/${data.rows.length} rows\n\n${formatRows(filtered.slice(0, 20), data.columns)}`);
    }

    case "group_by": {
      const groupCol = resolveColumn(args.group_by_column ?? args.column ?? "", data);
      const groupErr = validateColumn(groupCol ?? args.group_by_column ?? args.column, data, "group_by_column");
      if (groupErr) return groupErr;

      const aggCol = args.column && resolveColumn(args.column, data) !== groupCol
        ? resolveColumn(args.column, data)
        : null;
      const agg = args.aggregation ?? "count";

      if (aggCol && agg !== "count" && data.columnTypes[aggCol] !== "numeric") {
        return `Cannot ${agg} column "${aggCol}" — it's ${data.columnTypes[aggCol]}, not numeric. Try "count" instead.`;
      }

      const { results, totalRows, validRows, skippedRows } = computeGroupBy(data.rows, groupCol!, aggCol, agg);
      const output = results.slice(0, 25).map((r: GroupByResult) => `  ${r.group}: ${r.value.toFixed(2)}`).join("\n");
      const coverage = skippedRows > 0
        ? `\n\nData coverage: ${validRows} of ${totalRows} rows used. ${skippedRows} rows had non-numeric values and were excluded.`
        : "";
      return withConfidence(`Group by: ${groupCol}\nAggregation: ${agg}${aggCol ? ` of ${aggCol}` : ""}\nGroups: ${results.length}\n\n${output}${coverage}`);
    }

    case "sort": {
      const col = args.column ? resolveColumn(args.column, data) : null;
      const colErr = validateColumn(col ?? args.column, data, "column");
      if (colErr) return colErr;

      const order = args.sort_order ?? "desc";
      const isNumeric = data.columnTypes[col!] === "numeric";
      const sorted = [...data.rows].sort((a, b) => {
        if (isNumeric) {
          const va = Number(a[col!]); const vb = Number(b[col!]);
          return order === "asc" ? va - vb : vb - va;
        }
        return order === "asc"
          ? String(a[col!] ?? "").localeCompare(String(b[col!] ?? ""))
          : String(b[col!] ?? "").localeCompare(String(a[col!] ?? ""));
      });
      return withConfidence(`Sorted by: ${col} (${order})\n\n${formatRows(sorted.slice(0, 20), data.columns)}`);
    }

    case "top_n": {
      const col = args.column ? resolveColumn(args.column, data) : null;
      const colErr = validateColumn(col ?? args.column, data, "column");
      if (colErr) return colErr;

      const n = Math.min(parseInt(args.value ?? "10", 10), 100);
      if (data.columnTypes[col!] !== "numeric") {
        return `Cannot rank by "${col}" — not numeric. Numeric columns: ${data.columns.filter((c) => data.columnTypes[c] === "numeric").join(", ") || "none"}`;
      }

      const sorted = [...data.rows].sort((a, b) => Number(b[col!]) - Number(a[col!]));
      return withConfidence(`Top ${n} by ${col}:\n\n${formatRows(sorted.slice(0, n), data.columns)}`);
    }

    default:
      return `Unknown operation: ${args.operation}. Available: filter, group_by, sort, top_n`;
  }
}

function formatRows(rows: Row[], columns: string[]): string {
  if (rows.length === 0) return "(no matching rows)";
  return rows.map((r) => columns.map((c) => `${c}: ${r[c] ?? ""}`).join(" | ")).join("\n");
}

// ── Shared group-by computation ──────────────────────────

interface GroupByResult {
  group: string;
  value: number;
}

interface GroupByOutput {
  results: GroupByResult[];
  totalRows: number;
  validRows: number;
  skippedRows: number;
}

function computeGroupBy(
  rows: Row[],
  groupCol: string,
  aggCol: string | null,
  agg: string
): GroupByOutput {
  const groups = new Map<string, number[]>();
  let skippedRows = 0;

  for (const row of rows) {
    const key = String(row[groupCol] ?? "(null)");
    if (!groups.has(key)) groups.set(key, []);
    if (aggCol) {
      const raw = row[aggCol];
      const v = Number(raw);
      if (!isNaN(v) && raw != null && String(raw).trim() !== "") {
        groups.get(key)!.push(v);
      } else {
        skippedRows++;
      }
    } else {
      groups.get(key)!.push(1);
    }
  }

  const results: GroupByResult[] = [];
  for (const [key, vals] of groups) {
    let result: number;
    switch (agg) {
      case "sum": result = vals.reduce((a, b) => a + b, 0); break;
      case "count": result = vals.length; break;
      case "avg": result = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0; break;
      case "min": result = vals.length > 0 ? Math.min(...vals) : 0; break;
      case "max": result = vals.length > 0 ? Math.max(...vals) : 0; break;
      default: result = vals.length;
    }
    results.push({ group: key, value: result });
  }

  results.sort((a, b) => b.value - a.value);

  return {
    results,
    totalRows: rows.length,
    validRows: rows.length - skippedRows,
    skippedRows,
  };
}

// ── Chart builder ────────────────────────────────────────

const MAX_CHART_POINTS = 100;

interface CreateChartArgs {
  chart_type: string;
  title: string;
  metric: string;
  group_by: string;
  aggregation?: string;
  split_by?: string;
  filter?: string;
  metric_2?: string;
}

// ── Drill-down suggestion generator ──────────────────────

function generateDrilldowns(
  data: ParsedData,
  metricCol: string,
  groupCol: string,
  metric2Col: string | null,
  currentFilter?: string,
  chartType?: string
): string[] {
  const suggestions: string[] = [];

  // Compute actual data insights to make suggestions contextual
  const { results: grouped } = computeGroupBy(data.rows, groupCol, metricCol, "sum");
  const topGroup = grouped[0]?.group;
  const bottomGroup = grouped.length > 1 ? grouped[grouped.length - 1]?.group : null;

  // Other dimensions available
  const otherGroupCols = data.columns.filter(
    (c) => c !== groupCol && c !== metricCol && c !== metric2Col && data.columnTypes[c] !== "numeric"
  );
  const otherMetrics = data.columns.filter(
    (c) => c !== metricCol && c !== metric2Col && c !== groupCol && data.columnTypes[c] === "numeric"
  );
  const dateCol = data.columns.find(
    (c) => c !== groupCol && data.columnTypes[c] === "date"
  );

  // 1. BREAK DOWN — change the grouping dimension
  if (otherGroupCols.length > 0) {
    const nextDim = otherGroupCols[0];
    suggestions.push(`Now break this down by ${nextDim}`);
  }

  // 2. COMPARE — add a second metric
  if (otherMetrics.length > 0 && !metric2Col) {
    suggestions.push(`How does ${otherMetrics[0]} compare?`);
  }

  // 3. TREND — show over time if available and not already a line
  if (dateCol && chartType !== "line") {
    suggestions.push(`Show me the trend over time`);
  }

  // 4. FOCUS — drill into the top or bottom performer
  if (topGroup && !currentFilter && grouped.length > 3) {
    suggestions.push(`Dig into ${topGroup}`);
  }

  // 5. ANOMALY — highlight the bottom if there's a big gap
  if (topGroup && bottomGroup && grouped.length > 3) {
    const topVal = grouped[0]?.value ?? 0;
    const bottomVal = grouped[grouped.length - 1]?.value ?? 0;
    if (topVal > 0 && bottomVal / topVal < 0.3) {
      suggestions.push(`What's happening with ${bottomGroup}?`);
    }
  }

  return suggestions.slice(0, 4);
}

function buildChart(data: ParsedData, _fileName: string, args: CreateChartArgs) {
  const validTypes = ["bar", "line", "pie", "scatter"];
  if (!validTypes.includes(args.chart_type)) {
    return { error: `Invalid chart_type "${args.chart_type}". Use: ${validTypes.join(", ")}` };
  }

  // Parse metric(s) — supports comma-separated for multi-series
  let wasAutoResolved = false;
  const metricRaw = args.metric.split(",").map((m) => m.trim()).filter(Boolean);
  const metricCols: string[] = [];
  for (const m of metricRaw) {
    const resolved = resolveColumn(m, data);
    if (resolved) {
      metricCols.push(resolved);
    } else {
      console.log(`[create_chart] metric "${m}" not resolved — skipping`);
    }
  }

  // Also accept metric_2 for backward compatibility
  if (args.metric_2) {
    const resolved = resolveColumn(args.metric_2, data);
    if (resolved && !metricCols.includes(resolved)) {
      metricCols.push(resolved);
    }
  }

  // If no metrics resolved, auto-pick the first numeric column
  if (metricCols.length === 0) {
    const numericCols = data.columns.filter((c) => data.columnTypes[c] === "numeric");
    if (numericCols.length > 0) {
      metricCols.push(numericCols[0]);
      wasAutoResolved = true;
      console.log(`[create_chart] No valid metric from "${args.metric}" — auto-picked "${numericCols[0]}"`);
    } else {
      return { error: `No numeric columns available for charting. Columns: ${data.columns.join(", ")}` };
    }
  }

  let groupCol = resolveColumn(args.group_by, data);
  if (!groupCol) {
    const textCols = data.columns.filter(
      (c) => data.columnTypes[c] !== "numeric" && !metricCols.includes(c)
    );
    if (textCols.length > 0) {
      groupCol = textCols[0];
      wasAutoResolved = true;
      console.log(`[create_chart] group_by "${args.group_by}" not found — auto-picked "${groupCol}"`);
    } else {
      return { error: `Group-by column "${args.group_by}" not found. Available: ${data.columns.join(", ")}` };
    }
  }

  // Apply optional filter
  let rows = data.rows;
  if (args.filter) {
    const colonIdx = args.filter.indexOf(":");
    if (colonIdx > 0) {
      const fCol = resolveColumn(args.filter.slice(0, colonIdx).trim(), data);
      const fVal = args.filter.slice(colonIdx + 1).trim().toLowerCase();
      if (fCol) {
        rows = rows.filter((r) => String(r[fCol] ?? "").toLowerCase().includes(fVal));
        console.log(`[create_chart] Filter: ${fCol} contains "${fVal}" → ${rows.length} rows`);
      }
    }
  }

  if (rows.length === 0) {
    // Not a hard error — the assistant may have already answered via run_analysis.
    // Return a result (not an error) so it doesn't show as a failure.
    return { result: "No data matched the filter — chart skipped. The insight was already provided." };
  }

  const agg = args.aggregation ?? "sum";
  const primaryMetric = metricCols[0];

  // Scatter: raw x/y points
  if (args.chart_type === "scatter") {
    const chartData = rows.slice(0, MAX_CHART_POINTS).map((r) => ({
      label: String(r[groupCol] ?? ""),
      value: Number(r[primaryMetric] ?? 0),
      x: Number(r[groupCol] ?? 0),
      y: Number(r[primaryMetric] ?? 0),
    }));

    const drilldowns = generateDrilldowns(data, primaryMetric, groupCol, null, args.filter, "scatter");
    const scatterSummary = chartData.slice(0, 20).map((d) =>
      `  ${d.label}: ${groupCol}=${d.x}, ${primaryMetric}=${d.y}`
    ).join("\n");
    return {
      chart: { chart_type: "scatter", title: args.title, data: chartData, x_label: groupCol, y_label: primaryMetric },
      drilldowns,
      result: `Scatter: ${primaryMetric} vs ${groupCol} (${chartData.length} points)\n\nData (source of truth):\n${scatterSummary}`,
    };
  }

  // Resolve split_by column if provided
  let splitCol: string | null = null;
  if (args.split_by) {
    splitCol = resolveColumn(args.split_by, data);
    if (!splitCol) {
      // Auto-pick first text column that isn't the group_by
      const candidates = data.columns.filter(
        (c) => data.columnTypes[c] !== "numeric" && c !== groupCol
      );
      if (candidates.length > 0) {
        splitCol = candidates[0];
        console.log(`[create_chart] split_by "${args.split_by}" not found — auto-picked "${splitCol}"`);
      }
    }
  }

  // Determine natural label order for line charts
  const labelOrder = new Map<string, number>();
  for (const row of rows) {
    const key = String(row[groupCol] ?? "");
    if (!labelOrder.has(key)) labelOrder.set(key, labelOrder.size);
  }

  let chartData: Array<Record<string, string | number>>;
  let series: string[] | undefined;

  if (splitCol) {
    // ── Split-by: one series per unique value in splitCol ──
    const splitValues = [...new Set(rows.map((r) => String(r[splitCol!] ?? "")))].filter(Boolean);
    const limitedSplits = splitValues.slice(0, 8); // max 8 series to keep chart readable

    // Get all unique group labels
    const allLabels = [...labelOrder.keys()];

    // Compute aggregation for each split value
    const splitMaps = new Map<string, Map<string, number>>();
    for (const sv of limitedSplits) {
      const subsetRows = rows.filter((r) => String(r[splitCol!] ?? "") === sv);
      const { results: grouped } = computeGroupBy(subsetRows, groupCol, primaryMetric, agg);
      splitMaps.set(sv, new Map(grouped.map((g: GroupByResult) => [g.group, g.value])));
    }

    // Build data points: one entry per label, one field per split value
    chartData = allLabels.slice(0, MAX_CHART_POINTS).map((label) => {
      const point: Record<string, string | number> = { label };
      for (const sv of limitedSplits) {
        point[sv] = splitMaps.get(sv)?.get(label) ?? 0;
      }
      return point;
    });

    series = limitedSplits;

    // Sort by original order for line charts
    if (args.chart_type === "line") {
      chartData.sort((a, b) =>
        (labelOrder.get(String(a.label)) ?? 0) - (labelOrder.get(String(b.label)) ?? 0)
      );
    }

    console.log(`[create_chart] Split by ${splitCol}: ${limitedSplits.length} series, ${chartData.length} points`);

  } else if (metricCols.length > 1) {
    // ── Multi-metric: one series per metric column ──
    const primaryOutput = computeGroupBy(rows, groupCol, primaryMetric, agg);

    if (args.chart_type === "line") {
      primaryOutput.results.sort((a, b) => (labelOrder.get(a.group) ?? 0) - (labelOrder.get(b.group) ?? 0));
    }

    const limited = primaryOutput.results.slice(0, MAX_CHART_POINTS);
    const metricMaps: Map<string, Map<string, number>> = new Map();
    for (const mc of metricCols.slice(1)) {
      const { results: grouped } = computeGroupBy(rows, groupCol, mc, agg);
      metricMaps.set(mc, new Map(grouped.map((g: GroupByResult) => [g.group, g.value])));
    }

    chartData = limited.map((g: GroupByResult) => {
      const point: Record<string, string | number> = {
        label: g.group,
        [primaryMetric]: g.value,
      };
      for (const mc of metricCols.slice(1)) {
        point[mc] = metricMaps.get(mc)?.get(g.group) ?? 0;
      }
      return point;
    });
    series = metricCols;

  } else {
    // ── Single series ──
    const primaryOutput = computeGroupBy(rows, groupCol, primaryMetric, agg);

    if (args.chart_type === "line") {
      primaryOutput.results.sort((a, b) => (labelOrder.get(a.group) ?? 0) - (labelOrder.get(b.group) ?? 0));
    }

    const limited = primaryOutput.results.slice(0, MAX_CHART_POINTS);
    chartData = limited.map((g: GroupByResult) => ({ label: g.group, value: g.value }));
  }

  // Pie: cap at 7 slices
  if (args.chart_type === "pie" && chartData.length > 7) {
    const top = chartData.slice(0, 6);
    const rest = chartData.slice(6);
    const otherValue = rest.reduce((sum, d) => sum + Number(d.value ?? 0), 0);
    chartData = [...top, { label: "Other", value: otherValue }];
  }

  const drilldowns = generateDrilldowns(
    data, primaryMetric, groupCol, metricCols.length > 1 ? metricCols[1] : null, args.filter, args.chart_type
  );

  const metricLabel = metricCols.length > 1
    ? metricCols.join(" & ")
    : primaryMetric;

  // Build a data summary so the assistant speaks from the SAME numbers the chart shows
  const dataSummary = summarizeChartData(chartData, series);
  const conf = computeConfidence(data, primaryMetric, groupCol, wasAutoResolved);

  return {
    chart: {
      chart_type: args.chart_type,
      title: args.title,
      data: chartData,
      x_label: groupCol,
      y_label: `${agg} of ${metricLabel}`,
      series,
    },
    drilldowns,
    result: `Chart: ${args.title}\n${agg} of ${metricLabel} by ${groupCol}\n\nData (this is the source of truth — speak ONLY these numbers):\n${dataSummary}${formatConfidenceForAssistant(conf)}`,
  };
}

/** Format chart data into text the assistant must use as source of truth */
function summarizeChartData(
  chartData: Array<Record<string, string | number>>,
  series?: string[]
): string {
  if (chartData.length === 0) return "(no data)";

  const seriesKeys = series ?? ["value"];

  return chartData.map((d) => {
    const label = d.label;
    if (seriesKeys.length === 1 && seriesKeys[0] === "value") {
      return `  ${label}: ${formatNum(Number(d.value ?? 0))}`;
    }
    const parts = seriesKeys.map((k) => `${k}=${formatNum(Number(d[k] ?? 0))}`);
    return `  ${label}: ${parts.join(", ")}`;
  }).join("\n");
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n % 1 === 0 ? n.toString() : n.toFixed(2);
}

// ── Dataset cache ────────────────────────────────────────

const MAX_DATASET_ROWS = 50_000;
const TOOL_TIMEOUT_MS = 15_000;

interface CachedDataset {
  data: ParsedData;
  profileResult?: string;
  timestamp: number;
}

// Cache keyed by fileName — survives across requests within the same server instance
const datasetCache = new Map<string, CachedDataset>();

// Aggregation result cache keyed by "fileName:tool:argsHash"
const aggCache = new Map<string, { result: string; timestamp: number; chart?: unknown; drilldowns?: string[] }>();
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

function getCacheKey(fileName: string, tool: string, args: Record<string, unknown>): string {
  // Stable hash from sorted args
  const sorted = Object.keys(args).sort().map((k) => `${k}=${args[k]}`).join("&");
  return `${fileName}:${tool}:${sorted}`;
}

function resolveDataset(
  parsedData: ParsedData | undefined,
  fileContent: string | undefined,
  fileName: string | undefined
): ParsedData | null {
  // Check cache first
  if (fileName) {
    const cached = datasetCache.get(fileName);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  // Use provided data
  const data = parsedData ?? legacyParse(fileContent);
  if (!data) return null;

  // Enforce row limit
  if (data.rows.length > MAX_DATASET_ROWS) {
    console.log(`[cache] Dataset "${fileName}" has ${data.rows.length} rows — capping at ${MAX_DATASET_ROWS}`);
    data.rows = data.rows.slice(0, MAX_DATASET_ROWS);
    data.totalRows = data.rows.length;
  }

  // Cache it
  if (fileName) {
    datasetCache.set(fileName, { data, timestamp: Date.now() });
    console.log(`[cache] Cached dataset "${fileName}" (${data.rows.length} rows, ${data.columns.length} cols)`);
  }

  return data;
}

// ── Rate limiting ────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // max 30 calls per minute
const callTimestamps: number[] = [];

function checkRateLimit(): boolean {
  const now = Date.now();
  // Remove timestamps older than the window
  while (callTimestamps.length > 0 && callTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    callTimestamps.shift();
  }
  if (callTimestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }
  callTimestamps.push(now);
  return true;
}

// ── Tool dispatch with caching ───────────────────────────

async function executeToolLogic(
  tool: string,
  args: Record<string, unknown>,
  data: ParsedData | null,
  fileName: string
): Promise<Response> {
  switch (tool) {
    case "profile_dataset": {
      if (!data) {
        return Response.json(
          { error: `Cannot profile: no data available for "${fileName}"` },
          { status: 400 }
        );
      }

      // Check profile cache
      const cached = datasetCache.get(fileName);
      if (cached?.profileResult) {
        console.log(`[cache] Profile cache hit for "${fileName}"`);
        return Response.json({ result: cached.profileResult });
      }

      const result = profileDataset(data, fileName);

      // Cache the profile result
      if (datasetCache.has(fileName)) {
        datasetCache.get(fileName)!.profileResult = result;
      }

      return Response.json({ result });
    }

    case "run_analysis": {
      if (!data) {
        return Response.json(
          { error: `Cannot analyze: no data available for "${fileName}"` },
          { status: 400 }
        );
      }

      // Check aggregation cache
      const cacheKey = getCacheKey(fileName, tool, args);
      const cachedAgg = aggCache.get(cacheKey);
      if (cachedAgg && Date.now() - cachedAgg.timestamp < CACHE_TTL_MS) {
        console.log(`[cache] Aggregation cache hit: ${cacheKey}`);
        return Response.json({ result: cachedAgg.result });
      }

      const analysisArgs: AnalysisArgs = {
        operation: (args.operation as AnalysisArgs["operation"]) ?? "filter",
        column: args.column as string | undefined,
        value: args.value as string | undefined,
        group_by_column: args.group_by_column as string | undefined,
        aggregation: args.aggregation as AnalysisArgs["aggregation"],
        sort_order: args.sort_order as AnalysisArgs["sort_order"],
      };
      const result = runAnalysis(data, fileName, analysisArgs);

      // Cache it
      aggCache.set(cacheKey, { result, timestamp: Date.now() });

      return Response.json({ result });
    }

    case "create_chart": {
      if (!data) {
        return Response.json(
          { error: "Cannot create chart: no data available. Make sure a file is uploaded." },
          { status: 400 }
        );
      }

      const chartType = args.chart_type as string | undefined;
      const title = args.title as string | undefined;
      const metric = args.metric as string | undefined;
      const groupBy = args.group_by as string | undefined;

      if (!chartType) return Response.json({ error: "Missing chart_type. Use: bar, line, pie, scatter" }, { status: 400 });
      if (!title) return Response.json({ error: "Missing title for chart" }, { status: 400 });
      if (!metric) return Response.json({ error: `Missing metric. Available: ${data.columns.join(", ")}` }, { status: 400 });
      if (!groupBy) return Response.json({ error: `Missing group_by. Available: ${data.columns.join(", ")}` }, { status: 400 });

      // Check aggregation cache for chart
      const cacheKey = getCacheKey(fileName, tool, args);
      const cachedChart = aggCache.get(cacheKey);
      if (cachedChart && Date.now() - cachedChart.timestamp < CACHE_TTL_MS) {
        console.log(`[cache] Chart cache hit: ${cacheKey}`);
        return Response.json({ result: cachedChart.result, chart: cachedChart.chart, drilldowns: cachedChart.drilldowns });
      }

      const chartArgs: CreateChartArgs = {
        chart_type: chartType,
        title,
        metric,
        group_by: groupBy,
        aggregation: args.aggregation as string | undefined,
        split_by: args.split_by as string | undefined,
        filter: args.filter as string | undefined,
        metric_2: args.metric_2 as string | undefined,
      };

      const result = buildChart(data, fileName, chartArgs);

      if ("error" in result) {
        return Response.json({ error: result.error }, { status: 400 });
      }

      if (result.chart) {
        console.log(`[create_chart] Built: ${result.chart.title} (${result.chart.data.length} points)`);
      }

      // Cache the chart result
      aggCache.set(cacheKey, {
        result: result.result,
        chart: result.chart,
        drilldowns: result.drilldowns,
        timestamp: Date.now(),
      });

      return Response.json({ result: result.result, chart: result.chart, drilldowns: result.drilldowns });
    }

    case "recommend_actions": {
      if (!data) {
        return Response.json({ error: "Cannot recommend: no data available." }, { status: 400 });
      }

      const { analyzeDataset } = await import("@/lib/insights");
      const { generateDecisions, formatDecisionsForAssistant } = await import("@/lib/decisions");
      const { selectKpis } = await import("@/lib/kpi");

      // Detect columns
      const primaryMetric = data.columns.find((c) => data.columnTypes[c] === "numeric") ?? null;
      const secondaryMetric = primaryMetric
        ? data.columns.find((c) => data.columnTypes[c] === "numeric" && c !== primaryMetric) ?? null
        : null;
      const timeCol = data.columns.find((c) => data.columnTypes[c] === "date") ??
        data.columns.find((c) => /date|month|quarter|year|period|week/i.test(c)) ?? null;
      const categories = data.columns.filter(
        (c) => data.columnTypes[c] !== "numeric" && c !== timeCol
      );
      const kpis = selectKpis(data);

      const analysis = analyzeDataset(data, primaryMetric, secondaryMetric, timeCol, categories, kpis);
      const decisions = generateDecisions(analysis, data, primaryMetric, secondaryMetric, timeCol, categories, kpis);

      const conf = computeConfidence(data, primaryMetric ?? undefined);

      // Build supporting chart for top recommendation
      let chart = undefined;
      if (decisions.topRecommendation.supportingChart) {
        const sc = decisions.topRecommendation.supportingChart;
        const chartGroupBy = sc.group_by === "auto"
          ? (timeCol ?? categories[0] ?? data.columns[0])
          : sc.group_by;
        const chartResult = buildChart(data, fileName, {
          chart_type: sc.chart_type,
          title: sc.title,
          metric: sc.metric,
          group_by: chartGroupBy,
        });
        if (!("error" in chartResult) && chartResult.chart) {
          chart = chartResult.chart;
        }
      }

      const resultText = formatDecisionsForAssistant(decisions) + "\n" + formatConfidenceForAssistant(conf);

      console.log(`[recommend_actions] Top: ${decisions.topRecommendation.title} | ${decisions.alternatives.length} alternatives | ${decisions.strategies.length} strategies`);

      return Response.json({
        result: resultText,
        chart,
        decisions: {
          topRecommendation: decisions.topRecommendation,
          alternatives: decisions.alternatives,
          strategies: decisions.strategies,
        },
      });
    }

    case "generate_dashboard": {
      if (!data) {
        return Response.json(
          { error: "Cannot generate dashboard: no data available." },
          { status: 400 }
        );
      }

      const { generateDashboard } = await import("@/lib/dashboard");
      const dashboard = generateDashboard(data, fileName);

      // Build chart data for each dashboard chart using the existing buildChart function
      const builtCharts = [];
      for (const dc of dashboard.charts) {
        const chartResult = buildChart(data, fileName, {
          chart_type: dc.chart_type,
          title: dc.title,
          metric: dc.metric,
          group_by: dc.group_by,
          aggregation: dc.aggregation,
        });
        if (!("error" in chartResult) && chartResult.chart) {
          builtCharts.push(chartResult.chart);
        }
      }

      // Format a text summary for the assistant to speak from
      const { formatInsightsForAssistant } = await import("@/lib/insights");

      const summaryLines = [
        `Dashboard: ${dashboard.title}`,
        `${dashboard.subtitle}`,
        "",
        "KPIs (source of truth — speak these numbers):",
        ...dashboard.kpis.map((k) => `  ${k.label}: ${k.value}`),
        "",
        formatInsightsForAssistant({ insights: dashboard.insights, risks: dashboard.risks, opportunities: dashboard.opportunities }),
      ];

      const conf = computeConfidence(data);
      summaryLines.push(formatConfidenceForAssistant(conf));

      console.log(`[generate_dashboard] Built: ${builtCharts.length} charts, ${dashboard.kpis.length} KPIs`);

      return Response.json({
        result: summaryLines.join("\n"),
        dashboard: {
          ...dashboard,
          charts: builtCharts,
        },
        drilldowns: dashboard.drilldowns,
      });
    }

    default:
      return Response.json({ error: `Unknown tool: ${tool}` }, { status: 400 });
  }
}

// ── Route handler ────────────────────────────────────────

export async function POST(request: Request) {
  if (!checkRateLimit()) {
    console.warn("[tools/execute] Rate limit exceeded");
    return Response.json(
      { error: "Too many requests. Please wait a moment before trying again." },
      { status: 429 }
    );
  }

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

  const fName = fileName ?? "unknown";
  console.log(`[tools/execute] ${tool} on ${fName}`, JSON.stringify(args));

  // Resolve dataset from cache or provided data
  const data = resolveDataset(parsedData, fileContent, fileName);

  try {
    // Wrap execution in a timeout
    const result = await Promise.race([
      executeToolLogic(tool, args, data, fName),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Tool execution timed out")), TOOL_TIMEOUT_MS)
      ),
    ]);

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool execution failed";
    console.error(`[tools/execute] ${tool} error:`, message);
    return Response.json({ error: message }, { status: 500 });
  }
}

// ── Legacy text parser (fallback) ────────────────────────

function legacyParse(content?: string): ParsedData | null {
  if (!content) return null;

  const lines = content.split("\n").filter((l) => l.trim());
  const rows: Row[] = [];
  let columns: string[] = [];

  const colMatch = content.match(/Columns: (.+)/);
  if (colMatch) columns = colMatch[1].split(", ").map((c) => c.trim());

  for (const line of lines) {
    if (!line.includes(": ") || /^(File|Type|Columns|Total|Sheet|Data \(|Sample)/.test(line) || line.startsWith("---")) continue;
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
  if (columns.length === 0 && rows.length > 0) columns = Object.keys(rows[0]);

  const columnTypes: Record<string, "numeric" | "text" | "date"> = {};
  for (const col of columns) {
    const vals = rows.map((r) => r[col]).filter((v) => v != null);
    const numCount = vals.filter((v) => typeof v === "number").length;
    columnTypes[col] = numCount > vals.length * 0.7 ? "numeric" : "text";
  }

  return { columns, columnTypes, rows, totalRows: rows.length };
}
