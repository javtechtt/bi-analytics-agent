/**
 * Phase 3: Visual Composition Engine — type system.
 *
 * A VisualScene is the unit of intelligence displayed on screen. It is the
 * NEW source of truth for what the user sees; the legacy `charts[]` and
 * `activeDashboard` state in useRealtimeSession are kept for backwards
 * compatibility but everything renders through SceneStage now.
 *
 * Architectural contract:
 *   - One tool call → at most one new scene appended to `scenes[]`.
 *   - Existing tools (create_chart, generate_dashboard, query_document)
 *     are bridged client-side into scenes (see useRealtimeSession.ts).
 *   - The new `compose_visual_scene` tool returns a scene directly.
 *   - SceneStage selects a layout per scene and dispatches each fragment
 *     to its component via the fragment registry in fragments.ts.
 *
 * Backward compat:
 *   - `ChartProps` is structurally identical to the existing `ChartConfig`
 *     used by ChartOverlay/ChartCard, so chart fragments render via the
 *     same component without any data conversion.
 *   - `KpiProps` matches the legacy `KpiCard` shape, so kpi fragments
 *     render via the existing KpiCards component.
 */

import type { Fact, Metric, TimelineEvent, Entity, DocumentType, SourceSpan } from "@/lib/documents/types";

// ── Layouts ──────────────────────────────────────────────

export type SceneLayout =
  | "spotlight"   // one large fragment + supporting fragments below
  | "grid"        // responsive 2-column grid
  | "split"       // left/right split (e.g. risk panel | doc preview)
  | "stack"       // vertical stack (default for narrative scenes)
  | "dashboard";  // KPI row → charts grid → callouts (mirrors DashboardView)

// ── Fragment prop types ──────────────────────────────────

export interface KpiProps {
  cards: Array<{
    label: string;
    value: string;
    /** Optional delta string like "+12%" or "-3.4K". */
    delta?: string;
    /** true → green, false → red, undefined → neutral */
    deltaPositive?: boolean;
    /** Internal key — defaults to label if absent (used as React key). */
    column?: string;
    /** Whether `value` should be rendered as a percentage. */
    isPercent?: boolean;
    /** Raw numeric value, optional, mostly informational. */
    rawValue?: number;
  }>;
}

export interface ChartProps {
  chart_type: "bar" | "line" | "pie" | "area" | "scatter";
  title: string;
  data: Array<Record<string, string | number>>;
  x_label?: string;
  y_label?: string;
  series?: string[];
  coverage?: string;
  dataSummary?: string;
}

export interface TableProps {
  title: string;
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  /** Cap rows rendered (defaults to 10). */
  maxRows?: number;
  caption?: string;
}

export interface SummaryProps {
  title: string;
  body: string;
  bullets?: string[];
  confidence?: "high" | "medium" | "low";
}

export interface RiskItem {
  severity: "high" | "medium" | "low";
  title: string;
  description: string;
  sourcePage?: number;
  sourceText?: string;
}

export interface RiskPanelProps {
  title: string;
  risks: RiskItem[];
}

export interface TimelineItem {
  date: string;
  label: string;
  detail?: string;
  sourcePage?: number;
}

export interface TimelineProps {
  title: string;
  events: TimelineItem[];
}

export interface EntityCardProps {
  title: string;
  entities: Array<{
    name: string;
    type: string;
    role?: string;
    aliases?: string[];
  }>;
}

export interface DocPreviewProps {
  documentId?: string;
  fileName: string;
  /** Verbatim snippets from the source, in display order. */
  snippets: Array<{ page?: number; text: string; highlight?: boolean }>;
}

export interface CalloutProps {
  tone: "info" | "warning" | "success" | "neutral";
  title?: string;
  body: string;
  sourcePage?: number;
  sourceText?: string;
}

/**
 * Phase 9 — live loading state shown while a long tool runs. The skeleton
 * appears immediately on tool start with a single bootstrap message; the
 * client polls `/api/tools/progress/[traceId]` and replaces `messages` as
 * new events stream in. When the tool returns, the skeleton scene is
 * replaced by the real one.
 */
export interface ProgressSkeletonProps {
  /** Tool that's running — e.g. "query_document_v2". Shown subtly. */
  toolName: string;
  /** Optional file the agent is working on. */
  fileName?: string;
  /** User's question — gives context while waiting. Truncated client-side. */
  question?: string;
  /** Most recent message stack, newest LAST. The renderer dims older
   *  entries so the eye lands on the current step. */
  messages: Array<{ kind: "phase" | "info" | "warn"; text: string; at: string }>;
  /** Optional millisecond tick the client may use to show "elapsed". */
  startedAt?: string;
}

// ── Discriminated fragment union ─────────────────────────

export type VisualFragment =
  | { id: string; kind: "kpi";                props: KpiProps }
  | { id: string; kind: "chart";              props: ChartProps }
  | { id: string; kind: "table";              props: TableProps }
  | { id: string; kind: "summary";            props: SummaryProps }
  | { id: string; kind: "risk_panel";         props: RiskPanelProps }
  | { id: string; kind: "timeline";           props: TimelineProps }
  | { id: string; kind: "entity_card";        props: EntityCardProps }
  | { id: string; kind: "doc_preview";        props: DocPreviewProps }
  | { id: string; kind: "callout";            props: CalloutProps }
  | { id: string; kind: "progress_skeleton";  props: ProgressSkeletonProps };

export type FragmentKind = VisualFragment["kind"];

// ── Scene ────────────────────────────────────────────────

export interface VisualScene {
  id: string;
  documentId?: string;
  sessionId?: string;
  /** Headline shown on the scene chrome (e.g. "Risk profile · contract.pdf"). */
  title: string;
  layout: SceneLayout;
  fragments: VisualFragment[];
  /** Short caption — what the voice agent said when composing this scene. */
  caption?: string;
  /** Optional drill-down chip suggestions for the user. */
  drilldowns?: string[];
  /** Confidence label inherited from the source extraction / aggregation. */
  confidence?: "high" | "medium" | "low";
  /** ISO timestamp for ordering and persistence. */
  createdAt: string;
}

// ── Compose input contracts (used by composer.ts) ────────

export type SceneIntent =
  | "overview"
  | "risk"
  | "timeline"
  | "metric"
  | "parties"
  | "obligations"
  | "trend"
  | "comparison"
  | "custom";

export interface ComposeSceneInput {
  intent: SceneIntent;
  documentType: DocumentType | "spreadsheet";
  documentId?: string;
  sessionId?: string;
  fileName: string;
  question?: string;
  caption?: string;

  // Tabular inputs (one of these is typically provided for spreadsheet scenes)
  parsedData?: import("@/lib/types").ParsedData;
  kpis?: KpiProps["cards"];
  charts?: ChartProps[];

  // Narrative inputs
  facts?: Fact[];
  metrics?: Metric[];
  timeline?: TimelineEvent[];
  entities?: Entity[];
  spans?: Record<string, SourceSpan>;
  /** Spoken answer text — becomes the body of a summary fragment when present. */
  answer?: string;

  confidence?: "high" | "medium" | "low";

  /** Drill-down suggestions if the caller already has them (e.g. from generate_dashboard). */
  drilldowns?: string[];
}
