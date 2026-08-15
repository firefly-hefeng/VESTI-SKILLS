# Large MCP file-search benchmark

- Dataset: `vesti-file-search-large-v2` (72 paired cases, 2 warm-ups + 10 timed repeats per arm)
- Chain: synthetic SQLite/FTS → built VESTI-APP MCP → SDK in-memory JSON-RPC → tool result
- APP MCP dist artifact SHA-256: `0e67c5c13c4ca48b680a06756b49f47ed6df96575cdef6e61eebfd200d25ca2f`
- Primary endpoint: paired task success at Top 5
- Important boundary: this measures the retrieval/tool chain, not the independent effect of SKILL.md instructions.

## Overall results

| Arm | Scored N | Task success | Hit@1 | Hit@3 | Recall@5 | All targets@5 | Project | Evidence | Calls | Visible bytes | Latency ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| legacy | 66 | 81.8% | 80.0% | 80.0% | 80.0% | 80.0% | 80.0% | 80.0% | 11.0 | 12317 | 7.9 |
| search-files | 66 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 1.0 | 4318 | 5.5 |

## Paired primary result

- Treatment minus legacy task-success delta: **18.2%** (concept-cluster bootstrap 95% CI 17.4% to 19.0%; 12 independent concept clusters).
- Discordant pairs: treatment-only success 12; legacy-only success 0; both success 54; both fail 0.
- Case-level exact McNemar two-sided p-value: 0.0005 (descriptive only because tasks share concept clusters).
- 6 hard-negative pairs are excluded only from the primary quality endpoint; they remain in pressure and runtime summaries.

## Results by category

| Stratum | Arm | N | Task success | Hit@3 | Recall@5 | Negative FP | Calls | Visible bytes |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| cross-project | legacy | 12 | 100.0% | 100.0% | 100.0% | n/a | 11.0 | 12137 |
| cross-project | search-files | 12 | 100.0% | 100.0% | 100.0% | n/a | 1.0 | 4304 |
| filename-only | legacy | 12 | 0.0% | 0.0% | 0.0% | n/a | 11.0 | 14735 |
| filename-only | search-files | 12 | 100.0% | 100.0% | 100.0% | n/a | 1.0 | 4392 |
| multi-file | legacy | 12 | 100.0% | 100.0% | 100.0% | n/a | 11.0 | 13107 |
| multi-file | search-files | 12 | 100.0% | 100.0% | 100.0% | n/a | 1.0 | 4338 |
| negative-clean | legacy | 6 | 100.0% | n/a | n/a | 0.0% | 1.0 | 68 |
| negative-clean | search-files | 6 | 100.0% | n/a | n/a | 0.0% | 1.0 | 68 |
| negative-hard | legacy | 6 | n/a | n/a | n/a | 100.0% | 11.0 | 11687 |
| negative-hard | search-files | 6 | n/a | n/a | n/a | 100.0% | 1.0 | 3740 |
| semantic-single | legacy | 12 | 100.0% | 100.0% | 100.0% | n/a | 11.0 | 12598 |
| semantic-single | search-files | 12 | 100.0% | 100.0% | 100.0% | n/a | 1.0 | 4314 |
| stale-path | legacy | 12 | 100.0% | 100.0% | 100.0% | n/a | 11.0 | 12057 |
| stale-path | search-files | 12 | 100.0% | 100.0% | 100.0% | n/a | 1.0 | 4361 |

## Treatment failures for review

No treatment failures in this run.

## Interpretation limits

- The corpus is synthetic and inspectable. It is useful for regression and engineering comparisons, not a production-user effect claim.
- `provisional-holdout` is visible in source and is therefore not a true hidden holdout.
- Stale-path cases score historical retrieval only. Current filesystem verification requires the later Agent experiment.
- Timing uses in-process MCP transport; it excludes model latency, filesystem reads and a real stdio/network framing layer. It is descriptive, not a product-level latency claim.
