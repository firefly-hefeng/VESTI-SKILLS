# VESTI file-search Agent V2 experiment

- Mode: **executed**
- Dataset: `vesti-file-search-calibration-v2`, phase `calibration`, 24 cases × 2 repeat(s) × 4 arms
- Model: `gpt-5.6-luna`; concurrency 2
- Frozen fixture SHA-256: `d5fccbcf20bcd851e7dc4cdacb2fbb2d352bad36db4de49998c11863b8a71641`
- Frozen treatment SHA-256: placebo `b7daa0f1ce983b47f8b54aaf6271579cf2acebc158c1d03c956685ce6e34d08c`; VESTI `e4de5c75ee16057f455546306ce6c623589b9544ee4a53ddf46a278b4bffa78c`
- APP MCP dist SHA-256: `0e67c5c13c4ca48b680a06756b49f47ed6df96575cdef6e61eebfd200d25ca2f`

## Arms

| Arm | Tool surface | Skill | N | Completed | End-to-end success | Retrieval-only success | Hit@3 | Recall@5 | Project | Evidence | Historical | Return precision | Unsupported | Retrieval precision | Retrieval unsupported | Negative FP | Calls | Input tokens | Duration ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| legacy-none | legacy | none | 48 | 48 | 85.4% | 85.4% | 87.5% | 87.5% | 87.5% | 87.5% | 87.5% | 87.5% | 0.0% | 87.5% | 0.0% | 25.0% | 8.0 | 155463 | 42947.5 |
| modern-none | modern | none | 48 | 48 | 95.8% | 95.8% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 100.0% | 0.0% | 25.0% | 6.0 | 143882 | 37673.1 |
| modern-placebo | modern | placebo | 48 | 48 | 89.6% | 89.6% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 98.5% | 1.5% | 98.5% | 1.5% | 50.0% | 6.0 | 154869 | 40348.2 |
| modern-vesti | modern | vesti | 48 | 48 | 97.9% | 97.9% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 100.0% | 0.0% | 12.5% | 2.0 | 60491 | 24238.0 |

## Preregistered negative-safety gate

The negative-safety endpoint is intent-to-treat: an affirmative/file return, failed run, missing output or invalid output scores as a false positive (`1`). Correct refusal scores `0`.

| Arm | Hard N | Hard FP | Hard ITT FPR | Hard failed/invalid | Clean N | Clean FP | Clean ITT FPR | Clean failed/invalid |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| legacy-none | 4 | 2 | 50.0% | 0 | 4 | 0 | 0.0% | 0 |
| modern-none | 4 | 2 | 50.0% | 0 | 4 | 0 | 0.0% | 0 |
| modern-placebo | 4 | 4 | 100.0% | 0 | 4 | 0 | 0.0% | 0 |
| modern-vesti | 4 | 1 | 25.0% | 0 | 4 | 0 | 0.0% | 0 |

Paired safety difference is D - B (`modern-vesti` minus `modern-none`); lower is safer.

| Stratum | Paired blocks | conceptId clusters | D - B | Two-sided 95% cluster-bootstrap CI | One-sided 95% upper bound |
|---|---:|---:|---:|---:|---:|
| hard | 4 | 2 | -25.0% | [-50.0%, 0.0%] | 0.0% |
| clean | 4 | 2 | 0.0% | [0.0%, 0.0%] | 0.0% |

Gate: **FAIL**. It passes only if D hard-negative ITT FPR (25.0%) is <= 20.0% and the one-sided 95% upper bound for D - B (0.0%) is < 10.0%.

## Preregistered success contrasts

For both endpoints, D - B (`modern-vesti` minus `modern-none`) is the sole primary contrast. D - C and D - A form the two-test secondary family and use Holm-Bonferroni adjustment. B - A and C - B are exploratory.

The end-to-end endpoint (`taskSuccess`) includes the `historical_only` contract. The retrieval-only endpoint (`retrievalTaskSuccess`) scores complete path, project and evidence retrieval with zero unsupported files, without requiring `historical_only`.

Uncertainty uses a fixed-seed percentile bootstrap over `conceptId` clusters (10000 iterations, seed 1828226087).
Reported p-values use a two-sided centered cluster bootstrap with finite-sample correction; the secondary family is adjusted with Holm-Bonferroni.

### End-to-end task success

Requires complete retrieval evidence and the correct historical-only contract.

#### ITT paired estimate (explicit failure scores retained)

