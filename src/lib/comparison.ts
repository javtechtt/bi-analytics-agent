/**
 * Multi-File Comparison Engine.
 * Compares two datasets when the user explicitly requests it.
 * Never silently merges — only activates on explicit intent.
 */

import type { ParsedData } from "./types";
import { formatLabel, formatKpiValue } from "./labels";

// ── Types ────────────────────────────────────────────────

export interface ComparisonKpi {
  label: string;
  column: string;
  valueA: number;
  valueB: number;
  formattedA: string;
  formattedB: string;
  delta: number;
  deltaFormatted: string;
  deltaPositive: boolean;
}

export interface CompatibilityReport {
  compatible: boolean;
  sharedColumns: string[];
  sharedNumeric: string[];
  sharedCategories: string[];
  mappedColumns: Array<{ colA: string; colB: string; canonical: string }>;
  issues: string[];
}

export interface ComparisonChart {
  chart_type: "bar" | "line";
  title: string;
  data: Array<Record<string, string | number>>;
  series: string[];
  x_label: string;
  y_label: string;
}

export interface ComparisonResult {
  compatible: boolean;
  fileA: string;
  fileB: string;
  kpis: ComparisonKpi[];
  charts: ComparisonChart[];
  summary: string;
  spokenSummary: string;
  issues: string[];
  drilldowns: string[];
}

// ── Column alias resolution ──────────────────────────────

const COLUMN_GROUPS: Record<string, string[]> = {
  revenue: ["revenue", "gross_revenue", "net_revenue", "total_revenue", "sales", "total_sales", "income", "amount"],
  profit: ["profit", "gross_profit", "net_profit", "earnings"],
  cost: ["cost", "total_cost", "costs", "expense", "expenses", "cogs"],
  quantity: ["quantity", "qty", "units", "units_sold", "volume"],
  price: ["price", "unit_price", "selling_price", "avg_price", "average_selling_price"],
  discount: ["discount", "discount_pct", "discount_amount", "rebate"],
  region: ["region", "area", "territory", "location", "geography"],
  category: ["category", "product_category", "type", "product_type", "segment"],
  product: ["product", "product_name", "item", "item_name", "sku"],
  date: ["date", "order_date", "sale_date", "month", "quarter", "year", "period"],
  campaign: ["campaign", "campaign_name", "channel", "source", "medium"],
  customer: ["customer", "customer_name", "client", "buyer", "account"],
};

function findCanonicalGroup(colName: string): string | null {
  const lower = colName.toLowerCase();
  for (const [canonical, aliases] of Object.entries(COLUMN_GROUPS)) {
    if (aliases.some((a) => lower === a || lower.includes(a) || a.includes(lower))) {
      return canonical;
    }
  }
  return null;
}

// ── Compatibility check ──────────────────────────────────

