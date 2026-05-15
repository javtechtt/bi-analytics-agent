@AGENTS.md

# BI Analytics Agent — Project Context

## Product Vision
Voice-first AI business intelligence analyst. User speaks; assistant analyzes spreadsheets AND narrative business documents (contracts, reports, policies, case studies), shows visual scenes, and guides decisions — all through natural conversation. The assistant IS the product. Not a dashboard tool with AI bolted on.

## Current State (after Phase 6 + Polish)
Frontier-quality narrative Q&A via retrieval-augmented generation with multi-step reasoning for compare/synthesis questions. Judge accuracy on a 29-question golden eval = **95.9%** (vs. 66% pre-rebuild baseline). Layout-heavy PDFs handled by chunked vision pipeline. Complex questions decompose into sub-questions, retrieve in parallel, and synthesize with `o4-mini`. Answers verified by an LLM judge before return. Prompt-injection hardened against malicious uploads. Centralized OpenAI client with role-aware retries.

| Phase | Status | What it shipped |
|---|---|---|
| 0 — Eval + telemetry | ✓ | Golden eval set, scoring harness, `tool_calls` + `llm_calls` tables, cost rollup |
| 1 — RAG foundation | ✓ | pgvector + `passages` table, semantic chunker, embeddings, retrieval, reranker, `query_document_v2`, routing guard |
| 2 — Vision adapter (small) | ✓ | Strategy router, GPT-4o vision via OpenAI Files API, Markdown-aware chunker |
| Mini 3 — Model config | ✓ | `src/lib/models.ts` — env-overridable model selection per role |
| 4 — Chunked vision (big PDFs) | ✓ | `pdf-lib` page splitter, parallel chunk vision, Markdown stitching with absolute page markers |
| 5 — Verifier + injection hardening | ✓ | `verifyAnswer` LLM-judge post-composition + prompt-injection detector + defensive composer framing + threat model docs |
| 6 — Multi-step reasoning | ✓ | Planner (`gpt-4.1`) classifies simple/complex; orchestrator fans out sub-questions in parallel; `o4-mini` synthesis; 27.6% complex routing rate observed |
| Polish | ✓ | Centralized OpenAI client (`src/lib/openai/client.ts`) with role-aware retry/timeout profiles; `/api/debug/document/[id]` debug endpoint; graceful degradation audit |

## Tech Stack
- Next.js 16.2.3 (Turbopack) + TypeScript + Tailwind v4 + React 19
- OpenAI Realtime API (`gpt-realtime-1.5`) via WebRTC for voice; OpenAI Files API + chat completions for PDF vision; OpenAI Embeddings for RAG
- Supabase Postgres + `pgvector` extension (HNSW index, cosine distance)
- Clerk for auth
- Recharts for charts, html-to-image for PNG export
- `unpdf` for text-layer PDF extraction; `pdf-lib` for PDF page splitting (Phase 4)
- `zod` for structured output validation
- `tsx` for running TS scripts (eval, backfill)

## Model Stack (env-overridable via `src/lib/models.ts`)

| Role | Default model | Notes |
|---|---|---|
| `ragAnswer` | `gpt-4.1` | The hot path — composes answer over retrieved passages |
| `vision` | `gpt-4o` | PDF → Markdown via OpenAI Files API |
| `embedding` | `text-embedding-3-small` (1536-dim) | Dim wired into `passages.embedding vector(N)` |
| `classifier` | `gpt-4o-mini` | Tier 2 document type refinement |
| `verifier` | `gpt-4o-mini` | Phase 5 LLM-as-judge on composed answers |
| `reranker` | `gpt-4o-mini` | Structured-output reranker (top-K → top-N) |
| `judge` | `gpt-4o-mini` | Eval scoring only |
| `reasoning` | `o4-mini` | Phase 6 — final synthesis on complex (decomposed) questions |
| `reasoningPlanner` | `gpt-4.1` | Phase 6 — classifies simple/complex + decomposes into sub-questions |
| Voice | `gpt-realtime-1.5` | Separate config in `realtime/session/route.ts` |

