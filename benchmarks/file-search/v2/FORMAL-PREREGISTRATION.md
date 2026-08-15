# VESTI Historical File Search V2 — Formal Experiment Preregistration

> Status: **LOCKED — FORMAL MODEL RUN NOT STARTED**  
> Lock time: `2026-08-15T18:09:04.301Z` UTC
> (`2026-08-16T02:09:04.305+08:00`, Asia/Shanghai).  
> Lock basis: the completed no-model formal dry-run manifest at
> `benchmarks/file-search/results/agent-v2-formal-lock-dryrun-20260816/manifest.json`.
> From this lock time until all 1,440 formal runs finish, no scientific artifact,
> hash, endpoint, threshold, or analysis rule in this protocol may change. The
> first formal model call is permitted only after the locked worktree is made
> immutable by a recorded Git commit or annotated tag.

## 1. Research question and estimand

The experiment tests whether the frozen VESTI file-location instructions improve
an Agent's ability to locate files and supporting sessions in a captured
historical-conversation corpus when the Agent has access to the modern VESTI MCP
tool set.

The primary estimand is the paired percentage-point difference in end-to-end
`taskSuccess` between arm D (`modern-vesti`) and arm B (`modern-none`) over all
scheduled formal case/repeat blocks. It measures the incremental effect of the
frozen VESTI instructions beyond the modern tool itself. The treatment is frozen
text injected into the Agent prompt; this experiment does **not** measure runtime
Skill discovery or triggering.

## 2. Experimental design

### 2.1 Fixed sample

- Formal corpus: 120 synthetic cases in 20 `conceptId` clusters.
- Per concept: six task categories, for 120 cases in total.
- Negative category: 10 hard negatives and 10 clean negatives; therefore each
  arm has 30 scheduled hard-negative observations across the three repetitions.
- Arms: four.
- Repetitions: three fresh Agent executions per case and arm.
- Individual scheduled runs: `120 × 4 × 3 = 1,440`.
- Matched four-arm blocks: `120 × 3 = 360`.
- Statistical cluster: `conceptId`, not an individual run.

The sample size is fixed in advance. It will not be increased, reduced, or
stopped early in response to observed outcome values, confidence intervals, or
apparent significance.

### 2.2 Arms

| Label | Runner arm | Tools | Prompt treatment | Interpretation |
| --- | --- | --- | --- | --- |
| A | `legacy-none` | legacy search, timeline, turns | none | Legacy-tool baseline |
| B | `modern-none` | A plus `vesti_search_files` | none | Modern-tool baseline |
| C | `modern-placebo` | same as B | frozen irrelevant, format/length-matched placebo | Prompt-presence control |
| D | `modern-vesti` | same as B/C | frozen VESTI file-location instructions | Proposed method |

All arms receive the same task text, neutral benchmark-server instruction, model,
output schema, byte-identical fixture content, execution sandbox, and timeout.
Each run uses a fresh Agent process and a private fixture copy. Arm order is
seeded and randomized within each matched case/repeat block by the frozen runner.

### 2.3 Formal-run command

The formal run must use the frozen equivalents of:

```powershell
node benchmarks/file-search/v2/run-agent-v2.mjs `
  --phase formal `
  --dataset benchmarks/file-search/v2/formal-corpus.mjs `
  --mcp-entry <FROZEN_VESTI_MCP_ENTRY> `
  --repeats 3 `
  --concurrency 2 `
  --results-dir <NEW_EMPTY_FORMAL_RESULTS_DIRECTORY>
```

`--max-cases` is prohibited. A prior result directory is prohibited unless the
invocation is an exact compatible `--resume` as defined below.

## 3. Outcomes

### 3.1 Unique primary outcome

The **only primary outcome** is the D-minus-B difference in end-to-end
`taskSuccess`, using the runner's intent-to-treat (ITT) paired estimate.

For an answerable case, `taskSuccess = 1` only when all expected targets occur in
the top five returned files, every target has the correct project and supporting
session evidence, every returned file is supported, `answerable` is true, and
every target is explicitly marked `historical_only = true`. For a negative case,
success requires abstention. A run-level Agent/output failure receives the
runner's explicit zero. No failed or inconvenient block may be silently dropped
from the primary estimate.

The primary contrast is

`Δ_primary = mean(taskSuccess_D - taskSuccess_B)`

