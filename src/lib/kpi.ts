/**
 * KPI selection logic.
 * Dynamically picks the best available KPI metrics from any dataset
 * by matching column names against known business metric patterns.
 */

import type { ParsedData } from "./types";
import { formatLabel, formatKpiValue, formatDelta } from "./labels";

// ── KPI definitions ──────────────────────────────────────

interface KpiDefinition {
  /** Display name */
  label: string;
  /** Candidate column names (first match wins) */
  candidates: string[];
  /** How to aggregate: sum the column, or use the last value, or compute */
  aggregation: "sum" | "avg" | "last" | "count";
  /** Optional: format as percentage */
  isPercent?: boolean;
  /** Priority for ordering (lower = higher priority) */
  priority: number;
}

const KPI_CATALOG: KpiDefinition[] = [
  {
    label: "Revenue",
    candidates: ["gross_revenue", "net_revenue", "revenue", "total_revenue", "sales", "total_sales", "income", "turnover", "amount", "total_amount"],
    aggregation: "sum",
    priority: 1,
  },
  {
    label: "Gross Profit",
    candidates: ["gross_profit", "profit", "net_profit", "earnings", "margin"],
    aggregation: "sum",
    priority: 2,
  },
  {
    label: "Gross Margin",
    candidates: ["gross_margin_pct", "margin_pct", "gross_margin", "profit_margin"],
    aggregation: "avg",
    isPercent: true,
    priority: 3,
  },
  {
    label: "Units Sold",
    candidates: ["units_sold", "quantity", "qty", "units", "volume", "count"],
    aggregation: "sum",
    priority: 4,
  },
  {
    label: "Return Rate",
    candidates: ["return_rate", "refund_rate", "returns_pct"],
    aggregation: "avg",
    isPercent: true,
    priority: 5,
  },
  {
    label: "ROAS",
    candidates: ["roas", "return_on_ad_spend"],
    aggregation: "avg",
    priority: 6,
  },
  {
    label: "Avg Order Value",
    candidates: ["average_selling_price", "aov", "avg_order_value", "avg_price", "unit_price"],
    aggregation: "avg",
    priority: 7,
  },
  {
    label: "Cost",
    candidates: ["cost", "total_cost", "costs", "cogs", "cost_of_goods", "expense"],
    aggregation: "sum",
    priority: 8,
  },
  {
    label: "Discount",
    candidates: ["discount_pct", "discount_amount", "discount", "rebate"],
    aggregation: "avg",
    priority: 9,
  },
  {
    label: "Sessions",
    candidates: ["site_sessions", "sessions", "visits", "traffic"],
    aggregation: "sum",
    priority: 10,
  },
  {
    label: "Conversion Rate",
    candidates: ["conversion_rate", "cvr", "conv_rate"],
    aggregation: "avg",
    isPercent: true,
    priority: 11,
  },
];

// ── KPI card output ──────────────────────────────────────

export interface KpiCard {
  label: string;
  value: string;
  rawValue: number;
  column: string;
  delta?: string;
  deltaPositive?: boolean;
  isPercent: boolean;
}

// ── Column matcher ───────────────────────────────────────

function findColumn(candidates: string[], dataColumns: string[]): string | null {
  for (const candidate of candidates) {
    // Exact match (case-insensitive)
    const exact = dataColumns.find((c) => c.toLowerCase() === candidate);
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    // Partial match
    const partial = dataColumns.find((c) => c.toLowerCase().includes(candidate));
    if (partial) return partial;
  }
  return null;
}

// ── Compute KPI value from data ──────────────────────────

function computeKpi(
  data: ParsedData,
  column: string,
  aggregation: "sum" | "avg" | "last" | "count"
): number | null {
  const values = data.rows
    .map((r) => r[column])
    .filter((v) => v != null && v !== "")
    .map(Number)
    .filter((n) => !isNaN(n));

  if (values.length === 0) return null;

  switch (aggregation) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "last":
      return values[values.length - 1];
    case "count":
      return values.length;
  }
}

// ── Main: select KPIs from a dataset ─────────────────────

export function selectKpis(data: ParsedData, maxCards = 6): KpiCard[] {
  if (!data || data.columns.length === 0 || data.rows.length === 0) return [];

  const lowerColumns = data.columns.map((c) => c.toLowerCase());
  const cards: KpiCard[] = [];

  // Detect time column for delta computation
  const timeKeywords = ["date", "month", "quarter", "year", "period", "week"];
  const timeCol = data.columns.find((c) => data.columnTypes[c] === "date") ??
    data.columns.find((c) => timeKeywords.some((k) => c.toLowerCase().includes(k)));

  // Split data into current and previous period for deltas
  let currentRows = data.rows;
  let previousRows: typeof data.rows = [];

  if (timeCol) {
    const timeValues = [...new Set(data.rows.map((r) => String(r[timeCol] ?? "")))].filter(Boolean);
    // Order by appearance in data
    const orderMap = new Map<string, number>();
    for (const row of data.rows) {
      const t = String(row[timeCol] ?? "");
      if (t && !orderMap.has(t)) orderMap.set(t, orderMap.size);
    }
    const ordered = timeValues.sort((a, b) => (orderMap.get(a) ?? 0) - (orderMap.get(b) ?? 0));

    if (ordered.length >= 2) {
      const lastPeriod = ordered[ordered.length - 1];
      const prevPeriod = ordered[ordered.length - 2];
      currentRows = data.rows.filter((r) => String(r[timeCol] ?? "") === lastPeriod);
      previousRows = data.rows.filter((r) => String(r[timeCol] ?? "") === prevPeriod);
    }
  }

  for (const def of KPI_CATALOG) {
    if (cards.length >= maxCards) break;

    const column = findColumn(def.candidates, lowerColumns);
    if (!column) continue;

    const actualCol = data.columns.find((c) => c.toLowerCase() === column) ?? column;
    const rawValue = computeKpi(data, actualCol, def.aggregation);
    if (rawValue == null) continue;

    if (cards.some((c) => c.column === actualCol)) continue;

    const value = def.isPercent
      ? `${rawValue.toFixed(1)}%`
      : formatKpiValue(rawValue);

    // Compute delta if we have period data
    let delta: string | undefined;
    let deltaPositive: boolean | undefined;

    if (previousRows.length > 0 && currentRows.length > 0) {
      const currentVal = computeKpiFromRows(currentRows, actualCol, def.aggregation);
      const prevVal = computeKpiFromRows(previousRows, actualCol, def.aggregation);

      if (currentVal != null && prevVal != null && prevVal !== 0) {
        const pctChange = ((currentVal - prevVal) / Math.abs(prevVal)) * 100;
        delta = formatDelta(pctChange);
        deltaPositive = pctChange >= 0;
      }
    }

    cards.push({
      label: def.label,
      value,
      rawValue,
      column: actualCol,
      isPercent: def.isPercent ?? false,
      delta,
      deltaPositive,
    });
  }

  return cards;
}

/** Compute KPI from a subset of rows (for delta calculation) */
function computeKpiFromRows(
  rows: Array<Record<string, string | number | null>>,
  column: string,
  aggregation: "sum" | "avg" | "last" | "count"
): number | null {
  const values = rows
    .map((r) => r[column])
    .filter((v) => v != null && v !== "")
    .map(Number)
    .filter((n) => !isNaN(n));

  if (values.length === 0) return null;

  switch (aggregation) {
    case "sum": return values.reduce((a, b) => a + b, 0);
    case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
    case "last": return values[values.length - 1];
    case "count": return values.length;
  }
}

// Re-export formatLabel for convenience
export { formatLabel, formatKpiValue, formatDelta };
