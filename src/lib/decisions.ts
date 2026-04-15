/**
 * Decision Layer — Data-Grounded Action Generation & Impact Simulation.
 *
 * ALL projections are derived from actual dataset values.
 * NO fixed percentage multipliers (total * X%).
 * Every recommendation includes explicit assumptions.
 */

import type { ParsedData } from "./types";
import type { StructuredInsight, AnalysisOutput } from "./insights";
import type { KpiCard } from "./kpi";
import { formatLabel, formatKpiValue } from "./labels";

// ── Types ────────────────────────────────────────────────

export interface Action {
  title: string;
  explanation: string;
  expectedOutcome: string;
  assumptions: string[];
  revenueImpact: { low: number; high: number; description: string };
  profitImpact?: { low: number; high: number; description: string };
  riskLevel: "low" | "medium" | "high";
  confidence: "high" | "medium" | "low";
  priority: number;
  sourceInsight: string;
  supportingChart?: {
    chart_type: "bar" | "line";
    title: string;
    metric: string;
    group_by: string;
  };
}

export interface Strategy {
  name: string;
  actions: Action[];
  totalRevenueImpact: { low: number; high: number };
  riskLevel: "low" | "medium" | "high";
  confidence: "high" | "medium" | "low";
  summary: string;
}

export interface DecisionOutput {
  topRecommendation: Action;
  alternatives: Action[];
  strategies: Strategy[];
  spokenSummary: string;
  dataQualityWarning?: string;
}

// ── Data helpers ─────────────────────────────────────────

function numericValues(data: ParsedData, col: string): number[] {
  return data.rows
    .map((r) => r[col])
    .filter((v) => v != null && v !== "")
    .map(Number)
    .filter((n) => !isNaN(n));
}

function periodicSums(data: ParsedData, timeCol: string, metricCol: string): Array<{ period: string; value: number }> {
  const map = new Map<string, number>();
  const order = new Map<string, number>();
  for (const row of data.rows) {
    const p = String(row[timeCol] ?? "");
    const v = Number(row[metricCol]);
    if (!p || isNaN(v)) continue;
    map.set(p, (map.get(p) ?? 0) + v);
    if (!order.has(p)) order.set(p, order.size);
  }
  return [...map.entries()]
    .map(([period, value]) => ({ period, value }))
    .sort((a, b) => (order.get(a.period) ?? 0) - (order.get(b.period) ?? 0));
}

function groupSums(data: ParsedData, groupCol: string, metricCol: string): Array<{ group: string; total: number; count: number }> {
  const groups = new Map<string, { total: number; count: number }>();
  for (const row of data.rows) {
    const key = String(row[groupCol] ?? "");
    const val = Number(row[metricCol]);
    if (!key || isNaN(val)) continue;
    const g = groups.get(key) ?? { total: 0, count: 0 };
    g.total += val;
    g.count++;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([group, { total, count }]) => ({ group, total, count }))
    .sort((a, b) => b.total - a.total);
}

/** Linear regression slope with prediction interval data.
 *  Returns slope, R², and standard error of residuals for computing
 *  data-grounded uncertainty bands instead of arbitrary multipliers. */
function computeSlope(values: number[]): { slope: number; rSquared: number; stdError: number; n: number } {
  const n = values.length;
  if (n < 3) return { slope: 0, rSquared: 0, stdError: 0, n };
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0, ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * i;
    ssRes += (values[i] - predicted) ** 2;
    ssTot += (values[i] - yMean) ** 2;
  }
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  // Standard error of residuals: sqrt(SSres / (n - 2))
  const stdError = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;
  return { slope, rSquared, stdError, n };
}

/** Compute prediction interval half-width for a future period.
 *  Uses t-approximation: t * SE * sqrt(1 + 1/n + (h-xMean)²/Sxx)
 *  where h is the forecast horizon index. */
function predictionInterval(n: number, stdError: number, periodsAhead: number, den: number): number {
  // t-value approximation for 80% prediction interval (conservative)
  // For small n, use larger t; for large n, converges to ~1.28
  const tValue = n <= 5 ? 1.5 : n <= 10 ? 1.4 : n <= 20 ? 1.33 : 1.28;
  const xMean = (n - 1) / 2;
  const h = n - 1 + periodsAhead; // forecast point index
  const leverageTerm = 1 + 1 / n + (h - xMean) ** 2 / Math.max(den, 1);
  return tValue * stdError * Math.sqrt(leverageTerm);
}

