"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatLabel } from "@/lib/labels";
import type { ChartConfig } from "@/lib/useRealtimeSession";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface ChartCardProps {
  chart: ChartConfig;
  focused: boolean;
  onClose: () => void;
  onFocus: () => void;
}

const CHART_COLORS = [
  "#22d3ee", "#818cf8", "#a78bfa", "#34d399",
  "#fb923c", "#f472b6", "#facc15", "#38bdf8",
];

const GRID_COLOR = "rgba(148, 163, 184, 0.06)";
const AXIS_COLOR = "rgba(148, 163, 184, 0.3)";

// ── Detect series keys from data ─────────────────────────

function detectSeries(chart: ChartConfig): string[] {
  if (chart.series && chart.series.length > 0) return chart.series;
  const skip = new Set(["label", "name", "x", "y", "id"]);
  const keys = new Set<string>();
  for (const d of chart.data) {
    for (const [k, v] of Object.entries(d)) {
      if (!skip.has(k) && typeof v === "number") keys.add(k);
    }
  }
  return keys.size > 0 ? Array.from(keys) : ["value"];
}

// ── Custom tooltip ───────────────────────────────────────

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-deep/95 px-3 py-2 text-xs shadow-xl backdrop-blur-sm">
      <p className="mb-1 font-medium text-text-secondary">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className="flex items-center gap-1.5 text-text-primary">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: entry.color ?? CHART_COLORS[i] }}
          />
          {entry.name !== "value" && <span className="text-text-muted">{entry.name}:</span>}
          {typeof entry.value === "number"
            ? entry.value.toLocaleString(undefined, { maximumFractionDigits: 2 })
            : entry.value}
        </p>
      ))}
    </div>
  );
}

// ── Shared axis props ────────────────────────────────────

function xAxisProps(chart: ChartConfig) {
  return {
    dataKey: "label",
    tick: { fill: AXIS_COLOR, fontSize: 11 },
    axisLine: { stroke: GRID_COLOR },
    tickLine: false,
    label: chart.x_label
      ? { value: formatLabel(chart.x_label), position: "insideBottom" as const, offset: -2, fill: AXIS_COLOR, fontSize: 11 }
      : undefined,
  };
}

function yAxisProps(chart: ChartConfig) {
  return {
    tick: { fill: AXIS_COLOR, fontSize: 11 },
    axisLine: false as const,
    tickLine: false,
    width: 55,
    label: chart.y_label
      ? { value: formatLabel(chart.y_label), angle: -90, position: "insideLeft" as const, fill: AXIS_COLOR, fontSize: 11 }
      : undefined,
  };
}

// ── Chart renderers ──────────────────────────────────────

