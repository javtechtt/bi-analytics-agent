"use client";

import { cn } from "@/lib/cn";
import type { SessionStatus as SessionStatusType } from "@/lib/types";

interface SessionStatusProps {
  status: SessionStatusType;
}

const statusConfig: Record<
  SessionStatusType,
  { label: string; dotClass: string }
> = {
  disconnected: {
    label: "Offline",
    dotClass: "bg-text-muted",
  },
  connecting: {
    label: "Connecting…",
    dotClass: "bg-amber-400 animate-pulse",
  },
  connected: {
    label: "Live",
    dotClass: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]",
  },
  error: {
    label: "Error",
    dotClass: "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.5)]",
  },
};

export function SessionStatus({ status }: SessionStatusProps) {
  const config = statusConfig[status];

  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <div className={cn("h-1.5 w-1.5 rounded-full", config.dotClass)} />
      <span className="text-[11px] font-medium uppercase tracking-widest text-text-muted">
        {config.label}
      </span>
    </div>
  );
}