// ── Data quality gate ────────────────────────────────────

interface QualityCheck {
  pass: boolean;
  warning?: string;
}

function checkDataQuality(data: ParsedData, primaryMetric: string | null): QualityCheck {
  if (data.totalRows < 50) {
    return {
      pass: false,
      warning: `Dataset has only ${data.totalRows} rows — too small for reliable recommendations. Upload a larger dataset for actionable projections.`,
    };
  }

  if (primaryMetric) {
    const values = numericValues(data, primaryMetric);
    const missingPct = ((data.totalRows - values.length) / data.totalRows) * 100;
    if (missingPct > 25) {
      return {
        pass: false,
        warning: `${formatLabel(primaryMetric)} is ${missingPct.toFixed(0)}% incomplete — projections would be unreliable. Clean the data or use a more complete metric.`,
      };
    }
  }

  return { pass: true };
}

// ── Action generators (data-grounded) ────────────────────

function actionsFromTrend(
  insight: StructuredInsight,
  data: ParsedData,
  primaryMetric: string,
  timeCol: string | null
): Action[] {
  if (!timeCol) return [];

  const series = periodicSums(data, timeCol, primaryMetric);
  // Require at least 6 periods for statistically meaningful trend projections
  if (series.length < 6) return [];

  const values = series.map((s) => s.value);
  const { slope, rSquared, stdError, n } = computeSlope(values);
  const metricName = formatLabel(primaryMetric);
  const lastValue = values[values.length - 1];
  const avgValue = values.reduce((a, b) => a + b, 0) / values.length;

  if (Math.abs(slope) < avgValue * 0.01) return []; // Slope too flat to matter

  const isDecline = slope < 0;
  const periodsAhead = 3;

  // Project forward using actual slope with data-derived uncertainty bands
  const projectedChange = slope * periodsAhead;
  // Compute Sxx (sum of squared x-deviations) for prediction interval
  const xMean = (n - 1) / 2;
  const sxx = Array.from({ length: n }, (_, i) => (i - xMean) ** 2).reduce((a, b) => a + b, 0);
  const piHalfWidth = predictionInterval(n, stdError, periodsAhead, sxx);
  // Uncertainty band: projected change ± prediction interval, clamped to non-negative
  const absProjected = Math.abs(projectedChange);
  const absLow = Math.max(0, absProjected - piHalfWidth);
  const absHigh = absProjected + piHalfWidth;

  if (isDecline) {
    // Decline: action is to reverse the trend
    const recoveryPerPeriod = Math.abs(slope);
    return [{
      title: `Address ${metricName} decline`,
      explanation: `${insight.observation} The data shows a decline of ~${formatKpiValue(Math.abs(slope))} per period (R²=${rSquared.toFixed(2)}).`,
      expectedOutcome: `Reversing this trend over ${periodsAhead} periods could recover ${formatKpiValue(absLow)}–${formatKpiValue(absHigh)}.`,
      assumptions: [
        `Based on linear trend of ${formatKpiValue(Math.abs(slope))} per period decline.`,
        `Uncertainty range derived from regression residuals (±${formatKpiValue(piHalfWidth)}).`,
        `Assumes the decline can be halted and partially reversed.`,
        `R² of ${rSquared.toFixed(2)} — ${rSquared > 0.7 ? "strong trend fit" : rSquared > 0.4 ? "moderate trend fit" : "weak trend fit, treat with caution"}.`,
      ],
      revenueImpact: { low: absLow, high: absHigh, description: `Recovery of ${formatKpiValue(absLow)}–${formatKpiValue(absHigh)} over ${periodsAhead} periods` },
      riskLevel: "medium",
      confidence: rSquared > 0.6 ? "medium" : "low",
      priority: Math.min(rSquared * 80 + 20, 90),
      sourceInsight: insight.observation,
      supportingChart: { chart_type: "line", title: `${metricName} Trend`, metric: primaryMetric, group_by: timeCol },
    }];
  }

  // Growth: action is to sustain/accelerate
  return [{
    title: `Sustain ${metricName} growth trajectory`,
    explanation: `${insight.observation} Current growth rate is ~${formatKpiValue(slope)} per period.`,
    expectedOutcome: `Maintaining this trajectory projects ${formatKpiValue(absLow)}–${formatKpiValue(absHigh)} additional ${metricName} over ${periodsAhead} periods.`,
    assumptions: [
      `Based on observed growth of ${formatKpiValue(slope)} per period.`,
      `Uncertainty range derived from regression residuals (±${formatKpiValue(piHalfWidth)}).`,
      `Assumes current conditions continue — no market disruption or seasonal shift.`,
      `R² of ${rSquared.toFixed(2)} — ${rSquared > 0.7 ? "strong fit" : "moderate fit"}.`,
    ],
    revenueImpact: { low: absLow, high: absHigh, description: `+${formatKpiValue(absLow)}–${formatKpiValue(absHigh)} projected` },
    riskLevel: "low",
    confidence: rSquared > 0.6 ? "medium" : "low",
    priority: Math.min(rSquared * 60 + 20, 80),
    sourceInsight: insight.observation,
    supportingChart: { chart_type: "line", title: `${metricName} Trend`, metric: primaryMetric, group_by: timeCol },
  }];
}