export function checkCompatibility(
  dataA: ParsedData,
  dataB: ParsedData,
  fileA: string,
  fileB: string
): CompatibilityReport {
  const issues: string[] = [];
  const sharedColumns: string[] = [];
  const sharedNumeric: string[] = [];
  const sharedCategories: string[] = [];
  const mappedColumns: Array<{ colA: string; colB: string; canonical: string }> = [];

  // Direct name matches (case-insensitive)
  for (const colA of dataA.columns) {
    const matchB = dataB.columns.find((b) => b.toLowerCase() === colA.toLowerCase());
    if (matchB) {
      sharedColumns.push(colA);
      if (dataA.columnTypes[colA] === "numeric" && dataB.columnTypes[matchB] === "numeric") {
        sharedNumeric.push(colA);
      }
      if (dataA.columnTypes[colA] !== "numeric" && dataB.columnTypes[matchB] !== "numeric") {
        sharedCategories.push(colA);
      }
    }
  }

  // Alias-based mapping for columns that don't match directly
  for (const colA of dataA.columns) {
    if (sharedColumns.some((s) => s.toLowerCase() === colA.toLowerCase())) continue;
    const groupA = findCanonicalGroup(colA);
    if (!groupA) continue;

    for (const colB of dataB.columns) {
      if (sharedColumns.some((s) => s.toLowerCase() === colB.toLowerCase())) continue;
      if (mappedColumns.some((m) => m.colB === colB)) continue;
      const groupB = findCanonicalGroup(colB);
      if (groupA === groupB) {
        mappedColumns.push({ colA, colB, canonical: groupA });
        if (dataA.columnTypes[colA] === "numeric" && dataB.columnTypes[colB] === "numeric") {
          sharedNumeric.push(colA);
        }
        if (dataA.columnTypes[colA] !== "numeric" && dataB.columnTypes[colB] !== "numeric") {
          sharedCategories.push(colA);
        }
        break;
      }
    }
  }

  const totalShared = sharedColumns.length + mappedColumns.length;

  if (totalShared === 0) {
    issues.push(`No shared or mappable columns found between "${fileA}" and "${fileB}".`);
  }
  if (sharedNumeric.length === 0) {
    issues.push("No shared numeric columns for metric comparison.");
  }
  if (sharedCategories.length === 0 && sharedNumeric.length > 0) {
    issues.push("No shared category columns — can compare totals but not breakdowns.");
  }

  // Row count warning
  const rowRatio = Math.max(dataA.totalRows, dataB.totalRows) / Math.max(Math.min(dataA.totalRows, dataB.totalRows), 1);
  if (rowRatio > 10) {
    issues.push(`Significant size difference: ${fileA} has ${dataA.totalRows} rows vs ${fileB} has ${dataB.totalRows} rows.`);
  }

  return {
    compatible: sharedNumeric.length > 0,
    sharedColumns,
    sharedNumeric,
    sharedCategories,
    mappedColumns,
    issues,
  };
}

// ── KPI comparison ───────────────────────────────────────

function compareKpis(
  dataA: ParsedData,
  dataB: ParsedData,
  compat: CompatibilityReport,
  fileA: string,
  fileB: string
): ComparisonKpi[] {
  const kpis: ComparisonKpi[] = [];

  for (const col of compat.sharedNumeric.slice(0, 6)) {
    // Resolve actual column names in each dataset
    const colA = col;
    const mapped = compat.mappedColumns.find((m) => m.colA === col);
    const colB = mapped ? mapped.colB : dataB.columns.find((c) => c.toLowerCase() === col.toLowerCase()) ?? col;

    const valsA = dataA.rows.map((r) => r[colA]).filter((v) => v != null && v !== "").map(Number).filter((n) => !isNaN(n));
    const valsB = dataB.rows.map((r) => r[colB]).filter((v) => v != null && v !== "").map(Number).filter((n) => !isNaN(n));

    if (valsA.length === 0 || valsB.length === 0) continue;

    const sumA = valsA.reduce((a, b) => a + b, 0);
    const sumB = valsB.reduce((a, b) => a + b, 0);
    const delta = sumA !== 0 ? ((sumB - sumA) / Math.abs(sumA)) * 100 : 0;

    kpis.push({
      label: formatLabel(col),
      column: col,
      valueA: sumA,
      valueB: sumB,
      formattedA: formatKpiValue(sumA),
      formattedB: formatKpiValue(sumB),
      delta,
      deltaFormatted: `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`,
      deltaPositive: delta >= 0,
    });
  }

  return kpis;
}

// ── Comparison chart generation ──────────────────────────

