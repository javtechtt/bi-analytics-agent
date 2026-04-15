/**
 * Insight Intelligence Engine.
 * Analyzes datasets to produce structured, actionable insights.
 * Each insight has: observation, implication, recommendation.
 * Insights are ranked by business impact.
 */

import type { ParsedData } from "./types";
import type { KpiCard } from "./kpi";
import { formatLabel, formatKpiValue } from "./labels";

// ── Types ────────────────────────────────────────────────

export interface StructuredInsight {
  type: "trend" | "anomaly" | "concentration" | "efficiency" | "quality";
  severity: "high" | "medium" | "low";
  observation: string;
  implication: string;
  recommendation: string;
  /** Single-sentence summary for the assistant to speak */
  spoken: string;
  /** Impact score 0–100 for ranking */
  impact: number;
}

export interface AnalysisOutput {
  insights: StructuredInsight[];
  risks: StructuredInsight[];
  opportunities: StructuredInsight[];
}

// ── Helpers ──────────────────────────────────────────────

function numericValues(data: ParsedData, col: string): number[] {
  return data.rows
    .map((r) => r[col])
    .filter((v) => v != null && v !== "")
    .map(Number)
    .filter((n) => !isNaN(n));
}

function groupSum(data: ParsedData, groupCol: string, metricCol: string): Array<{ group: string; total: number; count: number }> {
  const groups = new Map<string, { total: number; count: number }>();
  for (const row of data.rows) {
    const key = String(row[groupCol] ?? "");
    if (!key) continue;
    const val = Number(row[metricCol]);
    if (isNaN(val)) continue;
    const existing = groups.get(key) ?? { total: 0, count: 0 };
    existing.total += val;
    existing.count++;
    groups.set(key, existing);
  }
  return [...groups.entries()]
    .map(([group, { total, count }]) => ({ group, total, count }))
    .sort((a, b) => b.total - a.total);
}

function periodicValues(data: ParsedData, timeCol: string, metricCol: string): Array<{ period: string; value: number }> {
  const periodMap = new Map<string, number>();
  for (const row of data.rows) {
    const period = String(row[timeCol] ?? "");
    const val = Number(row[metricCol]);
    if (!period || isNaN(val)) continue;
    periodMap.set(period, (periodMap.get(period) ?? 0) + val);
  }
  // Preserve original order from data
  const orderMap = new Map<string, number>();
  for (const row of data.rows) {
    const p = String(row[timeCol] ?? "");
    if (p && !orderMap.has(p)) orderMap.set(p, orderMap.size);
  }
  return [...periodMap.entries()]
    .map(([period, value]) => ({ period, value }))
    .sort((a, b) => (orderMap.get(a.period) ?? 0) - (orderMap.get(b.period) ?? 0));
}

function pctChange(from: number, to: number): number {
  if (from === 0) return to > 0 ? 100 : 0;
  return ((to - from) / Math.abs(from)) * 100;
}

// ── Seasonality Detection ────────────────────────────────

function detectSeasonality(values: number[]): { seasonal: boolean; cycleLength: number } {
  if (values.length < 8) return { seasonal: false, cycleLength: 0 };

  // Check for repeating patterns via autocorrelation at common cycle lengths
  for (const lag of [4, 12, 6, 3]) {
    if (values.length < lag * 2) continue;

    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n - lag; i++) {
      num += (values[i] - mean) * (values[i + lag] - mean);
    }
    for (let i = 0; i < n; i++) {
      den += (values[i] - mean) ** 2;
    }
    const autocorr = den === 0 ? 0 : num / den;

    // Autocorrelation > 0.4 at this lag suggests seasonality
    if (autocorr > 0.4) {
      return { seasonal: true, cycleLength: lag };
    }
  }

  return { seasonal: false, cycleLength: 0 };
}

// ── Linear Regression ────────────────────────────────────

