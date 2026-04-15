"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { VoiceOrb } from "@/components/VoiceOrb";
import { Starfield } from "@/components/Starfield";
import { DocumentPanel } from "@/components/DocumentPanel";
import { SessionStatus } from "@/components/SessionStatus";
import { TranscriptOverlay } from "@/components/TranscriptOverlay";
import { ChartStage } from "@/components/ChartStage";
import { DashboardView } from "@/components/DashboardView";
import { ModeSelector } from "@/components/ModeSelector";
import { AuthShell } from "@/components/AuthShell";
import { useWorkspaceContext } from "@/components/WorkspaceProvider";
import { useRealtimeSession } from "@/lib/useRealtimeSession";
import { selectKpis } from "@/lib/kpi";
import type { UploadedFile, OutputMode } from "@/lib/types";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SUPPORTED_EXTENSIONS = [".csv", ".xlsx", ".xls", ".pdf"];

function isSupportedFile(name: string): boolean {
  return SUPPORTED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

export default function Home() {
  const workspace = useWorkspaceContext();
  const [files, setFiles] = useState<UploadedFile[]>(workspace.initialFiles);
  const [mode, setMode] = useState<OutputMode>(workspace.session?.outputMode ?? "executive");

  const {
    orbState,
    sessionStatus,
    messages,
    connect,
    disconnect,
    sendFileContext,
    isConnecting,
    error,
    charts,
    focusedChartId,
    removeChart,
    clearCharts,
    focusChart,
    drilldowns,
    sendDrilldown,
    activeDashboard,
    closeDashboard,
  } = useRealtimeSession(files, mode, {
    initialMessages: workspace.initialMessages,
    initialCharts: workspace.initialCharts,
    initialDashboard: workspace.initialDashboard,
    onSave: workspace.saveSessionState,
  });

  const handleOrbClick = useCallback(() => {
    if (sessionStatus === "connected") {
      disconnect();
    } else if (
      sessionStatus === "disconnected" ||
      sessionStatus === "error"
    ) {
      connect();
    }
  }, [sessionStatus, connect, disconnect]);

  const handleUpload = useCallback(
    async (fileList: FileList) => {
      const incoming = Array.from(fileList).filter((f) =>
        isSupportedFile(f.name)
      );
      if (incoming.length === 0) return;

      const entries: UploadedFile[] = incoming.map((f) => ({
        id: crypto.randomUUID(),
        name: f.name,
        size: f.size,
        sizeLabel: formatFileSize(f.size),
        type: f.type,
        status: "parsing" as const,
      }));

      setFiles((prev) => [...prev, ...entries]);

      for (let i = 0; i < incoming.length; i++) {
        const file = incoming[i];
        const entry = entries[i];

        try {
          const form = new FormData();
          form.append("file", file);

          const res = await fetch("/api/files/parse", {
            method: "POST",
            body: form,
          });

          if (!res.ok) {
            const { error: errMsg } = (await res.json()) as { error: string };
            throw new Error(errMsg);
          }

          const { text, summary, parsedData } = (await res.json()) as {
            text: string;
            summary: string;
            parsedData?: import("@/lib/types").ParsedData;
          };

          const readyFile: UploadedFile = {
            ...entry,
            status: "ready" as const,
            content: text,
            summary,
            parsedData,
          };

          setFiles((prev) =>
            prev.map((f) => f.id === entry.id ? readyFile : f)
          );

          // Persist file to Supabase
          workspace.saveFile(readyFile, file);

          if (sessionStatus === "connected") {
            sendFileContext(file.name, text, parsedData);
          }
        } catch (err) {
          const raw = err instanceof Error ? err.message : "Parse failed";
          const msg = raw.includes("too large")
            ? raw
            : "Couldn't read this file. Try a different format.";
          console.error("[upload]", file.name, raw);
          setFiles((prev) =>
            prev.map((f) =>
              f.id === entry.id
                ? { ...f, status: "error" as const, error: msg }
                : f
            )
          );
        }
      }
    },
    [sessionStatus, sendFileContext]
  );

  const handleRemove = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const orbLabel =
    sessionStatus === "disconnected" || sessionStatus === "error"
      ? "Tap to connect"
      : isConnecting
        ? "Connecting…"
        : undefined;

  // Compute KPI cards from the most recent ready file's parsed data
  const kpiCards = useMemo(() => {
    const readyFile = [...files].reverse().find((f) => f.status === "ready" && f.parsedData);
    if (!readyFile?.parsedData) return [];
    return selectKpis(readyFile.parsedData);
  }, [files]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <Starfield />

      <header className="relative z-10 flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="h-2 w-2 rounded-full bg-accent-cyan shadow-[0_0_8px_var(--glow-cyan)]" />
          <h1 className="text-sm font-semibold tracking-wide text-text-primary">
            BI Analyst
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <ModeSelector
            mode={mode}
            onChange={setMode}
            disabled={sessionStatus === "connected"}
          />
          <SessionStatus status={sessionStatus} />
          <AuthShell />
        </div>
      </header>

      <DocumentPanel
        files={files}
        onUpload={handleUpload}
        onRemove={handleRemove}
      />

      <div className="relative z-10 flex flex-1 items-center justify-center px-6">
        <VoiceOrb
          state={isConnecting ? "thinking" : orbState}
          label={orbLabel}
          onClick={handleOrbClick}
        />
      </div>

      {error && (
        <div className="absolute bottom-24 left-1/2 z-30 -translate-x-1/2 rounded-xl border border-red-500/20 bg-red-950/60 px-5 py-2.5 text-xs text-red-200 shadow-lg backdrop-blur-md">
          {error}
        </div>
      )}

      <TranscriptOverlay messages={messages} />

      {/* Multi-chart stage — focused chart centered, supporting charts below */}
      <ChartStage
        charts={charts}
        focusedChartId={focusedChartId}
        drilldowns={drilldowns}
        kpiCards={kpiCards}
        onRemove={removeChart}
        onFocus={focusChart}
        onClearAll={clearCharts}
        onDrilldown={sendDrilldown}
      />

      {/* AI-generated dashboard */}
      {activeDashboard && (
        <DashboardView
          dashboard={activeDashboard}
          onClose={closeDashboard}
          onDrilldown={sendDrilldown}
        />
      )}
    </div>
  );
}