A/B test via env: `OPENAI_RAG_ANSWER_MODEL=o4-mini npm run eval -- --reset`

## Architecture

### Layers
```
src/
├── app/
│   ├── (app)/page.tsx                    ← Main page, renders SceneStage
│   └── api/
│       ├── realtime/session/route.ts     ← System prompt + ephemeral token (10 tools)
│       ├── files/parse/route.ts          ← Upload → universalParse → saveDocument → embed
│       ├── tools/execute/route.ts        ← Dispatch for all 10 tools, telemetry + guard
│       └── workspace/*                   ← Session/file persistence
├── components/
│   ├── VoiceOrb.tsx, Starfield.tsx       ← Visual chrome
│   ├── ChartOverlay.tsx, KpiCards.tsx    ← Reusable fragments (used by SceneStage)
│   ├── ChartStage.tsx, DashboardView.tsx ← LEGACY (kept for compat, not rendered)
│   └── scenes/
│       ├── SceneStage.tsx                ← Phase 3 — unified visual surface
│       └── fragments/                    ← 9 fragment renderers (chart, kpi, table, summary,
│                                            risk_panel, timeline, entity_card, doc_preview, callout)
└── lib/
    ├── models.ts                         ← Central model config (Mini Phase 3)
    ├── tools.ts                          ← 10 tool definitions
    ├── types.ts                          ← UploadedFile, ParsedData, Message, etc.
    ├── useRealtimeSession.ts             ← WebRTC hook + tool result → scene bridge
    ├── documents/
    │   ├── types.ts                      ← DocumentExtraction, Fact, Entity, SourceSpan, etc.
    │   └── store.ts                      ← Persistence + cache (find by filename, save, update)
    ├── ingestion/
    │   ├── universal-parser.ts           ← classify → adapter → narrative pivot
    │   ├── classifier.ts                 ← Tier 1 heuristic + Tier 2 LLM
    │   ├── strategies.ts                 ← Phase 2 — text-layer vs vision router
    │   ├── pdf-split.ts                  ← Phase 4 — pdf-lib N-page splitter
    │   └── adapters/
    │       ├── tabular.ts                ← CSV/Excel/PDF-table (Phase 1 from rebuild plan)
    │       ├── narrative.ts              ← Text-layer narrative PDF (Phase 2 from rebuild plan)
    │       └── vision-pdf.ts             ← Phase 2/4 — single-call + chunked vision via OpenAI
    ├── retrieval/                        ← Phase 1 — RAG
    │   ├── chunker.ts                    ← Semantic, Markdown-aware, paragraph-preserving
    │   ├── embed.ts                      ← Batched text-embedding-3-small, embedDocument()
    │   ├── retrieve.ts                   ← pgvector cosine RPC, formatPassagesForPrompt
    │   ├── rerank.ts                     ← gpt-4o-mini structured-output reranker
    │   ├── answer.ts                     ← composeAnswerFromPassages — the gpt-4.1 hot path
    │   └── query.ts                      ← Orchestrator: plan → (simple or complex) → verify
    ├── reasoning/                        ← Phase 6 — multi-step reasoning
    │   ├── plan.ts                       ← gpt-4.1 planner: simple|complex + decomposition into sub-questions (max 4)
    │   └── orchestrator.ts               ← Parallel sub-question fan-out + o4-mini synthesis with sub-answer fallback
    ├── extraction/                       ← Phase 2 legacy v1 (kept for un-embedded docs)
    │   ├── extractor.ts, composer.ts, validators.ts, reconciler.ts, schemas.ts
    │   ├── query.ts                      ← Legacy fact-graph orchestrator (runQueryDocument)
    │   └── verifier.ts                   ← Phase 5 — LLM-as-judge on RAG answers
    ├── security/
    │   └── injection-detector.ts         ← Phase 5 — pattern scanner over retrieved passages
    ├── planner/
    │   └── guard.ts                      ← Phase 1 — heuristic tool/file-type compatibility check
    ├── openai/
    │   └── client.ts                     ← Polish — role-aware factory: default/embedding/vision/reasoning/realtime with retry+timeout profiles
    ├── visual/                           ← Phase 3 — scene composition
    │   ├── scene-types.ts                ← VisualScene, VisualFragment, all prop types
    │   ├── fragments.ts                  ← Fragment factory functions
    │   ├── composer.ts                   ← Rules engine — composeScene + composeSceneFromPassages
    │   └── store.ts                      ← Optional Supabase persistence for scenes
    ├── telemetry/
    │   ├── cost.ts                       ← Per-model pricing table + cost computation
    │   └── trace.ts                      ← AsyncLocalStorage trace context, recordLlmCall, instrumented()
    └── supabase/
        ├── server.ts                     ← Service-role client
        └── types.ts                      ← Db* row types + mappers

evals/
├── golden/*.json                         ← 29 questions across 6 fixtures (narrative-only in v1)
├── fixtures/                             ← Gitignored — local copies of test docs
└── reports/                              ← Markdown + JSON eval outputs

scripts/
├── eval/                                 ← run.ts (orchestrator) + score.ts + report.ts + types.ts
└── backfill/embed-documents.ts           ← One-shot: embed all narrative docs that lack passages

supabase/migrations/
├── 0001_phase1_documents.sql             ← documents table (rebuild plan Phase 1)
├── 0002_phase3_scenes.sql                ← scenes table (rebuild plan Phase 3)
├── 0003_phase0_telemetry.sql             ← tool_calls + llm_calls (eval rebuild plan Phase 0)
└── 0004_phase1_passages.sql              ← pgvector + passages + match_passages RPC (Phase 1)
```

