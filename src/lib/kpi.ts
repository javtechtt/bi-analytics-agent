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
    label: "Gross Profit",
    candidates: ["gross_profit", "profit", "net_profit", "earnings", "net_income"],
    aggregation: "sum",
    priority: 1,
  },
  {
    label: "Revenue",
    candidates: ["gross_revenue", "net_revenue", "revenue", "total_revenue", "sales", "total_sales", "income", "turnover", "amount", "total_amount"],
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
    // Partial match — only accept if unambiguous (exactly one column matches)
    const matches = dataColumns.filter((c) => c.toLowerCase().includes(candidate));
    if (matches.length === 1) return matches[0];
    // If multiple matches, skip this candidate and try the next one (more specific candidates first)
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

/** Extract a sortable numeric value from period strings like "Q1 2024", "2024-Q3", "Jan 2025", etc. */
function parseNumericPeriod(s: string): number | null {
  // "2024" → 2024
  if (/^\d{4}$/.test(s.trim())) return parseInt(s.trim(), 10);
  // "2024-01", "2024/03" → 2024.01
  const ymd = s.match(/(\d{4})[\-\/](\d{1,2})/);
  if (ymd) return parseInt(ymd[1], 10) + parseInt(ymd[2], 10) / 100;
  // "Q1 2024", "Q3-2024" → 2024.1
  const qy = s.match(/Q(\d)\s*[\-\/]?\s*(\d{4})/i) ?? s.match(/(\d{4})\s*[\-\/]?\s*Q(\d)/i);
  if (qy) {
    const parts = s.match(/Q(\d)/i);
    const year = s.match(/(\d{4})/);
    if (parts && year) return parseInt(year[1], 10) + parseInt(parts[1], 10) / 10;
  }
  // "Jan 2024", "March 2025"
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const my = s.match(/([a-zA-Z]+)\s*(\d{4})/);
  if (my) {
    const mi = months.findIndex((m) => my[1].toLowerCase().startsWith(m));
    if (mi >= 0) return parseInt(my[2], 10) + (mi + 1) / 100;
  }
  return null;
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

    // Try to sort chronologically by parsing as dates; fall back to natural string sort
    const ordered = timeValues.sort((a, b) => {
      const da = Date.parse(a);
      const db = Date.parse(b);
      // Both valid dates → sort chronologically
      if (!isNaN(da) && !isNaN(db)) return da - db;
      // One or both not parseable → try numeric extraction (e.g., "Q1 2024" → 2024.1)
      const na = parseNumericPeriod(a);
      const nb = parseNumericPeriod(b);
      if (na !== null && nb !== null) return na - nb;
      // Fall back to locale string comparison
      return a.localeCompare(b, undefined, { numeric: true });
    });

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