function linearSlope(values: number[]): { slope: number; rSquared: number } {
  const n = values.length;
  if (n < 3) return { slope: 0, rSquared: 0 };
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (values[i] - (intercept + slope * i)) ** 2;
    ssTot += (values[i] - yMean) ** 2;
  }
  return { slope, rSquared: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

// ── Trend Analysis (with seasonality awareness) ──────────

function analyzeTrends(data: ParsedData, timeCol: string | null, primaryMetric: string | null): StructuredInsight[] {
  const results: StructuredInsight[] = [];
  if (!timeCol || !primaryMetric) return results;

  const series = periodicValues(data, timeCol, primaryMetric);
  if (series.length < 3) return results;

  const values = series.map((s) => s.value);
  const metricName = formatLabel(primaryMetric);

  // Check for seasonality before interpreting trends
  const { seasonal, cycleLength } = detectSeasonality(values);

  // Use linear regression instead of naive first/last comparison
  const { slope, rSquared } = linearSlope(values);
  const avgValue = values.reduce((a, b) => a + b, 0) / values.length;
  const slopeAsPercent = avgValue > 0 ? (slope / avgValue) * 100 : 0;

  // Skip if slope is flat relative to the values
  if (Math.abs(slopeAsPercent) < 1) return results;

  const direction = slope > 0 ? "upward" : "downward";
  const absSlope = Math.abs(slopeAsPercent).toFixed(1);

  // Check momentum (recent vs overall) using regression on halves
  const mid = Math.floor(values.length / 2);
  const firstHalf = linearSlope(values.slice(0, mid));
  const secondHalf = linearSlope(values.slice(mid));
  const isAccelerating = Math.abs(secondHalf.slope) > Math.abs(firstHalf.slope) && secondHalf.slope * slope > 0;

  let seasonalNote = "";
  if (seasonal) {
    seasonalNote = ` Note: data shows a seasonal pattern (cycle: ~${cycleLength} periods) — some variation is expected and should not be confused with strategic shifts.`;
  }

  const fitQuality = rSquared > 0.7 ? "strong" : rSquared > 0.4 ? "moderate" : "weak";

  results.push({
    type: "trend",
    severity: Math.abs(slopeAsPercent) > 5 ? "high" : "medium",
    observation: `${metricName} shows a ${direction} trend of ~${absSlope}% per period (${fitQuality} fit, R²=${rSquared.toFixed(2)}).`,
    implication: isAccelerating
      ? `The trend is ${slope > 0 ? "accelerating" : "worsening"} — recent periods show steeper movement.${seasonalNote}`
      : `The trend is ${slope > 0 ? "steady" : "stabilizing"} — recent periods are consistent with the overall pattern.${seasonalNote}`,
    recommendation: slope < 0
      ? "Investigate the decline drivers. Check pricing, volume, and mix changes across segments."
      : "Current trajectory is positive. Identify what's driving it and whether it's sustainable.",
    spoken: seasonal
      ? `${metricName} has a ${direction} trend of about ${absSlope}% per period, though there's a seasonal cycle in the data — so not all movement is strategic.`
      : `${metricName} has a ${direction} trend of about ${absSlope}% per period. The fit is ${fitQuality}.`,
    impact: Math.min(Math.abs(slopeAsPercent) * 8 + rSquared * 30, 90),
  });

  return results;
}

// ── Anomaly Detection (seasonality-aware) ────────────────

/** Adaptive anomaly threshold based on sample size.
 *  For small samples (n<30), uses approximate t-distribution critical values
 *  at the 95% two-tailed level. For large samples, converges to ~2.0 (z-score).
 *  This prevents small datasets from producing too many false anomalies. */
function anomalyThreshold(n: number): number {
  if (n <= 5) return 2.78;  // t(4, 0.025) ≈ 2.78
  if (n <= 8) return 2.45;  // t(7, 0.025) ≈ 2.36
  if (n <= 12) return 2.28; // t(11, 0.025) ≈ 2.20
  if (n <= 20) return 2.15; // t(19, 0.025) ≈ 2.09
  if (n <= 30) return 2.05; // t(29, 0.025) ≈ 2.04
  return 2.0;               // z ≈ 1.96, rounded to 2.0
}

function detectAnomalies(data: ParsedData, timeCol: string | null, primaryMetric: string | null): StructuredInsight[] {
  const results: StructuredInsight[] = [];
  if (!timeCol || !primaryMetric) return results;

  const series = periodicValues(data, timeCol, primaryMetric);
  if (series.length < 4) return results;

  const values = series.map((s) => s.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const stdDev = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);

  if (stdDev === 0) return results;

  const ANOMALY_THRESHOLD = anomalyThreshold(values.length);

  const metricName = formatLabel(primaryMetric);

  // Detect seasonality — suppress anomalies that fall on seasonal cycle positions
  const { seasonal, cycleLength } = detectSeasonality(values);

  for (let idx = 0; idx < series.length; idx++) {
    const point = series[idx];
    const zScore = (point.value - mean) / stdDev;

    if (Math.abs(zScore) <= ANOMALY_THRESHOLD) continue;

    // If data is seasonal, check if this point falls on a seasonal cycle position
    // A point at index i is "seasonal" if similar deviations occur at i ± cycleLength
    if (seasonal && cycleLength > 0) {
      let isSeasonalPattern = false;
      // Check if the same direction of deviation repeats at the cycle lag
      for (const lagOffset of [cycleLength, -cycleLength, cycleLength * 2, -cycleLength * 2]) {
        const compareIdx = idx + lagOffset;
        if (compareIdx >= 0 && compareIdx < values.length) {
          const compareZScore = (values[compareIdx] - mean) / stdDev;
          // Same direction and both above threshold → seasonal, not anomalous
          if (zScore * compareZScore > 0 && Math.abs(compareZScore) > ANOMALY_THRESHOLD * 0.7) {
            isSeasonalPattern = true;
            break;
          }
        }
      }

      if (isSeasonalPattern) {
        // This is a seasonal pattern, not a true anomaly — report as seasonal note, not actionable anomaly
        results.push({
          type: "anomaly",
          severity: "low",
          observation: `${metricName} in ${point.period} (${formatKpiValue(point.value)}) appears to be part of a recurring seasonal pattern, not an anomaly.`,
          implication: "This variation repeats at regular intervals and is expected behavior.",
          recommendation: "No action needed — this is normal seasonal variation. Focus on the underlying trend instead.",
          spoken: `The ${point.value > mean ? "high" : "low"} in ${point.period} looks seasonal — it repeats in prior cycles.`,
          impact: 15, // Very low impact — not actionable
        });
        continue;
      }
    }

    // True anomaly (not seasonal)
    const direction = zScore > 0 ? "spike" : "drop";
    const deviation = Math.abs(((point.value - mean) / mean) * 100).toFixed(0);

    results.push({
      type: "anomaly",
      severity: Math.abs(zScore) > 3.0 ? "high" : "medium",
      observation: `${metricName} had a significant ${direction} in ${point.period} — ${formatKpiValue(point.value)}, which is ${deviation}% ${zScore > 0 ? "above" : "below"} the average.`,
      implication: direction === "spike"
        ? "This appears to be a genuine outlier — not part of a seasonal pattern."
        : "This drop is unusual and not explained by seasonal variation.",
      recommendation: `Investigate ${point.period} specifically — check for campaigns, market events, operational changes, or data issues.`,
      spoken: `There's a genuine ${direction} in ${point.period} — ${formatKpiValue(point.value)}, about ${deviation}% ${zScore > 0 ? "above" : "below"} average. This doesn't look seasonal.`,
      impact: Math.min(Math.abs(zScore) * 25, 85),
    });
  }

  return results.sort((a, b) => b.impact - a.impact).slice(0, 2);
}

// ── Concentration Risk ───────────────────────────────────

function detectConcentrationRisks(data: ParsedData, primaryMetric: string | null, categories: string[]): StructuredInsight[] {
  const results: StructuredInsight[] = [];
  if (!primaryMetric) return results;

  for (const catCol of categories.slice(0, 3)) {
    const grouped = groupSum(data, catCol, primaryMetric);
    if (grouped.length < 3) continue;

    const total = grouped.reduce((sum, g) => sum + g.total, 0);
    if (total === 0) continue;

    const catName = formatLabel(catCol);
    const metricName = formatLabel(primaryMetric);

    // Top-heavy concentration: top 1 or top 3 dominate
    const topShare = (grouped[0].total / total) * 100;
    const top3Share = grouped.slice(0, 3).reduce((s, g) => s + g.total, 0) / total * 100;

    if (topShare > 50) {
      results.push({
        type: "concentration",
        severity: topShare > 70 ? "high" : "medium",
        observation: `"${grouped[0].group}" accounts for ${topShare.toFixed(0)}% of total ${metricName} across all ${catName} values.`,
        implication: "Heavy dependence on a single segment creates risk — a downturn there impacts the entire business disproportionately.",
        recommendation: `Explore growth strategies for other ${catName} segments to reduce concentration risk.`,
        spoken: `${grouped[0].group} is ${topShare.toFixed(0)}% of all ${metricName} — that's a concentration risk worth watching.`,
        impact: Math.min(topShare * 1.2, 90),
      });
    } else if (top3Share > 80 && grouped.length > 5) {
      const topNames = grouped.slice(0, 3).map((g) => g.group).join(", ");
      results.push({
        type: "concentration",
        severity: "medium",
        observation: `Top 3 ${catName} values (${topNames}) account for ${top3Share.toFixed(0)}% of ${metricName}.`,
        implication: "Revenue is concentrated in a few segments. The remaining segments are undercontributing.",
        recommendation: `Evaluate whether smaller segments have growth potential or should be deprioritized.`,
        spoken: `Top 3 ${catName} segments make up ${top3Share.toFixed(0)}% of ${metricName} — the rest are marginal.`,
        impact: top3Share * 0.8,
      });
    }
  }

  return results.sort((a, b) => b.impact - a.impact).slice(0, 2);
}

// ── Efficiency / Margin Analysis ─────────────────────────

function analyzeEfficiency(data: ParsedData, primaryMetric: string | null, secondaryMetric: string | null, categories: string[]): StructuredInsight[] {
  const results: StructuredInsight[] = [];
  if (!primaryMetric || !secondaryMetric) return results;

  const pName = formatLabel(primaryMetric);
  const sName = formatLabel(secondaryMetric);

  // Overall efficiency ratio
  const pTotal = numericValues(data, primaryMetric).reduce((a, b) => a + b, 0);
  const sTotal = numericValues(data, secondaryMetric).reduce((a, b) => a + b, 0);

  if (pTotal > 0 && sTotal > 0) {
    const ratio = (sTotal / pTotal) * 100;

    // Check efficiency across categories
    for (const catCol of categories.slice(0, 2)) {
      const pGrouped = groupSum(data, catCol, primaryMetric);
      const sGrouped = groupSum(data, catCol, secondaryMetric);
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

      if (efficiencies.length >= 3) {
        const worst = efficiencies[0];
        const best = efficiencies[efficiencies.length - 1];
        const gap = best.ratio - worst.ratio;

        if (gap > 10) {
          const catName = formatLabel(catCol);
          results.push({
            type: "efficiency",
            severity: gap > 25 ? "high" : "medium",
            observation: `${sName}-to-${pName} ratio varies significantly across ${catName}: "${worst.group}" has ${worst.ratio.toFixed(1)}% while "${best.group}" has ${best.ratio.toFixed(1)}%.`,
            implication: `A ${gap.toFixed(0)} percentage point gap suggests operational or pricing differences worth investigating.`,
            recommendation: `Analyze why "${worst.group}" has lower ${sName} relative to ${pName}. Check pricing, cost structure, or product mix.`,
            spoken: `There's a big efficiency gap across ${catName} — ${worst.group} keeps ${worst.ratio.toFixed(0)}% as ${sName} while ${best.group} keeps ${best.ratio.toFixed(0)}%.`,
            impact: Math.min(gap * 2.5, 85),
          });
        }
      }
    }
  }

  return results.sort((a, b) => b.impact - a.impact).slice(0, 2);
}

// ── Data Quality Analysis ────────────────────────────────

function analyzeDataQuality(data: ParsedData): StructuredInsight[] {
  const results: StructuredInsight[] = [];

  // Small dataset warning
  if (data.totalRows < 30) {
    results.push({
      type: "quality",
      severity: "high",
      observation: `Dataset has only ${data.totalRows} rows.`,
      implication: "Sample size is too small for reliable statistical patterns. Aggregations may not be representative.",
      recommendation: "Use this data directionally, not for definitive conclusions. Upload a larger dataset for more reliable analysis.",
      spoken: `Just a heads up — this is a small dataset at ${data.totalRows} rows, so treat the patterns as directional, not definitive.`,
      impact: 70,
    });
  }

  // Columns with significant missing data
  for (const col of data.columns) {
    if (data.columnTypes[col] !== "numeric") continue;
    const total = data.rows.length;
    const valid = numericValues(data, col).length;
    const missingPct = ((total - valid) / total) * 100;

    if (missingPct > 20) {
      results.push({
        type: "quality",
        severity: missingPct > 40 ? "high" : "medium",
        observation: `${formatLabel(col)} is ${missingPct.toFixed(0)}% incomplete (${total - valid} of ${total} rows missing).`,
        implication: `Aggregations on this field exclude a significant portion of the data and may misrepresent reality.`,
        recommendation: `Verify whether missing values are random or systematic. Consider filtering to complete records for this metric.`,
        spoken: `${formatLabel(col)} is ${missingPct.toFixed(0)}% incomplete — that could skew any analysis using it.`,
        impact: Math.min(missingPct * 1.5, 75),
      });
    }
  }

  return results.sort((a, b) => b.impact - a.impact).slice(0, 2);
}

// ── Opportunity Detection ────────────────────────────────

function detectOpportunities(data: ParsedData, primaryMetric: string | null, timeCol: string | null, categories: string[]): StructuredInsight[] {
  const results: StructuredInsight[] = [];
  if (!primaryMetric) return results;

  const metricName = formatLabel(primaryMetric);

  for (const catCol of categories.slice(0, 2)) {
    const grouped = groupSum(data, catCol, primaryMetric);
    if (grouped.length < 3) continue;

    const total = grouped.reduce((s, g) => s + g.total, 0);
    const catName = formatLabel(catCol);

    // Find segments that are small but could grow
    // Small share + exists (not zero) = potential
    for (const g of grouped) {
      const share = (g.total / total) * 100;
      if (share > 3 && share < 15 && g.count >= 5) {
        // Check if this segment has higher-than-average per-unit value
        const avgPerUnit = g.total / g.count;
        const overallAvg = total / data.rows.length;

        if (avgPerUnit > overallAvg * 1.2) {
          results.push({
            type: "trend",
            severity: "medium",
            observation: `"${g.group}" is only ${share.toFixed(0)}% of total ${metricName} but has ${((avgPerUnit / overallAvg - 1) * 100).toFixed(0)}% higher average value per transaction.`,
            implication: "This segment punches above its weight on a per-unit basis — scaling it could disproportionately impact the top line.",
            recommendation: `Investigate what drives "${g.group}" and whether marketing or distribution can amplify it.`,
            spoken: `${g.group} is small — only ${share.toFixed(0)}% — but the per-transaction value is ${((avgPerUnit / overallAvg - 1) * 100).toFixed(0)}% above average. There could be upside there.`,
            impact: Math.min((avgPerUnit / overallAvg) * 40, 80),
          });
        }
      }
    }

    // Find the bottom performer as a risk/opportunity
    const bottom = grouped[grouped.length - 1];
    const top = grouped[0];
    if (top.total > 0 && bottom.total / top.total < 0.1 && bottom.count >= 3) {
      results.push({
        type: "concentration",
        severity: "low",
        observation: `"${bottom.group}" contributes only ${((bottom.total / total) * 100).toFixed(1)}% of ${metricName} — the smallest ${catName} segment.`,
        implication: "This segment is marginal. It may need investment to grow or could be deprioritized to focus resources.",
        recommendation: `Evaluate whether "${bottom.group}" has strategic value or if resources should shift to higher-performing segments.`,
        spoken: `${bottom.group} is barely contributing — under ${((bottom.total / total) * 100).toFixed(0)}% of ${metricName}. Worth deciding whether to invest or redirect.`,
        impact: 40,
      });
    }
  }

  return results.sort((a, b) => b.impact - a.impact).slice(0, 3);
}

// ── Main: Run Full Analysis ──────────────────────────────

export function analyzeDataset(
  data: ParsedData,
  primaryMetric: string | null,
  secondaryMetric: string | null,
  timeCol: string | null,
  categories: string[],
  kpis: KpiCard[]
): AnalysisOutput {
  // Collect all insights
  const allInsights: StructuredInsight[] = [
    ...analyzeTrends(data, timeCol, primaryMetric),
    ...detectAnomalies(data, timeCol, primaryMetric),
    ...detectConcentrationRisks(data, primaryMetric, categories),
    ...analyzeEfficiency(data, primaryMetric, secondaryMetric, categories),
    ...analyzeDataQuality(data),
  ];

  // Collect opportunities
  const allOpportunities = detectOpportunities(data, primaryMetric, timeCol, categories);

  // Sort all by impact and split into insights vs risks
  allInsights.sort((a, b) => b.impact - a.impact);

  const insights = allInsights
    .filter((i) => i.severity !== "high" || i.type !== "quality")
    .slice(0, 5);

  const risks = allInsights
    .filter((i) => i.type === "anomaly" || i.type === "concentration" || i.type === "quality" || i.type === "efficiency")
    .filter((i) => i.severity === "high" || i.severity === "medium")
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 3);

  const opportunities = allOpportunities.slice(0, 3);

  return { insights, risks, opportunities };
}

/** Format insights for the assistant to speak from (source of truth) */
export function formatInsightsForAssistant(output: AnalysisOutput): string {
  const lines: string[] = [];

  if (output.insights.length > 0) {
    lines.push("Key findings (source of truth — speak these):");
    for (const i of output.insights) {
      lines.push(`  [${i.type.toUpperCase()}] ${i.observation}`);
      lines.push(`    → ${i.implication}`);
      lines.push(`    → Recommendation: ${i.recommendation}`);
    }
  }

  if (output.risks.length > 0) {
    lines.push("\nRisks:");
    for (const r of output.risks) {
      lines.push(`  ⚠ ${r.observation}`);
      lines.push(`    → ${r.implication}`);
    }
  }

  if (output.opportunities.length > 0) {
    lines.push("\nOpportunities:");
    for (const o of output.opportunities) {
      lines.push(`  → ${o.observation}`);
      lines.push(`    → ${o.recommendation}`);
    }
  }

  return lines.join("\n");
}
