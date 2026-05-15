"use client";

/**
 * Risk panel fragment — vertically stacked list of risks/obligations with
 * severity coloring and optional source citation. Used for contract/policy
 * documents where the user wants to see exposures grouped together.
 */

import type { RiskPanelProps } from "@/lib/visual/scene-types";
import { cn } from "@/lib/cn";
import { AlertTriangle } from "lucide-react";

const SEVERITY_STYLES = {
  high:   { border: "border-red-400/40",    bg: "bg-red-400/5",    text: "text-red-300" },
  medium: { border: "border-amber-400/40",  bg: "bg-amber-400/5",  text: "text-amber-300" },
  low:    { border: "border-slate-400/40",  bg: "bg-slate-400/5",  text: "text-slate-300" },
};

export function RiskPanelFragment({ props }: { props: RiskPanelProps }) {
  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold text-text-primary">{props.title}</h3>
        <span className="text-[10px] uppercase tracking-widest text-text-muted">
          {props.risks.length} item{props.risks.length === 1 ? "" : "s"}
        </span>
      </div>

      <ul className="mt-3 space-y-2.5">
        {props.risks.map((r, i) => {
          const s = SEVERITY_STYLES[r.severity];
          return (
            <li
              key={i}
              className={cn("rounded-xl border p-3", s.border, s.bg)}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h4 className={cn("text-sm font-medium", s.text)}>{r.title}</h4>
                <span className={cn("text-[10px] uppercase tracking-wider", s.text)}>
                  {r.severity}
                </span>
              </div>
              <p className="mt-1 text-xs text-text-secondary">{r.description}</p>
              {r.sourceText && (
                <p className="mt-2 border-l-2 border-text-muted/30 pl-2 text-[11px] italic text-text-muted">
                  &ldquo;{r.sourceText.length > 240 ? r.sourceText.slice(0, 237) + "…" : r.sourceText}&rdquo;
                  {r.sourcePage != null && (
                    <span className="ml-1 not-italic">(p.{r.sourcePage})</span>
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
