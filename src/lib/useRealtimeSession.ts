"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import type {
  OrbState,
  Message,
  SessionStatus,
  RealtimeServerEvent,
  UploadedFile,
} from "./types";
import { executeClientTool } from "./tools";

const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime/calls";
const MODEL = "gpt-realtime-1.5";
const FETCH_TIMEOUT_MS = 15_000;
const TOOL_FETCH_TIMEOUT_MS = 30_000;

/** Chart config emitted by the generate_visual tool */
export interface ChartConfig {
  chart_type: "bar" | "line" | "pie" | "area" | "scatter";
  title: string;
  data: Array<Record<string, string | number>>;
  x_label?: string;
  y_label?: string;
  /** Names of numeric series to plot (e.g. ["revenue", "profit"]). If absent, uses "value". */
  series?: string[];
}

export interface UseRealtimeSession {
  orbState: OrbState;
  sessionStatus: SessionStatus;
  messages: Message[];
  connect: () => Promise<void>;
  disconnect: () => void;
  sendFileContext: (fileName: string, content: string) => void;
  isConnecting: boolean;
  error: string | null;
  activeChart: ChartConfig | null;
  clearChart: () => void;
}

// ── Pending function call accumulator ────────────────────
interface PendingFunctionCall {
  callId: string;
  name: string;
  args: string;
}

// ── Helpers ──────────────────────────────────────────────

function classifyMicError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return "Microphone access denied. Please allow microphone access and try again.";
      case "NotFoundError":
        return "No microphone found. Please connect a microphone and try again.";
      case "NotReadableError":
        return "Microphone is in use by another application.";
      case "OverconstrainedError":
        return "Microphone does not support the required audio settings.";
      default:
        return `Microphone error: ${err.message}`;
    }
  }
  return "Could not access microphone.";
}

function log(tag: string, ...args: unknown[]) {
  console.log(`[realtime:${tag}]`, ...args);
}

function logError(tag: string, ...args: unknown[]) {
  console.error(`[realtime:${tag}]`, ...args);
}

