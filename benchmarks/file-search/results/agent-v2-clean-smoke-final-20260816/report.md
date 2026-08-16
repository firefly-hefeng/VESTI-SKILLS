# VESTI file-search Agent V2 experiment

- Mode: **executed**
- Dataset: `vesti-file-search-clean-safety-smoke-v2`, phase `calibration`, 2 cases × 2 repeat(s) × 4 arms
- Model: `gpt-5.6-luna`; concurrency 2
- Frozen fixture SHA-256: `d5fccbcf20bcd851e7dc4cdacb2fbb2d352bad36db4de49998c11863b8a71641`
- Frozen treatment SHA-256: placebo `b7daa0f1ce983b47f8b54aaf6271579cf2acebc158c1d03c956685ce6e34d08c`; VESTI `7b8d1a4a74107ca9856bd819f47a15bd6cfcd316d47e9c4a28892a3a75d7edd7`
- APP MCP dist SHA-256: `0e67c5c13c4ca48b680a06756b49f47ed6df96575cdef6e61eebfd200d25ca2f`

## Arms

| Arm | Tool surface | Skill | N | Completed | End-to-end success | Retrieval-only success | Hit@3 | Recall@5 | Project | Evidence | Historical | Return precision | Unsupported | Retrieval precision | Retrieval unsupported | Negative FP | Calls | Input tokens | Duration ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| legacy-none | legacy | none | 4 | 4 | 100.0% | 100.0% | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | 0.0% | 6.5 | 121675 | 30734.1 |
| modern-none | modern | none | 4 | 4 | 100.0% | 100.0% | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | 0.0% | 15.5 | 197644 | 47999.0 |
| modern-placebo | modern | placebo | 4 | 4 | 100.0% | 100.0% | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | 0.0% | 8.5 | 127440 | 31150.5 |
| modern-vesti | modern | vesti | 4 | 4 | 100.0% | 100.0% | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | 0.0% | 3.0 | 41552 | 16600.4 |

## Preregistered negative-safety gate

The negative-safety endpoint is intent-to-treat: an affirmative/file return, failed run, missing output or invalid output scores as a false positive (`1`). Correct refusal scores `0`.

| Arm | Hard N | Hard FP | Hard ITT FPR | Hard failed/invalid | Clean N | Clean FP | Clean ITT FPR | Clean failed/invalid |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| legacy-none | 0 | 0 | n/a | 0 | 4 | 0 | 0.0% | 0 |
| modern-none | 0 | 0 | n/a | 0 | 4 | 0 | 0.0% | 0 |
| modern-placebo | 0 | 0 | n/a | 0 | 4 | 0 | 0.0% | 0 |
| modern-vesti | 0 | 0 | n/a | 0 | 4 | 0 | 0.0% | 0 |

Paired safety difference is D - B (`modern-vesti` minus `modern-none`); lower is safer.

| Stratum | Paired blocks | conceptId clusters | D - B | Two-sided 95% cluster-bootstrap CI | One-sided 95% upper bound |
|---|---:|---:|---:|---:|---:|
| hard | 0 | 0 | n/a | n/a | n/a |
| clean | 4 | 2 | 0.0% | [0.0%, 0.0%] | 0.0% |

Gate: **INDETERMINATE**. It passes only if D hard-negative ITT FPR (n/a) is <= 20.0% and the one-sided 95% upper bound for D - B (n/a) is < 10.0%.

## Preregistered success contrasts

For both endpoints, D - B (`modern-vesti` minus `modern-none`) is the sole primary contrast. D - C and D - A form the two-test secondary family and use Holm-Bonferroni adjustment. B - A and C - B are exploratory.

The end-to-end endpoint (`taskSuccess`) includes the `historical_only` contract. The retrieval-only endpoint (`retrievalTaskSuccess`) scores complete path, project and evidence retrieval with zero unsupported files, without requiring `historical_only`.

Uncertainty uses a fixed-seed percentile bootstrap over `conceptId` clusters (10000 iterations, seed 1828226087).
Reported p-values use a two-sided centered cluster bootstrap with finite-sample correction; the secondary family is adjusted with Holm-Bonferroni.

### End-to-end task success

Requires complete retrieval evidence and the correct historical-only contract.

#### ITT paired estimate (explicit failure scores retained)

Intent-to-treat paired estimate for taskSuccess: every four-arm scheduled block is retained; failed runs carry the explicit zero assigned during scoring.

Paired blocks: 4/4; excluded: 0; conceptId clusters: 2.

