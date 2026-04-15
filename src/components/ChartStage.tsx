"use client";

import { useState, useEffect } from "react";
import { X, Minimize2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { ChartCard } from "@/components/ChartOverlay";
import { DrilldownChips } from "@/components/DrilldownChips";
import { KpiCards } from "@/components/KpiCards";
import type { ChartConfig } from "@/lib/useRealtimeSession";
import type { KpiCard } from "@/lib/kpi";

interface ChartStageProps {
  charts: ChartConfig[];
  focusedChartId: string | null;
  drilldowns: string[];
  kpiCards: KpiCard[];
  onRemove: (id: string) => void;
  onFocus: (id: string) => void;
  onClearAll: () => void;
  onDrilldown: (text: string) => void;
}

export function ChartStage({
  charts,
  focusedChartId,
  drilldowns,
  kpiCards,
  onRemove,
  onFocus,
  onClearAll,
  onDrilldown,
}: ChartStageProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (charts.length > 0 && !visible) {
      requestAnimationFrame(() => setVisible(true));
    }
    if (charts.length === 0) {
      setVisible(false);
    }
  }, [charts.length, visible]);

  if (charts.length === 0) return null;

  const focused = charts.find((c) => c.id === focusedChartId) ?? charts[charts.length - 1];
  const supporting = charts.filter((c) => c.id !== focused.id);

  return (
    <div
      className={cn(
        "fixed inset-0 z-30 flex flex-col transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0 pointer-events-none"
      )}
    >
      {/* Backdrop — click to dismiss */}
      <div
        className="absolute inset-0 bg-bg-deep/60 backdrop-blur-sm cursor-pointer"
        onClick={onClearAll}
      />

      {/* Close / Clear all button — large, always visible */}
      <div className="relative z-10 flex items-center justify-end gap-2 px-6 py-3">
        <button
          type="button"
          onClick={onClearAll}
          className="flex items-center gap-2 rounded-xl border border-border-accent/40 bg-bg-elevated/80 px-4 py-2 text-xs font-medium text-text-primary shadow-lg backdrop-blur-md transition-all duration-200 hover:border-red-500/40 hover:bg-red-950/40 hover:text-red-300"
        >
          {charts.length > 1 ? (
            <>
              <X className="h-4 w-4" />
              Clear all charts
            </>
          ) : (
            <>
              <Minimize2 className="h-4 w-4" />
              Close chart
            </>
          )}
        </button>
      </div>

      {/* Chart layout */}
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-4 overflow-hidden px-6 pb-6">
        {/* KPI cards — above charts */}
        {kpiCards.length > 0 && (
          <div className="w-full max-w-5xl">
            <KpiCards cards={kpiCards} />
          </div>
        )}

        {/* Focused chart */}
        <div
          className={cn(
            "w-full transition-all duration-500 ease-out",
            supporting.length > 0
              ? "max-w-4xl h-[50vh]"
              : "max-w-5xl h-[60vh]"
          )}
        >
          <ChartCard
            chart={focused}
            focused={true}
            onClose={() => onRemove(focused.id)}
            onFocus={() => {}}
          />
        </div>

        {/* Drill-down chips */}
        {drilldowns.length > 0 && (
          <div className="w-full max-w-5xl">
            <DrilldownChips suggestions={drilldowns} onSelect={onDrilldown} />
          </div>
        )}

        {/* Supporting charts */}
        {supporting.length > 0 && (
          <div className="flex w-full max-w-5xl gap-3 overflow-x-auto pb-2">
            {supporting.map((chart) => (
              <div
                key={chart.id}
                className="h-[24vh] min-w-[300px] flex-1 max-w-lg"
              >
                <ChartCard
                  chart={chart}
                  focused={false}
                  onClose={() => onRemove(chart.id)}
                  onFocus={() => onFocus(chart.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
