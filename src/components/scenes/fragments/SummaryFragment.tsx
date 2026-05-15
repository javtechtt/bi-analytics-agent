"use client";

/**
 * Summary fragment — the textual anchor for a scene. Pairs with the
 * voice agent's spoken narration; the body text is essentially what the
 * agent said, captured for visual reference.
 */

import type { SummaryProps } from "@/lib/visual/scene-types";
import { cn } from "@/lib/cn";

const CONFIDENCE_STYLES = {
  high:   "border-emerald-400/30 bg-emerald-400/5 text-emerald-300/80",
  medium: "border-amber-400/30  bg-amber-400/5  text-amber-300/80",
  low:    "border-red-400/30    bg-red-400/5    text-red-300/80",
};

export function SummaryFragment({ props }: { props: SummaryProps }) {
  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-primary">{props.title}</h3>
        {props.confidence && (
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider",
              CONFIDENCE_STYLES[props.confidence]
            )}
          >
            {props.confidence} confidence
          </span>
        )}
      </div>

      {props.body && (
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">{props.body}</p>
      )}

      {props.bullets && props.bullets.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {props.bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-text-secondary">
              <span className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent-cyan/70" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
