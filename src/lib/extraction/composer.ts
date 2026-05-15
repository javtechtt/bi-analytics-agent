/**
 * Phase 2: Answer composer.
 *
 * Given a question, a focus area, and a list of GROUNDED facts (with their
 * source spans), compose a short spoken-style answer that uses ONLY those
 * facts. The composer is the last line of defense against hallucination —
 * even if extraction was imperfect, the composer's prompt is locked to
 * "no facts → no answer, just say you don't know".
 *
 * Heuristic visual suggestions are also produced here so the Phase 3
 * composer can lay out the right scene without another LLM call.
 */

import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import type { Fact, Metric, SourceSpan, TimelineEvent } from "@/lib/documents/types";
import type { ExtractionFocus } from "./extractor";
import { instrumented } from "@/lib/telemetry/trace";
import { MODELS } from "@/lib/models";
import { openai } from "@/lib/openai/client";

const COMPOSER_MODEL = MODELS.composer;
const COMPOSER_TEMPERATURE = 0.2;

export type SuggestedVisualKind =
  | "summary_card"
  | "risk_panel"
  | "entity_card"
  | "timeline"
  | "kpi"
  | "doc_preview";

export interface ComposerInput {
  question: string;
  focus?: ExtractionFocus;
  facts: Fact[];
  metrics: Metric[];
  timeline: TimelineEvent[];
  spans: Record<string, SourceSpan>;
  documentType: string;
}

export interface ComposerOutput {
  answer: string;
  citedSpanIds: string[];
  /** Overall confidence label derived from input facts. */
  confidence: "high" | "medium" | "low";
  suggestedVisuals: SuggestedVisualKind[];
}

const ComposerResponseSchema = z.object({
  answer: z.string(),
  citedSpanIds: z.array(z.string()),
});

function formatFactForPrompt(f: Fact, spans: Record<string, SourceSpan>): string {
  const spanText = f.sourceSpanIds
    .map((sid) => spans[sid]?.text)
    .filter(Boolean)
    .join(" / ");
  const subject = f.subject ? `${f.subject}: ` : "";
  const unit = f.unit ? ` ${f.unit}` : "";
  return `- [${f.type}] ${subject}${f.value}${unit} (span_ids: ${f.sourceSpanIds.join(",")}; source: "${spanText.slice(0, 200)}")`;
}

function formatMetricForPrompt(m: Metric, spans: Record<string, SourceSpan>): string {
  const spanText = m.sourceSpanIds
    .map((sid) => spans[sid]?.text)
    .filter(Boolean)
    .join(" / ");
  const period = m.period ? ` (${m.period})` : "";
  return `- [metric] ${m.name}${period}: ${m.value}${m.unit ? " " + m.unit : ""} (span_ids: ${m.sourceSpanIds.join(",")}; source: "${spanText.slice(0, 200)}")`;
}

function formatTimelineForPrompt(t: TimelineEvent, spans: Record<string, SourceSpan>): string {
  const spanText = t.sourceSpanIds
    .map((sid) => spans[sid]?.text)
    .filter(Boolean)
    .join(" / ");
  return `- [event] ${t.date} — ${t.description} (span_ids: ${t.sourceSpanIds.join(",")}; source: "${spanText.slice(0, 200)}")`;
}

function deriveConfidence(facts: Fact[], metrics: Metric[]): "high" | "medium" | "low" {
  const all = [
    ...facts.map((f) => f.confidence),
    ...metrics.map((m) => m.confidence),
  ];
  if (all.length === 0) return "low";
  const avg = all.reduce((a, b) => a + b, 0) / all.length;
  if (avg >= 0.75) return "high";
  if (avg >= 0.5) return "medium";
  return "low";
}

function suggestVisuals(input: ComposerInput): SuggestedVisualKind[] {
  const visuals = new Set<SuggestedVisualKind>();
  if (input.facts.some((f) => f.type === "risk")) visuals.add("risk_panel");
  if (input.facts.some((f) => f.type === "party")) visuals.add("entity_card");
  if (input.timeline.length > 0) visuals.add("timeline");
  if (input.metrics.length > 0) visuals.add("kpi");
  visuals.add("summary_card");
  if (input.focus === "general") visuals.add("doc_preview");
  return [...visuals];
}

