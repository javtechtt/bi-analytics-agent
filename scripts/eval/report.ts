/**
 * Golden eval — report formatting.
 *
 * Two outputs:
 *   - Markdown report to stdout (and optionally a file): human-readable.
 *   - JSON dump alongside: machine-readable for diffs over time.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { RunSummary, QuestionResult } from "./types";

export async function writeReport(summary: RunSummary, outDir: string): Promise<{ md: string; jsonPath: string; mdPath: string }> {
  await fs.mkdir(outDir, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `eval-${stamp}.json`);
  const mdPath = path.join(outDir, `eval-${stamp}.md`);

  await fs.writeFile(jsonPath, JSON.stringify(summary, null, 2), "utf-8");

  const md = renderMarkdown(summary);
  await fs.writeFile(mdPath, md, "utf-8");

  // Also write/update a "latest" symlink-style copy for easy diffing.
  await fs.writeFile(path.join(outDir, "latest.json"), JSON.stringify(summary, null, 2), "utf-8");
  await fs.writeFile(path.join(outDir, "latest.md"), md, "utf-8");

  return { md, jsonPath, mdPath };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function ms(n: number): string {
  return `${(n / 1000).toFixed(2)}s`;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function renderMarkdown(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push(`# Eval Run ${summary.runId}`);
  lines.push("");
  lines.push(`- **Started**: ${summary.startedAt}`);
  lines.push(`- **Finished**: ${summary.finishedAt}`);
  lines.push(`- **Total questions**: ${summary.totalQuestions}`);
  if (summary.skipped > 0) lines.push(`- **Skipped**: ${summary.skipped} (missing fixtures)`);
  lines.push("");

  lines.push(`## Aggregate`);
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Overall accuracy | ${pct(summary.aggregate.overallAccuracy)} |`);
  lines.push(`| Judge accuracy | ${pct(summary.aggregate.judgeAccuracy)} |`);
  lines.push(`| Contains pass rate | ${pct(summary.aggregate.containsPassRate)} |`);
  lines.push(`| Excludes pass rate | ${pct(summary.aggregate.excludesPassRate)} |`);
  lines.push(`| Citation pass rate | ${pct(summary.aggregate.citationPassRate)} |`);
  lines.push(`| p50 latency | ${ms(summary.aggregate.p50LatencyMs)} |`);
  lines.push(`| p95 latency | ${ms(summary.aggregate.p95LatencyMs)} |`);
  lines.push(`| Total cost | ${usd(summary.aggregate.totalCostUsd)} |`);
  lines.push(`| Avg cost/question | ${usd(summary.aggregate.avgCostUsd)} |`);
  lines.push(`| Complex routing rate | ${pct(summary.aggregate.complexRoutingRate)} |`);
  lines.push("");

  lines.push(`## Per-question`);
  lines.push("");
  lines.push(`| ID | Mode | Category | Score | Judge | Contains | Excludes | Citation | Latency | Cost |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of summary.results) {
    const b = r.breakdown;
    // Mode column shows the actual routing taken (simple/complex/legacy)
    // rather than the golden question's declared target tool — the latter
    // doesn't change run-to-run and was misleading on the report.
    const mode = b.reasoningMode
      ? b.reasoningMode === "complex"
        ? `complex(${b.subAnswersCompleted ?? "?"}/${b.subQuestions?.length ?? "?"})`
        : "simple"
      : "legacy";
    lines.push(
      `| ${r.question.id} | ${mode} | ${r.question.category} | ` +
        `${(r.score * 100).toFixed(0)}% | ${(b.judgeScore * 100).toFixed(0)}% | ` +
        `${b.containsPass ? "✓" : "✗"} | ${b.excludesPass ? "✓" : "✗"} | ${b.citationPass ? "✓" : "✗"} | ` +
        `${ms(b.actualLatencyMs)} | ${b.actualCostUsd != null ? usd(b.actualCostUsd) : "—"} |`
    );
  }
  lines.push("");

  // Failure details
  const failures = summary.results.filter((r) => r.score < 0.6 || r.error);
  if (failures.length > 0) {
    lines.push(`## Failures and low scorers (< 60%)`);
    lines.push("");
    for (const r of failures) {
      lines.push(`### ${r.question.id} — score ${(r.score * 100).toFixed(0)}%`);
      lines.push("");
      lines.push(`**Question**: ${r.question.question}`);
      if (r.question.focus) lines.push(`**Focus**: ${r.question.focus}`);
      lines.push("");
      if (r.error) {
        lines.push(`**Error**: ${r.error}`);
        lines.push("");
      } else {
        lines.push(`**Answer**: ${r.answer.slice(0, 300)}${r.answer.length > 300 ? "…" : ""}`);
        lines.push("");
        // Show sub-questions when the complex path ran — helps diagnose
        // whether decomposition picked the right axes for failures.
        if (r.breakdown.reasoningMode === "complex" && r.breakdown.subQuestions?.length) {
          lines.push(`**Routing**: complex — ${r.breakdown.subAnswersCompleted ?? "?"}/${r.breakdown.subQuestions.length} sub-answers completed`);
          for (const sq of r.breakdown.subQuestions) lines.push(`  - ${sq}`);
          lines.push("");
        }
        lines.push(`**Judge**: ${(r.breakdown.judgeScore * 100).toFixed(0)}% — ${r.breakdown.judgeReasoning}`);
        if (r.breakdown.containsMissing.length > 0) {
          lines.push(`**Missing required substrings**: ${r.breakdown.containsMissing.join("; ")}`);
        }
        if (r.breakdown.excludesViolations.length > 0) {
          lines.push(`**Forbidden substrings appeared**: ${r.breakdown.excludesViolations.join("; ")}`);
        }
        if (!r.breakdown.citationPass) {
          lines.push(`**Citation pages**: expected ∈ [${r.question.expectedCitationPages?.join(", ") ?? "—"}], got [${r.breakdown.citationActualPages.join(", ")}]`);
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function logQuickSummary(summary: RunSummary): void {
  console.log("");
  console.log(`──── Eval ${summary.runId} ────`);
  console.log(`  Overall accuracy: ${pct(summary.aggregate.overallAccuracy)}`);
  console.log(`  Judge accuracy:   ${pct(summary.aggregate.judgeAccuracy)}`);
  console.log(`  Citation pass:    ${pct(summary.aggregate.citationPassRate)}`);
  console.log(`  p50 / p95 latency: ${ms(summary.aggregate.p50LatencyMs)} / ${ms(summary.aggregate.p95LatencyMs)}`);
  console.log(`  Total cost:       ${usd(summary.aggregate.totalCostUsd)}`);
  console.log("");
}

export function summarizeResults(
  results: QuestionResult[],
  runId: string,
  startedAt: string,
  finishedAt: string,
  totalQuestions: number,
  skipped: number
): RunSummary {
  const valid = results.filter((r) => !r.error);
  const latencies = valid.map((r) => r.breakdown.actualLatencyMs).sort((a, b) => a - b);
  const costs = valid.map((r) => r.breakdown.actualCostUsd ?? 0);
  const p = (arr: number[], q: number): number =>
    arr.length === 0 ? 0 : arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];

  return {
    runId,
    startedAt,
    finishedAt,
    totalQuestions,
    skipped,
    results,
    aggregate: {
      overallAccuracy: avg(results.map((r) => r.score)),
      judgeAccuracy: avg(results.map((r) => r.breakdown.judgeScore)),
      containsPassRate: rate(results, (r) => r.breakdown.containsPass),
      excludesPassRate: rate(results, (r) => r.breakdown.excludesPass),
      citationPassRate: rate(results, (r) => r.breakdown.citationPass),
      p50LatencyMs: p(latencies, 0.5),
      p95LatencyMs: p(latencies, 0.95),
      totalCostUsd: costs.reduce((a, b) => a + b, 0),
      avgCostUsd: avg(costs),
      complexRoutingRate: rate(results, (r) => r.breakdown.reasoningMode === "complex"),
    },
  };
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function rate(results: QuestionResult[], pred: (r: QuestionResult) => boolean): number {
  if (results.length === 0) return 0;
  return results.filter(pred).length / results.length;
}
