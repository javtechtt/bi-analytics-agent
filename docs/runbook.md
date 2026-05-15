# Ops runbook

When something's wrong, work top-down: confirm the doc is parseable → confirm it's embedded → check what the query path did → look at cost/latency.

## Quick triage

A user complains a query is wrong / slow / silent. Get their document id and:

```
curl http://localhost:3000/api/debug/document/<id> | jq .
```

(Auth: must be logged in as the document's owner.) Returns: metadata, passage stats, recent tool_calls, LLM cost rollup by operation. Look for:

- `document.hasPassages === false` → query is routing to legacy `query_document`. Probably means embedding failed at upload. Check `document.error` and the parse-route logs.
- `passageStats.count === 0` but `hasPassages === true` → state mismatch; re-run backfill (`npm run backfill:embed -- --force`).
- `recentToolCalls[*].status === "error"` → look at `error` field. Common: OpenAI 429 (retry exhausted), OpenAI 5xx, timeout.
- `recentToolCalls[*].durationMs > 30000` → tool ran long. Look at `llmCostRollup` to see if vision/synth dominated.
- `llmCostRollup` shows `synthesize_answer` operations → the reasoning path ran. Look at `recentToolCalls[*].args` for the original question; if it shouldn't have decomposed, the planner is over-routing.

## Common issues

### "Query is silent for 30+ seconds"

Vision parsing on first upload runs synchronously in `/api/files/parse`. A 200-page PDF can chunk into multiple 80-page vision calls (~20-40s each). After that, retrieval queries are fast (~5-7s). If first-upload latency is the complaint, the answer is "vision is parsing." If second-query latency is the complaint, look at:

- `query_document_v2` tool_call. Was reasoning routed? Latency of 15-20s is normal for complex; 30s+ is a problem.
- `vision_pdf_to_markdown` calls in `llmCostRollup` — those shouldn't fire after upload. If they do, the doc was re-uploaded or backfill is in flight.

### "Answer doesn't match the document"

Three diagnostic steps:

1. **Check what passages retrieval pulled.** Inspect the document's passages via `/api/debug/document/<id>` — does the doc actually contain what was asked? If not, the user's question is unanswerable from this doc and the composer should have said "the document doesn't say".
2. **Check routing.** Look at the `Mode` column in the latest eval, or telemetry: was the question routed to simple or complex? If complex with bad sub-questions, the planner over-decomposed.
3. **Check the verifier.** A `caveat` containing "verifier flagged" means the LLM judge thought the answer wasn't supported. Confidence will have been downgraded.

### "Eval is producing different numbers run-to-run"

The judge (`gpt-4o-mini`) has run-to-run variance of ±3-4pt on a 29-question set. Two runs of identical code can produce judge accuracy of 92.4% and 95.9%. To get a stable read:

- Run 3x and average.
- Inspect the same per-question report and look for substantive answer changes, not score changes.
- For comparing phases, look at per-question deltas, not aggregates.

### "Cost is higher than expected"

Phase 6's complex path costs ~2× the simple path. If complex routing rate goes above 30%, total cost rises faster than accuracy. To tune:

- `OPENAI_REASONING_PLANNER_MODEL=gpt-4o-mini npm run eval` — swap planner to a cheaper, less aggressive classifier.
- Tighten the planner's prompt in [src/lib/reasoning/plan.ts](../src/lib/reasoning/plan.ts) — raise the bar for what counts as complex.

## Re-embedding documents

When the chunker, embedding model, or passages migration changes, existing docs need to be re-embedded:

```
npm run backfill:embed              # all narrative docs without passages
npm run backfill:embed -- --user=<id>
npm run backfill:embed -- --force   # re-embed even if has_passages=true
```

This deletes old passages for each doc and re-inserts. Cost: ~$0.01 per long doc.

## Environment knobs

All in `.env.local`:

| Var | Default | What it changes |
|---|---|---|
| `OPENAI_RAG_ANSWER_MODEL` | `gpt-4.1` | Hot-path composer model |
| `OPENAI_REASONING_MODEL` | `o4-mini` | Complex-path synthesis model |
| `OPENAI_REASONING_PLANNER_MODEL` | `gpt-4.1` | Question complexity classifier |
| `OPENAI_VERIFIER_MODEL` | `gpt-4o-mini` | LLM judge for answer correctness |
| `OPENAI_VISION_MODEL` | `gpt-4o` | PDF → Markdown vision parser |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model (1536-dim — DO NOT change without altering the passages table) |
| `PARSING_STRATEGY` | (auto) | Force `vision` or `text` for PDF parsing |

A/B-test a model swap with the eval:

```
OPENAI_RAG_ANSWER_MODEL=gpt-4.1-mini npm run eval -- --reset
```

## Retry behaviour

Every OpenAI call routes through `src/lib/openai/client.ts` with role-aware retry profiles. Defaults:

- `default` (composer, classifier, judge, reranker): 3 retries, 60s timeout
- `embedding`: 5 retries, 30s timeout (small payloads, retry aggressively)
- `vision`: 2 retries, 180s timeout (compounding retries blow latency)
- `reasoning`: 2 retries, 120s timeout
- `realtime`: 1 retry, 30s timeout (user-blocking, fail fast)

The OpenAI SDK does exponential backoff with jitter on 408/409/429/5xx automatically. No custom retry loop needed.

## Graceful degradation map

Every layer fails open or has a clear fallback:

| Layer | On failure |
|---|---|
| Vision parsing | Falls back to text-layer narrative adapter |
| Embedding (upload) | Caught at parse route; doc keeps `has_passages=false`; legacy v1 serves queries |
| Retrieval (empty) | Throws `FallbackToLegacyError`; tool route runs legacy `query_document` |
| Reranker | Catches; falls back to similarity-order top-K |
| Planner (Phase 6) | Catches; classifies as simple |
| Sub-questions | `Promise.allSettled`; drops failures, continues with rest |
| Orchestrator (all fail) | Caught in `query.ts`; falls back to simple path |
| Synthesis | Catches; returns highest-confidence sub-answer with caveat |
| Composer (no parsed content) | Returns "couldn't generate an answer right now" with low confidence |
| Verifier | Fails open with `supports: true`; answer passes through |
