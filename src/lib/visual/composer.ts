/**
 * Phase 3: Scene composer.
 *
 * Deterministic rules engine — NO LLM call here. Maps an intent + the data
 * we already have (parsedData, charts, kpis, facts, metrics, timeline,
 * entities) to a VisualScene. This is the single place that decides:
 *
 *   - Which fragments belong in a scene for a given intent.
 *   - What layout to use (spotlight / grid / split / stack / dashboard).
 *   - How to summarize a spoken answer as a summary fragment.
 *
 * The composer is invoked from two paths:
 *
 *   1. CLIENT BRIDGE (useRealtimeSession.ts): when an existing tool result
 *      arrives (chart, dashboard, query_document), the bridge converts it
 *      into a scene by calling composeScene().
 *
 *   2. SERVER TOOL (compose_visual_scene): the agent explicitly asks for
 *      a scene by intent. The server resolves the document, gathers facts,
 *      and calls composeScene() on the server, returning the scene to the
 *      client which appends it to state.
 *
 * Backwards compat: chart fragments use the same ChartProps shape as
 * ChartConfig, so existing tools produce scene-ready data with no changes.
 */

import type {
  VisualScene,
  VisualFragment,
  ComposeSceneInput,
  SceneLayout,
} from "./scene-types";
import {
  kpiFragment,
  chartFragment,
  tableFragment,
  summaryFragment,
  riskPanelFragment,
  timelineFragment,
  entityCardFragment,
  docPreviewFragment,
  calloutFragment,
} from "./fragments";
import type { Fact, SourceSpan } from "@/lib/documents/types";

let sceneCounter = 0;
function nextSceneId(): string {
  sceneCounter++;
  return `scene_${Date.now()}_${sceneCounter}`;
}

// ── Phase 1: passage-based composer (RAG path) ───────────

/**
 * Compose a scene from retrieved passages — the natural input shape for
 * `query_document_v2`. Produces a stack of (summary, doc_preview, optional
 * callouts) without inventing structured facts. Use this from the bridge
 * when the tool result carries `passages` instead of `facts`.
 */
export interface ComposePassageSceneInput {
  documentId?: string;
  sessionId?: string;
  fileName: string;
  documentType: string;
  question?: string;
  answer: string;
  confidence: "high" | "medium" | "low";
  /** All retrieved passages, in relevance order. The first N (up to 6) are shown in the doc preview. */
  passages: Array<{
    passageId: string;
    chunkIndex: number;
    pageStart: number | null;
    pageEnd: number | null;
    text: string;
    heading: string | null;
  }>;
  /** Subset of `passages` actually used in the answer. Shown highlighted; the rest are dimmed. */
  citedPassageIds: string[];
  caveat?: string;
  drilldowns?: string[];
}

export function composeSceneFromPassages(
  input: ComposePassageSceneInput
): VisualScene {
  const {
    documentId,
    sessionId,
    fileName,
    documentType,
    question,
    answer,
    confidence,
    passages,
    citedPassageIds,
    caveat,
    drilldowns,
  } = input;

  const fragments: VisualFragment[] = [];
  const cited = new Set(citedPassageIds);

  // 1. Summary card with the answer.
  fragments.push(
    summaryFragment({
      title: question && question.length < 80 ? question : "Findings",
      body: caveat ? `${answer}\n\n(${caveat})` : answer,
      confidence,
    })
  );

  // 2. Doc preview — cited passages first (highlighted), then up to 3 supporting
  //    passages (dimmed) for context.
  if (passages.length > 0 && documentId) {
    const citedFirst = passages.filter((p) => cited.has(p.passageId));
    const others = passages
      .filter((p) => !cited.has(p.passageId))
      .slice(0, Math.max(0, 4 - citedFirst.length));
    const ordered = [...citedFirst, ...others];

    fragments.push(
      docPreviewFragment({
        documentId,
        fileName,
        snippets: ordered.map((p) => ({
          page: p.pageStart ?? undefined,
          text: p.text.length > 320 ? p.text.slice(0, 317) + "…" : p.text,
          highlight: cited.has(p.passageId),
        })),
      })
    );
  }

  // 3. One callout per cited passage (max 2) for emphasis. Keeps scenes tight.
  for (const p of passages.filter((pp) => cited.has(pp.passageId)).slice(0, 2)) {
    fragments.push(
      calloutFragment({
        tone: confidence === "low" ? "warning" : "info",
        title: p.heading ?? `Page ${p.pageStart ?? "?"}`,
        body: p.text.length > 240 ? p.text.slice(0, 237) + "…" : p.text,
        sourcePage: p.pageStart ?? undefined,
        sourceText: p.text,
      })
    );
  }

  return {
    id: nextSceneId(),
    documentId,
    sessionId,
    title: `${humanizeType(documentType)} · ${fileName}`,
    layout: "stack",
    fragments,
    caption: answer.length > 140 ? answer.slice(0, 137) + "…" : answer,
    drilldowns,
    confidence,
    createdAt: new Date().toISOString(),
  };
}

