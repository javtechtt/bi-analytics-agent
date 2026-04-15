"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { UploadedFile, Message, OutputMode } from "@/lib/types";
import type { ChartConfig } from "@/lib/useRealtimeSession";
import type { DashboardData } from "@/components/DashboardView";
import { dbFileToClient, dbMessageToClient, dbChartToClient } from "@/lib/supabase/types";

export interface WorkspaceSession {
  id: string;
  title: string;
  outputMode: OutputMode;
}

export interface WorkspaceState {
  session: WorkspaceSession | null;
  initialFiles: UploadedFile[];
  initialMessages: Message[];
  initialCharts: ChartConfig[];
  initialDashboard: DashboardData | null;
  loading: boolean;
}

export function useWorkspace() {
  const [state, setState] = useState<WorkspaceState>({
    session: null,
    initialFiles: [],
    initialMessages: [],
    initialCharts: [],
    initialDashboard: null,
    loading: true,
  });
  const initializedRef = useRef(false);

  // On mount: fetch or create the active session
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    (async () => {
      try {
        // List sessions — look for an active one
        const listRes = await fetch("/api/workspace/sessions");
        if (!listRes.ok) throw new Error("Failed to list sessions");
        const { sessions } = await listRes.json() as {
          sessions: Array<{ id: string; title: string; output_mode: string; is_active: boolean }>;
        };

        const active = sessions.find((s) => s.is_active);

        if (active) {
          // Load full session data
          const fullRes = await fetch(`/api/workspace/sessions/${active.id}`);
          if (!fullRes.ok) throw new Error("Failed to load session");
          const full = await fullRes.json() as {
            session: { id: string; title: string; output_mode: string };
            files: unknown[];
            messages: unknown[];
            charts: unknown[];
            dashboard: unknown | null;
          };

          setState({
            session: {
              id: full.session.id,
              title: full.session.title,
              outputMode: full.session.output_mode as OutputMode,
            },
            initialFiles: (full.files as Parameters<typeof dbFileToClient>[0][]).map(dbFileToClient),
            initialMessages: (full.messages as Parameters<typeof dbMessageToClient>[0][]).map(dbMessageToClient),
            initialCharts: (full.charts as Parameters<typeof dbChartToClient>[0][]).map(dbChartToClient),
            initialDashboard: full.dashboard as DashboardData | null,
            loading: false,
          });
        } else {
          // Create a new session
          const createRes = await fetch("/api/workspace/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "New Session" }),
          });
          if (!createRes.ok) throw new Error("Failed to create session");
          const { session } = await createRes.json() as {
            session: { id: string; title: string; output_mode: string };
          };

          setState({
            session: {
              id: session.id,
              title: session.title,
              outputMode: session.output_mode as OutputMode,
            },
            initialFiles: [],
            initialMessages: [],
            initialCharts: [],
            initialDashboard: null,
            loading: false,
          });
        }
      } catch (err) {
        console.error("[workspace] Init failed:", err);
        // Fall back to no-session mode (app still works, just no persistence)
        setState((prev) => ({ ...prev, loading: false }));
      }
    })();
  }, []);

  // Save session state (called on disconnect, chart create, dashboard generate)
  const saveSessionState = useCallback(
    async (data: {
      messages: Message[];
      charts: ChartConfig[];
      dashboard: DashboardData | null;
      outputMode: OutputMode;
    }) => {
      if (!state.session) return;

      try {
        await fetch(`/api/workspace/sessions/${state.session.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: data.messages,
            charts: data.charts.map((c) => ({
              id: c.id,
              chart_type: c.chart_type,
              title: c.title,
              data: c.data,
              x_label: c.x_label,
              y_label: c.y_label,
              series: c.series,
              coverage: c.coverage,
              dataSummary: c.dataSummary,
            })),
            dashboard: data.dashboard,
            outputMode: data.outputMode,
          }),
        });
      } catch (err) {
        console.error("[workspace] Save failed:", err);
      }
    },
    [state.session]
  );

  // Save a single file record (called after parse completes)
  const saveFile = useCallback(
    async (file: UploadedFile, originalBlob: File | null) => {
      if (!state.session) return file.id;

      try {
        const sb_path = originalBlob
          ? `${state.session.id}/${file.id}/${file.name}`
          : null;

        // Upload blob to storage if available
        if (originalBlob && sb_path) {
          const formData = new FormData();
          formData.append("path", sb_path);
          formData.append("file", originalBlob);
          // Storage upload happens via the API in Phase 4
        }

        // Insert file record
        const res = await fetch("/api/workspace/files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: state.session.id,
            file: {
              id: file.id,
              name: file.name,
              size: file.size,
              sizeLabel: file.sizeLabel,
              mimeType: file.type,
              status: file.status,
              content: file.content,
              summary: file.summary,
              parsedData: file.parsedData,
              error: file.error,
              storagePath: sb_path,
            },
          }),
        });

        if (res.ok) {
          const { fileId } = await res.json() as { fileId: string };
          return fileId;
        }
      } catch (err) {
        console.error("[workspace] File save failed:", err);
      }
      return file.id;
    },
    [state.session]
  );

  return {
    ...state,
    saveSessionState,
    saveFile,
  };
}
