/**
 * Phase 2: Schema-guided extraction.
 *
 * Zod schemas that the LLM extractor uses as the response format for
 * narrative documents. The schemas are written to be compatible with
 * OpenAI's structured-output mode (via openai/helpers/zod):
 *
 *   - No `optional()` — strict mode requires all fields present. We use
 *     `nullable()` instead and treat null as absence.
 *   - No `union()` of disparate types. `value` is always string; numeric
 *     metrics are parsed downstream (parseNumericValue in extractor.ts).
 *   - No defaults — defaults aren't applied by the structured-output API.
 *
 * Document-type-specific focus is conveyed through the user prompt
 * (extractor.ts:buildUserPrompt), not via separate schemas. One schema,
 * one extraction surface — keeps the pipeline simple.
 */

import { z } from "zod";

// ── Atomic shapes ────────────────────────────────────────

const SourceSpanSchema = z.object({
  /** Verbatim text from the source document — used by the grounding validator. */
  text: z.string(),
  /** Page number (1-indexed) where the text appears, if known. */
  page: z.number().int().nonnegative().nullable(),
});

export const FactSchema = z.object({
  type: z.enum(["metric", "claim", "date", "party", "obligation", "risk"]),
  /** What the fact is about (e.g. "Termination clause", "Acme Corp", "Q3 revenue"). */
  subject: z.string().nullable(),
  /** Value as a string. Numeric facts (type === "metric") are parsed downstream. */
  value: z.string(),
  /** Unit if applicable: "USD", "%", "days", "shares", etc. */
  unit: z.string().nullable(),
  source: SourceSpanSchema,
});

export const EntitySchema = z.object({
  canonicalName: z.string(),
  type: z.enum(["person", "org", "account", "product", "location"]),
  /** Alternative names found in the document. */
  aliases: z.array(z.string()),
  /** Role in this document (buyer, seller, signatory, vendor, etc.). */
  role: z.string().nullable(),
});

export const MetricSchema = z.object({
  /** Human-readable metric name ("Total revenue", "Headcount", "EBITDA"). */
  name: z.string(),
  /** As a string so the LLM doesn't have to commit to a numeric representation;
   *  parser handles "$2.4M", "2,400,000", "2.4 million", "(1,200)" → numbers. */
  valueText: z.string(),
  unit: z.string().nullable(),
  /** "Q3 2024", "FY24", "2023" — free text. */
  period: z.string().nullable(),
  source: SourceSpanSchema,
});

export const TimelineEventSchema = z.object({
  /** Either ISO 8601 ("2024-09-01") or natural ("September 2024"). Validator
   *  attempts ISO normalization downstream. */
  date: z.string(),
  description: z.string(),
  source: SourceSpanSchema,
});

// ── Top-level extraction result ──────────────────────────

export const ExtractionResultSchema = z.object({
  facts: z.array(FactSchema),
  entities: z.array(EntitySchema),
  metrics: z.array(MetricSchema),
  timeline: z.array(TimelineEventSchema),
});

export type ExtractedFact = z.infer<typeof FactSchema>;
export type ExtractedEntity = z.infer<typeof EntitySchema>;
export type ExtractedMetric = z.infer<typeof MetricSchema>;
export type ExtractedTimelineEvent = z.infer<typeof TimelineEventSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
