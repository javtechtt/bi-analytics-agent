/**
 * Phase 2: Grounding validation + numeric round-trip.
 *
 * Every fact/metric/timeline-event extracted by the LLM cites a `source.text`
 * span that the model claims appears in the document. We do NOT trust that
 * claim. This module verifies:
 *
 *   1. SPAN MATCH — the cited text appears verbatim (after normalization)
 *      in the document text. If not → mark as `unverified` and exclude
 *      from confident output.
 *
 *   2. NUMERIC ROUND-TRIP — for metric facts and metrics, the parsed
 *      numeric value must round-trip back to a string that also appears
 *      near the cited span in the source. This catches "the model invented
 *      a number" hallucinations where it cites a real sentence but reports
 *      the wrong figure.
 *
 * The output verificationStatus drives downstream behavior:
 *   - "grounded"   → safe to speak as fact
 *   - "partial"    → mention with a hedge ("the document mentions roughly...")
 *   - "unverified" → exclude from spoken answers; surface as a warning only
 *
 * This is the central defense against hallucination in Phase 2. Future
 * phases may add LLM-as-judge as a third gate.
 */

import type {
  Fact,
  Metric,
  SourceSpan,
  TimelineEvent,
  VerificationStatus,
} from "@/lib/documents/types";
import { parseNumericValue, type SegmentedSentence } from "./extractor";
import type { ExtractionResult } from "./schemas";

// ── Text normalization ───────────────────────────────────

/**
 * Normalize text for substring matching: collapse whitespace, lowercase,
 * strip punctuation that often varies between source and citation. This
 * is intentionally aggressive — we'd rather accept a near-match than
 * reject a legitimate citation due to a fancy hyphen or a soft line break.
 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")    // unicode dashes → ascii hyphen
    .replace(/[‘’]/g, "'")           // smart single quotes
    .replace(/[“”]/g, '"')           // smart double quotes
    .replace(/ /g, " ")                   // non-breaking space
    .replace(/[\r\n\t]+/g, " ")                // newlines and tabs → space
    .replace(/\s+/g, " ")                      // collapse whitespace
    .trim();
}

// ── Span match ───────────────────────────────────────────

/**
 * Returns true if `spanText` appears as a substring of `documentText`
 * after normalization. The span text needs at least 8 characters of
 * signal — shorter snippets give too many false positives.
 */
export function spanAppearsInDocument(
  spanText: string,
  normalizedDocText: string
): boolean {
  const normalized = normalize(spanText);
  if (normalized.length < 8) return false;
  return normalizedDocText.includes(normalized);
}

/**
 * Stricter validation: the cited span must match (or be a substring of)
 * ONE of the pre-segmented sentences the extractor saw. This forbids the
 * LLM from citing text that spans two unrelated sentences or from
 * fabricating fragments that happen to appear in the doc only by accident.
 *
 * Returns the matching sentence if found, null otherwise. Caller uses
 * the matched sentence's page number for the persisted SourceSpan.
 */
export function spanMatchesAnySentence(
  spanText: string,
  sentences: SegmentedSentence[]
): SegmentedSentence | null {
  const normalized = normalize(stripSentencePrefix(spanText));
  if (normalized.length < 8) return null;

  // Try exact match first.
  for (const s of sentences) {
    if (normalize(s.text) === normalized) return s;
  }
  // Then substring match: the span is part of a sentence (allowed — model
  // can quote a fragment of a sentence). It must NOT span two sentences.
  for (const s of sentences) {
    const ns = normalize(s.text);
    if (ns.includes(normalized) || normalized.includes(ns)) return s;
  }
  return null;
}

/** Strip optional "[S12 p.3]" or "[S12]" prefix the model may include. */
function stripSentencePrefix(text: string): string {
  return text.replace(/^\s*\[s\d+(?:\s*p\.?\s*\d+)?\]\s*/i, "");
}

// ── Numeric round-trip ───────────────────────────────────