### 10 Tools (registered with OpenAI)
1. `list_uploaded_files` — client-side, returns file names/sizes/status
2. `profile_dataset` — TABULAR. Column stats + sample rows + confidence
3. `run_analysis` — TABULAR. filter/group_by/sort/top_n with coverage reporting
4. `create_chart` — TABULAR. Backend builds chart data from metric+group_by+split_by
5. `recommend_actions` — TABULAR. Data-grounded projections + strategies
6. `compare_files` — TABULAR. Multi-file KPI comparison + overlaid charts
7. `generate_dashboard` — TABULAR. Auto-selects KPIs + charts + insights + risks
8. `query_document_v2` — **NARRATIVE, RAG** (Phase 1). Preferred when `has_passages=true`. Retrieves passages, reranks, composes with gpt-4.1, verifies with gpt-4o-mini.
9. `query_document` — NARRATIVE LEGACY (fallback). Eager schema-guided extraction. Used when document hasn't been embedded yet.
10. `compose_visual_scene` — NARRATIVE. Composes a full scene by intent (overview/risk/timeline/metric/parties/obligations). Routes through v2 internally.

### Data Flow

#### Upload (narrative document)
```
PDF upload → /api/files/parse
  → universalParse (classify → adapter)
      → tabular adapter tries first
      → if no tables found, narrative pivot:
          → strategies.decidePdfStrategy → "text" or "vision"
          → runNarrativeAdapter (text-layer) OR runVisionPdfAdapter (single-call or chunked)
          → classifyDocumentLLM (Tier 2 refinement; non-tabular only)
  → saveDocument (Supabase)
  → if pageTexts present: embedDocument
      → semanticChunk → text-embedding-3-small → insert passages
      → flip documents.has_passages = true
  → return {documentId, hasPassages, extraction (stripped of server-only pageTexts)}
```