// ── Public composer ──────────────────────────────────────

export function composeScene(input: ComposeSceneInput): VisualScene {
  const { intent, documentType, fileName } = input;

  // Tabular path (spreadsheet / table_pdf)
  if (documentType === "spreadsheet" || documentType === "table_pdf") {
    return composeTabularScene(input);
  }

  // Narrative path (contract, policy, report, memo, financial_statement, etc.)
  return composeNarrativeScene(input);

  // Note: unreachable end; helper hoists handle all paths.
  void intent;
  void fileName;
}

// ── Tabular composer ─────────────────────────────────────

function composeTabularScene(input: ComposeSceneInput): VisualScene {
  const { intent, parsedData, kpis, charts, fileName, caption, question } = input;
  const fragments: VisualFragment[] = [];

  // Determine layout from intent.
  let layout: SceneLayout = "dashboard";
  let title = `Analysis · ${fileName}`;

  switch (intent) {
    case "trend":
    case "metric":
      // Single chart + brief narration
      if (charts && charts.length > 0) fragments.push(chartFragment(charts[0]));
      if (caption || question) {
        fragments.push(
          summaryFragment({
            title: question ? "What I noticed" : "Summary",
            body: caption ?? "",
            confidence: input.confidence,
          })
        );
      }
      layout = "spotlight";
      title = charts?.[0]?.title ?? `Trend · ${fileName}`;
      break;

    case "comparison":
      // Multiple charts side by side
      if (charts) charts.slice(0, 4).forEach((c) => fragments.push(chartFragment(c)));
      if (caption) fragments.push(summaryFragment({ title: "Comparison summary", body: caption }));
      layout = "grid";
      title = "Comparison";
      break;

    case "overview":
    default: {
      // KPI row → primary chart → table preview → drilldowns
      if (kpis && kpis.length > 0) fragments.push(kpiFragment({ cards: kpis }));
      if (charts && charts.length > 0) {
        charts.slice(0, 3).forEach((c) => fragments.push(chartFragment(c)));
      }
      if (parsedData && parsedData.rows.length > 0) {
        fragments.push(
          tableFragment({
            title: "Sample rows",
            columns: parsedData.columns,
            rows: parsedData.rows.slice(0, 10),
            maxRows: 10,
            caption: `Showing 10 of ${parsedData.totalRows.toLocaleString()} rows`,
          })
        );
      }
      if (caption) {
        fragments.push(
          summaryFragment({
            title: "Key takeaway",
            body: caption,
            confidence: input.confidence,
          })
        );
      }
      layout = "dashboard";
      title = `Overview · ${fileName}`;
      break;
    }
  }

  return {
    id: nextSceneId(),
    documentId: input.documentId,
    sessionId: input.sessionId,
    title,
    layout,
    fragments,
    caption,
    drilldowns: input.drilldowns,
    confidence: input.confidence,
    createdAt: new Date().toISOString(),
  };
}

// ── Narrative composer ───────────────────────────────────