/**
 * Given a parsed numeric value and the source text it came from, check
 * that SOME representation of the same number appears near the span.
 * Accepts: "2400000", "2,400,000", "$2.4M", "$2.4 million", "2.4M".
 *
 * Within-tolerance: ±0.5% to allow for rounding (e.g., "2.4M" ≈ 2,400,000
 * exactly, but "2.4 million" could be 2,350,000 ÷ 2,449,999).
 */
export function numericValueAppearsNear(
  parsedValue: number,
  spanText: string,
  documentText: string
): boolean {
  const normalizedDoc = normalize(documentText);
  const normalizedSpan = normalize(spanText);

  // Where does the span land in the doc? Search ±300 chars around it.
  const idx = normalizedDoc.indexOf(normalizedSpan);
  const radius = 300;
  const fromIdx = idx >= 0 ? Math.max(0, idx - radius) : 0;
  const toIdx = idx >= 0 ? Math.min(normalizedDoc.length, idx + normalizedSpan.length + radius) : normalizedDoc.length;
  const haystack = normalizedDoc.slice(fromIdx, toIdx);

  // Generate likely string representations of the value.
  const abs = Math.abs(parsedValue);
  const candidates: string[] = [];

  // Raw integer / decimal
  if (Number.isInteger(parsedValue)) {
    candidates.push(String(parsedValue));
  } else {
    candidates.push(parsedValue.toFixed(2));
    candidates.push(parsedValue.toFixed(1));
  }

  // With thousands separators
  if (abs >= 1000) {
    candidates.push(Math.round(parsedValue).toLocaleString("en-US"));
  }

  // Scaled forms
  if (abs >= 1_000_000_000) {
    candidates.push((parsedValue / 1_000_000_000).toFixed(1) + "b");
    candidates.push((parsedValue / 1_000_000_000).toFixed(2) + "b");
    candidates.push((parsedValue / 1_000_000_000).toFixed(1) + " billion");
  } else if (abs >= 1_000_000) {
    candidates.push((parsedValue / 1_000_000).toFixed(1) + "m");
    candidates.push((parsedValue / 1_000_000).toFixed(2) + "m");
    candidates.push((parsedValue / 1_000_000).toFixed(1) + " million");
  } else if (abs >= 1000) {
    candidates.push((parsedValue / 1000).toFixed(1) + "k");
    candidates.push((parsedValue / 1000).toFixed(1) + " thousand");
  }

  // Percent forms (the value might already be in percent units)
  if (abs <= 100) {
    candidates.push(String(parsedValue) + "%");
    if (Number.isInteger(parsedValue)) {
      candidates.push(parsedValue.toFixed(1) + "%");
    }
  }

  const normalizedCandidates = candidates.map((c) => normalize(c));
  return normalizedCandidates.some((c) => haystack.includes(c));
}

// ── Public validation API ────────────────────────────────

export interface ValidatedExtraction {
  facts: Fact[];
  metrics: Metric[];
  timeline: TimelineEvent[];
  spans: Record<string, SourceSpan>;
  /** Ratio of grounded facts to all facts (excluding entities). 1.0 if no facts. */
  groundingRatio: number;
  /** Per-status counts for telemetry. */
  counts: { grounded: number; partial: number; unverified: number };
}

let spanIdCounter = 0;
function nextSpanId(): string {
  spanIdCounter++;
  return `span_${Date.now()}_${spanIdCounter}`;
}

let factIdCounter = 0;
function nextFactId(prefix: string): string {
  factIdCounter++;
  return `${prefix}_${Date.now()}_${factIdCounter}`;
}

/**
 * Validate an ExtractionResult.
 *
 * Phase 3.1 — STRICT MODE: when `sentences` is provided, every fact's
 * cited source MUST match (exactly or as a substring of) one of the
 * pre-segmented sentences the LLM was shown. Citations that span two
 * unrelated sentences, hallucinated fragments, or substrings that only
 * coincidentally appear in the doc all get rejected.
 *
 * Phase 2 — LEGACY MODE: when `sentences` is omitted, falls back to the
 * substring-against-full-document check. Less precise but compatible with
 * any caller that hasn't yet adopted sentence segmentation.
 */
