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

import { createServerSupabase } from "@/lib/supabase/server";
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
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[backfill] SUPABASE_SERVICE_ROLE_KEY is not set. Aborting.");
    process.exit(1);
  }

  const opts = parseCli(process.argv);
  const sb = createServerSupabase();

  let q = sb
    .from("documents")
    .select("id, user_id, type, extraction, has_passages")
    .order("created_at", { ascending: true });

  if (opts.user) q = q.eq("user_id", opts.user);
  if (opts.document) q = q.eq("id", opts.document);
  if (!opts.force) q = q.eq("has_passages", false);

  const { data, error } = await q;
  if (error) {
    console.error("[backfill] Failed to fetch documents:", error.message);
    process.exit(1);
  }
  if (!data || data.length === 0) {
    console.log("[backfill] No documents to embed.");
    return;
  }

  // Filter to narrative docs with pageTexts.
  type Row = {
    id: string;
    user_id: string;
    type: string;
    extraction: DocumentExtraction & { sourceFileName?: string };
    has_passages: boolean;
  };
  const rows = (data as Row[]).filter((r) => {
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
