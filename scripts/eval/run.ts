/**
 * Golden eval — runner.
 *
 * Usage:
 *   tsx scripts/eval/run.ts               # run all questions across all golden files
 *   tsx scripts/eval/run.ts --category=narrative-risk
 *   tsx scripts/eval/run.ts --id=case-studies-q01
 *   tsx scripts/eval/run.ts --user=eval-user-1   # use a specific user id for trace rows
 *
 * Operation:
 *   1. Loads all golden question files from evals/golden/.
 *   2. Resolves required fixtures from evals/fixtures/. Missing fixtures →
 *      questions are SKIPPED with a warning (not a failure).
 *   3. For each unique fixture, uploads it once via universalParse + saveDocument
 *      under the eval user id. Reuses the document for all questions on it.
 *   4. For each question, calls runQueryDocument (or compose_visual_scene logic)
 *      inside a fresh trace, scores via scoreAnswer, and writes results.
 *   5. Writes markdown + JSON reports to evals/reports/.
 *
 * Phase 0 scope: NARRATIVE tools only (query_document, compose_visual_scene).
 * Tabular eval coverage expands in Phase 1.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { universalParse } from "@/lib/ingestion/universal-parser";
import {
  saveDocument,
  findDocumentByFileName,
} from "@/lib/documents/store";
import { runQueryDocument } from "@/lib/extraction/query";
import { runQueryDocumentV2, FallbackToLegacyError } from "@/lib/retrieval/query";
import { embedDocument } from "@/lib/retrieval/embed";
import { isNarrativeType } from "@/lib/ingestion/classifier";
import {
  withTrace,
  settlePendingWrites,
  totalCostForTraceId,
} from "@/lib/telemetry/trace";
import { scoreAnswer, failedResult } from "./score";
import {
  writeReport,
  logQuickSummary,
  summarizeResults,
} from "./report";
import type { GoldenQuestion, QuestionResult, EvalFocus } from "./types";

// ── Paths ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const GOLDEN_DIR = path.join(REPO_ROOT, "evals", "golden");
const FIXTURES_DIR = path.join(REPO_ROOT, "evals", "fixtures");
const REPORTS_DIR = path.join(REPO_ROOT, "evals", "reports");

// ── CLI parsing ──────────────────────────────────────────

interface CliOpts {
  category?: string;
  id?: string;
  user: string;
  /** When true, delete all cached documents + passages for the eval user
   *  before running. Use after a parsing-strategy change (e.g. Phase 2
   *  vision routing) that would otherwise reuse stale text-layer extractions. */
  reset: boolean;
}

function parseCli(argv: string[]): CliOpts {
  const opts: CliOpts = { user: "eval-user-default", reset: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--reset") {
      opts.reset = true;
      continue;
    }
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "category") opts.category = v;
    else if (k === "id") opts.id = v;
    else if (k === "user") opts.user = v;
  }
  return opts;
}

async function resetEvalUserData(userId: string): Promise<void> {
  const { createServerSupabase } = await import("@/lib/supabase/server");
  const sb = createServerSupabase();
  console.log(`[eval] --reset: purging cached data for user ${userId}…`);
  const passages = await sb.from("passages").delete().eq("user_id", userId);
  if (passages.error) console.warn(`  passages purge warning: ${passages.error.message}`);
  const docs = await sb.from("documents").delete().eq("user_id", userId);
  if (docs.error) console.warn(`  documents purge warning: ${docs.error.message}`);
  console.log(`[eval] reset done — next upload will re-process every fixture.`);
}

// ── Load golden questions ────────────────────────────────

async function loadGoldenQuestions(): Promise<GoldenQuestion[]> {
  let files: string[];
  try {
    files = await fs.readdir(GOLDEN_DIR);
  } catch {
    console.error(`[eval] No golden directory at ${GOLDEN_DIR}. Create it with at least one *.json question file.`);
    process.exit(1);
  }

  const all: GoldenQuestion[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const raw = await fs.readFile(path.join(GOLDEN_DIR, f), "utf-8");
    const parsed = JSON.parse(raw) as GoldenQuestion[];
    if (!Array.isArray(parsed)) {
      console.warn(`[eval] ${f}: expected an array of questions, got ${typeof parsed} — skipping`);
      continue;
    }
    all.push(...parsed);
  }
  return all;
}