function buildComparisonCharts(
  dataA: ParsedData,
  dataB: ParsedData,
  compat: CompatibilityReport,
  fileA: string,
  fileB: string
): ComparisonChart[] {
  const charts: ComparisonChart[] = [];
  const labelA = fileA.replace(/\.[^.]+$/, "");
  const labelB = fileB.replace(/\.[^.]+$/, "");

  if (compat.sharedNumeric.length === 0) return charts;

  const primaryMetric = compat.sharedNumeric[0];
  const metricName = formatLabel(primaryMetric);
  const mappedMetric = compat.mappedColumns.find((m) => m.colA === primaryMetric);
  const metricColB = mappedMetric ? mappedMetric.colB : dataB.columns.find((c) => c.toLowerCase() === primaryMetric.toLowerCase()) ?? primaryMetric;

  // Chart 1: Category comparison (grouped bar)
  if (compat.sharedCategories.length > 0) {
    const catCol = compat.sharedCategories[0];
    const mappedCat = compat.mappedColumns.find((m) => m.colA === catCol);
    const catColB = mappedCat ? mappedCat.colB : dataB.columns.find((c) => c.toLowerCase() === catCol.toLowerCase()) ?? catCol;
    const catName = formatLabel(catCol);

    // Aggregate by category for each file
    const groupA = new Map<string, number>();
    for (const row of dataA.rows) {
      const key = String(row[catCol] ?? "");
      const val = Number(row[primaryMetric]);
      if (key && !isNaN(val)) groupA.set(key, (groupA.get(key) ?? 0) + val);
    }

    const groupB = new Map<string, number>();
    for (const row of dataB.rows) {
      const key = String(row[catColB] ?? "");
      const val = Number(row[metricColB]);
      if (key && !isNaN(val)) groupB.set(key, (groupB.get(key) ?? 0) + val);
    }

    const allKeys = [...new Set([...groupA.keys(), ...groupB.keys()])].slice(0, 20);

    charts.push({
      chart_type: "bar",
      title: `${metricName} by ${catName} — ${labelA} vs ${labelB}`,
      data: allKeys.map((key) => ({
        label: key,
        [labelA]: groupA.get(key) ?? 0,
        [labelB]: groupB.get(key) ?? 0,
      })),
      series: [labelA, labelB],
      x_label: catName,
      y_label: metricName,
    });
  }

  // Chart 2: Time trend comparison (multi-line) if time dimension exists
  const timeKeywords = ["date", "month", "quarter", "year", "period", "week"];
  const timeColA = compat.sharedCategories.find((c) => timeKeywords.some((k) => c.toLowerCase().includes(k))) ??
    dataA.columns.find((c) => dataA.columnTypes[c] === "date");

  if (timeColA) {
    const mappedTime = compat.mappedColumns.find((m) => m.colA === timeColA);
    const timeColB = mappedTime ? mappedTime.colB : dataB.columns.find((c) => c.toLowerCase() === timeColA.toLowerCase()) ?? timeColA;

    const seriesA = new Map<string, number>();
    for (const row of dataA.rows) {
      const p = String(row[timeColA] ?? "");
      const v = Number(row[primaryMetric]);
      if (p && !isNaN(v)) seriesA.set(p, (seriesA.get(p) ?? 0) + v);
    }

    const seriesB = new Map<string, number>();
    for (const row of dataB.rows) {
      const p = String(row[timeColB] ?? "");
      const v = Number(row[metricColB]);
      if (p && !isNaN(v)) seriesB.set(p, (seriesB.get(p) ?? 0) + v);
    }

    // Preserve order from data
    const orderMap = new Map<string, number>();
    for (const row of [...dataA.rows, ...dataB.rows]) {
      const p = String(row[timeColA] ?? row[timeColB] ?? "");
      if (p && !orderMap.has(p)) orderMap.set(p, orderMap.size);
    }

    const allPeriods = [...new Set([...seriesA.keys(), ...seriesB.keys()])]
      .sort((a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0))
      .slice(0, 50);

    if (allPeriods.length >= 3) {
      charts.push({
        chart_type: "line",
        title: `${metricName} Trend — ${labelA} vs ${labelB}`,
        data: allPeriods.map((p) => ({
          label: p,
          [labelA]: seriesA.get(p) ?? 0,
          [labelB]: seriesB.get(p) ?? 0,
        })),
        series: [labelA, labelB],
        x_label: formatLabel(timeColA),
        y_label: metricName,
      });
    }
  }

  // Chart 3: Total comparison bar (simple side-by-side totals)
  if (compat.sharedNumeric.length >= 2 && charts.length < 3) {
    const topMetrics = compat.sharedNumeric.slice(0, 4);
    charts.push({
      chart_type: "bar",
      title: `Key Metrics — ${labelA} vs ${labelB}`,
      data: topMetrics.map((col) => {
        const mappedCol = compat.mappedColumns.find((m) => m.colA === col);
        const colBName = mappedCol ? mappedCol.colB : dataB.columns.find((c) => c.toLowerCase() === col.toLowerCase()) ?? col;

        const sumA = dataA.rows.map((r) => Number(r[col])).filter((n) => !isNaN(n)).reduce((a, b) => a + b, 0);
        const sumB = dataB.rows.map((r) => Number(r[colBName])).filter((n) => !isNaN(n)).reduce((a, b) => a + b, 0);

        return { label: formatLabel(col), [labelA]: sumA, [labelB]: sumB };
      }),
      series: [labelA, labelB],
      x_label: "Metric",
      y_label: "Value",
    });
  }

  return charts.slice(0, 3);
}

