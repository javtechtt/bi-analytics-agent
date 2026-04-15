"use client";

import { Briefcase, BarChart3, TrendingUp, Settings2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { OutputMode } from "@/lib/types";

interface ModeSelectorProps {
  mode: OutputMode;
  onChange: (mode: OutputMode) => void;
  disabled?: boolean;
}

const MODES: Array<{ value: OutputMode; label: string; icon: typeof Briefcase }> = [
  { value: "executive", label: "Executive", icon: Briefcase },
  { value: "analyst", label: "Analyst", icon: BarChart3 },
  { value: "sales", label: "Sales", icon: TrendingUp },
  { value: "operations", label: "Operations", icon: Settings2 },
];

export function ModeSelector({ mode, onChange, disabled }: ModeSelectorProps) {
  return (
    <div className="flex items-center gap-1 rounded-xl border border-border-subtle bg-bg-elevated/40 p-1 backdrop-blur-sm">
      {MODES.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(value)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-all duration-200",
            mode === value
              ? "bg-accent-cyan/15 text-accent-cyan shadow-[0_0_8px_var(--glow-cyan)]"
              : "text-text-muted hover:text-text-secondary",
            disabled && "opacity-40 cursor-not-allowed"
          )}
        >
          <Icon className="h-3 w-3" />
          {label}
        </button>
      ))}
    </div>
  );
}
