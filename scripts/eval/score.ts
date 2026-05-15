/**
 * Golden eval — scorers.
 *
 * Hybrid scoring: mechanical assertions on structure (contains/excludes/
 * citation pages/confidence/latency/cost) PLUS an LLM-judge that scores
 * answer correctness against the expected substrings.
 *
 * Overall question score weighting:
 *   judge:    40%
 *   contains: 25%
 *   excludes: 15%
 *   citation: 15%
 *   confidence: 5%
 * Latency and cost are reported but don't dock the score — they're separate budgets.
 */

import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import type {
  GoldenQuestion,
  ScoreBreakdown,
  QuestionResult,
} from "./types";
import { MODELS } from "@/lib/models";
import { openai } from "@/lib/openai/client";

const JUDGE_MODEL = MODELS.judge;

const JudgeSchema = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string(),
});

const CONFIDENCE_RANK: Record<"low" | "medium" | "high", number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface ScoreRoutingInfo {
  reasoningMode?: "simple" | "complex";
  subQuestions?: string[];
  subAnswersCompleted?: number;
}

export async function scoreAnswer(
  question: GoldenQuestion,
  answer: string,
  citationPages: number[],
  confidence: "low" | "medium" | "high" | undefined,
  latencyMs: number,
  costUsd: number | null,
  routing?: ScoreRoutingInfo
): Promise<{ score: number; breakdown: ScoreBreakdown }> {
  const answerLower = (answer || "").toLowerCase();

  // Contains check
  const containsMissing: string[] = [];
  for (const needle of question.expectedAnswerContains ?? []) {
    if (!answerLower.includes(needle.toLowerCase())) containsMissing.push(needle);
  }
  const containsPass = containsMissing.length === 0;

  // Excludes check
  const excludesViolations: string[] = [];
  for (const needle of question.expectedAnswerExcludes ?? []) {
    if (answerLower.includes(needle.toLowerCase())) excludesViolations.push(needle);
  }
  const excludesPass = excludesViolations.length === 0;

  // Citation page check
  const citationPass =
    !question.expectedCitationPages || question.expectedCitationPages.length === 0
      ? true
      : citationPages.some((p) => question.expectedCitationPages!.includes(p));

  // Confidence check
  let confidencePass = true;
  if (question.expectedMinConfidence) {
    if (!confidence) confidencePass = false;
    else confidencePass = CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[question.expectedMinConfidence];
  }

  // Latency / cost
  const latencyPass = !question.maxLatencyMs || latencyMs <= question.maxLatencyMs;
  const costPass = !question.maxCostUsd || costUsd == null || costUsd <= question.maxCostUsd;

  // Judge LLM
  const { score: judgeScore, reasoning: judgeReasoning } = await runJudge(
    question,
    answer
  );

  const score =
    0.40 * judgeScore +
    0.25 * (containsPass ? 1 : 0) +
    0.15 * (excludesPass ? 1 : 0) +
    0.15 * (citationPass ? 1 : 0) +
    0.05 * (confidencePass ? 1 : 0);

  const breakdown: ScoreBreakdown = {
    toolSucceeded: true,
    containsPass,
    containsMissing,
    excludesPass,
    excludesViolations,
    citationPass,
    citationActualPages: citationPages,
    confidencePass,
    actualConfidence: confidence,
    judgeScore,
    judgeReasoning,
    latencyPass,
    actualLatencyMs: latencyMs,
    costPass,
    actualCostUsd: costUsd,
    reasoningMode: routing?.reasoningMode,
    subQuestions: routing?.subQuestions,
    subAnswersCompleted: routing?.subAnswersCompleted,
  };

  return { score, breakdown };
}

async function runJudge(
  question: GoldenQuestion,
  answer: string
): Promise<{ score: number; reasoning: string }> {
  if (!process.env.OPENAI_API_KEY) {
    return { score: 0, reasoning: "OPENAI_API_KEY not set; skipping judge" };
  }
  if (!answer || answer.trim().length === 0) {
    return { score: 0, reasoning: "Empty answer" };
  }

  const expected = (question.expectedAnswerContains ?? []).join("; ");
  const client = openai();
  try {
    const completion = await client.chat.completions.parse({
      model: JUDGE_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are a strict grader for question-answering. Given a question, an expected-content hint (substrings the ideal answer would contain), and the actual answer, score the answer in [0, 1] for how well it addresses the question.

Rubric:
- 1.0: Fully correct, on-topic, addresses every aspect of the question.
- 0.7-0.9: Mostly correct, minor omissions.
- 0.4-0.6: Partially correct, addresses some of the question but misses key points.
- 0.1-0.3: Tangentially related, mostly wrong.
- 0.0: Off-topic, hallucinated, or "I don't know" when the expected content is clearly answerable.

Be terse — one sentence of reasoning.`,
        },
        {
          role: "user",
          content: `Question: ${question.question}\n\nExpected content (substrings the ideal answer would contain): ${expected || "(none — judge on general correctness)"}\n\nActual answer: ${answer}\n\nScore the actual answer.`,
        },
      ],
      response_format: zodResponseFormat(JudgeSchema, "judgment"),
    });
    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) return { score: 0, reasoning: "judge returned empty" };
    return { score: parsed.score, reasoning: parsed.reasoning };
  } catch (err) {
    return {
      score: 0,
      reasoning: `judge error: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

export function failedResult(
  question: GoldenQuestion,
  error: string
): QuestionResult {
  return {
    question,
    score: 0,
    answer: "",
    error,
    breakdown: {
      toolSucceeded: false,
      containsPass: false,
      containsMissing: question.expectedAnswerContains ?? [],
      excludesPass: true,
      excludesViolations: [],
      citationPass: false,
      citationActualPages: [],
      confidencePass: false,
      judgeScore: 0,
      judgeReasoning: error,
      latencyPass: false,
      actualLatencyMs: 0,
      costPass: true,
      actualCostUsd: null,
    },
  };
}
