/**
 * Universal parser.
 *
 * Phase 2 update: now supports the narrative pivot. The pipeline:
 *
 *     bytes
 *       │
 *       ▼
 *   classifyDocument()                ← Tier 1 heuristic
 *       │
 *       ▼
 *   route by suggestedAdapter
 *       │
 *       ▼
 *   runTabularAdapter()               ← still the entry point for CSV/Excel/PDF
 *       │
 *       ▼
 *   PDF AND extractionMethod === "none"?
 *       │
 *       ├─ no  → return tabular result
 *       │
 *       └─ yes (PDF has no tables — likely narrative)
 *               │
 *               ▼
 *           runNarrativeAdapter()      ← extracts pageTexts + sections
 *               │
 *               ▼
 *           classifyDocumentLLM()      ← Tier 2 LLM refinement (contract / memo / report / ...)
 *               │
 *               ▼
 *           stamp narrative result with refined type
 *               │
 *               ▼
 *           return narrative result
 *
 * The pivot keeps Phase 1's behavior intact for tabular content while
 * routing narrative PDFs (contracts, memos, reports) through the new
 * narrative adapter. Voice agent sees a refined `type` like "contract"
 * and selects `query_document` instead of `profile_dataset`.
 *
 * Heavy schema-guided fact extraction happens LAZILY in the query_document
 * tool, NOT here — uploads stay fast. The narrative adapter only does:
 *   - per-page text extraction (via unpdf)
 *   - section detection (heuristic)
 *   - empty facts/metrics/entities (filled on first query)
 */

import {
  classifyDocument,
  classifyDocumentLLM,
  type ClassificationResult,
} from "./classifier";
import { runTabularAdapter } from "./adapters/tabular";
import { runNarrativeAdapter } from "./adapters/narrative";
import { runVisionPdfAdapter } from "./adapters/vision-pdf";
import { decidePdfStrategy } from "./strategies";
import type { DocumentExtraction } from "@/lib/documents/types";
import type { ParsedData } from "@/lib/types";

export class UnsupportedDocumentTypeError extends Error {
  constructor(public readonly classification: ClassificationResult) {
    super(
      classification.suggestedAdapter === "none"
        ? "Unsupported file type."
        : `Documents of type "${classification.type}" are not yet supported — the ${classification.suggestedAdapter} adapter will land in a later phase.`
    );
    this.name = "UnsupportedDocumentTypeError";
  }
}

export interface UniversalParseInput {
  buffer: Buffer;
  fileName: string;
  mime: string;
  size: number;
  documentId?: string;
}

export interface UniversalParseResult {
  text: string;
  summary: string;
  parsedData: ParsedData;
  extraction: DocumentExtraction;
  classification: ClassificationResult;
}

export async function universalParse(
  input: UniversalParseInput
): Promise<UniversalParseResult> {
  // 1. Tier 1 — heuristic classification.
  const tier1 = await classifyDocument({
    fileName: input.fileName,
    mime: input.mime,
    size: input.size,
    bytes: input.buffer.subarray(0, 16),
  });

  if (tier1.suggestedAdapter !== "tabular") {
    throw new UnsupportedDocumentTypeError(tier1);
  }

  // 2. Try the tabular adapter (Phase 1 behavior).
  const tabular = await runTabularAdapter({
    buffer: input.buffer,
    fileName: input.fileName,
    classification: tier1,
  });

  // 3. PDF narrative handling.
  //
  // Two paths into narrative mode:
  //   (a) Tabular adapter found nothing (extractionMethod === "none").
  //       Definitely not a table — pivot to narrative unconditionally.
  //   (b) Tabular adapter found something weak. The pdf-table-extractor
  //       confidence threshold is intentionally low (0.2) so we don't miss
  //       real tables, but that means narrative PDFs with vaguely tabular
  //       structure (case studies, reports with bullet lists) get
  //       misclassified as table_pdf. Run Tier 2 LLM on the preview text
  //       as a tiebreaker: if it confidently says narrative, override.
  //
  // For non-PDF tabular (CSV/XLSX), Tier 1 confidence is 0.95 — no Tier 2.
  const isPdf = input.fileName.toLowerCase().endsWith(".pdf");
  const isEmptyTabular = tabular.extraction.extractionMethod === "none";

  if (isPdf && isEmptyTabular) {
    return runNarrativePivot(input, tier1);
  }

  if (isPdf) {
    // Tier 2 tiebreaker — uses the tabular adapter's text preview, which
    // already extracted the PDF text, so no second unpdf pass needed here.
    const sample = (tabular.text || "").slice(0, 4000);
    const refined = await classifyDocumentLLM(sample, tier1);
    if (refined.suggestedAdapter === "narrative" && refined.confidence > 0.6) {
      console.log(
        `[universal-parser] Tier 2 overrode tabular for ${input.fileName}: ${tier1.type} → ${refined.type} (conf=${refined.confidence.toFixed(2)}) — re-running narrative adapter`
      );
      // Re-run narrative adapter with the refined classification baked in.
      return runNarrativePivot(input, refined);
    }
  }

  // 4. Tabular result — Phase 1 contract preserved exactly.
  if (input.documentId) {
    tabular.extraction.documentId = input.documentId;
  }
  return {
    text: tabular.text,
    summary: tabular.summary,
    parsedData: tabular.parsedData,
    extraction: tabular.extraction,
    classification: tier1,
  };
}