#### Query (voice agent asks question)
```
sendFileContext injects has_passages flag → realtime agent picks tool
→ query_document_v2 invoked with file_name + question + focus
→ tools/execute/route.ts opens trace + tool_call
  → routing guard checks file-type match
  → runQueryDocumentV2:
      → findDocumentByFileName
      → planQuestionComplexity (Phase 6, gpt-4.1) — simple or complex?
      ├─ SIMPLE (~72%):
      │     → retrievePassages (embed query → pgvector RPC → top-12)
      │     → rerankPassages (gpt-4o-mini → top-6)
      │     → composeAnswerFromPassages (gpt-4.1 + injection-aware framing)
      └─ COMPLEX (~28%):
            → for each of N sub-questions in parallel (Promise.allSettled):
            │     retrieve top-10 → rerank top-5 → compose (no verifier on sub-answers)
            → synthesizeFinalAnswer (o4-mini) over union of passages + sub-answers
            (if all sub-questions fail OR synthesis errors → fall back to SIMPLE)
      → verifyAnswer (gpt-4o-mini judge → maybe downgrade confidence; never re-runs composition)
  → return {result (spoken text), documentResponse (answer + passages + citations + confidence + reasoningMode + subQuestions?)}
→ useRealtimeSession bridges result → scene via composeSceneFromPassages
→ SceneStage renders the scene
→ Voice agent reads `result` aloud
```

## Key Design Decisions

- **RAG, not eager extraction.** Phase 1 replaced the schema-guided fact-graph approach with retrieval over real passages. The legacy `query_document` path stays alive as fallback for docs without `has_passages=true`.
- **Capability-based feature flag.** `has_passages` is what routes the agent between v2 and legacy — NOT the document type. A doc with vision-extracted Markdown but Tier-2-reclassified-as-tabular still gets v2 because pageTexts exist.
- **Vision via OpenAI Files API, not PDF.js rendering.** No node-canvas / worker foot-gun. Big docs (>80 pages) get split via `pdf-lib` into chunks, parallel vision calls (concurrency=3), Markdown stitched with absolute page markers.
- **Verifier downgrade, not retry.** Phase 5's verifier flags answers that don't follow from citations. We downgrade confidence + append caveat rather than retrying composition — keeps latency low; correction loops are Phase 6 territory.
- **Defense-in-depth on prompt injection.** (1) Detector scans retrieved passages for ~25 instruction patterns. (2) System role never templated with doc content. (3) Defensive framing in user message when detector triggers. (4) Always-on Rule #7 in composer system prompt. (5) Verifier catches subtle hallucinations. See [docs/security.md](docs/security.md).
- **No backwards-compatibility cruft.** When a phase replaces a path (e.g. SceneStage vs ChartStage), the old code stays on disk but isn't imported. Phase 9 polish will delete dead code.
- **Telemetry is non-blocking.** `recordLlmCall` fires and forgets; eval runner calls `settlePendingWrites()` to flush before querying rollups. Production never waits on a telemetry insert.
- **Trace propagation via `AsyncLocalStorage`.** Every LLM call inside a tool invocation inherits the trace_id without manual threading. See `src/lib/telemetry/trace.ts:withTrace`.

## System Prompt (`realtime/session/route.ts`)
12 numbered sections + tool routing table + mode-specific lenses (Executive/Analyst/Sales/Operations). Key routing rule from Section 4:

| Document type | Tool |
|---|---|
| spreadsheet, table_pdf | `profile_dataset` → tabular tools |
| narrative + `has_passages=true` | `query_document_v2` (RAG) |
| narrative + `has_passages=false` | `query_document` (legacy fallback) |

## Eval System

```bash
npm run eval                # run all golden questions, score, write report
npm run eval -- --reset     # purge cached docs first (use after parsing-strategy changes)
npm run eval -- --category=narrative-risk   # filter
npm run eval -- --id=msa-parties-01         # single question
```

