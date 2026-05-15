/**
 * Phase 5: LLM-as-judge verifier.
 *
 * Runs after composeAnswerFromPassages and asks a cheap model: "Given the
 * question and the cited passages, does the answer actually follow from
 * them?" This catches the residual class of failures where:
 *
 *   - Retrieval found the right passages but the composer paraphrased the
 *     answer in a way that subtly diverges from the source.
 *   - Composer fabricated a number / name / date the passages don't contain.
 *   - Composer cited passages that don't actually support the claim.
 *
 * Cheap because gpt-4o-mini is good enough at "does X follow from Y" binary
 * judgments. We do NOT use the verifier to rewrite answers — its only job
 * is to flag bad ones. The caller decides what to do (downgrade confidence,
 * retry composition, return as-is with a caveat).
 *
 * Non-blocking by design: if the verifier itself errors or returns nonsense,
 * we proceed with the original answer and log a warning. The cost of being
 * conservative here is that some bad answers slip through; the cost of
 * being aggressive is that good answers get suppressed.
 */

import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import { instrumented } from "@/lib/telemetry/trace";
import { MODELS } from "@/lib/models";
import { openai } from "@/lib/openai/client";
import type { Passage } from "@/lib/retrieval/retrieve";

const VERIFIER_MODEL = MODELS.verifier;

const VerifierResponseSchema = z.object({
  /** Does the answer follow from the cited passages? Strict yes/no. */
  supports: z.boolean(),
  /** One short sentence explaining the verdict — for logs/telemetry, not the user. */
  reasoning: z.string(),
  /** "high" = answer is fully supported. "partial" = some claims supported, others not.
   *  "unsupported" = the answer adds claims not in the passages. */
  category: z.enum(["high", "partial", "unsupported"]),
});

export interface VerifyInput {
  question: string;
  answer: string;
  /** The passages that were actually cited by the composer (NOT the full retrieved set —
   *  the verifier should judge based on what the composer said it used). */
  citedPassages: Passage[];
  /** Document type — gives the verifier light context for what kind of answer to expect. */
  documentType?: string;
}

export interface VerifyOutput {
  supports: boolean;
  category: "high" | "partial" | "unsupported";
  reasoning: string;
  /** True when the verifier itself failed (API error, malformed response).
   *  In that case `supports` defaults to true so we don't suppress good answers. */
  verifierFailed: boolean;
}

const PASSAGE_SNIPPET_CHARS = 800;

/**
 * Verify whether an answer is supported by its cited passages.
 *
 * Returns `verifierFailed: true` and `supports: true` on internal error —
 * we prefer false-positives (passing through a possibly-bad answer) to
 * false-negatives (suppressing a correct answer because the verifier choked).
 */
export async function verifyAnswer(input: VerifyInput): Promise<VerifyOutput> {
  const { question, answer, citedPassages, documentType } = input;

  if (citedPassages.length === 0) {
    // No citations to verify against. We could call this "unsupported" but
    // composeAnswerFromPassages handles the no-content case with a "doesn't
    // say" answer that's already honest. Skip verification.
    return {
      supports: true,
      category: "high",
      reasoning: "no citations to verify",
      verifierFailed: false,
    };
  }

  const passagesBlock = citedPassages
    .map(
      (p, i) =>
        `[Passage ${i + 1}, page ${p.pageStart ?? "?"}]\n${truncate(p.text, PASSAGE_SNIPPET_CHARS)}`
    )
    .join("\n\n");

  const typeContext = documentType ? ` (document type: ${documentType})` : "";

  const systemPrompt = `You are a strict factual verifier. Given a question, an answer, and the passages that were cited as the basis for the answer${typeContext}, decide whether the answer FOLLOWS FROM the passages.

The answer is "supported" when:
- Every concrete claim (numbers, names, dates, attributions) appears in the passages OR is a direct logical synthesis of multiple passage statements.
- Rounded numbers count as supported when the rounded form is faithful to the source ("about 2.4 million" supports "$2,403,591").
- Honest non-answers like "the document doesn't say" are supported (when the passages indeed don't address the question).

The answer is NOT supported when:
- A claim is in the answer but no passage states it (the model invented or extrapolated).
- A number is stated more precisely than any passage supports.
- An attribution is wrong (passage says A but answer attributes to B).
- The answer changes the polarity of a passage's claim (passage says X grew, answer says X declined).

Be conservative: when in doubt about whether a claim is supported, mark as "partial" rather than "high". When the answer clearly invents content, mark "unsupported".`;

  const userPrompt = `Question: ${question}

Answer to verify: ${answer}

Cited passages:

${passagesBlock}

Does the answer follow from these passages?`;

  try {
    const client = openai();
    const completion = await instrumented(
      "verify_answer",
      VERIFIER_MODEL,
      () =>
        client.chat.completions.parse({
          model: VERIFIER_MODEL,
          temperature: 0,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: zodResponseFormat(VerifierResponseSchema, "verification"),
        }),
      { promptChars: systemPrompt.length + userPrompt.length }
    );
    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) {
      return {
        supports: true,
        category: "high",
        reasoning: "verifier returned no parsed content",
        verifierFailed: true,
      };
    }
    return {
      supports: parsed.supports,
      category: parsed.category,
      reasoning: parsed.reasoning,
      verifierFailed: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "verifier error";
    console.warn(`[verifier] failed (will pass answer through): ${msg}`);
    return {
      supports: true,
      category: "high",
      reasoning: `verifier error: ${msg}`,
      verifierFailed: true,
    };
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
