"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { X, AlertTriangle, TrendingUp, Lightbulb, Download } from "lucide-react";
import { cn } from "@/lib/cn";
import { KpiCards } from "@/components/KpiCards";
import { ChartCard } from "@/components/ChartOverlay";
import { DrilldownChips } from "@/components/DrilldownChips";
import { exportToPng } from "@/lib/export";
import type { ChartConfig } from "@/lib/useRealtimeSession";
import type { KpiCard } from "@/lib/kpi";

interface InsightItem {
  type: string;
  severity: string;
  observation: string;
  implication: string;
  recommendation: string;
  spoken: string;
  impact: number;
}

export interface DashboardData {
  title: string;
  subtitle: string;
  kpis: KpiCard[];
  charts: ChartConfig[];
  insights: InsightItem[];
  risks: InsightItem[];
  opportunities: InsightItem[];
  drilldowns: string[];
}

interface DashboardViewProps {
  dashboard: DashboardData;
  onClose: () => void;
  onDrilldown: (text: string) => void;
}

export function DashboardView({ dashboard, onClose, onDrilldown }: DashboardViewProps) {
  const [visible, setVisible] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const handleClose = () => {
    setVisible(false);
    setTimeout(onClose, 300);
  };

  const handleDownload = useCallback(async () => {
    if (!exportRef.current || exporting) return;
    setExporting(true);
    try {
      const slug = dashboard.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
      await exportToPng(exportRef.current, slug || "dashboard");
    } finally {
      setExporting(false);
    }
  }, [dashboard.title, exporting]);

  const chartsWithIds = useMemo(
    () => dashboard.charts.map((c, i) => ({ ...c, id: c.id ?? `dash-chart-${i}` })),
    [dashboard.charts]
  );

  return (
    <div
      className={cn(
        "fixed inset-0 z-40 flex flex-col transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0 pointer-events-none"
      )}
    >
      <div className="absolute inset-0 bg-bg-deep/80 backdrop-blur-md" />

      {/* Scrollable content */}
      <div className="relative z-10 flex flex-1 flex-col overflow-y-auto">

        {/* Toolbar — excluded from export */}
        <div
          data-export-hidden
          className="sticky top-0 z-20 flex items-center justify-end gap-2 border-b border-border-subtle bg-bg-deep/90 px-8 py-3 backdrop-blur-md"
        >
          <button
            type="button"
            onClick={handleDownload}
            disabled={exporting}
            className={cn(
              "flex items-center gap-2 rounded-xl border border-border-accent/40 bg-bg-elevated/80 px-4 py-2 text-xs font-medium text-text-primary shadow-lg backdrop-blur-md transition-all duration-200 hover:border-accent-cyan/60 hover:text-accent-cyan",
              exporting && "opacity-50 cursor-wait"
            )}
          >
            <Download className="h-4 w-4" />
            {exporting ? "Exporting…" : "Download Dashboard"}
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="flex items-center gap-2 rounded-xl border border-border-accent/40 bg-bg-elevated/80 px-4 py-2 text-xs font-medium text-text-primary shadow-lg backdrop-blur-md transition-all duration-200 hover:border-red-500/40 hover:bg-red-950/40 hover:text-red-300"
          >
            <X className="h-4 w-4" />
            Close
          </button>
        </div>

        {/* ── Export area: everything below here is captured ── */}
        <div ref={exportRef} className="mx-auto w-full max-w-7xl px-8 py-8">

          {/* Dashboard title — included in export */}
          <div className="mb-8">
            <h2 className="text-xl font-bold tracking-wide text-text-primary">
              {dashboard.title}
            </h2>
            <p className="mt-1 text-sm text-text-muted">{dashboard.subtitle}</p>
          </div>

          {/* KPI row */}
          {dashboard.kpis.length > 0 && (
            <section className="mb-8">
              <KpiCards cards={dashboard.kpis} />
            </section>
          )}

          {/* Charts grid */}
          {chartsWithIds.length > 0 && (
            <section className="mb-8">
              <div
                className={cn(
                  "grid gap-4",
                  chartsWithIds.length === 1 && "grid-cols-1",
                  chartsWithIds.length === 2 && "grid-cols-1 lg:grid-cols-2",
                  chartsWithIds.length >= 3 && "grid-cols-1 md:grid-cols-2",
                )}
              >
                {chartsWithIds.map((chart, i) => (
                  <div
                    key={chart.id}
                    className={cn(
                      "h-[350px]",
                      i === 0 && chartsWithIds.length >= 3 && "md:col-span-2 h-[400px]"
                    )}
                  >
                    <ChartCard
                      chart={chart}
                      focused={i === 0}
                      onClose={() => {}}
                      onFocus={() => {}}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Insights + Risks + Opportunities panels */}
          <section className="mb-8 grid gap-4 md:grid-cols-3">
            {dashboard.insights.length > 0 && (
              <div className="glass rounded-2xl p-5">
                <div className="mb-3 flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-accent-cyan" />
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-accent-cyan">
                    Key Findings
                  </h3>
                </div>
                <ul className="space-y-4">
                  {dashboard.insights.map((insight, i) => (
                    <li key={i}>
                      <p className="text-sm font-medium leading-relaxed text-text-primary">{insight.observation}</p>
                      <p className="mt-1 text-xs leading-relaxed text-text-muted">{insight.implication}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {dashboard.risks.length > 0 && (
              <div className="glass rounded-2xl border-red-500/10 p-5">
                <div className="mb-3 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-400" />
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-red-400">
                    Risks
                  </h3>
                </div>
                <ul className="space-y-4">
                  {dashboard.risks.map((risk, i) => (
                    <li key={i}>
                      <p className="text-sm font-medium leading-relaxed text-text-primary">{risk.observation}</p>
                      <p className="mt-1 text-xs leading-relaxed text-text-muted">{risk.recommendation}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {dashboard.opportunities.length > 0 && (
              <div className="glass rounded-2xl border-emerald-500/10 p-5">
                <div className="mb-3 flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-emerald-400" />
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-emerald-400">
                    Opportunities
                  </h3>
                </div>
                <ul className="space-y-4">
                  {dashboard.opportunities.map((opp, i) => (
                    <li key={i}>
                      <p className="text-sm font-medium leading-relaxed text-text-primary">{opp.observation}</p>
                      <p className="mt-1 text-xs leading-relaxed text-text-muted">{opp.recommendation}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* Drill-down chips — excluded from export */}
          {dashboard.drilldowns.length > 0 && (
            <section className="mb-8" data-export-hidden>
              <DrilldownChips suggestions={dashboard.drilldowns} onSelect={onDrilldown} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
