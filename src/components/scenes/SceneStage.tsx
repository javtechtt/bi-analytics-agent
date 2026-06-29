"use client";

/**
 * Phase 3: SceneStage — the unified visual surface.
 *
 * Replaces the role of ChartStage + DashboardView as the primary renderer.
 * Renders the most recent scene as a focused card with the others
 * collapsed below as a stack. Each scene picks its own layout (dashboard /
 * stack / grid / split / spotlight) which determines how its fragments
 * are arranged.
 *
 * Backward compat:
 *   - Legacy chart/dashboard tool results are bridged into scenes by
 *     useRealtimeSession before reaching this component, so this is the
 *     ONE place visuals render in Phase 3.
 *   - ChartStage and DashboardView still exist on disk but are no longer
 *     rendered from page.tsx — they can be deleted in a future phase.
 */

import { useState, useEffect } from "react";
import { X, ChevronDown, ChevronUp, Layers } from "lucide-react";
import { cn } from "@/lib/cn";
import { DrilldownChips } from "@/components/DrilldownChips";
import type { VisualScene, VisualFragment, SceneLayout } from "@/lib/visual/scene-types";

import { KpiFragment } from "./fragments/KpiFragment";
import { ChartFragment } from "./fragments/ChartFragment";
import { TableFragment } from "./fragments/TableFragment";
import { SummaryFragment } from "./fragments/SummaryFragment";
import { RiskPanelFragment } from "./fragments/RiskPanelFragment";
import { TimelineFragment } from "./fragments/TimelineFragment";
import { EntityCardFragment } from "./fragments/EntityCardFragment";
import { DocPreviewFragment } from "./fragments/DocPreviewFragment";
import { CalloutFragment } from "./fragments/CalloutFragment";
import { ProgressSkeletonFragment } from "./fragments/ProgressSkeletonFragment";

interface SceneStageProps {
  scenes: VisualScene[];
  onRemoveScene: (id: string) => void;
  onClearAll: () => void;
  onDrilldown?: (text: string) => void;
}