// ── Fixture upload ───────────────────────────────────────

interface UploadedFixture {
  documentId: string;
  fileName: string;
}

async function uploadFixture(
  fixtureFile: string,
  userId: string
): Promise<UploadedFixture | null> {
  const fixturePath = path.join(FIXTURES_DIR, fixtureFile);
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(fixturePath);
  } catch {
    console.warn(`[eval] Fixture missing: ${fixturePath}`);
    return null;
  }

  // Reuse cached upload if a prior eval run already persisted this fixture
  // for the same eval user. Speeds up re-runs dramatically.
  const cached = await findDocumentByFileName(fixtureFile, userId);
  if (cached) {
    // Phase 1 cache-miss: documents persisted before the embedding pipeline
    // existed have pageTexts but no passages. Detect via has_passages and
    // backfill on the fly so v2 retrieval works on this eval run.
    if (
      isNarrativeType(cached.extraction.type) &&
      cached.extraction.pageTexts &&
      cached.extraction.pageTexts.length > 0
    ) {
      const { createServerSupabase } = await import("@/lib/supabase/server");
      const sb = createServerSupabase();
      const { data: docRow } = await sb
        .from("documents")
        .select("has_passages")
        .eq("id", cached.documentId)
        .maybeSingle();
      if (docRow?.has_passages !== true) {
        console.log(`[eval] cached fixture ${fixtureFile} not embedded yet — embedding now...`);
        try {
          const embedResult = await embedDocument({
            documentId: cached.documentId,
            userId,
            extraction: cached.extraction,
          });
          console.log(
            `         embedded: ${embedResult.passageCount} passages, ${embedResult.totalTokens} tokens, ${embedResult.durationMs}ms`
          );
        } catch (embedErr) {
          console.warn(
            `         embed failed (legacy query_document will serve this fixture): ${embedErr instanceof Error ? embedErr.message : embedErr}`
          );
        }
      }
    }
    return { documentId: cached.documentId, fileName: cached.fileName };
  }

  const mime = guessMime(fixtureFile);
  const documentId = randomUUID();
  console.log(`[eval] Uploading fixture: ${fixtureFile} (${(buffer.length / 1024).toFixed(1)} KB)`);
  const result = await universalParse({
    buffer,
    fileName: fixtureFile,
    mime,
    size: buffer.length,
    documentId,
  });

  await saveDocument({
    documentId,
    userId,
    sessionId: null,
    fileId: null,
    fileName: fixtureFile,
    extraction: result.extraction,
  });

  // Phase 1: embed narrative fixtures so the eval exercises query_document_v2.
  // Tabular fixtures are skipped — the embedding pipeline only handles
  // narrative content (pageTexts).
  if (
    isNarrativeType(result.classification.type) &&
    result.extraction.pageTexts &&
    result.extraction.pageTexts.length > 0
  ) {
    try {
      const embedResult = await embedDocument({
        documentId,
        userId,
        extraction: result.extraction,
      });
      console.log(
        `         embedded: ${embedResult.passageCount} passages, ${embedResult.totalTokens} tokens, ${embedResult.durationMs}ms`
      );
    } catch (embedErr) {
      console.warn(
        `         embed failed (legacy query_document will serve this fixture): ${embedErr instanceof Error ? embedErr.message : embedErr}`
      );
    }
  }

  return { documentId, fileName: fixtureFile };
}

function guessMime(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "csv") return "text/csv";
  if (ext === "xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === "xls") return "application/vnd.ms-excel";
  return "application/octet-stream";
}

// ── Per-question execution ───────────────────────────────

