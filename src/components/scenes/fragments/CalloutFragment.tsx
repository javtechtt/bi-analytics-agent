"use client";

/**
 * Callout fragment — short emphasized note with optional source citation.
 * Used for clause references, anomaly markers, and "look at this" moments
 * within a larger scene.
 */

import type { CalloutProps } from "@/lib/visual/scene-types";
import { cn } from "@/lib/cn";
import { Info, AlertTriangle, CheckCircle2, Circle } from "lucide-react";

const TONE_STYLES = {
  info:    { border: "border-cyan-400/30",    bg: "bg-cyan-400/5",    text: "text-cyan-300",    Icon: Info },
  warning: { border: "border-amber-400/40",   bg: "bg-amber-400/5",   text: "text-amber-300",   Icon: AlertTriangle },
  success: { border: "border-emerald-400/30", bg: "bg-emerald-400/5", text: "text-emerald-300", Icon: CheckCircle2 },
  neutral: { border: "border-slate-400/30",   bg: "bg-slate-400/5",   text: "text-slate-300",   Icon: Circle },
};

export function CalloutFragment({ props }: { props: CalloutProps }) {
  const s = TONE_STYLES[props.tone];
  const Icon = s.Icon;
  return (
    <div className={cn("rounded-xl border p-4", s.border, s.bg)}>
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", s.text)} />
        <div className="min-w-0 flex-1">
          {props.title && (
            <h4 className={cn("text-sm font-medium", s.text)}>{props.title}</h4>
          )}
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">{props.body}</p>
          {props.sourceText && (
            <p className="mt-2 border-l-2 border-text-muted/30 pl-2 text-[11px] italic text-text-muted">
              &ldquo;{props.sourceText.length > 240 ? props.sourceText.slice(0, 237) + "…" : props.sourceText}&rdquo;
              {props.sourcePage != null && (
                <span className="ml-1 not-italic">(p.{props.sourcePage})</span>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
