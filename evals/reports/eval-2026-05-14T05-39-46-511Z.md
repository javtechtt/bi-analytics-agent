# Eval Run run-2026-05-14T05-39-46-511Z

- **Started**: 2026-05-14T05:39:46.511Z
- **Finished**: 2026-05-14T05:45:13.477Z
- **Total questions**: 29

## Aggregate

| Metric | Value |
|---|---|
| Overall accuracy | 88.9% |
| Judge accuracy | 95.9% |
| Contains pass rate | 69.0% |
| Excludes pass rate | 89.7% |
| Citation pass rate | 100.0% |
| p50 latency | 7.92s |
| p95 latency | 19.40s |
| Total cost | $0.2818 |
| Avg cost/question | $0.0097 |
| Complex routing rate | 27.6% |

## Per-question

| ID | Mode | Category | Score | Judge | Contains | Excludes | Citation | Latency | Cost |
|---|---|---|---|---|---|---|---|---|---|
| cmp-cs-overview-01 | simple | narrative-overview | 100% | 100% | ✓ | ✓ | ✓ | 8.93s | $0.0068 |
| cmp-cs-countries-01 | simple | narrative-parties | 63% | 70% | ✗ | ✓ | ✓ | 7.92s | $0.0064 |
| cmp-cs-overview-detail-01 | simple | narrative-scene-overview | 100% | 100% | ✓ | ✓ | ✓ | 9.14s | $0.0072 |
| cmp-cs-implied-01 | complex(2/2) | narrative-implied | 100% | 100% | ✓ | ✓ | ✓ | 16.23s | $0.0181 |
| cmp-cs-bait-01 | simple | narrative-hallucination-bait | 60% | 100% | ✗ | ✗ | ✓ | 4.73s | $0.0062 |
| verified-cs-overview-01 | complex(2/2) | narrative-overview | 100% | 100% | ✓ | ✓ | ✓ | 13.05s | $0.0180 |
| verified-cs-parties-01 | simple | narrative-parties | 100% | 100% | ✓ | ✓ | ✓ | 6.23s | $0.0078 |
| verified-cs-risks-01 | simple | narrative-risk | 100% | 100% | ✓ | ✓ | ✓ | 18.89s | $0.0087 |
| verified-cs-metrics-01 | complex(3/3) | narrative-metric | 100% | 100% | ✓ | ✓ | ✓ | 16.77s | $0.0271 |
| verified-cs-bait-01 | simple | narrative-hallucination-bait | 75% | 100% | ✗ | ✓ | ✓ | 4.40s | $0.0076 |
| msa-parties-01 | simple | narrative-parties | 100% | 100% | ✓ | ✓ | ✓ | 6.95s | $0.0060 |
| msa-dates-01 | complex(2/2) | narrative-dates | 100% | 100% | ✓ | ✓ | ✓ | 13.05s | $0.0143 |
| msa-obligations-01 | complex(2/2) | narrative-obligations | 100% | 100% | ✓ | ✓ | ✓ | 22.20s | $0.0184 |
| msa-risks-01 | complex(2/2) | narrative-risk | 100% | 100% | ✓ | ✓ | ✓ | 19.40s | $0.0196 |
| msa-termination-01 | simple | narrative-citation-precision | 100% | 100% | ✓ | ✓ | ✓ | 8.74s | $0.0063 |
| msa-bait-01 | simple | narrative-hallucination-bait | 75% | 100% | ✗ | ✓ | ✓ | 3.96s | $0.0054 |
| jpm-overview-01 | complex(2/2) | narrative-overview | 100% | 100% | ✓ | ✓ | ✓ | 10.51s | $0.0153 |
| jpm-metrics-01 | simple | narrative-metric | 58% | 70% | ✗ | ✓ | ✓ | 8.71s | $0.0069 |
| jpm-risks-01 | simple | narrative-risk | 100% | 100% | ✓ | ✓ | ✓ | 7.90s | $0.0059 |
| jpm-citation-01 | simple | narrative-citation-precision | 100% | 100% | ✓ | ✓ | ✓ | 5.94s | $0.0069 |
| jpm-bait-01 | simple | narrative-hallucination-bait | 60% | 100% | ✗ | ✗ | ✓ | 7.48s | $0.0067 |
| privacy-scope-01 | simple | narrative-overview | 100% | 100% | ✓ | ✓ | ✓ | 5.09s | $0.0054 |
| privacy-data-types-01 | simple | narrative-metric | 100% | 100% | ✓ | ✓ | ✓ | 6.46s | $0.0055 |
| privacy-rights-01 | simple | narrative-obligations | 100% | 100% | ✓ | ✓ | ✓ | 4.71s | $0.0053 |
| privacy-third-parties-01 | complex(3/3) | narrative-citation-precision | 100% | 100% | ✓ | ✓ | ✓ | 9.83s | $0.0163 |
| privacy-bait-01 | simple | narrative-hallucination-bait | 75% | 100% | ✗ | ✓ | ✓ | 2.69s | $0.0047 |
| scotia-overview-01 | simple | narrative-stress-test | 100% | 100% | ✓ | ✓ | ✓ | 8.95s | $0.0061 |
| scotia-metrics-01 | simple | narrative-stress-test | 51% | 40% | ✗ | ✓ | ✓ | 6.90s | $0.0068 |
| scotia-bait-01 | simple | narrative-hallucination-bait | 60% | 100% | ✗ | ✗ | ✓ | 5.63s | $0.0058 |

## Failures and low scorers (< 60%)

### jpm-metrics-01 — score 58%

**Question**: What was the reported net income or revenue figure for the period?
**Focus**: metrics

**Answer**: Net income for 2025 was $57.0 billion and revenue was $185.6 billion. Another passage reports total net revenue for 2025 as $182.4 billion, showing a slight discrepancy between figures.

**Judge**: 70% — The answer provides the net income figure correctly but has a minor discrepancy in the revenue figure compared to the expected content.
**Missing required substrings**: net income = $57; net revenue = $182

### scotia-metrics-01 — score 51%

**Question**: What were the key financial highlights for the year?
**Focus**: metrics

**Answer**: Net income was about $7.8 billion, down 2% from the previous year. Total revenue rose to about $37.7 billion, with net interest income at $21.5 billion and non-interest income at $16.2 billion. Higher non-interest expenses, income taxes, and provisions for credit losses contributed to the decline in…

**Judge**: 40% — The answer provides some financial figures but misses key expected content and does not fully address the question about key highlights.
**Missing required substrings**: 9.5; 9.7; 11.8; 13.2