function composeNarrativeScene(input: ComposeSceneInput): VisualScene {
  const {
    intent,
    documentType,
    fileName,
    facts = [],
    metrics = [],
    timeline = [],
    entities = [],
    spans = {},
    answer,
    caption,
    documentId,
    question,
    confidence,
    drilldowns,
  } = input;

  const fragments: VisualFragment[] = [];
  let layout: SceneLayout = "stack";
  let title = `${humanizeType(documentType)} · ${fileName}`;

  // Always start with a summary fragment when we have a spoken answer.
  // The summary is the textual anchor that the voice narration corresponds to.
  if (answer || caption) {
    fragments.push(
      summaryFragment({
        title: titleForIntent(intent, question),
        body: answer ?? caption ?? "",
        confidence,
      })
    );
  }

  switch (intent) {
    case "risk": {
      const risks = facts.filter((f) => f.type === "risk" && f.verificationStatus === "grounded");
      if (risks.length > 0) {
        fragments.push(
          riskPanelFragment({
            title: "Identified risks",
            risks: risks.map((r) => factToRisk(r, spans)),
          })
        );
      }
      // Source callouts for the top risks
      risks.slice(0, 3).forEach((r) => {
        const span = r.sourceSpanIds.map((sid) => spans[sid]).find(Boolean);
        if (span) {
          fragments.push(
            calloutFragment({
              tone: "warning",
              title: r.subject ?? "Risk source",
              body: span.text,
              sourcePage: span.page,
            })
          );
        }
      });
      layout = "split";
      title = `Risks · ${fileName}`;
      break;
    }

    case "timeline": {
      if (timeline.length > 0) {
        fragments.push(
          timelineFragment({
            title: "Timeline",
            events: timeline.map((t) => ({
              date: t.date,
              label: t.description,
              sourcePage: t.sourceSpanIds.map((sid) => spans[sid]?.page).find(Boolean),
            })),
          })
        );
      }
      const obligations = facts.filter((f) => f.type === "obligation" && f.verificationStatus === "grounded");
      if (obligations.length > 0) {
        fragments.push(
          riskPanelFragment({
            title: "Obligations",
            risks: obligations.map((o) => ({
              severity: "medium" as const,
              title: o.subject ?? "Obligation",
              description: String(o.value),
              sourceText: o.sourceSpanIds.map((sid) => spans[sid]?.text).find(Boolean),
            })),
          })
        );
      }
      layout = "stack";
      title = `Timeline · ${fileName}`;
      break;
    }

    case "metric": {
      if (metrics.length > 0) {
        fragments.push(
          kpiFragment({
            cards: metrics.slice(0, 6).map((m) => ({
              label: m.name,
              value: formatMetric(m.value, m.unit),
              column: m.id,
              isPercent: m.unit === "%",
              rawValue: m.value,
            })),
          })
        );
      }
      // Source callouts for each KPI's span
      metrics.slice(0, 4).forEach((m) => {
        const span = m.sourceSpanIds.map((sid) => spans[sid]).find(Boolean);
        if (span) {
          fragments.push(
            calloutFragment({
              tone: "info",
              title: m.name,
              body: span.text,
              sourcePage: span.page,
            })
          );
        }
      });
      layout = "spotlight";
      title = `Metrics · ${fileName}`;
      break;
    }

    case "parties": {
      const parties = facts.filter((f) => f.type === "party" && f.verificationStatus === "grounded");
      const entityList = entities.length > 0
        ? entities
        : parties.map((p) => ({
            canonicalName: p.subject ?? String(p.value),
            type: "org" as const,
            aliases: [],
            role: undefined,
          }));
      if (entityList.length > 0) {
        fragments.push(
          entityCardFragment({
            title: "Parties",
            entities: entityList.map((e) => ({
              name: e.canonicalName,
              type: e.type,
              role: e.role,
              aliases: e.aliases,
            })),
          })
        );
      }
      layout = "grid";
      title = `Parties · ${fileName}`;
      break;
    }

    case "obligations": {
      const obligations = facts.filter((f) => f.type === "obligation" && f.verificationStatus === "grounded");
      if (obligations.length > 0) {
        fragments.push(
          riskPanelFragment({
            title: "Obligations",
            risks: obligations.map((o) => ({
              severity: "medium" as const,
              title: o.subject ?? "Obligation",
              description: String(o.value),
              sourceText: o.sourceSpanIds.map((sid) => spans[sid]?.text).find(Boolean),
            })),
          })
        );
      }
      layout = "stack";
      title = `Obligations · ${fileName}`;
      break;
    }

    case "overview":
    default: {
      // Build the full picture: parties → risks → timeline → metrics → doc preview.
      const parties = entities.length > 0
        ? entities
        : facts
            .filter((f) => f.type === "party" && f.verificationStatus === "grounded")
            .map((p) => ({
              canonicalName: p.subject ?? String(p.value),
              type: "org" as const,
              aliases: [],
              role: undefined,
            }));

      if (parties.length > 0) {
        fragments.push(
          entityCardFragment({
            title: "Parties",
            entities: parties.slice(0, 6).map((e) => ({
              name: e.canonicalName,
              type: e.type,
              role: e.role,
              aliases: e.aliases,
            })),
          })
        );
      }

      const risks = facts.filter((f) => f.type === "risk" && f.verificationStatus === "grounded");
      if (risks.length > 0) {
        fragments.push(
          riskPanelFragment({
            title: "Risks",
            risks: risks.slice(0, 5).map((r) => factToRisk(r, spans)),
          })
        );
      }

      if (timeline.length > 0) {
        fragments.push(
          timelineFragment({
            title: "Key dates",
            events: timeline.slice(0, 8).map((t) => ({
              date: t.date,
              label: t.description,
              sourcePage: t.sourceSpanIds.map((sid) => spans[sid]?.page).find(Boolean),
            })),
          })
        );
      }

      if (metrics.length > 0) {
        fragments.push(
          kpiFragment({
            cards: metrics.slice(0, 4).map((m) => ({
              label: m.name,
              value: formatMetric(m.value, m.unit),
              column: m.id,
              isPercent: m.unit === "%",
              rawValue: m.value,
            })),
          })
        );
      }

      // Source preview — top 3 grounded spans
      const previewSpans = collectPreviewSnippets(facts, spans, 3);
      if (previewSpans.length > 0 && documentId) {
        fragments.push(
          docPreviewFragment({
            documentId,
            fileName,
            snippets: previewSpans,
          })
        );
      }

      layout = "stack";
      title = `Overview · ${humanizeType(documentType)} · ${fileName}`;
      break;
    }
  }

  return {
    id: nextSceneId(),
    documentId,
    sessionId: input.sessionId,
    title,
    layout,
    fragments,
    caption,
    drilldowns,
    confidence,
    createdAt: new Date().toISOString(),
  };
}