over the 360 matched case/repeat blocks. The directional hypothesis is
`H0: Δ_primary <= 0` against `H1: Δ_primary > 0`.

The primary claim passes only if all validity gates pass and the lower endpoint
of the preregistered two-sided 95% concept-cluster bootstrap confidence interval
is greater than zero. This is a conservative directional decision rule. A
positive point estimate whose interval crosses zero is **not** confirmatory
evidence.

### 3.2 Key secondary outcomes and multiplicity control

Key secondary hypotheses use a hierarchical gate followed by a two-hypothesis
Holm family:

1. Only if the primary passes, test D minus B on `retrievalTaskSuccess`.
2. Only if that retrieval secondary passes, open a family containing (a) D minus
   C on end-to-end `taskSuccess` (VESTI instructions beyond placebo), and (b) D
   minus A on end-to-end `taskSuccess` (the complete proposed system versus the
   legacy baseline). Apply Holm-Bonferroni adjustment across these two tests at
   family alpha 0.05.

`retrievalTaskSuccess` uses the same complete top-five path, project, evidence,
and zero-unsupported-file requirements as `taskSuccess`, but does not score the
`historical_only` field.

The D-minus-B retrieval secondary passes when its two-sided 95%
concept-cluster-bootstrap interval has a lower endpoint greater than zero. For
the final two-test family, the runner's preregistered two-sided centered
concept-cluster-bootstrap p-values are Holm-adjusted; a member passes only when
its effect is positive and its Holm-adjusted p-value is below 0.05. Unadjusted
and adjusted p-values and two-sided 95% intervals are all reported.

This hierarchy plus Holm adjustment prevents a post-hoc choice among D-B, D-C,
and D-A. If either the primary or retrieval gate fails, all unopened hypotheses
remain descriptive. Passing D-A does not rescue a failed D-B primary, and
passing D-C does not permit skipping a failed D-B retrieval secondary.

### 3.3 Exploratory outcomes

The following are explicitly exploratory and cannot support the preregistered
primary or key-secondary claims:

- B minus A (`modernToolEffect`).
- C minus B (`placeboEffect`).
- Any metric/contrast pairing not explicitly named in the primary or
  key-secondary hierarchy, including retrieval-only D-C and D-A.
- Category-, language-, target-count-, stale-kind-, and project-count subgroups.
- Hit@1/3/5, recall@5, MRR, project/evidence/historical accuracy, stale safety,
  returned-file precision, unsupported-return rate, calls, latency, and tokens.
- Clean-completed analyses and any alternative aggregation or confidence method.
- Any interaction, mediation, per-concept, or error-taxonomy analysis.

Exploratory estimates and intervals must be labelled unadjusted/descriptive; no
selection among them may be described as a confirmatory finding.

## 4. Hard-negative safety acceptance gate

Hard-negative cases are evaluated separately from clean negatives. The safety
analysis uses every scheduled hard-negative repetition. A false positive is a
response with `answerable = true` or one or more returned files. A failed,
unparseable, or schema-invalid hard-negative run is counted conservatively as a
false positive for this safety gate, even if the runner's response-only
`negativeFalsePositive` field is null.

Arm D must satisfy **both** conditions:

1. Absolute ITT hard-negative FPR for D is at most 20% (`FPR_D <= 0.20`).
2. D is non-inferior to B with a +10 percentage-point margin. Define
   `Δ_FPR = FPR_D - FPR_B`; the one-sided 95% upper percentile of the paired
   concept-cluster bootstrap distribution must be strictly below `+0.10`.

The non-inferiority hypotheses are `H0: Δ_FPR >= 0.10` and
`H1: Δ_FPR < 0.10`. The absolute 20% rule is evaluated on the point estimate,
with its numerator and denominator reported. The hard-negative stratum contains
10 eligible `conceptId` clusters; each safety bootstrap sample draws 10 of those
clusters with replacement and retains every paired repetition in a sampled
cluster. The formal efficacy endpoints continue to use all 20 concept clusters.

This is a preregistered product-safety gate, not a second efficacy primary. An
overall statement that the method is both improved and acceptably safe requires
the primary efficacy rule and both safety conditions to pass. Failure of the
safety gate cannot be overridden by a favorable efficacy result.

## 5. Statistical analysis

### 5.1 ITT paired estimates

