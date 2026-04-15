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

/** Linear regression slope — actual rate of change per period */
function computeSlope(values: number[]): { slope: number; rSquared: number } {
  const n = values.length;
  if (n < 3) return { slope: 0, rSquared: 0 };
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
  return { slope, rSquared };
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
  if (series.length < 3) return [];

  const values = series.map((s) => s.value);
  const { slope, rSquared } = computeSlope(values);
  const metricName = formatLabel(primaryMetric);
  const lastValue = values[values.length - 1];
  const avgValue = values.reduce((a, b) => a + b, 0) / values.length;

  if (Math.abs(slope) < avgValue * 0.01) return []; // Slope too flat to matter

  const isDecline = slope < 0;
  const periodsAhead = 3;

  // Project forward using actual slope
  const projectedChange = slope * periodsAhead;
  const projectedLow = projectedChange * 0.7; // 30% uncertainty band
  const projectedHigh = projectedChange * 1.3;

  const absLow = Math.abs(projectedLow);
  const absHigh = Math.abs(projectedHigh);

  if (isDecline) {
    // Decline: action is to reverse the trend
    const recoveryPerPeriod = Math.abs(slope);
    return [{
      title: `Address ${metricName} decline`,
      explanation: `${insight.observation} The data shows a decline of ~${formatKpiValue(Math.abs(slope))} per period (R²=${rSquared.toFixed(2)}).`,
      expectedOutcome: `Reversing this trend over ${periodsAhead} periods could recover ${formatKpiValue(absLow)}–${formatKpiValue(absHigh)}.`,
      assumptions: [
        `Based on linear trend of ${formatKpiValue(Math.abs(slope))} per period decline.`,
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
    expectedOutcome: `Maintaining this trajectory projects ${formatKpiValue(projectedLow)}–${formatKpiValue(projectedHigh)} additional ${metricName} over ${periodsAhead} periods.`,
    assumptions: [
      `Based on observed growth of ${formatKpiValue(slope)} per period.`,
      `Assumes current conditions continue — no market disruption or seasonal shift.`,
      `R² of ${rSquared.toFixed(2)} — ${rSquared > 0.7 ? "strong fit" : "moderate fit"}.`,
    ],
    revenueImpact: { low: projectedLow, high: projectedHigh, description: `+${formatKpiValue(projectedLow)}–${formatKpiValue(projectedHigh)} projected` },
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

  if (isSpike) {
    return [{
      title: `Investigate and replicate the ${metricName} spike`,
      explanation: `${insight.observation} The spike was ~${formatKpiValue(anomalyMagnitude)} above the period average of ${formatKpiValue(mean)}.`,
      expectedOutcome: `If replicable, each occurrence could add ~${formatKpiValue(anomalyMagnitude * 0.5)}–${formatKpiValue(anomalyMagnitude * 0.8)} above baseline.`,
      assumptions: [
        `Spike magnitude: ${formatKpiValue(anomalyMagnitude)} above average.`,
        `Assumes 50–80% of the spike is replicable (not a one-time event).`,
        `Requires identifying the root cause first.`,
      ],
      revenueImpact: { low: anomalyMagnitude * 0.5, high: anomalyMagnitude * 0.8, description: `+${formatKpiValue(anomalyMagnitude * 0.5)}–${formatKpiValue(anomalyMagnitude * 0.8)} per recurrence` },
      riskLevel: "medium",
      confidence: "low",
      priority: 55,
      sourceInsight: insight.observation,
    }];
  }

  // Drop
  return [{
    title: `Prevent future ${metricName} drops`,
    explanation: `${insight.observation} The drop was ~${formatKpiValue(anomalyMagnitude)} below the period average.`,
    expectedOutcome: `Preventing recurrence preserves ~${formatKpiValue(anomalyMagnitude * 0.6)}–${formatKpiValue(anomalyMagnitude)} per period.`,
    assumptions: [
      `Drop magnitude: ${formatKpiValue(anomalyMagnitude)} below average.`,
      `Assumes 60–100% of the drop is preventable.`,
      `Requires root cause identification.`,
    ],
    revenueImpact: { low: anomalyMagnitude * 0.6, high: anomalyMagnitude, description: `Preserved ${formatKpiValue(anomalyMagnitude * 0.6)}–${formatKpiValue(anomalyMagnitude)}` },
    riskLevel: "medium",
    confidence: "low",
    priority: 60,
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

      // Realistic growth: double this segment's count at its current per-unit value
      const growthPotential = avgPerUnit * g.count; // current value
      const scaledValue = avgPerUnit * g.count * 0.5; // 50% growth in volume

      return [{
        title: `Scale "${g.group}" segment`,
        explanation: `${insight.observation} "${g.group}" is ${(share * 100).toFixed(0)}% of ${metricName} but has ${((avgPerUnit / overallAvg - 1) * 100).toFixed(0)}% higher per-transaction value.`,
        expectedOutcome: `Growing "${g.group}" volume by 50% at current per-unit value adds ~${formatKpiValue(scaledValue)}.`,
        assumptions: [
          `Current "${g.group}" value: ${formatKpiValue(g.total)} from ${g.count} transactions.`,
          `Per-transaction average: ${formatKpiValue(avgPerUnit)} vs overall ${formatKpiValue(overallAvg)}.`,
          `Assumes 50% volume growth is achievable through targeted effort.`,
          `Assumes per-unit value holds at current levels.`,
        ],
        revenueImpact: { low: scaledValue * 0.6, high: scaledValue, description: `+${formatKpiValue(scaledValue * 0.6)}–${formatKpiValue(scaledValue)}` },
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
