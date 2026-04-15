"use client";

import { cn } from "@/lib/cn";
import type { KpiCard } from "@/lib/kpi";

interface KpiCardsProps {
  cards: KpiCard[];
}

export function KpiCards({ cards }: KpiCardsProps) {
  if (cards.length === 0) return null;

  return (
    <div className="flex flex-wrap justify-center gap-3">
      {cards.map((card) => (
        <div
          key={card.column}
          className="glass flex min-w-[140px] flex-col items-center rounded-2xl px-5 py-4 transition-all duration-300 hover:shadow-[0_0_15px_var(--glow-cyan)]"
        >
          {/* Label */}
          <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted">
            {card.label}
          </span>

          {/* Value */}
          <span className="mt-1 text-2xl font-bold tracking-tight text-text-primary">
            {card.value}
          </span>

          {/* Delta (optional) */}
          {card.delta && (
            <span
              className={cn(
                "mt-1 text-xs font-medium",
                card.deltaPositive
                  ? "text-emerald-400"
                  : "text-red-400"
              )}
            >
              {card.delta}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
