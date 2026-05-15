/**
 * Phase 3: Fragment construction helpers.
 *
 * Small factory functions for building well-formed VisualFragment objects.
 * The composer rules in composer.ts call these so fragment ids are
 * consistent and there is only one place to evolve the shape when fragment
 * props change.
 *
 * Why factories instead of `new`/literal shorthand? Two reasons:
 *   1. Every fragment needs a stable, unique id (used as React key and
 *      for scene diffs in future phases).
 *   2. Default props (e.g. callout tone, table maxRows) live here so the
 *      composer stays focused on layout decisions.
 */

import type {
  VisualFragment,
  KpiProps,
  ChartProps,
  TableProps,
  SummaryProps,
  RiskPanelProps,
  TimelineProps,
  EntityCardProps,
  DocPreviewProps,
  CalloutProps,
  ProgressSkeletonProps,
  FragmentKind,
} from "./scene-types";

let fragmentCounter = 0;
function nextId(kind: FragmentKind): string {
  fragmentCounter++;
  return `frag_${kind}_${Date.now()}_${fragmentCounter}`;
}

// ── Factories ────────────────────────────────────────────

export function kpiFragment(props: KpiProps): Extract<VisualFragment, { kind: "kpi" }> {
  return { id: nextId("kpi"), kind: "kpi", props };
}

export function chartFragment(props: ChartProps): Extract<VisualFragment, { kind: "chart" }> {
  return { id: nextId("chart"), kind: "chart", props };
}

export function tableFragment(props: TableProps): Extract<VisualFragment, { kind: "table" }> {
  return { id: nextId("table"), kind: "table", props: { maxRows: 10, ...props } };
}

export function summaryFragment(props: SummaryProps): Extract<VisualFragment, { kind: "summary" }> {
  return { id: nextId("summary"), kind: "summary", props };
}

export function riskPanelFragment(props: RiskPanelProps): Extract<VisualFragment, { kind: "risk_panel" }> {
  return { id: nextId("risk_panel"), kind: "risk_panel", props };
}

export function timelineFragment(props: TimelineProps): Extract<VisualFragment, { kind: "timeline" }> {
  return { id: nextId("timeline"), kind: "timeline", props };
}

export function entityCardFragment(props: EntityCardProps): Extract<VisualFragment, { kind: "entity_card" }> {
  return { id: nextId("entity_card"), kind: "entity_card", props };
}

export function docPreviewFragment(props: DocPreviewProps): Extract<VisualFragment, { kind: "doc_preview" }> {
  return { id: nextId("doc_preview"), kind: "doc_preview", props };
}

export function calloutFragment(props: CalloutProps): Extract<VisualFragment, { kind: "callout" }> {
  return { id: nextId("callout"), kind: "callout", props: { ...props, tone: props.tone ?? "info" } };
}

export function progressSkeletonFragment(
  props: ProgressSkeletonProps
): Extract<VisualFragment, { kind: "progress_skeleton" }> {
  return { id: nextId("progress_skeleton"), kind: "progress_skeleton", props };
}