The primary and key-secondary analyses use all 360 scheduled matched blocks.
Within each case/repeat block, the appropriate arm score is subtracted before
aggregation. Agent-level failures retained by the runner carry their explicit
score of zero. The clean-completed paired estimate is a sensitivity analysis
only.

### 5.2 Concept-cluster bootstrap

Uncertainty is estimated with 10,000 fixed-seed percentile bootstrap samples.
Each sample draws 20 `conceptId` clusters with replacement from the 20 formal
concepts and includes all six cases, all three repetitions, and all relevant
arms belonging to each sampled concept. This preserves dependence among task
categories, repetitions, and paired arms. The 2.5th and 97.5th percentiles form
the two-sided 95% interval.

The bootstrap seed is deterministically derived by the frozen runner from the
formal dataset seed. It may not be changed after outcomes are observed. Effects
are reported as percentage-point differences with the number of scheduled and
analyzed blocks. For the Holm family only, the runner also computes the frozen
two-sided centered-bootstrap p-value with finite-sample correction before
applying Holm-Bonferroni adjustment.

### 5.3 No outcome-dependent changes

There is no interim efficacy analysis and no outcome-based early stopping. While
the formal run is incomplete, monitoring is limited to process liveness,
schedule coverage, hashes, infrastructure status, and aggregate failure counts;
per-arm success rates and item-level answers are not inspected. Model, corpus,
Skill/placebo text, tools, schema, scoring, contrasts, thresholds, and bootstrap
settings remain frozen until all 1,440 runs finish or the experiment is declared
invalid for a preregistered operational reason.

## 6. Integrity, completeness, and failure gates

Confirmatory interpretation is allowed only when all of the following hold:

1. The completed manifest and all hashes match the locked ledger below.
2. The schedule contains exactly 1,440 unique planned `runId` values and the
   final NDJSON contains exactly one valid row for each; there are no external,
   duplicate, missing, or cherry-picked rows.
3. All 360 case/repeat blocks contain A, B, C, and D and have numeric binary
   `taskSuccess` and `retrievalTaskSuccess` values.
4. No unresolved infrastructure failure, fixture-copy mismatch, artifact
   mutation, manifest mismatch, MCP initialization/protocol failure, corrupted
   NDJSON record, or incompatible schema/scoring record remains.
5. At least 1,426 of 1,440 runs (>=99%) have `status = completed`, and each arm
   has at least 357 of 360 completed runs (>=99%). Retained Agent-level failures
   count as zero in ITT and against these limits.
6. Any run-local failed MCP call, invalid model output, JSON/schema error, model
   exit, or timeout is disclosed by arm and failure class. Retriable
   infrastructure failures do not disappear from the audit trail; their retry is
   recorded in `resumeHistory`.

If any gate fails, the full ITT estimates are still reported when mechanically
possible, but the experiment is labelled operationally invalid and no
confirmatory success claim is made. Thresholds will not be relaxed post hoc.

## 7. Interruption and resume policy

The only permitted continuation of an interrupted formal run is the runner's
strict `--resume` mode against the same results directory. Resume must validate
the original experiment, schedule, fixture, runner, schema, MCP artifact,
instructions, Skill/placebo, and arm hashes. It retains completed and
Agent-failed runs, ignores only a truncated final NDJSON line, and reruns only
missing or runner-classified infrastructure-failed `runId` values. The same
`runId` and frozen schedule remain authoritative.

No individual run may be repeated because its answer or score is unfavorable,
and no duplicate attempt may be selected. Changing any scientific artifact or
hash requires invalidating the entire run, issuing a new preregistration/version,
and starting in a new empty result directory. Resume concurrency remains fixed
at two unless a pre-outcome infrastructure incident requires one; any such
change must be documented in `resumeHistory` and does not authorize other
changes.

## 8. Formal-set firewall

### 8.1 Pre-lock development checks and their evidentiary boundary

The targeted hard-negative safety calibration in
`agent-v2-safety-calibration-final-20260816` completed 48 development runs
(4 cases × 3 repetitions × 4 arms) and passed its development safety gate:
arm D hard-negative ITT FPR was 0%, and the D-minus-B one-sided 95% upper bound
was -33.3 percentage points. It used pre-lock candidate treatment hash
`2a5493807a5425e49cdcc6cd7fba15b645d5f921cc181dda0294de15eca837e4`.
This was a calibration result used before final treatment freeze, not a formal
claim about the locked treatment.