function renderBar(chart: ChartConfig, series: string[]) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chart.data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
        <XAxis {...xAxisProps(chart)} />
        <YAxis {...yAxisProps(chart)} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(34,211,238,0.04)" }} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11, color: AXIS_COLOR }} />}
        {series.map((key, i) => (
          <Bar key={key} dataKey={key} name={key} fill={CHART_COLORS[i % CHART_COLORS.length]}
            fillOpacity={0.85} radius={[4, 4, 0, 0]} animationDuration={800} animationBegin={100 + i * 100} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

function renderLine(chart: ChartConfig, series: string[]) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chart.data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
        <XAxis {...xAxisProps(chart)} />
        <YAxis {...yAxisProps(chart)} />
        <Tooltip content={<ChartTooltip />} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11, color: AXIS_COLOR }} />}
        {series.map((key, i) => (
          <Line key={key} type="monotone" dataKey={key} name={key}
            stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2.5}
            dot={{ fill: CHART_COLORS[i % CHART_COLORS.length], r: 3, strokeWidth: 0 }}
            activeDot={{ r: 5, stroke: "#fff", strokeWidth: 1 }}
            animationDuration={1000} animationBegin={100 + i * 150} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function renderArea(chart: ChartConfig, series: string[]) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chart.data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <defs>
          {series.map((key, i) => (
            <linearGradient key={key} id={`areaGrad-${chart.id}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0.25} />
              <stop offset="95%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
        <XAxis {...xAxisProps(chart)} />
        <YAxis {...yAxisProps(chart)} />
        <Tooltip content={<ChartTooltip />} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11, color: AXIS_COLOR }} />}
        {series.map((key, i) => (
          <Area key={key} type="monotone" dataKey={key} name={key}
            stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2}
            fill={`url(#areaGrad-${chart.id}-${i})`}
            animationDuration={1000} animationBegin={100 + i * 150} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function renderPie(chart: ChartConfig, series: string[]) {
  const dataKey = series[0] ?? "value";
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Tooltip content={<ChartTooltip />} />
        <Pie data={chart.data} dataKey={dataKey} nameKey="label"
          cx="50%" cy="50%" innerRadius="40%" outerRadius="72%"
          paddingAngle={2} strokeWidth={0} animationDuration={900} animationBegin={100}
          label={({ name, percent }: { name?: string; percent?: number }) =>
            `${name ?? ""} ${((percent ?? 0) * 100).toFixed(0)}%`
          }
          labelLine={{ stroke: AXIS_COLOR, strokeWidth: 1 }}>
          {chart.data.map((_, i) => (
            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.85} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

function renderScatter(chart: ChartConfig) {
  const xKey = chart.data[0]?.x != null ? "x" : "value";
  const yKey = chart.data[0]?.y != null ? "y" : "value";
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ScatterChart margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} />
        <XAxis dataKey={xKey} type="number" tick={{ fill: AXIS_COLOR, fontSize: 11 }}
          axisLine={{ stroke: GRID_COLOR }} tickLine={false} name={chart.x_label ?? "X"}
          label={chart.x_label ? { value: chart.x_label, position: "insideBottom", offset: -2, fill: AXIS_COLOR, fontSize: 11 } : undefined} />
        <YAxis dataKey={yKey} type="number" tick={{ fill: AXIS_COLOR, fontSize: 11 }}
          axisLine={false} tickLine={false} width={55} name={chart.y_label ?? "Y"}
          label={chart.y_label ? { value: chart.y_label, angle: -90, position: "insideLeft", fill: AXIS_COLOR, fontSize: 11 } : undefined} />
        <Tooltip content={<ChartTooltip />} cursor={{ strokeDasharray: "3 3", stroke: AXIS_COLOR }} />
        <Scatter data={chart.data} fill={CHART_COLORS[0]} fillOpacity={0.7} animationDuration={800} />
      </ScatterChart>
    </ResponsiveContainer>
  );
}

// ── Chart card (reusable, not fixed-position) ────────────

export function ChartCard({ chart, focused, onClose, onFocus }: ChartCardProps) {
  const series = useMemo(() => detectSeries(chart), [chart]);

  const renderers: Record<string, (c: ChartConfig, s: string[]) => React.ReactNode> = {
    bar: renderBar, line: renderLine, area: renderArea, pie: renderPie,
    scatter: (c) => renderScatter(c),
  };
  const renderChart = renderers[chart.chart_type] ?? renderBar;

  return (
    <div
      onClick={!focused ? onFocus : undefined}
      className={cn(
        "glass flex h-full flex-col overflow-hidden rounded-2xl transition-all duration-500 ease-out",
        focused
          ? "glow-border"
          : "border border-border-subtle cursor-pointer hover:border-border-accent opacity-80 hover:opacity-100"
      )}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 py-2.5">
        <h3 className={cn(
          "font-semibold tracking-wide text-text-primary",
          focused ? "text-sm" : "text-xs"
        )}>
          {chart.title}
        </h3>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="rounded p-1 text-text-muted transition-colors hover:text-red-400"
          aria-label="Close chart"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Chart body — min-h ensures ResponsiveContainer gets a real pixel height */}
      <div className="relative min-h-0 flex-1 p-3">
        {renderChart(chart, series)}
      </div>
    </div>
  );
}