async function executeQuestion(
  q: GoldenQuestion,
  fixture: UploadedFixture,
  userId: string,
  evalRunId: string
): Promise<QuestionResult> {
  const startedMs = Date.now();
  // Capture the trace id outside withTrace so we can query cost by it after.
  const questionTraceId = randomUUID();
  try {
    // Phase 1: prefer RAG path (query_document_v2). Auto-fall-back to legacy
    // when the document hasn't been embedded yet — keeps the eval valid
    // during a partial backfill state.
    const result = await withTrace(
      {
        traceId: questionTraceId,
        userId,
        documentId: fixture.documentId,
        evalRunId,
        evalQuestionId: q.id,
      },
      async () => {
        try {
          return await runQueryDocumentV2({
            userId,
            fileName: fixture.fileName,
            question: q.question,
            focus: q.focus as EvalFocus | undefined,
          });
        } catch (err) {
          if (err instanceof FallbackToLegacyError) {
            console.log(
              `[eval] ${q.id}: v2 unavailable (${err.reason}), falling back to legacy`
            );
            return await runQueryDocument({
              userId,
              fileName: fixture.fileName,
              question: q.question,
              focus: q.focus as EvalFocus | undefined,
            });
          }
          throw err;
        }
      }
    );

    const elapsedMs = Date.now() - startedMs;
    const dr = result.documentResponse;
    // Both v1 and v2 expose `page` on citations (v1 as page?: number,
    // v2 as page: number | null). Both filter to numeric pages identically.
    const citationPages = (dr.citations ?? [])
      .map((c) => (c as { page?: number | null }).page)
      .filter((p): p is number => typeof p === "number");

    // Flush any fire-and-forget telemetry inserts before rolling up cost.
    await settlePendingWrites();
    const cost = await totalCostForTraceId(questionTraceId);

    // V2 responses expose reasoningMode + sub-question metadata; the
    // legacy path doesn't. Read defensively so the legacy fallback case
    // simply omits these fields.
    const v2Dr = dr as {
      reasoningMode?: "simple" | "complex";
      subQuestions?: string[];
      subAnswersCompleted?: number;
    };

    const { score, breakdown } = await scoreAnswer(
      q,
      dr.answer,
      citationPages,
      dr.confidence,
      elapsedMs,
      cost,
      {
        reasoningMode: v2Dr.reasoningMode,
        subQuestions: v2Dr.subQuestions,
        subAnswersCompleted: v2Dr.subAnswersCompleted,
      }
    );
    return {
      question: q,
      score,
      breakdown,
      answer: dr.answer,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return failedResult(q, message);
  }
}

// ── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCli(process.argv);
  if (!process.env.OPENAI_API_KEY) {
    console.error("[eval] OPENAI_API_KEY is not set in environment. Aborting.");
    process.exit(1);
  }

  let questions = await loadGoldenQuestions();
  if (questions.length === 0) {
    console.warn(`[eval] No questions loaded from ${GOLDEN_DIR}. See evals/golden/README.md.`);
    process.exit(0);
  }
  if (opts.category) questions = questions.filter((q) => q.category === opts.category);
  if (opts.id) questions = questions.filter((q) => q.id === opts.id);
  console.log(`[eval] ${questions.length} questions to run` + (opts.category ? ` (category=${opts.category})` : "") + (opts.id ? ` (id=${opts.id})` : ""));

  if (opts.reset) {
    await resetEvalUserData(opts.user);
  }

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const startedAt = new Date().toISOString();

  // Upload all unique fixtures up front.
  const uniqueFixtures = [...new Set(questions.map((q) => q.fixture))];
  const fixtureMap = new Map<string, UploadedFixture>();
  let skipped = 0;
  for (const f of uniqueFixtures) {
    const u = await uploadFixture(f, opts.user);
    if (u) fixtureMap.set(f, u);
  }

  const results: QuestionResult[] = [];
  for (const q of questions) {
    const fixture = fixtureMap.get(q.fixture);
    if (!fixture) {
      console.warn(`[eval] Skipping ${q.id} — fixture ${q.fixture} not available`);
      skipped++;
      continue;
    }
    console.log(`[eval] ${q.id} — ${q.question.slice(0, 70)}…`);
    const r = await executeQuestion(q, fixture, opts.user, runId);
    console.log(`        → score ${(r.score * 100).toFixed(0)}%${r.error ? ` (error: ${r.error})` : ""}`);
    results.push(r);
  }

  const finishedAt = new Date().toISOString();
  const summary = summarizeResults(results, runId, startedAt, finishedAt, questions.length, skipped);
  logQuickSummary(summary);
  const { mdPath, jsonPath } = await writeReport(summary, REPORTS_DIR);
  console.log(`[eval] Report written:`);
  console.log(`         markdown: ${mdPath}`);
  console.log(`         json:     ${jsonPath}`);
}

main().catch((err) => {
  console.error("[eval] Fatal:", err);
  process.exit(1);
});