// ── Main: Compare two files ──────────────────────────────

export function compareFiles(
  dataA: ParsedData,
  dataB: ParsedData,
  fileA: string,
  fileB: string
): ComparisonResult {
  const compat = checkCompatibility(dataA, dataB, fileA, fileB);

  if (!compat.compatible) {
    return {
      compatible: false,
      fileA,
      fileB,
      kpis: [],
      charts: [],
      summary: `Cannot compare "${fileA}" and "${fileB}": ${compat.issues.join(" ")}`,
      spokenSummary: `These two files don't share any numeric columns I can compare. ${compat.issues[0] ?? ""}`,
      issues: compat.issues,
      drilldowns: [],
    };
  }

  const kpis = compareKpis(dataA, dataB, compat, fileA, fileB);
  const charts = buildComparisonCharts(dataA, dataB, compat, fileA, fileB);

  // Build spoken summary from KPIs
  const spokenParts: string[] = [];
  if (kpis.length > 0) {
    const top = kpis[0];
    spokenParts.push(`Comparing ${fileA} and ${fileB}: ${top.label} went from ${top.formattedA} to ${top.formattedB} — that's ${top.deltaFormatted}.`);
    if (kpis.length > 1) {
      const second = kpis[1];
      spokenParts.push(`${second.label} is ${second.deltaFormatted} (${second.formattedA} → ${second.formattedB}).`);
    }
  }

  const summaryLines = [
    `Comparison: ${fileA} vs ${fileB}`,
    `Shared metrics: ${compat.sharedNumeric.length}`,
    `Mapped columns: ${compat.mappedColumns.length}`,
    "",
    "KPI Comparison (source of truth — speak these numbers):",
    ...kpis.map((k) => `  ${k.label}: ${k.formattedA} → ${k.formattedB} (${k.deltaFormatted})`),
  ];

  if (compat.issues.length > 0) {
    summaryLines.push("", "Notes:", ...compat.issues.map((i) => `  ⚠ ${i}`));
  }

  // Drilldowns
  const drilldowns: string[] = [];
  if (compat.sharedCategories.length > 0) {
    drilldowns.push(`Break down comparison by ${formatLabel(compat.sharedCategories[0])}`);
  }
  if (kpis.length > 1) {
    drilldowns.push(`Focus on ${kpis[0].label} differences`);
  }
  if (compat.sharedNumeric.length > 2) {
    drilldowns.push(`Compare all ${compat.sharedNumeric.length} shared metrics`);
  }

  return {
    compatible: true,
    fileA,
    fileB,
    kpis,
    charts,
    summary: summaryLines.join("\n"),
    spokenSummary: spokenParts.join(" "),
    issues: compat.issues,
    drilldowns: drilldowns.slice(0, 4),
  };
}
