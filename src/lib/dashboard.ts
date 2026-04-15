/**
 * AI Dashboard Generator.
 * Automatically builds a BI summary dashboard from any dataset.
 * Selects KPIs, charts, insights, risks, and opportunities.
 */

import type { ParsedData } from "./types";
import { selectKpis, type KpiCard } from "./kpi";
import { formatLabel } from "./labels";
import { analyzeDataset, type StructuredInsight } from "./insights";

// ── Dashboard schema ─────────────────────────────────────

export interface DashboardChart {
  chart_type: "bar" | "line" | "pie" | "scatter";
  title: string;
  metric: string;
  group_by: string;
  aggregation: string;
  split_by?: string;
  priority: number;
  rationale: string;
}

export interface DashboardConfig {
  title: string;
  subtitle: string;
  kpis: KpiCard[];
  charts: DashboardChart[];
  insights: StructuredInsight[];
  risks: StructuredInsight[];
  opportunities: StructuredInsight[];
  drilldowns: string[];
}

// ── Time/date column detection ───────────────────────────

function findTimeColumn(data: ParsedData): string | null {
  // Check declared date types first
  for (const col of data.columns) {
    if (data.columnTypes[col] === "date") return col;
  }
  // Heuristic: column name contains time-related keywords
  const timeKeywords = ["date", "month", "quarter", "year", "period", "week", "time", "day"];
  for (const col of data.columns) {
    const lower = col.toLowerCase();
    if (timeKeywords.some((k) => lower.includes(k))) return col;
  }
  return null;
}

// ── Category column detection ────────────────────────────

function findCategoryColumns(data: ParsedData, exclude: string[]): string[] {
  const excludeSet = new Set(exclude.map((c) => c.toLowerCase()));
  return data.columns.filter((c) => {
    if (excludeSet.has(c.toLowerCase())) return false;
    if (data.columnTypes[c] === "numeric") return false;
    // Must have reasonable cardinality (2–30 unique values)
    const unique = new Set(data.rows.slice(0, 500).map((r) => String(r[c] ?? "")));
    return unique.size >= 2 && unique.size <= 30;
  });
}

// (findNumericColumns removed — not needed after insight engine integration)

// ── Primary metric detection ─────────────────────────────

// Profit first — revenue is vanity, profit is reality.
// Every business cares about profit. Revenue is context, profit is the outcome.
export const PROFIT_CANDIDATES = ["gross_profit", "profit", "net_profit", "earnings", "net_income"];
export const REVENUE_CANDIDATES = ["gross_revenue", "net_revenue", "revenue", "sales", "total_sales", "income", "amount"];

/** Find the best column from a candidate list. Returns null if not found. */
function matchCandidate(candidates: string[], lower: string[], columns: string[]): string | null {
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate);
    if (idx >= 0) return columns[idx];
  }
  // Partial match only if unambiguous
  for (const candidate of candidates) {
    const matches = lower.map((c, i) => c.includes(candidate) ? i : -1).filter((i) => i >= 0);
    if (matches.length === 1) return columns[matches[0]];
  }
  return null;
}

/** Primary metric: profit first, then revenue, then first numeric column. */
export function findPrimaryMetric(data: ParsedData): string | null {
  const lower = data.columns.map((c) => c.toLowerCase());
  // 1. Profit — the metric that matters most to business users
  const profit = matchCandidate(PROFIT_CANDIDATES, lower, data.columns);
  if (profit) return profit;
  // 2. Revenue — if no profit column, revenue is the next best
  const revenue = matchCandidate(REVENUE_CANDIDATES, lower, data.columns);
  if (revenue) return revenue;
  // 3. Fallback: first numeric column
  return data.columns.find((c) => data.columnTypes[c] === "numeric") ?? null;
}

/** Secondary metric: whichever of profit/revenue wasn't picked as primary. */
export function findSecondaryMetric(data: ParsedData, primary: string): string | null {
  const lower = data.columns.map((c) => c.toLowerCase());
  const primaryLower = primary.toLowerCase();
  // If primary is profit → secondary is revenue
  if (PROFIT_CANDIDATES.some((c) => primaryLower.includes(c))) {
    return matchCandidate(REVENUE_CANDIDATES, lower, data.columns.filter((c) => c !== primary));
  }
  // If primary is revenue → secondary is profit
  if (REVENUE_CANDIDATES.some((c) => primaryLower.includes(c))) {
    return matchCandidate(PROFIT_CANDIDATES, lower, data.columns.filter((c) => c !== primary));
  }
  // If primary is neither → check profit first, then revenue
  const profit = matchCandidate(PROFIT_CANDIDATES, lower, data.columns.filter((c) => c !== primary));
  if (profit) return profit;
  return matchCandidate(REVENUE_CANDIDATES, lower, data.columns.filter((c) => c !== primary));
}

