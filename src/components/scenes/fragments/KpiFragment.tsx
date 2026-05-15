"use client";

/**
 * KPI fragment — wraps the existing KpiCards component so visual identity
 * matches the legacy dashboard. The KpiCard shape is structurally identical
 * to KpiProps["cards"][number] for the fields KpiCards reads, so we pass
 * the cards array through.
 */

import { KpiCards } from "@/components/KpiCards";
import type { KpiProps } from "@/lib/visual/scene-types";
import type { KpiCard } from "@/lib/kpi";

export function KpiFragment({ props }: { props: KpiProps }) {
  // Coerce missing column → label, missing rawValue → 0, missing isPercent → false.
  // KpiCards is strict about shape; we keep that contract here.
  const cards: KpiCard[] = props.cards.map((c, idx) => ({
    column: c.column ?? `kpi_${idx}_${c.label}`,
    label: c.label,
    value: c.value,
    rawValue: c.rawValue ?? 0,
    isPercent: c.isPercent ?? false,
    delta: c.delta,
    deltaPositive: c.deltaPositive,
  }));
  return <KpiCards cards={cards} />;
}