// ── Narrative pivot ──────────────────────────────────────

async function runNarrativePivot(
  input: UniversalParseInput,
  tier1: ClassificationResult
): Promise<UniversalParseResult> {
  console.log(`[universal-parser] No tables in ${input.fileName} — pivoting to narrative path`);

  // Phase 2: ask the strategy router whether the text-layer is enough or
  // we should escalate to the vision adapter. The router does ONE pdfjs
  // pass to compute density/multi-column metrics.
  const decision = await decidePdfStrategy(input.buffer);
  console.log(
    `[universal-parser] PDF strategy: ${decision.strategy} ` +
      `(avgChars=${decision.metrics.avgCharsPerPage.toFixed(0)}/page, ` +
      `avgItems=${decision.metrics.avgItemsPerPage.toFixed(0)}/page, ` +
      `multiCol=${(decision.metrics.multiColumnRatio * 100).toFixed(0)}%) ` +
      `— ${decision.reasons.join("; ")}`
  );

  let narrative;
  if (decision.strategy === "vision") {
    try {
      narrative = await runVisionPdfAdapter({
        buffer: input.buffer,
        fileName: input.fileName,
        classification: tier1,
        pageCount: decision.pageCount,
      });
    } catch (visionErr) {
      console.warn(
        `[universal-parser] Vision adapter failed for ${input.fileName}, falling back to text-layer: ` +
          (visionErr instanceof Error ? visionErr.message : visionErr)
      );
      narrative = await runNarrativeAdapter({
        buffer: input.buffer,
        fileName: input.fileName,
        classification: tier1,
      });
      narrative.extraction.warnings.push(
        "Vision adapter failed; text-layer used as fallback. Layout-heavy content may be incomplete."
      );
    }
  } else {
    narrative = await runNarrativeAdapter({
      buffer: input.buffer,
      fileName: input.fileName,
      classification: tier1,
    });
  }

  // Use the first ~4000 chars of (whichever adapter produced) text for
  // Tier 2 LLM classification. Vision-Markdown is cleaner input here, so
  // Tier 2 should be more accurate on vision-routed docs.
  const sampleText = (narrative.extraction.pageTexts ?? []).join("\n").slice(0, 4000);
  const refined = await classifyDocumentLLM(sampleText, tier1);

  // Update the narrative extraction with the refined type/subtype/language.
  // BUT: don't downgrade to a tabular type. We just successfully extracted
  // narrative content via the narrative or vision adapter — Tier 2 sometimes
  // sees the structured Markdown output and over-classifies as "table_pdf",
  // which then breaks downstream tool routing (tabular tools have no
  // pageTexts to work with). If Tier 2 picks a tabular type after narrative
  // extraction, ignore it and keep "report" as a safe narrative default.
  const isTabularRefinement = refined.suggestedAdapter === "tabular";
  if (isTabularRefinement) {
    console.log(
      `[universal-parser] Ignoring Tier 2 reclassification of ${input.fileName} to "${refined.type}" — narrative content already extracted; keeping type as "report"`
    );
    narrative.extraction.type = "report";
  } else {
    narrative.extraction.type = refined.type;
  }
  narrative.extraction.subtype = refined.subtype;
  narrative.extraction.language = refined.language;
  narrative.extraction.classifierConfidence = refined.confidence;

  if (input.documentId) {
    narrative.extraction.documentId = input.documentId;
  }

  // Surface the EFFECTIVE classification (after the no-downgrade rule above)
  // so the rest of the pipeline routes correctly.
  const effectiveClassification = isTabularRefinement
    ? { ...refined, type: narrative.extraction.type, suggestedAdapter: "narrative" as const }
    : refined;

  console.log(
    `[universal-parser] Narrative result: type=${narrative.extraction.type}, ` +
      `pages=${narrative.extraction.pageCount}, ` +
      `sections=${narrative.extraction.sections?.length ?? 0}, ` +
      `method=${narrative.extraction.extractionMethod}`
  );

  return {
    text: narrative.text,
    summary: narrative.summary,
    parsedData: narrative.parsedData,
    extraction: narrative.extraction,
    classification: effectiveClassification,
  };
}
