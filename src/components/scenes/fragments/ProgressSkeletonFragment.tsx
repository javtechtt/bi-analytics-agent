"use client";

/**
 * Phase 9: progress skeleton fragment.
 *
 * Live placeholder shown while a long tool runs. Messages stream in from
 * `/api/tools/progress/[traceId]` polling. The latest message is bright;
 * older ones dim so the eye lands on the current step without losing the
 * sense of what's been done.
 *
 * The "tick" updates every 250ms while mounted so the elapsed counter
 * feels alive — it doesn't depend on incoming events.
 */

import { useEffect, useState } from "react";
import type { ProgressSkeletonProps } from "@/lib/visual/scene-types";
import { cn } from "@/lib/cn";
import { Loader2, AlertTriangle, Info, CheckCircle2 } from "lucide-react";

const KIND_ICONS = {
  phase: CheckCircle2,
  info: Info,
  warn: AlertTriangle,
};

const KIND_STYLES = {
  phase: "text-cyan-300",
  info: "text-text-secondary",
  warn: "text-amber-300",
};

export function ProgressSkeletonFragment({ props }: { props: ProgressSkeletonProps }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const startedAtMs = props.startedAt ? new Date(props.startedAt).getTime() : null;
  const elapsedMs = startedAtMs != null ? now - startedAtMs : null;
  const elapsedLabel = elapsedMs != null
    ? `${(elapsedMs / 1000).toFixed(1)}s`
    : null;

  // Show only the trailing 6 messages — older ones add no value and crowd
  // the scene. The renderer dims earlier entries so the latest is obvious.
  const visible = props.messages.slice(-6);

  return (
    <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-5">
      <div className="flex items-center gap-2 text-cyan-300">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm font-medium">Working on it…</span>
        {elapsedLabel && (
          <span className="ml-auto text-xs tabular-nums text-text-muted">{elapsedLabel}</span>
        )}
      </div>

      {props.fileName && (
        <p className="mt-2 text-xs text-text-muted">
          <span className="text-text-secondary">Document:</span> {props.fileName}
        </p>
      )}
      {props.question && (
        <p className="mt-1 line-clamp-2 text-xs italic text-text-muted">
          &ldquo;{props.question}&rdquo;
        </p>
      )}

      {visible.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {visible.map((m, i) => {
            const Icon = KIND_ICONS[m.kind];
            const isLatest = i === visible.length - 1;
            return (
              <li
                key={`${m.at}-${i}`}
                className={cn(
                  "flex items-center gap-2 text-xs transition-opacity",
                  isLatest ? "opacity-100" : "opacity-50"
                )}
              >
                <Icon className={cn("h-3 w-3 shrink-0", KIND_STYLES[m.kind])} />
                <span className={cn(isLatest ? "text-text-primary" : "text-text-muted")}>
                  {m.text}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
