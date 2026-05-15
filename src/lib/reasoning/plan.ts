/**
 * Phase 6: Question complexity planner.
 *
 * Decides whether a user question is "simple" (one retrieval + one
 * composition is enough) or "complex" (needs decomposition into
 * sub-questions, each retrieved independently, then synthesized).
 *
 * Why a separate planner rather than always decomposing:
 *
 *   - Decomposing a simple question into one sub-question is just extra
 *     latency for the same answer.
 *   - Decomposing a simple question into multiple sub-questions can DROP
 *     quality (the LLM invents adjacent questions whose retrieval pollutes
 *     synthesis).
 *
 * So the planner is a gate: only route through the expensive orchestrator
 * when the question genuinely spans multiple sub-claims that can't be
 * answered from a single retrieved set of passages.
 *
 * Heuristic intent (encoded in the prompt, not regex — questions are too
 * varied for patterns):
 *
 *   complex: comparisons ("A vs B"), counterfactuals ("if X, then?"),
 *            multi-entity questions ("for each party, list…"),
 *            multi-aspect questions ("revenue AND headcount AND risks"),
 *            sequential reasoning ("what changed between Q1 and Q3 and why").
 *
 *   simple:  single-fact lookup, single-entity questions, yes/no presence
 *            checks, even if the document is long.
 *
 * Failure mode: planner returns invalid output or errors → caller treats
 * as simple. The simple path is always safe.
 */

import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { instrumented } from "@/lib/telemetry/trace";
import { MODELS } from "@/lib/models";
import { openai } from "@/lib/openai/client";

const PLANNER_MODEL = MODELS.reasoningPlanner;
const PLANNER_TEMPERATURE = 0;

/** Cap on sub-questions per complex query. More than 4 means decomposition is
 *  guessing; quality drops and latency budget breaks. */
const MAX_SUB_QUESTIONS = 4;

const PlanResponseSchema = z.object({
  complexity: z.enum(["simple", "complex"]),
  /** One short sentence: why this classification — telemetry-only. */
  reasoning: z.string(),
  /** Decomposed sub-questions when complex; empty array when simple. */
  subQuestions: z.array(z.string()),
});

export interface PlanQuestionInput {
  question: string;
  /** Document type, used to hint the planner ("contract" → more likely
   *  to need clause-level decomposition; "report" → multi-section questions
   *  are more common). Pass-through, no behavior gating on it. */
  documentType?: string;
}

export interface PlanQuestionOutput {
  complexity: "simple" | "complex";
  /** Always present. Empty when simple. */
  subQuestions: string[];
  reasoning: string;
  /** True when the planner itself failed; caller should treat as simple. */
  plannerFailed: boolean;
}

export async function planQuestionComplexity(
  input: PlanQuestionInput
): Promise<PlanQuestionOutput> {
  const { question, documentType } = input;

  const typeContext = documentType ? ` (document type: ${documentType})` : "";

  const systemPrompt = `You are a question-routing planner for a retrieval-augmented question-answering system over a single document${typeContext}.

You classify each question as "simple" or "complex":

SIMPLE — a single retrieval over the document gives the answer.
- Single-fact lookup: "what is the revenue?", "who is the CEO?", "when was the contract signed?"
- Single-entity question: "what does Acme owe?", "what's the termination clause?"
- Yes/no presence: "is there an indemnity clause?", "does the contract mention arbitration?"
- Even very long documents are SIMPLE if one passage region answers the question.

COMPLEX — the answer requires combining facts from passages that are unlikely to retrieve together for a single embedding query.
- Explicit comparisons: "compare A to B", "A versus B", "what's the difference between X and Y"
- Counterfactuals / conditionals that depend on two different parts of the doc: "if revenue grew 10%, what would gross margin be?", "given the indemnity in clause 8, what happens if clause 12 is breached?"
- Multi-entity enumeration where each entity needs its own retrieval: "for each subsidiary, list its obligations" (only when entities are likely far apart in the document)
- Multi-aspect synthesis where each aspect lives in a different section: "summarize the financial AND operational AND legal risks"
- Sequential reasoning across time periods or sections that wouldn't co-retrieve.

WHEN COMPLEX, decompose into up to ${MAX_SUB_QUESTIONS} sub-questions. Each sub-question:
- Must be answerable on its own from a single retrieval.
- Must be a self-contained search query (use entity names; don't say "the company" or "that section").
- Must NOT duplicate another sub-question.
- Must collectively cover what the original question asks (no missing pieces).

If you would emit only 1 sub-question, the question is SIMPLE. If you can't think of clean independent sub-questions, the question is SIMPLE — better to retrieve once well than twice badly.

Output:
- complexity: "simple" or "complex"
- reasoning: one short sentence stating WHY (for telemetry, not the user)
- subQuestions: [] when simple; 2-${MAX_SUB_QUESTIONS} items when complex`;

  const userPrompt = `Question: ${question}

Classify and (if complex) decompose.`;

  try {
    const client = openai();
    const completion = await instrumented(
      "plan_complexity",
      PLANNER_MODEL,
      () =>
        client.chat.completions.parse({
          model: PLANNER_MODEL,
          temperature: PLANNER_TEMPERATURE,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: zodResponseFormat(PlanResponseSchema, "plan"),
        }),
      { promptChars: systemPrompt.length + userPrompt.length }
    );

    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) {
      return {
        complexity: "simple",
        subQuestions: [],
        reasoning: "planner returned no parsed content",
        plannerFailed: true,
      };
    }

    // Defensive normalisation: if the model emits "complex" but only one
    // sub-question, treat as simple (it can't be decomposed into independent
    // retrievals). Trim and de-duplicate sub-questions.
    const trimmed = parsed.subQuestions
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const unique = Array.from(new Set(trimmed)).slice(0, MAX_SUB_QUESTIONS);
    const isReallyComplex = parsed.complexity === "complex" && unique.length >= 2;

    return {
      complexity: isReallyComplex ? "complex" : "simple",
      subQuestions: isReallyComplex ? unique : [],
      reasoning: parsed.reasoning,
      plannerFailed: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "planner error";
    console.warn(`[reasoning/plan] failed (treating as simple): ${msg}`);
    return {
      complexity: "simple",
      subQuestions: [],
      reasoning: `planner error: ${msg}`,
      plannerFailed: true,
    };
  }
}