- Question schema: `scripts/eval/types.ts:GoldenQuestion`
- Score weighting: 40% judge + 25% contains + 15% excludes + 15% citation + 5% confidence
- Reports written to `evals/reports/eval-<timestamp>.{md,json}` plus a `latest.{md,json}` copy
- Fixtures gitignored (may contain proprietary content)
- Honest baselines:
  - Phase 0 (broken): 66% judge
  - Phase 1 (RAG online): 93.8% judge
  - Phase 2 (small-PDF vision): 95.9% judge
  - Phase 4 (chunked vision for big PDFs): 94.8% judge (similar — gain offset by judge variance)
  - Phase 5 target: ≥94% judge + higher excludes pass rate + verifier telemetry visible

## Known Patterns / Gotchas

### From the rebuild
- **Chunk filenames must end in `.pdf`** for OpenAI Files API MIME detection. Phase 4 bug: appending `#p1-80` put `.pdf` in the middle and MIME came back `None`. Fix: `${base}_p${start}-${end}.pdf`.
- **Vision returning 0 pages throws** so universal-parser falls back to text-layer narrative. Prevents persisting empty `vision-ocr` extractions that then silently skip embedding.
- **Tier 2 classifier sometimes reclassifies vision Markdown as `table_pdf`** because the structured output looks tabular. Universal-parser ignores that downgrade and keeps `type=report` when vision/narrative already extracted content.
- **`PARSING_STRATEGY=vision|text|auto`** env override forces the strategy router's decision for testing.
- **OpenAI's PDF file input has a ~256k token ceiling.** Phase 4 chunks at 80 pages per chunk (~120k tokens — safe margin).

### From original system (still relevant)
- `resolveFile()` in useRealtimeSession.ts auto-picks latest file if model omits file_name
- `resolveColumn()` in tools/execute/route.ts does exact → case-insensitive → partial → reverse partial → semantic alias matching
- Rate limit: 30 calls/minute on /api/tools/execute
- Long-running tools (`query_document_v2`, `query_document`, `compose_visual_scene`): 120s server timeout, 135s client fetch budget
- Dataset cache (5 min TTL) + aggregation cache + profile cache in `tools/execute/route.ts`
- File-content sanitization: never include raw doc text in realtime context; metadata only

## Backfill / Migration Workflow

```bash
# Apply new migrations in Supabase SQL editor (in order):
#   0001_phase1_documents.sql
#   0002_phase3_scenes.sql
#   0003_phase0_telemetry.sql
#   0004_phase1_passages.sql

# After 0004, embed any existing narrative documents that pre-date the RAG rollout:
npm run backfill:embed                 # all narrative docs without passages
npm run backfill:embed -- --user=<id>  # scope to a user
npm run backfill:embed -- --force      # re-embed already-embedded docs
```

## Security Model
See [docs/security.md](docs/security.md). Five layers against prompt injection: pattern detector → role isolation → defensive framing → always-on system rule → verifier as final check. Cross-user isolation via Supabase RLS (service-role API + manual `user_id` filtering at every query, anon key denied at table level).

## What's NOT Implemented Yet
- **Per-user cost budgets**: dollar caps + enforcement. Skipped because this is a personal project — easy to add via a `budgets/check.ts` helper called from `tools/execute/route.ts` if needed.
- **Coreference / entity resolution across passages** (was in original audit Phase 5; deferred — judge accuracy already high enough)
- **Streaming SSE for tool progress** (audit Phase 7; voice agent currently silent during 5-60s vision parses)
- **Visual scene reload across sessions** (audit Phase 4; scenes are in-memory only)
- **Persistent ~5pt failures** ([cmp-cs-countries-01](evals/golden/), [scotia-metrics-01](evals/golden/), [jpm-metrics-01](evals/golden/)) — all simple-path failures, not Phase 6 regressions. Likely fixable by widening retrieval K for enumeration/summary questions and softening Rule 5 (surface conflicts) in [src/lib/retrieval/answer.ts](src/lib/retrieval/answer.ts).