export async function composeAnswer(input: ComposerInput): Promise<ComposerOutput> {
  const { question, focus, facts, metrics, timeline, spans, documentType } = input;
  const confidence = deriveConfidence(facts, metrics);
  const visuals = suggestVisuals(input);

  // If no grounded material, return an honest non-answer without an LLM call.
  if (facts.length === 0 && metrics.length === 0 && timeline.length === 0) {
    return {
      answer:
        "I don't have grounded facts in this document that answer that question. The extraction either returned nothing or couldn't verify the citations against the source.",
      citedSpanIds: [],
      confidence: "low",
      suggestedVisuals: visuals,
    };
  }

  const factsBlock = facts.map((f) => formatFactForPrompt(f, spans)).join("\n");
  const metricsBlock = metrics.map((m) => formatMetricForPrompt(m, spans)).join("\n");
  const timelineBlock = timeline.map((t) => formatTimelineForPrompt(t, spans)).join("\n");

  const systemPrompt = `You compose short spoken-style answers for a voice business-intelligence agent. You will be given a question and a list of GROUNDED facts extracted from a ${documentType} document. Each fact has source span ids and a source text snippet.

CRITICAL RULES:
1. Use ONLY the facts provided. Do NOT add numbers, names, dates, or claims that aren't in the list.

2. RELEVANCE FIRST: The user asked a specific question. Only USE facts that DIRECTLY answer it. If a fact is in the input list but unrelated to the question, IGNORE it — do not mention it and do not cite it.

3. CITATION PRECISION: citedSpanIds MUST list ONLY the span ids of facts you actually USED in your answer. If you didn't use a fact, do NOT cite its span_id. Empty array is valid if the input contains nothing that answers the question. Quality of citations matters more than quantity — three precise citations beat ten loose ones.

4. NO INPUT, NO ANSWER: If none of the provided facts answer the question, say so plainly: "The document doesn't say." Do not pad with tangentially related facts to look helpful.

5. Keep the answer to 1–3 sentences. This will be spoken aloud — favor short clear sentences over comprehensive ones.

6. Round numbers naturally ("about 2.4 million", not "2,403,591"). But never change the value's order of magnitude.

7. Do NOT preface with "Based on the document" or "According to the facts" — just answer.

8. If the facts conflict (the input may include both a high and a low value for the same metric), surface the conflict briefly rather than picking one silently.`;

  const userPrompt = `Question: ${question}
${focus ? `Focus: ${focus}\n` : ""}
GROUNDED FACTS:
${factsBlock || "(none)"}

GROUNDED METRICS:
${metricsBlock || "(none)"}

GROUNDED TIMELINE:
${timelineBlock || "(none)"}

Compose the answer.`;

  const client = openai();
  try {
    const completion = await instrumented(
      "compose_answer",
      COMPOSER_MODEL,
      () =>
        client.chat.completions.parse({
          model: COMPOSER_MODEL,
          temperature: COMPOSER_TEMPERATURE,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: zodResponseFormat(ComposerResponseSchema, "answer"),
        }),
      { promptChars: systemPrompt.length + userPrompt.length }
    );
    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) {
      return {
        answer: "The composer returned no parsed content.",
        citedSpanIds: [],
        confidence: "low",
        suggestedVisuals: visuals,
      };
    }
    return {
      answer: parsed.answer,
      citedSpanIds: parsed.citedSpanIds,
      confidence,
      suggestedVisuals: visuals,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Composer failed";
    console.error("[composer] error:", msg);
    return {
      answer: "I couldn't generate an answer right now. The extracted facts are available — try asking a more specific question.",
      citedSpanIds: [],
      confidence: "low",
      suggestedVisuals: visuals,
    };
  }
}
