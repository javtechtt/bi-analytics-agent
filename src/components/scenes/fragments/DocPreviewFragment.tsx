"use client";

/**
 * Document preview fragment — verbatim snippets from the source document
 * with optional highlight rings. Phase 3 renders text-only; Phase 5+ may
 * add page-image previews for scanned/visual docs.
 */

import type { DocPreviewProps } from "@/lib/visual/scene-types";
import { cn } from "@/lib/cn";
import { FileText } from "lucide-react";

export function DocPreviewFragment({ props }: { props: DocPreviewProps }) {
  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-accent-cyan/80" />
        <h3 className="text-sm font-semibold text-text-primary">Source snippets</h3>
        <span className="text-[10px] uppercase tracking-widest text-text-muted">
          {props.fileName}
        </span>
      </div>

      <div className="mt-3 space-y-2.5">
        {props.snippets.map((s, i) => (
          <blockquote
            key={i}
            className={cn(
              "rounded-xl border p-3 text-xs leading-relaxed",
              s.highlight
                ? "border-accent-cyan/40 bg-accent-cyan/5 text-text-primary"
                : "border-border-default/40 bg-bg-elevated/40 text-text-secondary"
            )}
          >
            {s.page != null && (
              <span className="mr-2 text-[10px] uppercase tracking-wider text-text-muted">
                p.{s.page}
              </span>
            )}
            {s.text.length > 320 ? s.text.slice(0, 317) + "…" : s.text}
          </blockquote>
        ))}
      </div>
    </div>
  );
}
