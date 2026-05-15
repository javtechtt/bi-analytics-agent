# Eval Fixtures

This directory holds the documents the eval runner uploads and queries. Files
here are **not** committed to git by default (they may contain proprietary
content); add them locally to run the eval suite.

## Required fixtures for the example golden set

The shipped `evals/golden/example.json` references one fixture:

- `case-studies.pdf` — a multi-page narrative PDF with at least 2 named
  companies and some risk/challenge language.

If you have the `verified_case_studies (2).pdf` that prompted this rebuild,
copy it here as `case-studies.pdf`:

```bash
cp ~/Downloads/"verified_case_studies (2).pdf" evals/fixtures/case-studies.pdf
```

## Adding your own fixtures

1. Drop a representative document into this directory.
2. Add questions referencing it in a new file under `evals/golden/<name>.json`.
3. Run `npm run eval -- --category=<your-category>` to score them.

## Supported file types in Phase 0

- `.pdf` (narrative documents — contracts, reports, memos, case studies)
- `.csv` (spreadsheets — for Phase 1 tabular eval coverage)
- `.xlsx` / `.xls`

Scanned PDFs without a text layer will fail to upload — OCR support lands in
Phase 4 (layout-aware parsing) of the rebuild plan.

## What questions to add

Aim for a balanced mix that exercises the system's weaknesses:

| Category | Why it matters | Target count |
|---|---|---|
| `narrative-overview` | Baseline "what's this doc about" | 2-3 |
| `narrative-parties` | Entity extraction stress | 2-3 |
| `narrative-risk` | Risk language detection | 2-3 |
| `narrative-metric` | Numeric extraction precision | 2-3 |
| `narrative-citation-precision` | Cite-the-right-sentence | 3-5 (high priority) |
| `narrative-hallucination-bait` | Questions whose answer isn't in the doc | 2-3 |
| `narrative-implied` | Implied claims spanning multiple sentences | 2-3 |
| `narrative-compare` | "Compare X to Y" multi-section synthesis | 2-3 |

A question is good if:
- The expected answer is unambiguous from the document.
- A bad answer is detectably bad (specific substrings the answer SHOULD or
  should NOT contain).
- For citation-precision: you know which page(s) hold the supporting text.

## Privacy

Fixtures may contain customer-confidential content. This `evals/fixtures/`
directory is gitignored by default. The `evals/golden/` and `evals/reports/`
directories ARE committed so question schemas and historical scores stay in
version control.
