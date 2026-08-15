# Large MCP file-search benchmark

- Dataset: `vesti-file-search-large-v1` (72 paired cases, 2 warm-ups + 10 timed repeats per arm)
- Chain: synthetic SQLite/FTS → built VESTI-APP MCP → SDK in-memory JSON-RPC → tool result
- APP MCP dist artifact SHA-256: `8532a1358d5dbdaefe3c5776d5d17c5498bd2afa3213197f17ce32e36272296f`
- Primary endpoint: paired task success at Top 5
- Important boundary: this measures the retrieval/tool chain, not the independent effect of SKILL.md instructions.

## Overall results

| Arm | Scored N | Task success | Hit@1 | Hit@3 | Recall@5 | All targets@5 | Project | Evidence | Calls | Visible bytes | Latency ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| legacy | 66 | 51.5% | 26.7% | 43.3% | 46.7% | 46.7% | 46.7% | 46.7% | 7.0 | 6217 | 5.4 |
| search-files | 66 | 57.6% | 18.3% | 45.0% | 54.6% | 53.3% | 54.6% | 54.6% | 1.0 | 1978 | 2.9 |

## Paired primary result

- Treatment minus legacy task-success delta: **6.1%** (concept-cluster bootstrap 95% CI -8.7% to 17.9%; 12 independent concept clusters).
- Discordant pairs: treatment-only success 11; legacy-only success 7; both success 27; both fail 21.
- Case-level exact McNemar two-sided p-value: 0.4807 (descriptive only because tasks share concept clusters).
- 6 hard-negative pairs are excluded only from the primary quality endpoint; they remain in pressure and runtime summaries.

## Results by category

| Stratum | Arm | N | Task success | Hit@3 | Recall@5 | Negative FP | Calls | Visible bytes |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| cross-project | legacy | 12 | 41.7% | 41.7% | 41.7% | n/a | 11.0 | 10806 |
| cross-project | search-files | 12 | 41.7% | 33.3% | 41.7% | n/a | 1.0 | 3477 |
| filename-only | legacy | 12 | 0.0% | 0.0% | 0.0% | n/a | 1.0 | 67 |
| filename-only | search-files | 12 | 91.7% | 66.7% | 91.7% | n/a | 1.0 | 491 |
| multi-file | legacy | 12 | 58.3% | 58.3% | 58.3% | n/a | 11.0 | 12856 |
| multi-file | search-files | 12 | 33.3% | 33.3% | 39.6% | n/a | 1.0 | 4243 |
| negative-clean | legacy | 6 | 100.0% | n/a | n/a | 0.0% | 1.0 | 68 |
| negative-clean | search-files | 6 | 100.0% | n/a | n/a | 0.0% | 1.0 | 68 |
| negative-hard | legacy | 6 | n/a | n/a | n/a | 66.7% | 11.0 | 11195 |
| negative-hard | search-files | 6 | n/a | n/a | n/a | 83.3% | 1.0 | 3839 |
| semantic-single | legacy | 12 | 66.7% | 50.0% | 66.7% | n/a | 11.0 | 12597 |
| semantic-single | search-files | 12 | 50.0% | 41.7% | 50.0% | n/a | 1.0 | 4290 |
| stale-path | legacy | 12 | 66.7% | 66.7% | 66.7% | n/a | 11.0 | 12071 |
| stale-path | search-files | 12 | 50.0% | 50.0% | 50.0% | n/a | 1.0 | 4270 |

## Treatment failures for review

- `semantic-02` (semantic-single): (no result)
- `multi-02` (multi-file): (no result)
- `cross-02` (cross-project): (no result)
- `stale-02` (stale-path): (no result)
- `multi-04` (multi-file): `src/decoys/d4/migrationRegistry.ts`, `src/modules/f04/migrationRegistry.ts`, `src/modules/m04/DahliaM1.ts`
- `semantic-05` (semantic-single): `src/ui/代理Panel.tsx`
- `multi-05` (multi-file): `src/ui/代理Panel.tsx`
- `cross-05` (cross-project): `src/ui/代理Panel.tsx`
- `semantic-06` (semantic-single): `src/noise/dashboard/note1.md`, `src/noise/dashboard/note2.md`, `src/noise/dashboard/note3.md`
- `multi-06` (multi-file): `src/noise/dashboard/note1.md`, `src/noise/dashboard/note2.md`, `src/noise/dashboard/note3.md`
- `cross-06` (cross-project): `src/noise/dashboard/note1.md`, `src/noise/dashboard/note2.md`, `src/noise/dashboard/note3.md`
- `stale-06` (stale-path): `src/noise/dashboard/note1.md`, `src/noise/dashboard/note2.md`, `src/noise/dashboard/note3.md`
- `multi-07` (multi-file): `src/ui/向量Panel.tsx`
- `cross-07` (cross-project): `src/ui/向量Panel.tsx`
- `stale-07` (stale-path): `src/ui/向量Panel.tsx`
- `semantic-09` (semantic-single): `src/ui/导出Panel.tsx`
- `multi-09` (multi-file): `src/ui/导出Panel.tsx`
- `cross-09` (cross-project): `src/ui/导出Panel.tsx`
- `stale-09` (stale-path): `src/ui/导出Panel.tsx`
- `semantic-11` (semantic-single): `src/noise/localization/note1.md`, `src/noise/localization/note2.md`, `src/noise/localization/note3.md`
- `filename-11` (filename-only): `src/modules/m09/IndigoM1.ts`, `src/modules/m09/IndigoM2.ts`, `src/decoys/d7/embeddingRegistry.ts`
- `multi-11` (multi-file): `src/ui/localizationPanel.tsx`, `src/noise/localization/note1.md`, `src/noise/localization/note2.md`
- `cross-11` (cross-project): `src/noise/localization/note1.md`, `src/noise/localization/note2.md`, `src/noise/localization/note3.md`
- `stale-11` (stale-path): `src/ui/localizationPanel.tsx`, `src/noise/localization/note1.md`, `src/noise/localization/note2.md`
- `semantic-12` (semantic-single): (no result)
- `multi-12` (multi-file): (no result)
- `cross-12` (cross-project): (no result)
- `stale-12` (stale-path): (no result)

## Interpretation limits

- The corpus is synthetic and inspectable. It is useful for regression and engineering comparisons, not a production-user effect claim.
- `provisional-holdout` is visible in source and is therefore not a true hidden holdout.
- Stale-path cases score historical retrieval only. Current filesystem verification requires the later Agent experiment.
- Timing uses in-process MCP transport; it excludes model latency, filesystem reads and a real stdio/network framing layer. It is descriptive, not a product-level latency claim.