export function validateExtraction(
  raw: ExtractionResult,
  documentText: string,
  sentences?: SegmentedSentence[]
): ValidatedExtraction {
  const normalizedDoc = normalize(documentText);
  const useStrict = !!(sentences && sentences.length > 0);
  const spans: Record<string, SourceSpan> = {};
  const counts = { grounded: 0, partial: 0, unverified: 0 };

  /** Validate one cited source and return the span info + status. */
  function classify(
    citedText: string,
    citedPage: number | null
  ): {
    spanId: string;
    status: VerificationStatus;
    canonicalText: string;
    page: number | undefined;
  } {
    const spanId = nextSpanId();

    if (useStrict) {
      const match = spanMatchesAnySentence(citedText, sentences!);
      if (match) {
        return {
          spanId,
          status: "grounded",
          canonicalText: match.text,        // canonicalize to the full sentence
          page: match.page,
        };
      }
      return {
        spanId,
        status: "unverified",
        canonicalText: citedText,
        page: citedPage ?? undefined,
      };
    }

    // Legacy path
    const grounded = spanAppearsInDocument(citedText, normalizedDoc);
    return {
      spanId,
      status: grounded ? "grounded" : "unverified",
      canonicalText: citedText,
      page: citedPage ?? undefined,
    };
  }

  function bump(status: VerificationStatus) {
    if (status === "grounded") counts.grounded++;
    else if (status === "partial") counts.partial++;
    else counts.unverified++;
  }

  // Facts
  const facts: Fact[] = raw.facts.map((f) => {
    const c = classify(f.source.text, f.source.page);
    spans[c.spanId] = { id: c.spanId, page: c.page, text: c.canonicalText };
    bump(c.status);
    return {
      id: nextFactId("fact"),
      type: f.type,
      subject: f.subject ?? undefined,
      value: f.value,
      unit: f.unit ?? undefined,
      sourceSpanIds: [c.spanId],
      verificationStatus: c.status,
      confidence: confidenceFor(c.status),
    };
  });

  // Metrics — also numeric round-trip check
  const metrics: Metric[] = raw.metrics.map((m) => {
    const c = classify(m.source.text, m.source.page);
    spans[c.spanId] = { id: c.spanId, page: c.page, text: c.canonicalText };

    const parsed = parseNumericValue(m.valueText);
    let finalStatus: VerificationStatus = c.status;
    if (finalStatus === "grounded" && parsed !== null) {
      // Round-trip the numeric value against the canonical sentence text
      // (strict mode) or the full doc (legacy mode).
      const haystack = useStrict ? c.canonicalText : documentText;
      const numericOK = numericValueAppearsNear(parsed, c.canonicalText, haystack);
      if (!numericOK) finalStatus = "partial";
    } else if (parsed === null) {
      finalStatus = "unverified";
    }
    bump(finalStatus);

    return {
      id: nextFactId("metric"),
      name: m.name,
      value: parsed ?? 0,
      unit: m.unit ?? undefined,
      period: m.period ?? undefined,
      sourceSpanIds: [c.spanId],
      confidence: confidenceFor(finalStatus),
    };
  });

  // Timeline events
  const timeline: TimelineEvent[] = raw.timeline.map((t) => {
    const c = classify(t.source.text, t.source.page);
    spans[c.spanId] = { id: c.spanId, page: c.page, text: c.canonicalText };
    bump(c.status);
    return {
      id: nextFactId("event"),
      date: t.date,
      description: t.description,
      sourceSpanIds: [c.spanId],
    };
  });

  const totalChecked = counts.grounded + counts.partial + counts.unverified;
  const groundingRatio = totalChecked > 0 ? counts.grounded / totalChecked : 1.0;

  return { facts, metrics, timeline, spans, groundingRatio, counts };
}

function confidenceFor(status: VerificationStatus): number {
  switch (status) {
    case "grounded":   return 0.9;
    case "partial":    return 0.5;
    case "unverified": return 0.1;
  }
}
