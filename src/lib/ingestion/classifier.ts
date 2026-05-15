/**
 * Heuristic document classifier — Phase 1.
 *
 * Decides which adapter should handle a freshly uploaded file using only:
 *   - Filename extension
 *   - MIME type (from the browser upload)
 *   - Magic bytes (first 8 bytes of the buffer)
 *
 * No LLM call in Phase 1. Phase 2 will add a Tier 2 LLM-based classifier
 * that runs AFTER this one for ambiguous PDFs (e.g. "is this a contract or
 * a financial report?") and to detect subtype/language. This file is the
 * Tier 1 — fast, free, and final for unambiguous formats like CSV/XLSX.
 *
 * Suggested adapters that are NOT YET implemented (narrative, image, docx,
 * pptx) are still returned by this classifier. The universal parser checks
 * the suggested adapter against the registered adapter set and rejects
 * unsupported types with `UnsupportedDocumentTypeError`. The Phase 1
 * `parse/route.ts` additionally gates uploads at the extension allow-list,
 * so unsupported types never reach the classifier in practice today.
 */

import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import type { DocumentType } from "@/lib/documents/types";
import { instrumented } from "@/lib/telemetry/trace";
import { MODELS } from "@/lib/models";
import { openai } from "@/lib/openai/client";

export type SuggestedAdapter =
  | "tabular"
  | "narrative"
  | "image"
  | "docx"
  | "pptx"
  | "none";

export interface ClassificationResult {
  type: DocumentType;
  subtype?: string;
  /** [0, 1] — how confident the classifier is in its type assignment. */
  confidence: number;
  suggestedAdapter: SuggestedAdapter;
  /** ISO 639-1 — Phase 1 always reports "en"; Tier 2 will detect language. */
  language: string;
}

export interface ClassifierInput {
  fileName: string;
  mime: string;
  size: number;
  /** First few bytes of the file for magic-byte detection. Optional but
   *  recommended — protects against mismatched/misnamed extensions. */
  bytes?: Buffer;
}

// ── Magic-byte detection ──────────────────────────────────

type MagicKind = "pdf" | "zip" | "png" | "jpeg" | "gif" | "webp" | null;

function detectMagic(buffer: Buffer | undefined): MagicKind {
  if (!buffer || buffer.length < 8) return null;
  // PDF: "%PDF"
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return "pdf";
  // ZIP container (XLSX/DOCX/PPTX are all ZIP): "PK\x03\x04"
  if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) return "zip";
  // PNG: "\x89PNG"
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return "png";
  // JPEG: "\xFF\xD8\xFF"
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return "jpeg";
  // GIF: "GIF87a" / "GIF89a"
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "gif";
  // WEBP: "RIFF....WEBP" — check the WEBP signature at offset 8
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return "webp";
  return null;
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

// ── Classifier ────────────────────────────────────────────

export async function classifyDocument(input: ClassifierInput): Promise<ClassificationResult> {
  const ext = extensionOf(input.fileName);
  const mime = (input.mime ?? "").toLowerCase();
  const magic = detectMagic(input.bytes);

  // CSV — extension + MIME are both reliable.
  if (ext === "csv" || mime === "text/csv" || mime === "application/csv") {
    return {
      type: "spreadsheet",
      subtype: "csv",
      confidence: 0.95,
      suggestedAdapter: "tabular",
      language: "en",
    };
  }

  // Excel — extension or MIME or zip magic-bytes if extension is xlsx.
  const isExcelExt = ext === "xlsx" || ext === "xls";
  const isExcelMime =
    mime.includes("spreadsheetml") ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (isExcelExt || isExcelMime) {
    return {
      type: "spreadsheet",
      subtype: ext === "xls" ? "xls" : "xlsx",
      confidence: 0.95,
      suggestedAdapter: "tabular",
      language: "en",
    };
  }

  // PDF — magic bytes are authoritative; fall back to extension/mime.
  if (magic === "pdf" || ext === "pdf" || mime === "application/pdf") {
    // We default to "table_pdf" at Tier 1. A Tier 2 LLM classifier (Phase 2)
    // will refine this to "report" / "contract" / "memo" / "financial_statement"
    // based on actual content. The tabular adapter will succeed for tables and
    // return an extraction with `extractionMethod: "none"` if no tables exist —
    // narrative handling lands in Phase 2.
    return {
      type: "table_pdf",
      subtype: "pdf",
      confidence: 0.6,
      suggestedAdapter: "tabular",
      language: "en",
    };
  }

  // DOCX (Phase 5 adapter — classifier reports correctly today).
  if (ext === "docx" || mime.includes("wordprocessingml")) {
    return {
      type: "word",
      subtype: "docx",
      confidence: 0.9,
      suggestedAdapter: "docx",
      language: "en",
    };
  }

  // PPTX (Phase 5 adapter).
  if (ext === "pptx" || mime.includes("presentationml")) {
    return {
      type: "presentation",
      subtype: "pptx",
      confidence: 0.9,
      suggestedAdapter: "pptx",
      language: "en",
    };
  }

  // Images (Phase 5 vision adapter).
  if (
    ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "gif" ||
    mime.startsWith("image/") ||
    magic === "png" || magic === "jpeg" || magic === "webp" || magic === "gif"
  ) {
    return {
      type: "image",
      subtype: ext || (magic ?? "image"),
      confidence: 0.9,
      suggestedAdapter: "image",
      language: "en",
    };
  }

  // Unknown.
  return {
    type: "other",
    confidence: 0.1,
    suggestedAdapter: "none",
    language: "en",
  };
}