// ── Insight generation ───────────────────────────────────

// Old insight/risk/opportunity functions removed — replaced by src/lib/insights.ts engine

// ── Chart selection ──────────────────────────────────────

function selectCharts(
  data: ParsedData,
  primaryMetric: string | null,
  secondaryMetric: string | null,
  timeCol: string | null,
  categories: string[]
): DashboardChart[] {
  const charts: DashboardChart[] = [];

  if (!primaryMetric) return charts;

  const metricLabel = formatLabel(primaryMetric);

  // 1. Time trend (line chart) — highest priority
  if (timeCol) {
    charts.push({
      chart_type: "line",
      title: `${metricLabel} Over Time`,
      metric: secondaryMetric ? `${primaryMetric},${secondaryMetric}` : primaryMetric,
      group_by: timeCol,
      aggregation: "sum",
      priority: 1,
      rationale: "Primary trend view showing performance over time.",
    });
  }

  // 2. Category comparison (bar chart)
  if (categories.length > 0) {
    const bestCat = categories[0];
    charts.push({
      chart_type: "bar",
      title: `${metricLabel} by ${formatLabel(bestCat)}`,
      metric: primaryMetric,
      group_by: bestCat,
      aggregation: "sum",
      priority: 2,
      rationale: `Comparison across ${formatLabel(bestCat)} categories.`,
    });
  }

  // 3. Composition (pie chart) — only if a category has ≤7 values
  if (categories.length > 0) {
    const pieCat = categories.find((c) => {
      const unique = new Set(data.rows.slice(0, 500).map((r) => String(r[c] ?? "")));
      return unique.size >= 2 && unique.size <= 7;
    });
    if (pieCat && pieCat !== categories[0]) {
      charts.push({
        chart_type: "pie",
        title: `${metricLabel} Share by ${formatLabel(pieCat)}`,
        metric: primaryMetric,
        group_by: pieCat,
        aggregation: "sum",
        priority: 3,
        rationale: `Composition breakdown — ${formatLabel(pieCat)} has ≤7 categories.`,
      });
    }
  }

  // 4. Second category breakdown (bar) — if available
  if (categories.length > 1 && charts.length < 4) {
    const secondCat = categories[1];
    if (!charts.some((c) => c.group_by === secondCat)) {
      charts.push({
        chart_type: "bar",
        title: `${metricLabel} by ${formatLabel(secondCat)}`,
        metric: primaryMetric,
        group_by: secondCat,
        aggregation: "sum",
        priority: 4,
        rationale: `Secondary breakdown by ${formatLabel(secondCat)}.`,
      });
    }
  }

  return charts.sort((a, b) => a.priority - b.priority).slice(0, 4);
}

// ── Main: Generate dashboard config ──────────────────────

export function generateDashboard(data: ParsedData, fileName: string): DashboardConfig {
  const primaryMetric = findPrimaryMetric(data);
  const secondaryMetric = primaryMetric ? findSecondaryMetric(data, primaryMetric) : null;
  const timeCol = findTimeColumn(data);
  const usedCols = [primaryMetric, secondaryMetric, timeCol].filter(Boolean) as string[];
  const categories = findCategoryColumns(data, usedCols);
  const kpis = selectKpis(data);
  const charts = selectCharts(data, primaryMetric, secondaryMetric, timeCol, categories);

  // Run the insight intelligence engine
  const analysis = analyzeDataset(data, primaryMetric, secondaryMetric, timeCol, categories, kpis);
  const { insights, risks, opportunities } = analysis;

  // Drill-down suggestions
  const drilldowns: string[] = [];
  if (categories.length > 0 && primaryMetric) {
    drilldowns.push(`Break down ${formatLabel(primaryMetric)} by ${formatLabel(categories[0])}`);
  }
  if (timeCol && primaryMetric) {
    drilldowns.push(`Show ${formatLabel(primaryMetric)} trend over time`);
  }
  if (categories.length > 1) {
    drilldowns.push(`Compare across ${formatLabel(categories[1])}`);
  }

  const cleanName = fileName.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ");

  return {
    title: `${cleanName} — Executive Summary`,
    subtitle: `${data.totalRows.toLocaleString()} records · ${data.columns.length} fields · Auto-generated`,
    kpis,
    charts,
    insights,
    risks,
    opportunities,
    drilldowns: drilldowns.slice(0, 4),
  };
}
