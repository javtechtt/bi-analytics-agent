/**
 * Phase 1 backfill — embed existing narrative documents.
 *
 * Reads every documents row where:
 *   - type ∈ (report, memo, contract, policy, financial_statement,
 *             invoice, receipt, form)
 *   - has_passages = false
 *   - extraction.pageTexts is present
 *
 * Calls `embedDocument` for each one. On success the document flips
 * `has_passages = true` and starts routing through `query_document_v2`.
 *
 * Failures are logged and skipped — the legacy `query_document` path stays
 * valid for un-embedded docs.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/backfill/embed-documents.ts
 *   npx tsx --env-file=.env.local scripts/backfill/embed-documents.ts --user=<userId>
 *   npx tsx --env-file=.env.local scripts/backfill/embed-documents.ts --document=<documentId>
 *   npx tsx --env-file=.env.local scripts/backfill/embed-documents.ts --force   (re-embed already-embedded docs)
 */

import { getSql } from "@/lib/db";
import { embedDocument } from "@/lib/retrieval/embed";
import { isNarrativeType } from "@/lib/ingestion/classifier";
import type { DocumentExtraction } from "@/lib/documents/types";

interface CliOpts {
  user?: string;
  document?: string;
  force: boolean;
}

function parseCli(argv: string[]): CliOpts {
  const opts: CliOpts = { force: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--force") {
      opts.force = true;
      continue;
    }
    const m = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "user") opts.user = v;
    else if (k === "document") opts.document = v;
  }
  return opts;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("[backfill] OPENAI_API_KEY is not set. Aborting.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("[backfill] DATABASE_URL is not set. Aborting.");
    process.exit(1);
  }

  const opts = parseCli(process.argv);
  const sql = getSql();

  type Row = {
    id: string;
    user_id: string;
    type: string;
    extraction: DocumentExtraction & { sourceFileName?: string };
    has_passages: boolean;
  };

  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.user) { params.push(opts.user); conds.push(`user_id = $${params.length}`); }
  if (opts.document) { params.push(opts.document); conds.push(`id = $${params.length}`); }
  if (!opts.force) { params.push(false); conds.push(`has_passages = $${params.length}`); }
  const where = conds.length ? `where ${conds.join(" and ")}` : "";

  let data: Row[];
  try {
    data = (await sql.query(
      `select id, user_id, type, extraction, has_passages from documents ${where} order by created_at asc`,
      params
    )) as Row[];
  } catch (err) {
    console.error("[backfill] Failed to fetch documents:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.log("[backfill] No documents to embed.");
    return;
  }

  // Filter to narrative docs with pageTexts.
  const rows = data.filter((r) => {
    if (!isNarrativeType(r.type as Parameters<typeof isNarrativeType>[0])) return false;
    const pageTexts = r.extraction?.pageTexts;
    return Array.isArray(pageTexts) && pageTexts.length > 0;
  });

  console.log(
    `[backfill] ${rows.length} narrative document(s) to embed (force=${opts.force})` +
      (opts.user ? `, user=${opts.user}` : "") +
      (opts.document ? `, document=${opts.document}` : "")
  );

  let succeeded = 0;
  let failed = 0;
  let totalPassages = 0;

  for (const row of rows) {
    const name = row.extraction.sourceFileName ?? row.id;
    console.log(`[backfill] embedding ${name} (id=${row.id}, type=${row.type})…`);
    try {
      const result = await embedDocument({
        documentId: row.id,
        userId: row.user_id,
        extraction: row.extraction,
      });
      succeeded++;
      totalPassages += result.passageCount;
      console.log(
        `  → ${result.passageCount} passages, ${result.totalTokens} tokens, ${result.durationMs}ms`
      );
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : "unknown";
      console.warn(`  ✗ failed: ${msg}`);
    }
  }

  console.log("");
  console.log(`[backfill] Done. succeeded=${succeeded} failed=${failed} totalPassages=${totalPassages}`);
}

main().catch((err) => {
  console.error("[backfill] Fatal:", err);
  process.exit(1);
});
