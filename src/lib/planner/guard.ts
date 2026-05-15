/**
 * Phase 1: Routing guard.
 *
 * Runs before every tool call. Looks up the file's kind (narrative vs
 * tabular vs unknown) + RAG readiness, and checks whether the tool the
 * voice agent picked actually matches. Returns one of:
 *
 *   - allowed: true — tool can proceed as-is.
 *   - allowed: true with rewrittenArgs — minor argument fix-up (e.g. trim
 *     a sanitized filename back to a real one).
 *   - allowed: false with suggestedTool — return a soft error to the agent
 *     so it self-corrects in conversation.
 *
 * Heuristic-only. No LLM call. Fast, free, deterministic. The full LLM
 * planner lands in Phase 8 with a richer interface (rewrite args, decompose
 * multi-step queries) — this guard catches the basic class of bug today.
 *
 * What this prevents:
 *   - query_document / query_document_v2 on a CSV.
 *   - profile_dataset / create_chart on a narrative PDF.
 *   - query_document_v2 on a doc that hasn't been embedded (auto-falls back).
 */

import { createServerSupabase } from "@/lib/supabase/server";
import { findDocumentByFileName } from "@/lib/documents/store";
import { isNarrativeType } from "@/lib/ingestion/classifier";

export interface GuardInput {
  toolName: string;
  args: Record<string, unknown>;
  userId: string;
}

export interface GuardResult {
  allowed: boolean;
  reason?: string;
  suggestedTool?: string;
  /** When false, the tool execute route should synthesize a soft error
   *  result for the voice agent rather than running the tool. */
}

// ── Tool kind classification ─────────────────────────────

type ToolKind = "narrative-v2" | "narrative-v1" | "tabular" | "file-list" | "unknown";

const TOOL_KINDS: Record<string, ToolKind> = {
  query_document_v2: "narrative-v2",
  query_document: "narrative-v1",
  compose_visual_scene: "narrative-v1",
  profile_dataset: "tabular",
  run_analysis: "tabular",
  create_chart: "tabular",
  generate_dashboard: "tabular",
  compare_files: "tabular",
  recommend_actions: "tabular",
  list_uploaded_files: "file-list",
};

// ── File kind classification ─────────────────────────────

type FileKind =
  | { kind: "narrative"; hasPassages: boolean; documentType: string; documentId: string }
  | { kind: "tabular"; documentType: string; documentId: string | null }
  | { kind: "unknown" };

async function classifyFile(fileName: string, userId: string): Promise<FileKind> {
  const record = await findDocumentByFileName(fileName, userId);
  if (!record) return { kind: "unknown" };

  const type = record.extraction.type;
  if (isNarrativeType(type as Parameters<typeof isNarrativeType>[0])) {
    // Look up has_passages directly on the documents row — the cached
    // extraction may not carry it.
    const sb = createServerSupabase();
    const { data } = await sb
      .from("documents")
      .select("has_passages")
      .eq("id", record.documentId)
      .eq("user_id", userId)
      .maybeSingle();
    const hasPassages = data?.has_passages === true;
    return {
      kind: "narrative",
      hasPassages,
      documentType: type,
      documentId: record.documentId,
    };
  }

  // Tabular: spreadsheet, table_pdf, or extraction.tables has rows.
  const hasTables =
    (record.extraction.tables?.length ?? 0) > 0 &&
    (record.extraction.tables?.[0]?.data?.rows?.length ?? 0) > 0;
  if (type === "spreadsheet" || type === "table_pdf" || hasTables) {
    return {
      kind: "tabular",
      documentType: type,
      documentId: record.documentId,
    };
  }

  return { kind: "unknown" };
}

// ── Compatibility rules ──────────────────────────────────

export async function guardToolCall(input: GuardInput): Promise<GuardResult> {
  const toolKind = TOOL_KINDS[input.toolName] ?? "unknown";

  // Always-allowed tools.
  if (toolKind === "file-list" || toolKind === "unknown") {
    return { allowed: true };
  }

  const fileName = input.args.file_name as string | undefined;
  if (!fileName) {
    // Other handlers will reject missing file_name; we don't second-guess here.
    return { allowed: true };
  }

  const file = await classifyFile(fileName, input.userId);

  switch (toolKind) {
    case "narrative-v2": {
      if (file.kind === "unknown") {
        return {
          allowed: false,
          reason: `No document found matching "${fileName}". Ask the user to upload the file or use list_uploaded_files to see what's available.`,
        };
      }
      if (file.kind === "tabular") {
        return {
          allowed: false,
          reason: `"${fileName}" is a ${file.documentType} (tabular). Use create_chart or generate_dashboard instead.`,
          suggestedTool: "generate_dashboard",
        };
      }
      if (!file.hasPassages) {
        // The tool's own handler auto-falls back to legacy query_document
        // for un-embedded docs. We let it through so the fallback runs.
        return { allowed: true };
      }
      return { allowed: true };
    }

    case "narrative-v1": {
      if (file.kind === "unknown") {
        return {
          allowed: false,
          reason: `No document found matching "${fileName}".`,
        };
      }
      if (file.kind === "tabular") {
        return {
          allowed: false,
          reason: `"${fileName}" is a ${file.documentType} (tabular). Use create_chart or generate_dashboard instead.`,
          suggestedTool: "generate_dashboard",
        };
      }
      // Narrative — if has_passages=true and the tool is query_document
      // (legacy), suggest v2 but allow proceed.
      if (file.hasPassages && input.toolName === "query_document") {
        return {
          allowed: true,
          reason: `This doc is embedded — query_document_v2 would be faster and more accurate. (Allowed to proceed.)`,
          suggestedTool: "query_document_v2",
        };
      }
      return { allowed: true };
    }

    case "tabular": {
      if (file.kind === "unknown") {
        return {
          allowed: false,
          reason: `No document found matching "${fileName}".`,
        };
      }
      if (file.kind === "narrative") {
        return {
          allowed: false,
          reason: `"${fileName}" is a ${file.documentType} (narrative). Use ${file.hasPassages ? "query_document_v2" : "query_document"} instead.`,
          suggestedTool: file.hasPassages ? "query_document_v2" : "query_document",
        };
      }
      return { allowed: true };
    }

    default:
      return { allowed: true };
  }
}

/**
 * Build the Response body the tool execute route returns when the guard
 * blocks a call. Surfaces the redirect suggestion to the voice agent so it
 * can pick the right tool and try again without the user noticing the slip.
 */
export function guardSoftError(result: GuardResult): {
  result: string;
  routingError: { reason: string; suggestedTool?: string };
} {
  const reason = result.reason ?? "Tool not applicable to this file.";
  const lines = [reason];
  if (result.suggestedTool) {
    lines.push("");
    lines.push(`Suggested next tool: ${result.suggestedTool}`);
  }
  return {
    result: lines.join("\n"),
    routingError: {
      reason,
      suggestedTool: result.suggestedTool,
    },
  };
}
