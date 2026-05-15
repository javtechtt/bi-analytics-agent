export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export type OutputMode = "executive" | "analyst" | "sales" | "operations";

export type MessageRole = "user" | "assistant";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  /** true while the assistant is still streaming this message */
  streaming?: boolean;
}

export type SessionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type FileStatus = "parsing" | "ready" | "error";

export type ParsedRow = Record<string, string | number | null>;

export interface ParsedData {
  /** Column names in order */
  columns: string[];
  /** Column type inference: "numeric" | "text" | "date" */
  columnTypes: Record<string, "numeric" | "text" | "date">;
  /** All parsed rows as structured objects */
  rows: ParsedRow[];
  /** Total row count (may differ from rows.length if sampled) */
  totalRows: number;
  /** How the data was extracted: "positional" (PDF coordinates), "heuristic" (text patterns), "none" (no tables found) */
  extractionMethod?: "positional" | "heuristic" | "none";
}

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  sizeLabel: string;
  type: string;
  status: FileStatus;
  /** Human-readable text summary sent to the assistant's context */
  content?: string;
  /** Structured parsed data for tool operations */
  parsedData?: ParsedData;
  /** One-line summary shown in UI */
  summary?: string;
  /** Error message if parsing failed */
  error?: string;
  /**
   * Phase 1 (additive): universal document extraction produced by the
   * ingestion pipeline. Current consumers may ignore this; future-phase
   * tools and the visual composer will read it. Populated for every
   * successfully parsed file alongside `parsedData`.
   */
  extraction?: import("@/lib/documents/types").DocumentExtraction;
  /**
   * Phase 2: id of the persisted row in the `documents` table. The voice
   * agent's `query_document` tool resolves files by name → documentId, but
   * direct callers may use this for cache lookups.
   */
  documentId?: string;
  /**
   * Phase 1 RAG flag: true once the document has been embedded into the
   * passages table. The voice agent uses this to pick query_document_v2 vs
   * the legacy query_document. Populated from the parse response.
   */
  hasPassages?: boolean;
  /**
   * Phase 9: latest progress message from the parse pipeline while
   * `status === "parsing"`. The DocumentPanel renders this in place of
   * the static "Parsing…" label. Cleared on transition to ready/error.
   */
  progressMessage?: string;
}

// ── Realtime data-channel server events ──────────────────
// We only type the events we actually handle — the full protocol has many more.

export interface RealtimeServerEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

export interface SessionCreatedEvent extends RealtimeServerEvent {
  type: "session.created";
  session: { id: string };
}

export interface SpeechStartedEvent extends RealtimeServerEvent {
  type: "input_audio_buffer.speech_started";
}

export interface SpeechStoppedEvent extends RealtimeServerEvent {
  type: "input_audio_buffer.speech_stopped";
}

export interface InputTranscriptDelta extends RealtimeServerEvent {
  type: "conversation.item.input_audio_transcription.delta";
  item_id: string;
  delta: string;
}

export interface InputTranscriptCompleted extends RealtimeServerEvent {
  type: "conversation.item.input_audio_transcription.completed";
  item_id: string;
  transcript: string;
}

export interface ResponseCreatedEvent extends RealtimeServerEvent {
  type: "response.created";
  response: { id: string };
}

export interface OutputAudioTranscriptDelta extends RealtimeServerEvent {
  type: "response.audio_transcript.delta";
  response_id: string;
  delta: string;
}

export interface OutputAudioTranscriptDone extends RealtimeServerEvent {
  type: "response.audio_transcript.done";
  response_id: string;
  transcript: string;
}

export interface ResponseDoneEvent extends RealtimeServerEvent {
  type: "response.done";
  response: { id: string; status: string };
}

export interface OutputAudioDoneEvent extends RealtimeServerEvent {
  type: "response.audio.done";
}

export interface ErrorEvent extends RealtimeServerEvent {
  type: "error";
  error: { type: string; code?: string; message: string };
}