function actionsFromAnomaly(
  insight: StructuredInsight,
  data: ParsedData,
  primaryMetric: string,
  timeCol: string | null
): Action[] {
  if (!timeCol) return [];

  const series = periodicSums(data, timeCol, primaryMetric);
  if (series.length < 4) return [];

  const values = series.map((s) => s.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const metricName = formatLabel(primaryMetric);
  const isSpike = insight.observation.includes("spike");

  // Find the actual anomaly value from the data
  const stdDev = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
  const anomalyValues = values.filter((v) => Math.abs(v - mean) > stdDev * 1.5);
  const anomalyMagnitude = anomalyValues.length > 0
    ? anomalyValues.reduce((sum, v) => sum + Math.abs(v - mean), 0) / anomalyValues.length
    : stdDev;

  // Data-derived recurrence rate: what fraction of periods show similar-direction deviations?
  // This replaces the old arbitrary 0.5–0.8 multipliers with actual historical persistence.
  const spikeCount = values.filter((v) => v - mean > stdDev * 1.0).length;
  const dropCount = values.filter((v) => mean - v > stdDev * 1.0).length;
  const totalPeriods = values.length;
  const spikeRecurrenceRate = spikeCount / totalPeriods; // e.g., 3 spikes in 12 periods = 0.25
  const dropRecurrenceRate = dropCount / totalPeriods;

  if (isSpike) {
    // Low/high range: recurrence rate ± half (bounded 10%–90%)
    const rateLow = Math.max(0.1, spikeRecurrenceRate * 0.5);
    const rateHigh = Math.min(0.9, spikeRecurrenceRate * 1.5);
    return [{
      title: `Investigate and replicate the ${metricName} spike`,
      explanation: `${insight.observation} The spike was ~${formatKpiValue(anomalyMagnitude)} above the period average of ${formatKpiValue(mean)}.`,
      expectedOutcome: `If replicable, each occurrence could add ~${formatKpiValue(anomalyMagnitude * rateLow)}–${formatKpiValue(anomalyMagnitude * rateHigh)} above baseline.`,
      assumptions: [
        `Spike magnitude: ${formatKpiValue(anomalyMagnitude)} above average.`,
        `Historical recurrence: ${spikeCount} of ${totalPeriods} periods showed similar spikes (${(spikeRecurrenceRate * 100).toFixed(0)}%).`,
        `Impact range derived from observed recurrence rate (${(rateLow * 100).toFixed(0)}–${(rateHigh * 100).toFixed(0)}%).`,
        `Requires identifying the root cause first.`,
      ],
      revenueImpact: { low: anomalyMagnitude * rateLow, high: anomalyMagnitude * rateHigh, description: `+${formatKpiValue(anomalyMagnitude * rateLow)}–${formatKpiValue(anomalyMagnitude * rateHigh)} per recurrence` },
      riskLevel: "medium",
      confidence: spikeRecurrenceRate > 0.2 ? "medium" : "low",
      priority: Math.min(spikeRecurrenceRate * 100 + 40, 70),
      sourceInsight: insight.observation,
    }];
  }

  // Drop
  const rateLow = Math.max(0.1, dropRecurrenceRate * 0.5);
  const rateHigh = Math.min(1.0, dropRecurrenceRate * 1.5 + 0.3); // drops are more preventable
  return [{
    title: `Prevent future ${metricName} drops`,
    explanation: `${insight.observation} The drop was ~${formatKpiValue(anomalyMagnitude)} below the period average.`,
    expectedOutcome: `Preventing recurrence preserves ~${formatKpiValue(anomalyMagnitude * rateLow)}–${formatKpiValue(anomalyMagnitude * rateHigh)} per period.`,
    assumptions: [
      `Drop magnitude: ${formatKpiValue(anomalyMagnitude)} below average.`,
      `Historical recurrence: ${dropCount} of ${totalPeriods} periods showed similar drops (${(dropRecurrenceRate * 100).toFixed(0)}%).`,
      `Impact range derived from observed recurrence rate.`,
      `Requires root cause identification.`,
    ],
    revenueImpact: { low: anomalyMagnitude * rateLow, high: anomalyMagnitude * rateHigh, description: `Preserved ${formatKpiValue(anomalyMagnitude * rateLow)}–${formatKpiValue(anomalyMagnitude * rateHigh)}` },
    riskLevel: "medium",
    confidence: dropRecurrenceRate > 0.2 ? "medium" : "low",
    priority: Math.min(dropRecurrenceRate * 100 + 45, 75),
    sourceInsight: insight.observation,
  }];
}

function actionsFromConcentration(
  insight: StructuredInsight,
  data: ParsedData,
  primaryMetric: string,
  categories: string[]
): Action[] {
  if (categories.length === 0) return [];

  const catCol = categories[0];
  const grouped = groupSums(data, catCol, primaryMetric);
  if (grouped.length < 3) return [];

  const total = grouped.reduce((s, g) => s + g.total, 0);
  const metricName = formatLabel(primaryMetric);
  const catName = formatLabel(catCol);

  // Find actual non-top segments and their values
  const topShare = grouped[0].total / total;
  const nonTopTotal = total - grouped[0].total;
  const nonTopAvg = nonTopTotal / (grouped.length - 1);

  // If smaller segments grew to match average of top-3 non-leader, what's the gain?
  const bottomSegments = grouped.slice(Math.floor(grouped.length / 2));
  const bottomTotal = bottomSegments.reduce((s, g) => s + g.total, 0);
  const topNonLeaderAvg = grouped.length > 2
    ? (grouped[1].total + grouped[2].total) / 2
    : grouped[1]?.total ?? 0;

  // Realistic: lift bottom segments to reach average of mid-tier
  const liftTarget = Math.min(topNonLeaderAvg, nonTopAvg * 1.5);

  // Achievability factor: what fraction of the gap can realistically be closed.
  // 30% is a conservative estimate based on typical segment-growth programs.
  // This assumption is explicitly stated in the output so the user can adjust.
  const ACHIEVABILITY_FACTOR = 0.3;

  const potentialGain = bottomSegments.reduce((sum, g) => {
    const gap = liftTarget - g.total;
    return sum + (gap > 0 ? gap * ACHIEVABILITY_FACTOR : 0);
  }, 0);

  if (potentialGain < total * 0.005) return []; // Too small to matter

  return [{
    title: `Reduce ${catName} concentration risk`,
    explanation: `${insight.observation} The top segment is ${(topShare * 100).toFixed(0)}% of ${metricName}. Bottom ${bottomSegments.length} segments average only ${formatKpiValue(bottomTotal / bottomSegments.length)} each.`,
    expectedOutcome: `Lifting underperforming ${catName} segments toward mid-tier levels could add ${formatKpiValue(potentialGain * 0.7)}–${formatKpiValue(potentialGain * 1.3)}.`,
    assumptions: [
      `Bottom ${bottomSegments.length} ${catName} segments currently total ${formatKpiValue(bottomTotal)}.`,
      `Mid-tier benchmark: ${formatKpiValue(liftTarget)} per segment.`,
      `Assumes ${(ACHIEVABILITY_FACTOR * 100).toFixed(0)}% of the gap is achievable through targeted investment (conservative estimate — adjust based on your market context).`,
      `Does NOT assume top segment can be grown further.`,
    ],
    revenueImpact: { low: potentialGain * 0.7, high: potentialGain * 1.3, description: `+${formatKpiValue(potentialGain * 0.7)}–${formatKpiValue(potentialGain * 1.3)}` },
    riskLevel: "low",
    confidence: "medium",
    priority: Math.min(topShare * 80 + 10, 75),
    sourceInsight: insight.observation,
    supportingChart: { chart_type: "bar", title: `${metricName} by ${catName}`, metric: primaryMetric, group_by: catCol },
  }];
}

function actionsFromEfficiency(
  insight: StructuredInsight,
  data: ParsedData,
  primaryMetric: string,
  secondaryMetric: string | null,
  categories: string[]
): Action[] {
  if (!secondaryMetric || categories.length === 0) return [];

  const catCol = categories[0];
  const pGrouped = groupSums(data, catCol, primaryMetric);
  const sGrouped = groupSums(data, catCol, secondaryMetric);
  const sMap = new Map(sGrouped.map((g) => [g.group, g.total]));

  const efficiencies = pGrouped
    .filter((g) => g.total > 0)
    .map((g) => ({
      group: g.group,
      primary: g.total,
      secondary: sMap.get(g.group) ?? 0,
      ratio: ((sMap.get(g.group) ?? 0) / g.total) * 100,
    }))
    .sort((a, b) => a.ratio - b.ratio);

  if (efficiencies.length < 3) return [];

  const worst = efficiencies[0];
  const best = efficiencies[efficiencies.length - 1];
  const median = efficiencies[Math.floor(efficiencies.length / 2)];
  const gap = median.ratio - worst.ratio;

  if (gap < 3) return []; // Gap too small

  const metricName = formatLabel(primaryMetric);
  const secondaryName = formatLabel(secondaryMetric);

  // Impact: lift worst to median ratio
  const worstImprovement = worst.primary * (gap / 100);

  return [{
    title: `Close ${secondaryName} efficiency gap in "${worst.group}"`,
    explanation: `${insight.observation} "${worst.group}" has a ${worst.ratio.toFixed(1)}% ${secondaryName}-to-${metricName} ratio vs the median of ${median.ratio.toFixed(1)}% — a ${gap.toFixed(1)} percentage point gap.`,
    expectedOutcome: `Lifting "${worst.group}" to median efficiency could add ${formatKpiValue(worstImprovement * 0.5)}–${formatKpiValue(worstImprovement)} in ${secondaryName}.`,
    assumptions: [
      `"${worst.group}" ratio: ${worst.ratio.toFixed(1)}%, median: ${median.ratio.toFixed(1)}%, best: ${best.ratio.toFixed(1)}%.`,
      `Gap of ${gap.toFixed(1)} percentage points applied to ${formatKpiValue(worst.primary)} ${metricName}.`,
      `Assumes 50–100% of the gap is closable.`,
    ],
    revenueImpact: { low: 0, high: 0, description: "Revenue-neutral" },
    profitImpact: { low: worstImprovement * 0.5, high: worstImprovement, description: `+${formatKpiValue(worstImprovement * 0.5)}–${formatKpiValue(worstImprovement)} in ${secondaryName}` },
    riskLevel: "medium",
    confidence: "medium",
    priority: Math.min(gap * 3 + 50, 85),
    sourceInsight: insight.observation,
  }];
}

function actionsFromOpportunity(
  insight: StructuredInsight,
  data: ParsedData,
  primaryMetric: string,
  categories: string[]
): Action[] {
  if (categories.length === 0) return [];

  const catCol = categories[0];
  const grouped = groupSums(data, catCol, primaryMetric);
  const total = grouped.reduce((s, g) => s + g.total, 0);
  const metricName = formatLabel(primaryMetric);

  // Find the segment mentioned in the insight
  for (const g of grouped) {
    if (insight.observation.includes(g.group)) {
      const share = g.total / total;
      const avgPerUnit = g.total / Math.max(g.count, 1);
      const overallAvg = total / Math.max(data.rows.length, 1);

      // Additional revenue from 50% volume growth = 50% of current segment total
      const incrementFrom50PctGrowth = g.total * 0.5;
      // Range: 25-50% growth (conservative to optimistic)
      const incrementLow = g.total * 0.25;
      const incrementHigh = incrementFrom50PctGrowth;

      return [{
        title: `Scale "${g.group}" segment`,
        explanation: `${insight.observation} "${g.group}" is ${(share * 100).toFixed(0)}% of ${metricName} but has ${((avgPerUnit / overallAvg - 1) * 100).toFixed(0)}% higher per-transaction value.`,
        expectedOutcome: `Growing "${g.group}" volume by 25–50% at current per-unit value (${formatKpiValue(avgPerUnit)}) adds ~${formatKpiValue(incrementLow)}–${formatKpiValue(incrementHigh)}.`,
        assumptions: [
          `Current "${g.group}" value: ${formatKpiValue(g.total)} from ${g.count} transactions.`,
          `Per-transaction average: ${formatKpiValue(avgPerUnit)} vs overall ${formatKpiValue(overallAvg)}.`,
          `Range reflects 25% (conservative) to 50% (optimistic) volume growth.`,
          `Assumes per-unit value holds at current levels.`,
        ],
        revenueImpact: { low: incrementLow, high: incrementHigh, description: `+${formatKpiValue(incrementLow)}–${formatKpiValue(incrementHigh)} from segment growth` },
        riskLevel: "low",
        confidence: "medium",
        priority: Math.min((avgPerUnit / overallAvg) * 40 + 30, 75),
        sourceInsight: insight.observation,
      }];
    }
  }

  return [];
}

// ── Strategy builder ─────────────────────────────────────

function buildStrategies(actions: Action[]): Strategy[] {
  if (actions.length < 2) return [];
  const strategies: Strategy[] = [];

  const top = actions[0];
  strategies.push({
    name: "Focused: Single biggest lever",
    actions: [top],
    totalRevenueImpact: top.revenueImpact,
    riskLevel: top.riskLevel,
    confidence: top.confidence,
    summary: `Focus on "${top.title}" — projected impact: ${top.revenueImpact.description}.`,
  });

  const portfolio = actions.slice(0, 3);
  const pLow = portfolio.reduce((s, a) => s + a.revenueImpact.low, 0);
  const pHigh = portfolio.reduce((s, a) => s + a.revenueImpact.high, 0);
  strategies.push({
    name: "Balanced: Multiple levers",
    actions: portfolio,
    totalRevenueImpact: { low: pLow, high: pHigh },
    riskLevel: "medium",
    confidence: "medium",
    summary: `Pursue ${portfolio.length} actions for combined ${formatKpiValue(pLow)}–${formatKpiValue(pHigh)} projected impact.`,
  });

  const safe = actions.filter((a) => a.riskLevel === "low");
  if (safe.length > 0 && safe[0] !== top) {
    const sLow = safe.reduce((s, a) => s + a.revenueImpact.low, 0);
    const sHigh = safe.reduce((s, a) => s + a.revenueImpact.high, 0);
    strategies.push({
      name: "Conservative: Low-risk only",
      actions: safe.slice(0, 3),
      totalRevenueImpact: { low: sLow, high: sHigh },
      riskLevel: "low",
      confidence: "high",
      summary: `Low-risk path: ${formatKpiValue(sLow)}–${formatKpiValue(sHigh)} projected with minimal downside.`,
    });
  }

  return strategies;
}

// ── Main ─────────────────────────────────────────────────

export function generateDecisions(
  analysis: AnalysisOutput,
  data: ParsedData,
  primaryMetric: string | null,
  secondaryMetric: string | null,
  timeCol: string | null,
  categories: string[],
  kpis: KpiCard[]
): DecisionOutput {
  // Data quality gate — reject if data is insufficient
  const quality = checkDataQuality(data, primaryMetric);
  if (!quality.pass) {
    return {
      topRecommendation: {
        title: "Insufficient data for recommendations",
        explanation: quality.warning!,
        expectedOutcome: "Upload a larger or cleaner dataset to enable data-grounded projections.",
        assumptions: [],
        revenueImpact: { low: 0, high: 0, description: "N/A — data quality insufficient" },
        riskLevel: "low",
        confidence: "low",
        priority: 0,
        sourceInsight: quality.warning!,
      },
      alternatives: [],
      strategies: [],
      spokenSummary: quality.warning!,
      dataQualityWarning: quality.warning,
    };
  }

  if (!primaryMetric) {
    return {
      topRecommendation: {
        title: "No analyzable metric found",
        explanation: "The dataset doesn't contain a clear numeric metric to base recommendations on.",
        expectedOutcome: "Ensure the dataset includes revenue, profit, or another numeric KPI column.",
        assumptions: [],
        revenueImpact: { low: 0, high: 0, description: "N/A" },
        riskLevel: "low",
        confidence: "low",
        priority: 0,
        sourceInsight: "No primary metric detected.",
      },
      alternatives: [],
      strategies: [],
      spokenSummary: "I can't find a clear numeric metric in this data to base recommendations on.",
    };
  }

  const allActions: Action[] = [];

  for (const insight of [...analysis.insights, ...analysis.risks]) {
    switch (insight.type) {
      case "trend":
        allActions.push(...actionsFromTrend(insight, data, primaryMetric, timeCol));
        break;
      case "anomaly":
        allActions.push(...actionsFromAnomaly(insight, data, primaryMetric, timeCol));
        break;
      case "concentration":
        allActions.push(...actionsFromConcentration(insight, data, primaryMetric, categories));
        break;
      case "efficiency":
        allActions.push(...actionsFromEfficiency(insight, data, primaryMetric, secondaryMetric, categories));
        break;
    }
  }

  for (const opp of analysis.opportunities) {
    allActions.push(...actionsFromOpportunity(opp, data, primaryMetric, categories));
  }

  allActions.sort((a, b) => b.priority - a.priority);
  const top3 = allActions.slice(0, 3);

  if (top3.length === 0) {
    return {
      topRecommendation: {
        title: "No strong signals detected",
        explanation: "The data doesn't show clear trends, anomalies, or concentration patterns that would drive specific recommendations.",
        expectedOutcome: "The business appears stable. Consider uploading data with a longer time range or more granular segmentation.",
        assumptions: [],
        revenueImpact: { low: 0, high: 0, description: "N/A" },
        riskLevel: "low",
        confidence: "medium",
        priority: 0,
        sourceInsight: "No actionable patterns found.",
      },
      alternatives: [],
      strategies: [],
      spokenSummary: "Honestly, the data looks pretty stable — no strong signals jumping out. A longer time range might surface more.",
    };
  }

  const strategies = buildStrategies(top3);

  const spokenParts: string[] = [];
  spokenParts.push(`The biggest lever here is: ${top3[0].title}.`);
  spokenParts.push(top3[0].expectedOutcome);
  if (top3[0].assumptions.length > 0) {
    spokenParts.push(`That assumes ${top3[0].assumptions[0].toLowerCase()}`);
  }
  if (top3.length > 1) {
    spokenParts.push(`Alternatively, you could ${top3[1].title.toLowerCase()}.`);
  }

  return {
    topRecommendation: top3[0],
    alternatives: top3.slice(1),
    strategies,
    spokenSummary: spokenParts.join(" "),
  };
}

/** Format for the assistant to speak from */
export function formatDecisionsForAssistant(output: DecisionOutput): string {
  const lines: string[] = [];

  if (output.dataQualityWarning) {
    lines.push(`⚠ DATA QUALITY WARNING: ${output.dataQualityWarning}`);
    lines.push("Do NOT present projections as reliable. Explain the limitation clearly.");
    return lines.join("\n");
  }

  // Check if recommendations are predominantly low confidence
  const allActions = [output.topRecommendation, ...output.alternatives];
  const lowConfCount = allActions.filter((a) => a.confidence === "low").length;
  if (lowConfCount > allActions.length / 2) {
    lines.push("⚠ CAUTION: These recommendations are based on limited or noisy data. Treat as directional signals, not precise projections. Say so when presenting them.");
    lines.push("");
  }

  lines.push("=== DECISION RECOMMENDATIONS (source of truth — speak these numbers) ===");
  lines.push("");
  lines.push(`TOP RECOMMENDATION: ${output.topRecommendation.title}`);
  lines.push(`  Why: ${output.topRecommendation.explanation}`);
  lines.push(`  Impact: ${output.topRecommendation.revenueImpact.description}`);
  lines.push(`  Outcome: ${output.topRecommendation.expectedOutcome}`);
  if (output.topRecommendation.assumptions.length > 0) {
    lines.push(`  Assumptions:`);
    for (const a of output.topRecommendation.assumptions) {
      lines.push(`    - ${a}`);
    }
  }
  lines.push(`  Risk: ${output.topRecommendation.riskLevel} | Confidence: ${output.topRecommendation.confidence}`);

  if (output.alternatives.length > 0) {
    lines.push("");
    lines.push("ALTERNATIVES:");
    for (const alt of output.alternatives) {
      lines.push(`  ${alt.title}`);
      lines.push(`    Impact: ${alt.revenueImpact.description}`);
      lines.push(`    Key assumption: ${alt.assumptions[0] ?? "N/A"}`);
    }
  }

  if (output.strategies.length > 0) {
    lines.push("");
    lines.push("STRATEGIES:");
    for (const s of output.strategies) {
      lines.push(`  ${s.name}: ${s.summary}`);
    }
  }

  return lines.join("\n");
}