// ── Tier 2: LLM classification for narrative content ─────

/**
 * Phase 2 — runs after Tier 1 + initial text extraction to refine the
 * document type when the heuristic classifier was uncertain (e.g. PDFs
 * which could be reports, contracts, or memos). Called by the universal
 * parser when the tabular adapter finds no tables in a PDF, signaling
 * the document is narrative rather than tabular.
 *
 * Returns a refined ClassificationResult. On API failure, falls back to
 * the Tier 1 result so uploads aren't blocked by transient LLM errors.
 */

const LLM_CLASSIFIER_MODEL = MODELS.classifier;
const LLM_CLASSIFIER_SAMPLE_CHARS = 4000;

const LlmClassifierSchema = z.object({
  type: z.enum([
    "report",
    "memo",
    "contract",
    "policy",
    "financial_statement",
    "invoice",
    "receipt",
    "form",
    "table_pdf",
    "presentation",
    "other",
  ]),
  /** Free-text subtype, e.g. "MSA", "NDA", "Q3 earnings release". May be empty. */
  subtype: z.string().nullable(),
  /** ISO 639-1 language code detected from the text. */
  language: z.string(),
  /** Self-reported confidence in [0, 1]. */
  confidence: z.number().min(0).max(1),
  /** Brief justification, one short sentence. For telemetry/debug only. */
  reasoning: z.string(),
});

function mapTier2TypeToAdapter(t: z.infer<typeof LlmClassifierSchema>["type"]): SuggestedAdapter {
  switch (t) {
    case "report":
    case "memo":
    case "contract":
    case "policy":
    case "financial_statement":
      return "narrative";
    case "invoice":
    case "receipt":
    case "form":
      return "narrative";              // Phase 2 narrative adapter handles these (text-based)
    case "table_pdf":
      return "tabular";
    case "presentation":
      return "pptx";                   // Phase 5
    case "other":
    default:
      return "narrative";              // Default to narrative — safer than failing
  }
}

export async function classifyDocumentLLM(
  sampleText: string,
  tier1: ClassificationResult
): Promise<ClassificationResult> {
  if (!sampleText || sampleText.trim().length < 50) {
    // Not enough text to classify — keep Tier 1.
    return tier1;
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[classifier] OPENAI_API_KEY not set — skipping Tier 2");
    return tier1;
  }

  const sample = sampleText.slice(0, LLM_CLASSIFIER_SAMPLE_CHARS);

  try {
    const client = openai();
    const systemContent =
      "You classify business documents. Given the first few thousand characters of a document, return its type, subtype (free-text descriptor like 'MSA' or 'Q3 earnings release'), detected language code (ISO 639-1), and your confidence. Be conservative — when in doubt prefer 'report' over more specific types.";
    const userContent = `Filename: ${tier1.subtype ?? "unknown"}\nHeuristic guess: ${tier1.type}\n\n---DOCUMENT SAMPLE---\n${sample}\n---END SAMPLE---`;
    const completion = await instrumented(
      "classify_tier2",
      LLM_CLASSIFIER_MODEL,
      () =>
        client.chat.completions.parse({
          model: LLM_CLASSIFIER_MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: systemContent },
            { role: "user", content: userContent },
          ],
          response_format: zodResponseFormat(LlmClassifierSchema, "classification"),
        }),
      { promptChars: systemContent.length + userContent.length }
    );

    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) return tier1;

    const refined: ClassificationResult = {
      type: parsed.type as DocumentType,
      subtype: parsed.subtype ?? undefined,
      confidence: parsed.confidence,
      suggestedAdapter: mapTier2TypeToAdapter(parsed.type),
      language: parsed.language || "en",
    };

    console.log(
      `[classifier] Tier 2 → ${refined.type}` +
        (refined.subtype ? ` (${refined.subtype})` : "") +
        ` conf=${refined.confidence.toFixed(2)} reason=${parsed.reasoning}`
    );
    return refined;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tier 2 classification failed";
    console.warn("[classifier] Tier 2 error, falling back to Tier 1:", message);
    return tier1;
  }
}

// ── Document-type helpers ────────────────────────────────

const NARRATIVE_TYPES: DocumentType[] = [
  "report",
  "memo",
  "contract",
  "policy",
  "financial_statement",
  "invoice",
  "receipt",
  "form",
];

export function isNarrativeType(type: DocumentType): boolean {
  return NARRATIVE_TYPES.includes(type);
}