The subsequent clean-negative smoke in
`agent-v2-clean-smoke-final-20260816` used the final locked treatment hash
`7b8d1a4a74107ca9856bd819f47a15bd6cfcd316d47e9c4a28892a3a75d7edd7`
and completed 16 runs (2 clean cases × 2 repetitions × 4 arms). It contained no
hard-negative case, so its hard-safety gate was correctly indeterminate. It is
an engineering smoke check only; it supplies no confirmatory efficacy or safety
evidence and cannot replace the 120-case formal experiment.

Neither pre-lock check will be pooled with, used to increase the sample size of,
or reported as part of the formal result.

### 8.2 Post-lock firewall

The 120-case formal set is confirmatory, not a development set. Before locking,
its integrity and leakage properties may be audited without running the Agent or
examining outcome data. After locking:

- No Skill, prompt, tool, ranker, schema, scoring, or threshold is tuned to a
  formal item or formal result.
- Calibration results may inform the final freeze only before the formal corpus
  and treatment ledger is locked.
- Formal item-level outcomes are not used to debug or improve the evaluated
  method.
- A future improved method must be evaluated on a newly generated, independently
  frozen corpus; rerunning this formal set is replication/descriptive evidence,
  not a fresh confirmatory test.

## 9. Scope and limitations

The corpus and filesystem references are synthetic. The fixture represents
captured historical Agent sessions and controlled distractors; it is not a
sample of live users, repositories, operating systems, or production incidents.
The MCP tools are read-only over captured history. They can establish that a
path/project/session was mentioned or used in historical evidence, but cannot
establish that a file currently exists, has not moved, or still contains the
historical content.

Accordingly, every returned file is evaluated under the `historical_only = true`
contract. Success means correct historical localization and evidence attribution
inside this benchmark. It does not demonstrate current-filesystem verification,
general production accuracy, causal productivity gains, security, or performance
on uncaptured work. Any external claim must preserve these boundaries.

## 10. Reporting commitments

The final report will include, regardless of direction:

- the manifest, hash ledger, schedule coverage, exclusions, resumes, and all
  failure counts by arm;
- arm-level numerator/denominator and rate for both success metrics;
- primary and key-secondary paired estimates with 95% concept-cluster bootstrap
  intervals and an explicit pass/fail decision under the hierarchy;
- hard-negative D FPR with its numerator/denominator, D-minus-B FPR with its
  two-sided interval and one-sided upper bound, and both safety decisions;
- exploratory contrasts and subgroup analyses clearly separated from
  confirmatory results;
- the synthetic/historical-only limitation and frozen-text-delivery limitation;
- machine-readable `runs.ndjson`, `manifest.json`, and `summary.json` artifacts.

Null, negative, unsafe, or operationally invalid outcomes will be reported. No
result will be omitted because it is unfavorable.

## 11. Frozen-artifact ledger

All values below were copied from the formal lock dry-run manifest and
cross-checked against the current files at lock time. Hash algorithm is SHA-256
over file bytes unless a row explicitly names the runner's canonical JSON or
directory hashing procedure.

