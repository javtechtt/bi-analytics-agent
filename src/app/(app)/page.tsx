"use client";

import { useState, useCallback } from "react";
import { VoiceOrb } from "@/components/VoiceOrb";
import { Starfield } from "@/components/Starfield";
import { DocumentPanel } from "@/components/DocumentPanel";
import { SessionStatus } from "@/components/SessionStatus";
import { SceneStage } from "@/components/scenes/SceneStage";
import { ProfileMenu } from "@/components/ProfileMenu";
import { useWorkspaceContext } from "@/components/WorkspaceProvider";
import { useRealtimeSession } from "@/lib/useRealtimeSession";
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
  const [language, setLanguage] = useState("en");

  const {
    orbState,
    sessionStatus,
    connect,
    disconnect,
    sendFileContext,
    isConnecting,
    error,
    sendDrilldown,
    scenes,
    removeScene,
    clearScenes,
  } = useRealtimeSession(files, mode, language, {
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

        // Phase 9 upload progress: generate a per-file trace_id, send it
        // via X-Trace-Id, and poll /api/tools/progress/[traceId] every
        // 500ms while the parse is in flight. Latest message goes onto
        // the file's `progressMessage` so DocumentPanel can render it.
        const traceId =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `trace_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        let cursor: string | null = null;
        const pollHandle = setInterval(async () => {
          try {
            const url = new URL(
              `/api/tools/progress/${traceId}`,
              window.location.origin
            );
            if (cursor) url.searchParams.set("since", cursor);
            const r = await fetch(url.toString());
            if (!r.ok) return;
            const body = (await r.json()) as {
              events: Array<{
                id: string;
                kind: "phase" | "info" | "warn";
                message: string;
                createdAt: string;
              }>;
            };
            if (!body.events || body.events.length === 0) return;
            cursor = body.events[body.events.length - 1].createdAt;
            const latest = body.events[body.events.length - 1].message;
            setFiles((prev) =>
              prev.map((f) =>
                f.id === entry.id ? { ...f, progressMessage: latest } : f
              )
            );
          } catch {
            // Poll errors are non-fatal — try again next tick.
          }
        }, 500);

        try {
          const form = new FormData();
          form.append("file", file);

          const res = await fetch("/api/files/parse", {
            method: "POST",
            body: form,
            headers: {
              "X-Trace-Id": traceId,
            },
          });

          if (!res.ok) {
            const { error: errMsg } = (await res.json()) as { error: string };
            throw new Error(errMsg);
          }

          const { text, summary, parsedData, extraction, documentId, hasPassages } = (await res.json()) as {
            text: string;
            summary: string;
            parsedData?: import("@/lib/types").ParsedData;
            extraction?: import("@/lib/documents/types").DocumentExtraction;
            documentId?: string;
            hasPassages?: boolean;
          };

          const readyFile: UploadedFile = {
            ...entry,
            status: "ready" as const,
            content: text,
            summary,
            parsedData,
            extraction,
            documentId,
            hasPassages,
          };

          setFiles((prev) =>
            prev.map((f) => f.id === entry.id ? readyFile : f)
          );

          // Persist file to Supabase
          workspace.saveFile(readyFile, file);

          if (sessionStatus === "connected") {
            sendFileContext(file.name, text, parsedData, extraction, hasPassages);
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
                ? { ...f, status: "error" as const, error: msg, progressMessage: undefined }
                : f
            )
          );
        } finally {
          // Stop polling regardless of outcome. The progressMessage on a
          // ready file is irrelevant (DocumentPanel only reads it when
          // status === "parsing") but we clear it for tidiness.
          clearInterval(pollHandle);
          setFiles((prev) =>
            prev.map((f) =>
              f.id === entry.id && f.progressMessage
                ? { ...f, progressMessage: undefined }
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
    // Delete from Supabase so it doesn't reappear on reload
    fetch(`/api/workspace/files/${id}`, { method: "DELETE" }).catch((err) =>
      console.error("[workspace] File delete failed:", err)
    );
  }, []);

  const orbLabel =
    sessionStatus === "disconnected" || sessionStatus === "error"
      ? "Tap to connect"
      : isConnecting
        ? "Connecting…"
        : undefined;

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <Starfield />

      <header className="relative z-10 flex items-center justify-between px-6 py-3">
        <ProfileMenu
          mode={mode}
          onModeChange={setMode}
          modeDisabled={sessionStatus === "connected"}
          language={language}
          onLanguageChange={setLanguage}
        />
        <SessionStatus status={sessionStatus} />
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

      {/* Phase 3: Visual Composition Engine — unified scene renderer.
          All chart/dashboard/document outputs flow through here as scenes. */}
      <SceneStage
        scenes={scenes}
        onRemoveScene={removeScene}
        onClearAll={clearScenes}
        onDrilldown={sendDrilldown}
      />
    </div>
  );
}
