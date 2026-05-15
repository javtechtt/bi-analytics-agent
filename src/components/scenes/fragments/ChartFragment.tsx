"use client";

/**
 * Chart fragment — wraps the existing ChartCard component. ChartProps is
 * structurally identical to the legacy ChartConfig (we deliberately kept
 * the shape stable across Phase 1/2/3), so we pass it through with a
 * synthesized id and focused=true. Closing the chart removes the whole
 * scene; in Phase 4 we may allow per-fragment removal.
 */

import { ChartCard } from "@/components/ChartOverlay";
import type { ChartProps } from "@/lib/visual/scene-types";
import type { ChartConfig } from "@/lib/useRealtimeSession";

interface ChartFragmentRenderProps {
  props: ChartProps;
  fragmentId: string;
  onRemoveScene?: () => void;
}

export function ChartFragment({ props, fragmentId, onRemoveScene }: ChartFragmentRenderProps) {
  const chart: ChartConfig = {
    id: fragmentId,
    chart_type: props.chart_type,
    title: props.title,
    data: props.data,
    x_label: props.x_label,
    y_label: props.y_label,
    series: props.series,
    coverage: props.coverage,
    dataSummary: props.dataSummary,
  };
  return (
    <ChartCard
      chart={chart}
      focused={true}
      onClose={onRemoveScene ?? (() => {})}
      onFocus={() => {}}
    />
  );
}