| Artifact | Frozen path or identifier | SHA-256 / value |
| --- | --- | --- |
| Preregistration lock timestamp | UTC / Asia/Shanghai | `2026-08-15T18:09:04.301Z` / `2026-08-16T02:09:04.305+08:00` |
| Worktree base revision | Git `HEAD`; V2 lock artifacts are not yet committed | `65237899e34441935bc5a9fa480edf07d139a47e` |
| Formal lock dry-run manifest | `benchmarks/file-search/results/agent-v2-formal-lock-dryrun-20260816/manifest.json` | `a3db27da49cfed80c7dc83ffe11e4e445fe78241c3d891f988d99c35e43b28cf` |
| Formal dry-run mode / status | manifest | `dryRun=true` / `completed` / no model calls |
| Formal dataset ID | exported `DATASET_ID` | `vesti-file-search-formal-v2` |
| Formal dataset seed | exported `DATASET_SEED` | `815202617` |
| Formal dataset module | `benchmarks/file-search/v2/formal-corpus.mjs` | `2db619c5ef64468d276cc3cb0828b07c82fb6cde3851b91793aacd6e47248676` |
| Canonical corpus JSON | `{ projects, sessions, cases }` | `5afdd395ebb4b8a8d3d7c1f3c335cf6060501f9a52eab1e5ab6b233e57e0c1fb` |
| Generated fixture database | runner manifest `fixtureSha256` | `d1157e3f6d8c5e02de5053e2deb6b43cd188d65a5e2f36559b8c4324992758f5` |
| V2 runner | `benchmarks/file-search/v2/run-agent-v2.mjs` | `48d3c315f259f8177f50e4ccdecbdf60ba81edf1a671c06ab58e260332fa7296` |
| Output schema | `benchmarks/file-search/v2/agent-output-schema-v2.json` | `1e863ce1c5e72e28cff14c3097e6a0c7b26480b509b07db05709676920eb9814` |
| Benchmark MCP wrapper | `benchmarks/file-search/agent-mcp-server.mjs` | `f94c7fc74057dab7c861c1342eae7f9cdbf904b49e0ebf07a782a801686c7524` |
| APP MCP artifact directory | `VESTI-APP/packages/vesti-mcp/dist` (8 files), runner directory hash | `0e67c5c13c4ca48b680a06756b49f47ed6df96575cdef6e61eebfd200d25ca2f` |
| Neutral common instructions | runner manifest `neutralInstructionsSha256` | `78cc4a24027be2dc76b15bf88949b926f1592ec1ee5ce412c0b15b57e445c96c` |
| Benchmark-server instructions | runner manifest `benchmarkServerInstructionsSha256` | `39c84415e0e48feb1963fa8afd57ad37b231eea4cbaca0035f50a8c91f639003` |
| Placebo treatment | `benchmarks/file-search/v2/frozen/placebo-skill.md` | `b7daa0f1ce983b47f8b54aaf6271579cf2acebc158c1d03c956685ce6e34d08c` |
| VESTI treatment | `benchmarks/file-search/v2/frozen/vesti-memory-v2.md` | `7b8d1a4a74107ca9856bd819f47a15bd6cfcd316d47e9c4a28892a3a75d7edd7` |
| Arm A | runner manifest `armHashes.legacy-none` | `0e5354d39b2f47990e50d370c49c7402bc3295667113f6fee0dbeab830e295f5` |
| Arm B | runner manifest `armHashes.modern-none` | `2f85d6975f619e39351165366e6440c85b91ead87260018d6a6d63f02b940cd1` |
| Arm C | runner manifest `armHashes.modern-placebo` | `63102a9a7d01816cba3f55480abe07386742e2e09fcdb415afa7435ca826ecac` |
| Arm D | runner manifest `armHashes.modern-vesti` | `f30832ef501dc49db77703bb096069abd4be2e3ac0fa85e1eb97d1282580be7f` |
| Model | exact runner model identifier | `gpt-5.6-luna` |
| Codex CLI | runner manifest `codexVersion` | `codex-cli 0.144.6` |
| Experiment | runner manifest `experimentHash` | `555a5e07f8b86162f394d2c972a3dafe337b3272e2c4b5873f2d21601f226ad5` |
| Randomized schedule | runner manifest `scheduleSha256` | `5fb60c5afeb0b72d443c0421267e962408b8d7c71ea4165d5969027dbc55eedc` |
| Expected cases / repeats / runs | fixed protocol | `120 / 3 / 1,440` |
| Bootstrap | fixed protocol | `10,000; 20 concept clusters; 95% percentile CI` |
| Planned formal result directory | `benchmarks/file-search/results/agent-v2-formal-20260816` | absent at lock time |

### Lock attestation

The immutable Git commit (or annotated tag) containing this locked document is
recorded in the external run log and final report before the first model call;
embedding that commit's hash inside the commit itself would be self-referential.

- [x] Formal corpus integrity and leakage audit passed.
- [x] Calibration and all treatment-development work ended before lock.
- [x] Every scientific-artifact ledger value was populated and checked against
  the dry-run manifest and current file bytes.
- [x] Planned formal result directory was absent at lock time.
- [x] The formal lock run used `dryRun=true`; no formal model call occurred.
- [x] UTC lock time and worktree base revision were recorded.
- [ ] Before the first formal model call, record an immutable Git commit or
  annotated tag containing this locked worktree in the external run log.

Locking operator: `Codex /root/prepare_formal_prereg`  
Hash cross-check: `formal dry-run manifest versus current files and APP MCP dist`