// ── Helpers ──────────────────────────────────────────────

function titleForIntent(intent: string, question?: string): string {
  if (question && question.length < 80) return question;
  switch (intent) {
    case "risk":         return "Risks";
    case "timeline":     return "Timeline";
    case "metric":       return "Key metrics";
    case "parties":      return "Parties";
    case "obligations":  return "Obligations";
    case "overview":     return "Overview";
    case "trend":        return "Trend";
    case "comparison":   return "Comparison";
    default:             return "Findings";
  }
}

function humanizeType(t: string): string {
  return t.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function factToRisk(f: Fact, spans: Record<string, SourceSpan>) {
  // Pick the first available source span for citation.
  const span = f.sourceSpanIds.map((sid) => spans[sid]).find(Boolean);
  return {
    severity: severityFromConfidence(f.confidence) as "high" | "medium" | "low",
    title: f.subject ?? "Risk",
    description: String(f.value),
    sourcePage: span?.page,
    sourceText: span?.text,
  };
}

function severityFromConfidence(c: number): "high" | "medium" | "low" {
  // High confidence in a risk fact → render as high severity. We don't have
  // independent severity scoring yet; the LLM extractor will provide it
  // explicitly in a later phase.
  if (c >= 0.85) return "high";
  if (c >= 0.5) return "medium";
  return "low";
}

function formatMetric(v: number, unit?: string): string {
  const abs = Math.abs(v);
  let body: string;
  if (abs >= 1_000_000_000) body = (v / 1_000_000_000).toFixed(1) + "B";
  else if (abs >= 1_000_000) body = (v / 1_000_000).toFixed(1) + "M";
  else if (abs >= 1_000) body = (v / 1_000).toFixed(1) + "K";
  else body = Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (unit === "%") return body + "%";
  if (unit === "USD" || unit === "$") return "$" + body;
  return unit ? `${body} ${unit}` : body;
}

function collectPreviewSnippets(
  facts: Fact[],
  spans: Record<string, SourceSpan>,
  max: number
): Array<{ page?: number; text: string; highlight?: boolean }> {
  const seen = new Set<string>();
  const out: Array<{ page?: number; text: string; highlight?: boolean }> = [];
  for (const f of facts) {
    if (f.verificationStatus !== "grounded") continue;
    for (const sid of f.sourceSpanIds) {
      const sp = spans[sid];
      if (!sp || seen.has(sp.text)) continue;
      seen.add(sp.text);
      out.push({ page: sp.page, text: sp.text, highlight: true });
      if (out.length >= max) return out;
    }
  }
  return out;
}
