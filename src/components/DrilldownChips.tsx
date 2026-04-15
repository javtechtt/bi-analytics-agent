"use client";

import { ArrowRight } from "lucide-react";

interface DrilldownChipsProps {
  suggestions: string[];
  onSelect: (text: string) => void;
}

export function DrilldownChips({ suggestions, onSelect }: DrilldownChipsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] font-medium uppercase tracking-widest text-text-muted">
        Go deeper
      </span>
      {suggestions.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onSelect(s)}
          className="group flex items-center gap-1.5 rounded-full border border-border-subtle bg-bg-elevated/50 px-3.5 py-2 text-xs font-medium text-text-secondary transition-all duration-200 hover:border-accent-cyan/40 hover:text-accent-cyan hover:shadow-[0_0_10px_var(--glow-cyan)] hover:bg-accent-cyan/5"
        >
          {s}
          <ArrowRight className="h-3 w-3 -translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100" />
        </button>
      ))}
    </div>
  );
}
