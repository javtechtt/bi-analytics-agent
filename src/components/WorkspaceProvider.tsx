"use client";

import { createContext, useContext } from "react";
import { useWorkspace, type WorkspaceState } from "@/lib/useWorkspace";
import type { UploadedFile, Message, OutputMode } from "@/lib/types";
import type { ChartConfig } from "@/lib/useRealtimeSession";
import type { DashboardData } from "@/components/DashboardView";

interface WorkspaceContextValue extends WorkspaceState {
  saveSessionState: (data: {
    messages: Message[];
    charts: ChartConfig[];
    dashboard: DashboardData | null;
    outputMode: OutputMode;
  }) => Promise<void>;
  saveFile: (file: UploadedFile, blob: File | null) => Promise<string>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspaceContext() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspaceContext must be used within WorkspaceProvider");
  return ctx;
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const workspace = useWorkspace();

  if (workspace.loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#060918]">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#22d3ee] border-t-transparent" />
          <p className="text-xs text-[#94a3b8]">Loading workspace…</p>
        </div>
      </div>
    );
  }

  return (
    <WorkspaceContext.Provider value={workspace}>
      {children}
    </WorkspaceContext.Provider>
  );
}