Intent-to-treat paired estimate for taskSuccess: every four-arm scheduled block is retained; failed runs carry the explicit zero assigned during scoring.

Paired blocks: 48/48; excluded: 0; conceptId clusters: 4.

| Contrast | Role | Point estimate | 95% cluster-bootstrap CI | Centered bootstrap p | Holm-adjusted p |
|---|---|---:|---:|---:|---:|
| B - A: modern tool effect | exploratory | 10.4% | [4.2%, 16.7%] | 0.0037 | n/a |
| C - B: placebo effect | exploratory | -6.3% | [-12.5%, 0.0%] | 0.1410 | n/a |
| D - B: VESTI Skill effect (primary) | primary | 2.1% | [0.0%, 6.3%] | 0.5773 | n/a |
| D - C: VESTI Skill beyond placebo (secondary) | secondary | 8.3% | [0.0%, 18.8%] | 0.1410 | 0.1410 |
| D - A: full system effect (secondary) | secondary | 12.5% | [8.3%, 16.7%] | <0.0001 | 0.0002 |

#### Clean-completed paired estimate

Clean-completed paired estimate for taskSuccess: includes only blocks where all four arms have status=completed, no error, and a numeric score.

Paired blocks: 48/48; excluded: 0; conceptId clusters: 4.

| Contrast | Role | Point estimate | 95% cluster-bootstrap CI | Centered bootstrap p | Holm-adjusted p |
|---|---|---:|---:|---:|---:|
| B - A: modern tool effect | exploratory | 10.4% | [4.2%, 16.7%] | 0.0037 | n/a |
| C - B: placebo effect | exploratory | -6.3% | [-12.5%, 0.0%] | 0.1410 | n/a |
| D - B: VESTI Skill effect (primary) | primary | 2.1% | [0.0%, 6.3%] | 0.5773 | n/a |
| D - C: VESTI Skill beyond placebo (secondary) | secondary | 8.3% | [0.0%, 18.8%] | 0.1410 | 0.1410 |
| D - A: full system effect (secondary) | secondary | 12.5% | [8.3%, 16.7%] | <0.0001 | 0.0002 |

### Retrieval-only task success

Requires complete path, project and evidence retrieval with zero unsupported files; historical_only is not scored.

#### ITT paired estimate (explicit failure scores retained)

Intent-to-treat paired estimate for retrievalTaskSuccess: every four-arm scheduled block is retained; failed runs carry the explicit zero assigned during scoring.

Paired blocks: 48/48; excluded: 0; conceptId clusters: 4.

| Contrast | Role | Point estimate | 95% cluster-bootstrap CI | Centered bootstrap p | Holm-adjusted p |
|---|---|---:|---:|---:|---:|
| B - A: modern tool effect | exploratory | 10.4% | [4.2%, 16.7%] | 0.0037 | n/a |
| C - B: placebo effect | exploratory | -6.3% | [-12.5%, 0.0%] | 0.1410 | n/a |
| D - B: VESTI Skill effect (primary) | primary | 2.1% | [0.0%, 6.3%] | 0.5773 | n/a |
| D - C: VESTI Skill beyond placebo (secondary) | secondary | 8.3% | [0.0%, 18.8%] | 0.1410 | 0.1410 |
| D - A: full system effect (secondary) | secondary | 12.5% | [8.3%, 16.7%] | <0.0001 | 0.0002 |

#### Clean-completed paired estimate

Clean-completed paired estimate for retrievalTaskSuccess: includes only blocks where all four arms have status=completed, no error, and a numeric score.

Paired blocks: 48/48; excluded: 0; conceptId clusters: 4.

| Contrast | Role | Point estimate | 95% cluster-bootstrap CI | Centered bootstrap p | Holm-adjusted p |
|---|---|---:|---:|---:|---:|
| B - A: modern tool effect | exploratory | 10.4% | [4.2%, 16.7%] | 0.0037 | n/a |
| C - B: placebo effect | exploratory | -6.3% | [-12.5%, 0.0%] | 0.1410 | n/a |
| D - B: VESTI Skill effect (primary) | primary | 2.1% | [0.0%, 6.3%] | 0.5773 | n/a |
| D - C: VESTI Skill beyond placebo (secondary) | secondary | 8.3% | [0.0%, 18.8%] | 0.1410 | 0.1410 |
| D - A: full system effect (secondary) | secondary | 12.5% | [8.3%, 16.7%] | <0.0001 | 0.0002 |


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
