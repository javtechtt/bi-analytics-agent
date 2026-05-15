/**
 * Universal document types — Phase 1 foundation.
 *
 * These types are the new "currency" of the BI Analyst system. Every uploaded
 * document — spreadsheet, PDF, contract, image, screenshot, presentation,
 * report — is normalized into a DocumentExtraction object so downstream tools,
 * the voice agent, and the visual composer can reason uniformly about it.
 *
 * In Phase 1 ONLY the tabular adapter is implemented, so `tables` is populated
 * for CSV/Excel/PDF-tables and everything else (`facts`, `metrics`, `entities`,
 * `timeline`, `spans`, `sections`) is stubbed empty. Later phases:
 *
 *   - Phase 2 → narrative-PDF adapter populates `sections`, `facts`, `spans`.
 *   - Phase 5 → vision/OCR/DOCX/PPTX adapters populate the same fields.
 *   - Phase 6 → cross-document entity canonicalization populates `entities`.
 *
 * The legacy `ParsedData` (src/lib/types.ts) lives ALONGSIDE DocumentExtraction
 * in Phase 1. Existing tools (profile_dataset, run_analysis, create_chart,
 * generate_dashboard, recommend_actions) still consume ParsedData directly. In
 * a later phase, when those tools migrate, they will read from
 * `DocumentExtraction.tables[0].data` — the contract is the same.
 *
 * IMPORTANT: do not change `ParsedData.extractionMethod` values
 * ("positional" | "heuristic" | "none") — those are read as literals by the
 * confidence-scoring code in tools/execute/route.ts. The new
 * `DocumentExtraction.extractionMethod` is an orthogonal, richer enum used by
 * future-phase tools.
 */

import type { ParsedData } from "@/lib/types";

// ── Document classification ───────────────────────────────

export type DocumentType =
  | "spreadsheet"            // CSV, XLSX, XLS
  | "table_pdf"              // PDF whose primary content is extractable tables
  | "financial_statement"    // P&L, balance sheet, cashflow
  | "invoice"
  | "receipt"
  | "contract"
  | "policy"
  | "report"                 // long-form narrative PDF
  | "memo"
  | "presentation"           // PPTX
  | "dashboard_screenshot"
  | "form"
  | "scan_handwritten"
  | "image"                  // raw PNG / JPG / WEBP
  | "word"                   // DOCX
  | "other";

// ── Facts, entities, provenance ───────────────────────────

export type FactType =
  | "metric"
  | "claim"
  | "date"
  | "party"
  | "obligation"
  | "risk";

export type VerificationStatus = "grounded" | "partial" | "unverified";

export type EntityType =
  | "person"
  | "org"
  | "account"
  | "product"
  | "location";

/**
 * A verifiable region of the original document. Foundation for the grounding
 * validator in Phase 2 — every Fact must cite at least one SourceSpan, and
 * the validator checks that each cited span's `text` actually appears in the
 * parsed document.
 */
export interface SourceSpan {
  id: string;
  page?: number;
  /** Verbatim text from the source — used by the grounding validator. */
  text: string;
  bbox?: { x: number; y: number; w: number; h: number };
}

/** An atomic, span-grounded assertion extracted from the document. */
export interface Fact {
  id: string;
  type: FactType;
  subject?: string;
  value: string | number;
  unit?: string;
  /** MUST reference real SourceSpan ids. Validators will reject claims
   *  whose spans do not appear in the source. */
  sourceSpanIds: string[];
  verificationStatus: VerificationStatus;
  /** [0, 1] */
  confidence: number;
}

/** A KPI-like numeric quantity. Special case of Fact kept separate for
 *  fast aggregation in the metrics layer. */
export interface Metric {
  id: string;
  name: string;
  value: number;
  unit?: string;
  /** e.g. "Q1 2025", "FY24" — free text for now. */
  period?: string;
  sourceSpanIds: string[];
  confidence: number;
}

/** A named entity (party, account, product, location) — canonicalized
 *  across documents in Phase 6. */
export interface Entity {
  id: string;
  canonicalName: string;
  type: EntityType;
  aliases: string[];
  /** Role within THIS document (e.g. "buyer", "vendor", "signatory"). */
  role?: string;
}

/** A dated event — populated by contract/report adapters in later phases. */
export interface TimelineEvent {
  id: string;
  /** ISO 8601 date string. */
  date: string;
  description: string;
  sourceSpanIds: string[];
}

/** A logical section of a narrative document. */
export interface DocumentSection {
  id: string;
  heading: string;
  text: string;
  page?: number;
}

/**
 * A table extracted from the document. Wraps the legacy `ParsedData` so
 * existing analytics tools keep operating on the same row/column shape
 * they already understand.
 */
export interface DocumentTable {
  name: string;
  data: ParsedData;
  sourcePage?: number;
}

/**
 * The new extraction-method enum. Orthogonal to the legacy
 * `ParsedData.extractionMethod` and richer (covers narrative/vision/etc.).
 * Used by Phase 2+ confidence scoring and visual composition logic.
 */
export type ExtractionMethod =
  | "tabular-csv"
  | "tabular-xlsx"
  | "tabular-pdf-positional"
  | "narrative-pdf"
  | "vision-ocr"
  | "docx"
  | "pptx"
  | "image"
  | "none";

// ── Universal document representation ─────────────────────

export interface DocumentExtraction {
  /** Stable id; assigned when persisting to the `documents` table.
   *  Empty string until the document is persisted. */
  documentId: string;
  type: DocumentType;
  subtype?: string;
  language: string;

  /** Narrative content. Empty in Phase 1 — Phase 2 narrative adapter populates this. */
  sections?: DocumentSection[];

  /**
   * Phase 2 (server-side only): raw per-page text from the source document.
   * Used by the lazy extractor to run schema-guided extraction without
   * re-parsing the PDF. NEVER returned to the client over /api/files/parse —
   * stripped before serialization. Persisted in the `documents.extraction`
   * JSONB column so subsequent extractions don't need to re-OCR.
   */
  pageTexts?: string[];

  /** Tabular content. Populated by the Phase 1 tabular adapter. */
  tables?: DocumentTable[];

  /** Universal currency — populated by later adapters (Phase 2+). Phase 1 leaves these empty. */
  facts: Fact[];
  metrics: Metric[];
  entities: Entity[];
  timeline?: TimelineEvent[];

  /** factId → SourceSpan. Empty in Phase 1 (no facts to ground). */
  spans: Record<string, SourceSpan>;

  /** Overall extraction confidence in [0, 1]. Mirrors the heuristic used by
   *  tools/execute/route.ts so the voice agent's tone stays consistent. */
  confidence: number;

  /** Ratio of facts that pass grounding validation. Defaults to 1.0
   *  when there are no facts (vacuously grounded). */
  groundingRatio: number;

  /** Confidence of the classifier itself in [0, 1]. */
  classifierConfidence: number;

  /** Which adapter produced this extraction. */
  extractionMethod: ExtractionMethod;

  pageCount?: number;

  /** Soft warnings — not errors. e.g. "PDF table extraction had low confidence". */
  warnings: string[];
}