export function SceneStage({ scenes, onRemoveScene, onClearAll, onDrilldown }: SceneStageProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (scenes.length > 0 && !visible) {
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    if (scenes.length === 0 && visible) {
      const raf = requestAnimationFrame(() => setVisible(false));
      return () => cancelAnimationFrame(raf);
    }
  }, [scenes.length, visible]);

  if (scenes.length === 0) return null;

  const focused = scenes[scenes.length - 1];
  const history = scenes.slice(0, -1).reverse();

  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-20 flex max-h-[80vh] flex-col gap-4 px-4 pb-4 pt-2 transition-all duration-500",
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Layers className="h-3.5 w-3.5" />
          <span>{scenes.length} scene{scenes.length === 1 ? "" : "s"}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="glass flex items-center gap-1 rounded-full px-3 py-1 text-[11px] text-text-secondary hover:text-text-primary"
          >
            {collapsed ? (
              <>
                <ChevronUp className="h-3 w-3" /> Expand
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" /> Collapse
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onClearAll}
            className="glass flex items-center gap-1 rounded-full px-3 py-1 text-[11px] text-text-secondary hover:text-red-300"
          >
            <X className="h-3 w-3" /> Clear all
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-3 overflow-y-auto">
          {/* Focused scene */}
          <SceneCard scene={focused} onClose={() => onRemoveScene(focused.id)} focused />
          {focused.drilldowns && focused.drilldowns.length > 0 && onDrilldown && (
            <DrilldownChips suggestions={focused.drilldowns} onSelect={onDrilldown} />
          )}

          {/* History — collapsed previews */}
          {history.length > 0 && (
            <div className="flex flex-col gap-2 opacity-80">
              <p className="text-[10px] uppercase tracking-widest text-text-muted">Previous scenes</p>
              {history.map((s) => (
                <SceneCard
                  key={s.id}
                  scene={s}
                  onClose={() => onRemoveScene(s.id)}
                  focused={false}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Scene card ───────────────────────────────────────────

function SceneCard({
  scene,
  onClose,
  focused,
}: {
  scene: VisualScene;
  onClose: () => void;
  focused: boolean;
}) {
  return (
    <div
      className={cn(
        "glass rounded-3xl border border-border-default/40 p-4 transition-all duration-300",
        focused ? "shadow-[0_0_30px_var(--glow-cyan)]" : "scale-[0.98]"
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-text-primary">{scene.title}</h2>
          {scene.caption && focused && (
            <p className="mt-0.5 text-xs text-text-secondary">{scene.caption}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-1 text-text-muted transition-colors hover:bg-bg-elevated hover:text-red-300"
          aria-label="Remove scene"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className={cn("mt-4", layoutClassName(scene.layout))}>
        {scene.fragments.map((frag) => (
          <div
            key={frag.id}
            className={cn(
              spanClassFor(scene.layout, frag),
              // Charts render into a Recharts ResponsiveContainer (height:100%),
              // which collapses to 0 unless an ancestor has a resolved height.
              // Every other fragment is content-sized, so only charts need this.
              frag.kind === "chart" && chartHeightClass(scene.layout)
            )}
          >
            <FragmentRenderer fragment={frag} onRemoveScene={onClose} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Fragment dispatch ────────────────────────────────────

function FragmentRenderer({
  fragment,
  onRemoveScene,
}: {
  fragment: VisualFragment;
  onRemoveScene: () => void;
}) {
  switch (fragment.kind) {
    case "kpi":         return <KpiFragment props={fragment.props} />;
    case "chart":       return <ChartFragment props={fragment.props} fragmentId={fragment.id} onRemoveScene={onRemoveScene} />;
    case "table":       return <TableFragment props={fragment.props} />;
    case "summary":     return <SummaryFragment props={fragment.props} />;
    case "risk_panel":  return <RiskPanelFragment props={fragment.props} />;
    case "timeline":    return <TimelineFragment props={fragment.props} />;
    case "entity_card": return <EntityCardFragment props={fragment.props} />;
    case "doc_preview": return <DocPreviewFragment props={fragment.props} />;
    case "callout":     return <CalloutFragment props={fragment.props} />;
    case "progress_skeleton": return <ProgressSkeletonFragment props={fragment.props} />;
  }
}

// ── Layout helpers ───────────────────────────────────────

function layoutClassName(layout: SceneLayout): string {
  switch (layout) {
    case "spotlight":  return "grid grid-cols-1 gap-3";
    case "grid":       return "grid grid-cols-1 gap-3 md:grid-cols-2";
    case "split":      return "grid grid-cols-1 gap-3 lg:grid-cols-2";
    case "stack":      return "flex flex-col gap-3";
    case "dashboard":  return "grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3";
  }
}

/**
 * Concrete height for chart fragments. Recharts' ResponsiveContainer needs a
 * parent with a resolved height or it renders at 0px — the legacy ChartStage
 * gave charts explicit heights (h-[50vh]/h-[24vh]); SceneStage must too.
 * Taller for a single spotlight chart; shorter inside multi-column grids.
 */
function chartHeightClass(layout: SceneLayout): string {
  switch (layout) {
    case "spotlight": return "h-[44vh] min-h-[320px]";
    case "split":     return "h-80";
    case "grid":      return "h-72";
    case "dashboard": return "h-64";
    case "stack":     return "h-72";
  }
}

/**
 * Some fragments should always span the full width (KPI rows, summaries).
 * Others can sit in their own grid cell.
 */
function spanClassFor(layout: SceneLayout, fragment: VisualFragment): string {
  if (layout === "stack" || layout === "spotlight") return "";
  const fullWidthKinds: VisualFragment["kind"][] = ["kpi", "summary"];
  if (fullWidthKinds.includes(fragment.kind)) {
    if (layout === "dashboard") return "md:col-span-2 lg:col-span-3";
    if (layout === "grid" || layout === "split") return "md:col-span-2";
  }
  return "";
}
