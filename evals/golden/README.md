# Golden Eval Questions

One JSON file per fixture (loose convention — the runner concatenates all `*.json` files). Each file is an array of `GoldenQuestion` objects scored against the live system by `npm run eval`.

## Question schema

See `scripts/eval/types.ts:GoldenQuestion` for the full TypeScript definition. Key fields:

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Unique across all files, e.g. `msa-parties-01`. |
| `fixture` | yes | Filename in `evals/fixtures/`. Missing fixtures cause the question to be skipped (not failed). |
| `tool` | yes | `query_document` or `compose_visual_scene`. |
| `category` | yes | Free text — used for filtering (`npm run eval -- --category=narrative-risk`) and reporting. |
| `question` | yes | The natural-language question. |
| `focus` | no | One of `general`, `risks`, `parties`, `dates`, `metrics`, `obligations`. |
| `expectedAnswerContains` | no | Substrings the answer SHOULD contain (case-insensitive). All required. |
| `expectedAnswerExcludes` | no | Substrings the answer should NOT contain. Hallucination traps. |
| `expectedCitationPages` | no | Pages cited should overlap with at least one of these. |
| `expectedMinConfidence` | no | Tool's reported confidence must be ≥ this (`low`/`medium`/`high`). |
| `maxLatencyMs` | no | Soft budget. Latency reported but doesn't dock score. |
| `maxCostUsd` | no | Soft budget. |

## Scoring weights

| Component | Weight |
|---|---|
| LLM judge (vs `expectedAnswerContains` hints) | 40% |
| Contains substrings present | 25% |
| Excludes substrings absent | 15% |
| Citation page overlap | 15% |
| Confidence meets minimum | 5% |

## Phase 0 scope: narrative tools only

The runner currently evaluates `query_document` and `compose_visual_scene`. **Tabular tools** (`profile_dataset`, `run_analysis`, `create_chart`, `generate_dashboard`, `compare_files`, `recommend_actions`) are NOT yet wired into the runner. They will be added in Phase 1 alongside the RAG work so we have proper regression coverage when the new retrieval path lands.

Fixtures that currently have NO golden questions because they target tabular tools:

- `Products.xlsx`
- `f-balance-sheet.csv`
- `ind_nifty50list.csv`
- `liquidweb-woocommerce-product-sample-data.csv`
- `online-tech-store-3yr-sales-report.csv`
- `online-tech-store-3yr-sales-summary.pdf` (table-PDF — would route to tabular adapter)
- `store-space-sales.csv`

These will get question files when the eval runner expands in Phase 1.

## Filling in `expectedAnswerContains`

The scaffolded files leave most `expectedAnswerContains` arrays EMPTY because I don't know the document content. The LLM judge still scores answer quality without them — but adding 2-3 specific substrings dramatically tightens the signal:

- For "Who are the parties?": add the actual party names you find.
- For "What was revenue?": add the dollar figure or "X million".
- For "What's the termination clause?": add a key phrase from the actual clause.

Edit a JSON, save, re-run `npm run eval --id=<your-question-id>` to score just that one.

## How to author a question well

Three principles:

1. **The right answer is unambiguous from the document.** Don't ask things the doc doesn't actually say.
2. **A wrong answer is mechanically detectable.** Use `expectedAnswerContains` for specific phrases, `expectedAnswerExcludes` to trap common hallucinations.
3. **Citation tests need page numbers you've verified.** Open the PDF, find the actual page where the answer lives, put it in `expectedCitationPages`.

For hallucination-bait questions, ask something the doc CAN'T answer and require the answer contain refusal phrases ("doesn't say", "not mentioned", "no information") and exclude assertive forms ("the document says", dollar signs, named entities not in the doc).
