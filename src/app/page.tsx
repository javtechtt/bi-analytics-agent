"use client";

import { useState, useCallback } from "react";
import { VoiceOrb } from "@/components/VoiceOrb";
import { Starfield } from "@/components/Starfield";
import { DocumentPanel } from "@/components/DocumentPanel";
import { SessionStatus } from "@/components/SessionStatus";
import { TranscriptOverlay } from "@/components/TranscriptOverlay";
import { ChartOverlay } from "@/components/ChartOverlay";
import { useRealtimeSession } from "@/lib/useRealtimeSession";
import type { UploadedFile } from "@/lib/types";

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
  const [files, setFiles] = useState<UploadedFile[]>([]);

  const {
    orbState,
    sessionStatus,
    messages,
    connect,
    disconnect,
    sendFileContext,
    isConnecting,
    error,
    activeChart,
    clearChart,
  } = useRealtimeSession(files);

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

      // Create placeholder entries in "parsing" state
      const entries: UploadedFile[] = incoming.map((f) => ({
        id: crypto.randomUUID(),
        name: f.name,
        size: f.size,
        sizeLabel: formatFileSize(f.size),
        type: f.type,
        status: "parsing" as const,
      }));

      setFiles((prev) => [...prev, ...entries]);

      // Parse each file and inject into session
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
            const { error: errMsg } = (await res.json()) as {
              error: string;
            };
            throw new Error(errMsg);
          }

          const { text, summary, parsedData } = (await res.json()) as {
            text: string;
            summary: string;
            parsedData?: import("@/lib/types").ParsedData;
          };

          // Update file entry to "ready" with both text and structured data
          setFiles((prev) =>
            prev.map((f) =>
              f.id === entry.id
                ? { ...f, status: "ready" as const, content: text, summary, parsedData }
                : f
            )
          );

          // If session is live, inject the file context
          if (sessionStatus === "connected") {
            sendFileContext(file.name, text);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Parse failed";
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
        <SessionStatus status={sessionStatus} />
      </header>

      <DocumentPanel
        files={files}
        onUpload={handleUpload}
        onRemove={handleRemove}
      />

      <div className="relative z-10 flex flex-1 items-center justify-center">
        <VoiceOrb
          state={isConnecting ? "thinking" : orbState}
          size={420}
          intensity={orbState === "speaking" ? 0.85 : 0.5}
          label={orbLabel}
          onClick={handleOrbClick}
        />
      </div>

      {error && (
        <div className="absolute bottom-20 left-1/2 z-30 -translate-x-1/2 rounded-lg bg-red-500/10 px-4 py-2 text-xs text-red-300 backdrop-blur-sm">
          {error}
        </div>
      )}

      <TranscriptOverlay messages={messages} />

      {/* Chart overlay — appears when assistant generates a visual */}
      {activeChart && (
        <ChartOverlay chart={activeChart} onClose={clearChart} />
      )}
    </div>
  );
}