export function useRealtimeSession(
  files: UploadedFile[]
): UseRealtimeSession {
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [sessionStatus, setSessionStatus] =
    useState<SessionStatus>("disconnected");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeChart, setActiveChart] = useState<ChartConfig | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const connectingRef = useRef(false);
  const greetingPendingRef = useRef(false);

  const currentAssistantIdRef = useRef<string | null>(null);
  const currentUserItemIdRef = useRef<string | null>(null);
  const pendingCallRef = useRef<PendingFunctionCall | null>(null);
  const filesRef = useRef(files);
  filesRef.current = files;

  // ── Send event on data channel ─────────────────────────
  const sendDC = useCallback((payload: Record<string, unknown>) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === "open") {
      dc.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  // ── Execute a tool call and send result back ───────────
  const executeTool = useCallback(
    async (call: PendingFunctionCall) => {
      log("tool", `Executing ${call.name} (call_id: ${call.callId})`);

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.args);
      } catch {
        logError("tool", `Invalid JSON args for ${call.name}:`, call.args);
        args = {};
      }

      const clientResult = executeClientTool(
        call.name,
        args,
        filesRef.current
      );

      let resultText: string;
      let chartData: ChartConfig | null = null;

      if (clientResult) {
        resultText = clientResult.result;
        log("tool", `${call.name} resolved client-side`);
      } else {
        const fileName = args.file_name as string | undefined;
        const file = fileName
          ? filesRef.current.find(
              (f) => f.name.toLowerCase() === fileName.toLowerCase()
            )
          : undefined;

        if (fileName && !file) {
          resultText = `File "${fileName}" not found. Available: ${filesRef.current.map((f) => f.name).join(", ") || "none"}`;
          log("tool", `${call.name} — file not found: ${fileName}`);
        } else {
          try {
            const res = await fetch("/api/tools/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tool: call.name,
                args,
                fileContent: file?.content,
                fileName: file?.name ?? fileName,
                parsedData: file?.parsedData,
              }),
              signal: AbortSignal.timeout(TOOL_FETCH_TIMEOUT_MS),
            });

            if (!res.ok) {
              const errBody = (await res.json().catch(() => ({ error: "Unknown server error" }))) as { error: string };
              resultText = `Error: ${errBody.error}`;
              logError("tool", `${call.name} failed:`, errBody.error);
            } else {
              const data = (await res.json()) as {
                result: string;
                chart?: ChartConfig;
              };
              resultText = data.result;
              if (data.chart) chartData = data.chart;
              log("tool", `${call.name} completed server-side`);
            }
          } catch (err) {
            if (err instanceof DOMException && err.name === "TimeoutError") {
              resultText = `Tool timed out after ${TOOL_FETCH_TIMEOUT_MS / 1000}s. The data may be too large.`;
            } else {
              resultText = `Tool execution failed: ${err instanceof Error ? err.message : "unknown error"}`;
            }
            logError("tool", `${call.name} exception:`, resultText);
          }
        }
      }

      if (chartData) {
        setActiveChart(chartData);
      }

      sendDC({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.callId,
          output: resultText,
        },
      });

      sendDC({ type: "response.create" });
    },
    [sendDC]
  );

  // ── Cleanup ────────────────────────────────────────────
  const cleanup = useCallback(() => {
    log("lifecycle", "Cleaning up session resources");

    if (dcRef.current) {
      dcRef.current.onopen = null;
      dcRef.current.onmessage = null;
      dcRef.current.onclose = null;
      dcRef.current.close();
      dcRef.current = null;
    }

    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.oniceconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.srcObject = null;
      audioElRef.current = null;
    }

    currentAssistantIdRef.current = null;
    currentUserItemIdRef.current = null;
    pendingCallRef.current = null;
    connectingRef.current = false;
    greetingPendingRef.current = false;
  }, []);

  // ── Disconnect ─────────────────────────────────────────
  const disconnect = useCallback(() => {
    cleanup();
    setSessionStatus("disconnected");
    setOrbState("idle");
    setIsConnecting(false);
    setError(null);
    log("lifecycle", "Disconnected");
  }, [cleanup]);

  // ── Handle data-channel events ─────────────────────────
  const handleServerEvent = useCallback(
    (evt: RealtimeServerEvent) => {
      switch (evt.type) {
        case "session.created":
          setSessionStatus("connected");
          setOrbState("idle");
          log("session", "session.created");
          // Trigger greeting — if DC is open, send now; otherwise defer to dc.onopen
          if (dcRef.current?.readyState === "open") {
            sendDC({ type: "response.create" });
          } else {
            greetingPendingRef.current = true;
          }
          break;

        case "session.updated":
          setSessionStatus("connected");
          setOrbState("idle");
          break;

        case "input_audio_buffer.speech_started":
          setOrbState("listening");
          {
            const id = `user-${Date.now()}`;
            currentUserItemIdRef.current = id;
            setMessages((prev) => [
              ...prev,
              { id, role: "user", content: "", timestamp: Date.now(), streaming: true },
            ]);
          }
          break;

        case "input_audio_buffer.speech_stopped":
          setOrbState("thinking");
          if (currentUserItemIdRef.current) {
            const uid = currentUserItemIdRef.current;
            setMessages((prev) =>
              prev.map((m) => (m.id === uid ? { ...m, streaming: false } : m))
            );
          }
          break;

        case "conversation.item.input_audio_transcription.delta": {
          const delta = evt.delta as string | undefined;
          const itemId = currentUserItemIdRef.current;
          if (itemId && delta) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === itemId ? { ...m, content: m.content + delta } : m
              )
            );
          }
          break;
        }

        case "conversation.item.input_audio_transcription.completed": {
          const transcript = evt.transcript as string | undefined;
          const itemId = currentUserItemIdRef.current;
          if (itemId && transcript) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === itemId ? { ...m, content: transcript, streaming: false } : m
              )
            );
          }
          currentUserItemIdRef.current = null;
          break;
        }

        case "response.created": {
          setOrbState("thinking");
          const response = evt.response as { id: string } | undefined;
          currentAssistantIdRef.current = response?.id ?? `resp-${Date.now()}`;
          break;
        }

        case "response.output_item.added": {
          const item = evt.item as { type?: string; call_id?: string; name?: string; id?: string } | undefined;
          if (item?.type === "function_call") {
            pendingCallRef.current = {
              callId: item.call_id ?? item.id ?? `call-${Date.now()}`,
              name: item.name ?? "unknown",
              args: "",
            };
            log("tool", `Function call started: ${item.name}`);
          } else if (item?.type === "message") {
            const rid = currentAssistantIdRef.current;
            if (rid) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === rid)) return prev;
                return [...prev, { id: rid, role: "assistant", content: "", timestamp: Date.now(), streaming: true }];
              });
            }
          }
          break;
        }

        case "response.function_call_arguments.delta": {
          const delta = evt.delta as string | undefined;
          if (pendingCallRef.current && delta) {
            pendingCallRef.current.args += delta;
          }
          break;
        }

        case "response.function_call_arguments.done": {
          const args = evt.arguments as string | undefined;
          if (pendingCallRef.current) {
            if (args) pendingCallRef.current.args = args;
            const call = { ...pendingCallRef.current };
            pendingCallRef.current = null;
            executeTool(call);
          }
          break;
        }

        case "response.audio_transcript.delta": {
          setOrbState("speaking");
          const delta = evt.delta as string | undefined;
          const rid = currentAssistantIdRef.current;
          if (rid && delta) {
            setMessages((prev) => {
              const exists = prev.some((m) => m.id === rid);
              if (!exists) {
                return [...prev, { id: rid, role: "assistant", content: delta, timestamp: Date.now(), streaming: true }];
              }
              return prev.map((m) => (m.id === rid ? { ...m, content: m.content + delta } : m));
            });
          }
          break;
        }

        case "response.audio_transcript.done": {
          const transcript = evt.transcript as string | undefined;
          const rid = currentAssistantIdRef.current;
          if (rid && transcript) {
            setMessages((prev) =>
              prev.map((m) => (m.id === rid ? { ...m, content: transcript, streaming: false } : m))
            );
          }
          break;
        }

        case "response.done":
          currentAssistantIdRef.current = null;
          break;

        case "response.audio.done":
          setTimeout(() => setOrbState("idle"), 400);
          break;

        case "error": {
          const errObj = evt.error as { message?: string; code?: string } | undefined;
          const errMsg = errObj?.message ?? "Unknown error";
          logError("event", `Server error (${errObj?.code ?? "?"}): ${errMsg}`);
          setError(errMsg);
          setOrbState("idle");
          break;
        }

        default:
          break;
      }
    },
    [executeTool]
  );

  // ── Connect ────────────────────────────────────────────
  const connect = useCallback(async () => {
    // Guard against double-connect
    if (connectingRef.current) {
      log("lifecycle", "Connect already in progress, ignoring");
      return;
    }

    if (pcRef.current) {
      disconnect();
    }

    connectingRef.current = true;
    setIsConnecting(true);
    setError(null);
    setSessionStatus("connecting");
    setMessages([]);
    setActiveChart(null);

    try {
      // 1. Get ephemeral token
      log("lifecycle", "Requesting ephemeral token");
      const tokenRes = await fetch("/api/realtime/session", {
        method: "POST",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!tokenRes.ok) {
        const body = await tokenRes.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Session creation failed (${tokenRes.status})`);
      }
      const { clientSecret } = (await tokenRes.json()) as {
        clientSecret: string;
        expiresAt: number;
      };
      log("lifecycle", "Token received");

      // 2. Get microphone — with specific error classification
      log("lifecycle", "Requesting microphone access");
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            sampleRate: 24000,
          },
        });
      } catch (micErr) {
        throw new Error(classifyMicError(micErr));
      }
      streamRef.current = stream;
      log("lifecycle", "Microphone access granted");

      // 3. Set up RTCPeerConnection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.ontrack = (e) => {
        // Reuse existing audio element to prevent leaks
        if (!audioElRef.current) {
          audioElRef.current = new Audio();
          audioElRef.current.autoplay = true;
        }
        audioElRef.current.srcObject = e.streams[0];
      };

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      // 4. Data channel
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.onopen = () => {
        setSessionStatus("connected");
        setIsConnecting(false);
        connectingRef.current = false;
        log("lifecycle", "Data channel open — session live");
        // Send deferred greeting if session.created arrived before DC was ready
        if (greetingPendingRef.current) {
          greetingPendingRef.current = false;
          sendDC({ type: "response.create" });
        }
      };

      dc.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as RealtimeServerEvent;
          handleServerEvent(event);
        } catch (parseErr) {
          logError("dc", "Failed to parse data channel message:", parseErr);
        }
      };

      dc.onclose = () => {
        log("lifecycle", "Data channel closed");
        setSessionStatus("disconnected");
        setOrbState("idle");
      };

      // 5. ICE failure handling
      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        log("ice", state);
        if (state === "failed" || state === "disconnected") {
          setSessionStatus("disconnected");
          setOrbState("idle");
          setError("Connection lost — tap the orb to reconnect");
          setIsConnecting(false);
          connectingRef.current = false;
        }
      };

      // 6. SDP negotiation with timeout
      log("lifecycle", "Starting SDP negotiation");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpRes = await fetch(
        `${OPENAI_REALTIME_URL}?model=${MODEL}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }
      );

      if (!sdpRes.ok) {
        const errorBody = await sdpRes.text();
        logError("sdp", `Negotiation failed (${sdpRes.status}):`, errorBody);
        throw new Error(`WebRTC negotiation failed (${sdpRes.status})`);
      }

      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      log("lifecycle", "SDP negotiation complete — WebRTC connected");
    } catch (err) {
      let msg: string;
      if (err instanceof DOMException && err.name === "TimeoutError") {
        msg = "Connection timed out. Please check your network and try again.";
      } else {
        msg = err instanceof Error ? err.message : "Connection failed";
      }
      logError("connect", msg);
      setError(msg);
      setSessionStatus("error");
      setOrbState("idle");
      setIsConnecting(false);
      connectingRef.current = false;
      cleanup();
    }
  }, [disconnect, cleanup, handleServerEvent]);

  // ── Send file context ──────────────────────────────────
  const sendFileContext = useCallback(
    (fileName: string, content: string) => {
      if (!sendDC({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `[File uploaded: ${fileName}]\n\n${content}` }],
        },
      })) {
        log("file", "Data channel not open — file context not sent");
        return;
      }

      setMessages((prev) => [
        ...prev,
        { id: `file-${Date.now()}`, role: "user", content: `Uploaded ${fileName}`, timestamp: Date.now() },
      ]);

      sendDC({ type: "response.create" });
      log("file", `Injected context for ${fileName}`);
    },
    [sendDC]
  );

  const clearChart = useCallback(() => setActiveChart(null), []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  return {
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
  };
}