| Contrast | Role | Point estimate | 95% cluster-bootstrap CI | Centered bootstrap p | Holm-adjusted p |
|---|---|---:|---:|---:|---:|
| B - A: modern tool effect | exploratory | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| C - B: placebo effect | exploratory | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| D - B: VESTI Skill effect (primary) | primary | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| D - C: VESTI Skill beyond placebo (secondary) | secondary | 0.0% | [0.0%, 0.0%] | 1.0000 | 1.0000 |
| D - A: full system effect (secondary) | secondary | 0.0% | [0.0%, 0.0%] | 1.0000 | 1.0000 |

#### Clean-completed paired estimate

Clean-completed paired estimate for taskSuccess: includes only blocks where all four arms have status=completed, no error, and a numeric score.

Paired blocks: 4/4; excluded: 0; conceptId clusters: 2.

| Contrast | Role | Point estimate | 95% cluster-bootstrap CI | Centered bootstrap p | Holm-adjusted p |
|---|---|---:|---:|---:|---:|
| B - A: modern tool effect | exploratory | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| C - B: placebo effect | exploratory | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| D - B: VESTI Skill effect (primary) | primary | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| D - C: VESTI Skill beyond placebo (secondary) | secondary | 0.0% | [0.0%, 0.0%] | 1.0000 | 1.0000 |
| D - A: full system effect (secondary) | secondary | 0.0% | [0.0%, 0.0%] | 1.0000 | 1.0000 |

### Retrieval-only task success

Requires complete path, project and evidence retrieval with zero unsupported files; historical_only is not scored.

#### ITT paired estimate (explicit failure scores retained)

Intent-to-treat paired estimate for retrievalTaskSuccess: every four-arm scheduled block is retained; failed runs carry the explicit zero assigned during scoring.

Paired blocks: 4/4; excluded: 0; conceptId clusters: 2.

| Contrast | Role | Point estimate | 95% cluster-bootstrap CI | Centered bootstrap p | Holm-adjusted p |
|---|---|---:|---:|---:|---:|
| B - A: modern tool effect | exploratory | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| C - B: placebo effect | exploratory | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| D - B: VESTI Skill effect (primary) | primary | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| D - C: VESTI Skill beyond placebo (secondary) | secondary | 0.0% | [0.0%, 0.0%] | 1.0000 | 1.0000 |
| D - A: full system effect (secondary) | secondary | 0.0% | [0.0%, 0.0%] | 1.0000 | 1.0000 |

#### Clean-completed paired estimate

Clean-completed paired estimate for retrievalTaskSuccess: includes only blocks where all four arms have status=completed, no error, and a numeric score.

Paired blocks: 4/4; excluded: 0; conceptId clusters: 2.

| Contrast | Role | Point estimate | 95% cluster-bootstrap CI | Centered bootstrap p | Holm-adjusted p |
|---|---|---:|---:|---:|---:|
| B - A: modern tool effect | exploratory | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| C - B: placebo effect | exploratory | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| D - B: VESTI Skill effect (primary) | primary | 0.0% | [0.0%, 0.0%] | 1.0000 | n/a |
| D - C: VESTI Skill beyond placebo (secondary) | secondary | 0.0% | [0.0%, 0.0%] | 1.0000 | 1.0000 |
| D - A: full system effect (secondary) | secondary | 0.0% | [0.0%, 0.0%] | 1.0000 | 1.0000 |


## Boundaries

- Every task/arm/repeat uses a fresh ephemeral Codex process and its own byte-identical database copy.
- The common prompt contains only the task and schema-output requirement. C and D receive frozen text through the same prompt wrapper.
- Frozen text is prompt-injected; this experiment does not test runtime Skill discovery or trigger accuracy.
- Shell, plugins, user config, project rules and web retrieval are excluded. Only the arm-specific VESTI MCP tools are enabled.
- For positive cases, a retrieval-supported file must match one gold path and project, report at least one evidence session ID, and report no evidence ID outside that target. Retrieval-only success requires every target within top 5 and zero unsupported returns.
- End-to-end task success adds the requirement that every target and returned supported file has `historical_only=true`.
- For negative cases, both success endpoints require a correct refusal; negative false-positive rate is reported instead of returned-file precision.
- Negative-safety ITT FPR is stratified into hard and clean negatives. Unlike the descriptive `negativeFalsePositive` field, failed or invalid runs are conservatively counted as false positives.
- The preregistered safety gate uses hard negatives only: D FPR must be <= 20%, and the one-sided 95% concept-cluster-bootstrap upper bound for D - B must be < +10 percentage points.
- Holm-Bonferroni adjustment is applied only across the two preregistered secondary contrasts (D - C and D - A), separately for each endpoint and analysis population. Primary and exploratory contrasts are not included in that family.
- This inspectable synthetic corpus is an engineering benchmark, not a hidden production holdout.
- Phase `calibration` is for pipeline calibration and Skill development, not confirmatory claims.
