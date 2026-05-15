"use client";

/**
 * Timeline fragment — date-anchored events rendered as a vertical
 * spine. Common for contracts (effective date, termination) and reports
 * (reporting period milestones).
 */

import type { TimelineProps } from "@/lib/visual/scene-types";

export function TimelineFragment({ props }: { props: TimelineProps }) {
  return (
    <div className="glass rounded-2xl p-5">
      <h3 className="text-sm font-semibold text-text-primary">{props.title}</h3>

      <ol className="relative mt-4 space-y-3 border-l border-border-default/40 pl-4">
        {props.events.map((e, i) => (
          <li key={i} className="relative">
            <span className="absolute -left-[20px] top-1.5 h-2 w-2 rounded-full bg-accent-cyan/80 shadow-[0_0_6px_var(--glow-cyan)]" />
            <div className="text-[11px] font-medium uppercase tracking-wider text-accent-cyan/80">
              {e.date}
            </div>
            <p className="mt-0.5 text-sm text-text-primary">{e.label}</p>
            {e.detail && (
              <p className="mt-0.5 text-xs text-text-secondary">{e.detail}</p>
            )}
            {e.sourcePage != null && (
              <p className="mt-0.5 text-[10px] text-text-muted">p.{e.sourcePage}</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
