# File-search evaluation

For the product-level view that treats MCP retrieval and Skill validation as
one paired VESTI method, start with the
[Chinese public results summary](PUBLIC-RESULTS-ZH.md). The
[complete Chinese technical audit](INTEGRATED-METHOD-RESULTS-ZH.md) retains
every experiment, diagnostic result and interpretation boundary. The separate
layers below are retained for causal attribution and reproducibility.

Presentation-ready materials:

- [Chinese public results summary](PUBLIC-RESULTS-ZH.md)
- [Chinese slide deck](presentation/VESTI-MCP-SKILL-实验结果汇报-定向能力更新.pptx)
- [One-page Chinese briefing](presentation/汇报速览.md)

This directory evaluates `vesti_search_files` at four separate layers:

1. a five-case in-memory smoke test for the reusable retrieval core;
2. a 72-case deterministic test through the built VESTI-APP MCP server and a
   real SQLite/FTS fixture;
3. a blinded 2 x 2 Agent experiment that separates the effect of the new tool
   from the effect of the `vesti-memory` Skill instructions; and
4. a small, preregistered capability-targeted two-arm study that holds the MCP
   surface fixed and tests the incremental effect of frozen Skill decision
   rules in deliberately enriched ambiguity and evidence-verification tasks.

Do not combine these layers into one claim. The deterministic benchmark tests
retrieval and MCP wiring; only the four-arm experiment can estimate an Agent or
Skill effect. The targeted study estimates a narrower Skill effect only within
its predefined mechanism scenarios; it is not an overall user-task benchmark.

## Prerequisites

- Node.js 22.12 or newer and Corepack/pnpm.
- `VESTI-SKILLS` and `VESTI-APP` checked out as sibling directories. The
  default MCP entry is
  `../VESTI-APP/packages/vesti-mcp/dist/index.js`.
- A working, authenticated Codex CLI is required only for the Agent experiment.

Build the two artifacts used by the large and Agent benchmarks from the
`VESTI-SKILLS` repository root:

```bash
corepack pnpm --filter @vesti/search-files-core build
corepack pnpm --dir ../VESTI-APP --filter @vesti/vesti-mcp build
```

Every result manifest records the dataset seed and hashes of the corpus,
fixture, MCP artifact, Skill, schema, and runner as applicable. Compare runs
only when the relevant hashes are compatible.

## Five-case smoke test

The small in-memory test covers semantic lookup, filename-only lookup,
cross-project retrieval, a historical/deleted path, and an unsupported query.
It is useful for quickly checking the measurement chain, but it is not large
enough for an effectiveness claim.

```bash
corepack pnpm eval:file-search-demo
```

It writes `pilot-report.md`, `pilot-results.csv`, and `pilot-results.json` to
`benchmarks/file-search/results/`.

## 72-case real-MCP benchmark

### Dataset

`vesti-file-search-large-v2` is a deterministic, privacy-safe synthetic corpus
with seed `221250144`:

- 8 projects and 146 captured sessions;
- 72 cases: 12 each for semantic single-file, filename-only, same-project
  multi-file, cross-project, stale historical path, and negative retrieval;
- split sizes of 12 development, 48 test, and 12 provisional-holdout cases;
- English, mixed-language, and natural Chinese queries without artificial
  spaces;
- basename collisions, more-than-12-session fan-out, repeated file touches,
  project-qualified filenames, and clean/hard negatives.

The generated fixture uses the same SQLite/FTS/trigram path exercised by the
built VESTI-APP MCP package. The `provisional-holdout` data is visible in
`large-corpus.mjs`; it is useful for split isolation but is not a true hidden
holdout.

### Deterministic arms

| Arm | Tool workflow | What it measures |
|---|---|---|
| `legacy` | `vesti_search`, then `vesti_timeline` and `vesti_get_turns` for up to five sessions | A fixed, deliberately generous approximation of the former disclosure workflow |
| `search-files` | One `vesti_search_files` call | The new retrieval core plus the APP SQLite/MCP adapter |

The MCP runner captures the internal session-recall trace out of band in
`large-runs.ndjson`. The trace is not included in the tool payload that would
be visible to a model.

### Metrics

- Task success at Top 5 is the primary paired endpoint.
- Hit@1/3/5 and MRR measure the first expected file.
- Recall@5 and all-targets@5 measure multi-file and cross-project completeness.
- Project and evidence accuracy require the expected project and supporting
  session, not just a matching path string.
- Negative false-positive rate is reported separately for clean and hard
  negatives.
- Tool calls and model-visible UTF-8 bytes measure Agent-facing work and
  context; bytes are not tokenizer-specific Tokens.
- Median in-process MCP latency is diagnostic only.

The fixture uses Windows-style project roots. Its scorer normalizes `\\` to `/`
and compares those paths case-insensitively. POSIX case behavior is covered by
the retrieval-core tests, not by this fixture.

### Run and ablate the session candidate limit

Run both candidate caps against separately named result directories:

```bash
node benchmarks/file-search/run-mcp-large.mjs \
  --split all \
  --warmups 2 \
  --repeats 10 \
  --search-files-recall-limit 12 \
  --results-dir benchmarks/file-search/results/local-ablation-limit12

node benchmarks/file-search/run-mcp-large.mjs \
  --split all \
  --warmups 2 \
  --repeats 10 \
  --search-files-recall-limit 30 \
  --results-dir benchmarks/file-search/results/local-ablation-limit30
```

`--split` accepts `dev`, `test`, `provisional-holdout`, or `all`. The candidate
limit is intentionally restricted to 12 or 30. `--mcp-entry` can point to a
different built APP MCP entry. Use a new result directory for each run; unlike
the Agent runner, the deterministic runner does not refuse to replace artifact
files in an existing directory.

Each directory receives:

- `large-manifest.json`: versions, hashes, fixture counts, and run parameters;
- `large-runs.ndjson`: one scored row per case/arm, ranked output, timing, and
  per-repeat internal recall traces;
- `large-summary.json`: arm/category summaries and paired statistics;
- `large-results.csv`: flattened case-level metrics;
- `large-report.md`: human-readable summary and treatment failures.

### Current completed deterministic result

The completed release reference runs are
`results/full-v2-release-limit12/` and
`results/full-v2-release-limit30/`. Both used all 72 cases, two discarded
warm-ups, and ten timed repeats per arm.

| Recall limit | Legacy task success | Search-files task success | Search-files Hit@3 / Recall@5 | Median calls | Median visible bytes | Median search-files latency |
|---:|---:|---:|---:|---:|---:|---:|
| 12 | 81.8% | 100.0% | 100.0% / 100.0% | 1 | 4,318 | 5.5 ms |
| 30 | 81.8% | 100.0% | 100.0% / 100.0% | 1 | 4,321 | 5.7 ms |

At limit 12, the fixed legacy workflow used a median of 11 calls and 12,317
visible bytes. Search-files improved paired Top-5 task success by 18.2
percentage points (concept-cluster bootstrap 95% CI 17.4 to 19.0 points; 12
clusters). No scored retrieval metric improved at limit 30, so 12 remains the
default candidate budget and 30 remains an explicit ablation/debug setting.

The clean-negative false-positive rate was 0%. All six hard negatives returned
raw candidates in both deterministic arms because they intentionally share a
broad topic. They are excluded from the primary deterministic quality endpoint;
whether an Agent inspects weak evidence and abstains is tested in the four-arm
experiment.

The retrieval gate for starting the Agent experiment is:

- at least 90% Hit@3 for single-target strata;
- at least 85% Recall@5 for same-project multi-file and cross-project strata;
- 0% false positives on clean negatives;
- no tool errors, stable repeated rankings, and no project/evidence regression.

The two completed release-limit runs pass this gate. Earlier directories such as
`baseline-*`, `dev-*`, `smoke-*`, and `full-v2-realworld-*` are diagnostic
snapshots from intermediate implementations. Use each directory's manifest as
the authority and do not merge metrics across artifact hashes.

## Four-arm blinded Agent experiment

### Factorial design

The Agent runner uses `gpt-5.6-luna` and crosses tool surface with frozen Skill
instructions:

| Arm | Tool surface | `vesti-memory` Skill text |
|---|---|---:|
| `old-skill-off` | Search, timeline, and turns only | Off |
| `old-skill-on` | Search, timeline, and turns only | On |
| `new-skill-off` | Old tools plus `vesti_search_files` | Off |
| `new-skill-on` | Old tools plus `vesti_search_files` | On |

This design estimates the tool effect with Skill off/on, the Skill effect with
old/new tools, their marginal effects, and the tool-by-Skill interaction. It
avoids attributing an improvement from a new tool to prompt instructions, or
vice versa.

For each case, repeat, and arm, the runner:

- creates a fresh ephemeral Codex process and a byte-identical private database
  copy;
- randomizes case and arm order with a fixed seed;
- gives the Agent only the user query, neutral rules, the arm's MCP tools, and
  the frozen Skill text in Skill-on arms;
- keeps gold files, projects, and session IDs out of the prompt;
- disables shell access, apps, plugins, user config, repository rules, and
  unrelated retrieval;
- requires strict JSON with path, project, historical status, and supporting
  session IDs.

Positive task success requires all expected files within Top 5, correct project
and evidence attribution, historical-path labeling, and zero unsupported extra
files. Negative cases require abstention. The report also includes return
precision, unsupported-return rate, stale-path safety, tool calls, Codex usage
Tokens, and end-to-end duration.

### Calibrate, run, and resume

Validate scheduling, fixture copies, prompts, hashes, and commands without
making model calls:

```bash
node benchmarks/file-search/run-agent-factorial.mjs \
  --split dev \
  --max-cases 2 \
  --dry-run \
  --results-dir benchmarks/file-search/results/agent-factorial-dry-run
```

Then run a small real-model calibration before the full 288-run experiment:

```bash
node benchmarks/file-search/run-agent-factorial.mjs \
  --split dev \
  --max-cases 2 \
  --repeats 1 \
  --concurrency 1 \
  --results-dir benchmarks/file-search/results/agent-factorial-calibration

node benchmarks/file-search/run-agent-factorial.mjs \
  --split all \
  --repeats 1 \
  --concurrency 2 \
  --results-dir benchmarks/file-search/results/agent-factorial-full-luna
```

The runner allows one to three repeats and at most two concurrent Codex
processes. Each call has a 180-second timeout. A full one-repeat run schedules
72 cases x 4 arms = 288 fresh Agent calls.

Completed rows are appended to `runs.ndjson`. Resume an interrupted run with
the same split, subset, repeats, model inputs, and result directory:

```bash
node benchmarks/file-search/run-agent-factorial.mjs \
  --split all \
  --repeats 1 \
  --concurrency 2 \
  --results-dir benchmarks/file-search/results/agent-factorial-full-luna \
  --resume
```

Resume validates the schedule and all causal-input fingerprints before reusing
rows. It refuses incompatible or duplicate run IDs. The Agent result directory
contains `manifest.json`, `runs.ndjson`, `summary.json`, and `report.md` after a
complete run; during an interrupted run, only the manifest and incremental
NDJSON may exist.

The final report provides both intent-to-treat estimates, where failed runs
score zero, and clean-completed paired estimates. Uncertainty uses 10,000
fixed-seed percentile bootstrap samples over the 12 `conceptId` clusters.

### Completed full run (2026-08-15)

The first preregistered full run completed all 288 fresh Luna calls with no
infrastructure failures. Its immutable inputs were 72 cases, one repeat, the
`gpt-5.6-luna` model, frozen fixture SHA-256
`a8943c8ff6b340f3b05d5947b55a0a7ce90b0eae7a42561135e43ef27142a6c6`,
Skill SHA-256
`9ea2fbb084cd5191709c9cb852d36a7d664cae1055cf464e3db4825ec86066a8`,
and APP MCP dist SHA-256
`0e67c5c13c4ca48b680a06756b49f47ed6df96575cdef6e61eebfd200d25ca2f`.
The decoded Skill text is preserved in
[`frozen/vesti-memory-skill.md`](frozen/vesti-memory-skill.md); its LF-normalized
hash and the original mixed-newline hash are documented beside it.

| Arm | Overall task success | Positive success | Clean-negative FP | Hard-negative FP | Median calls | Median input Tokens | Median duration |
|---|---:|---:|---:|---:|---:|---:|---:|
| Old tools, Skill off | 84.7% | 52/60 (86.7%) | 0/6 | 3/6 | 7 | 78,694 | 27.7 s |
| Old tools, Skill on | 80.6% | 51/60 (85.0%) | 0/6 | 5/6 | 6 | 90,095 | 29.7 s |
| New tool, Skill off | 95.8% | 60/60 (100.0%) | 0/6 | 3/6 | 5 | 74,303 | 25.0 s |
| New tool, Skill on | 93.1% | 58/60 (96.7%) | 0/6 | 3/6 | 4 | 67,069 | 26.9 s |

The marginal **tool effect was +11.8 percentage points** with a 95% clustered
bootstrap interval of **[+7.6, +15.3]**. The current frozen Skill did not add a
measurable quality benefit: its marginal effect was **-3.5 points**
**[-9.7, 0.0]**. The tool-by-Skill interaction was **+1.4 points**
**[-6.9, +9.7]**. In other words, this run supports the new tool, not a claim
that the current Skill text improves success.

A separately versioned post-hoc comparison of the complete integrated arm
(`new-skill-on`) with the legacy baseline (`old-skill-off`) found 93.1%
versus 84.7%, a difference of +8.33 points with clustered 95% CI
[-1.39, +15.28] and exact McNemar p=0.146. It is an observed improvement, not
a statistically significant overall composite effect. See
[`composite-report.md`](results/agent-factorial-v2-final-limit12/composite-report.md).

All clean negatives were rejected correctly, but 14 of 24 hard-negative Agent
runs made an unsupported assertion. Raw deterministic retrieval also returns
related candidates for hard negatives by design; therefore the deterministic
100% result is a positive/clean-negative retrieval gate, not an overall
abstention claim. Hard-negative verification remains a release improvement
area for the Agent instructions.

Artifacts and the complete per-run audit trail are in
[`results/agent-factorial-v2-final-limit12`](results/agent-factorial-v2-final-limit12).
Canonical result directories include SHA-256 inventories and machine-specific
repository/tool installation paths are replaced with explicit placeholders.

## Targeted Skill mechanism evaluation

This study was defined and locked before the first model call. It keeps the
model, fixture, output schema and four-tool VESTI MCP surface identical between
the two arms:

- **B / modern-none:** MCP only, with no Skill text;
- **D / modern-vesti-v3:** the same MCP plus the frozen V3 file-locator Skill.

The 16-case synthetic corpus deliberately enriches four responsibilities of the
Skill: full-condition verification, minimal multi-file sets, project isolation,
and relational abstention. It contains 8 independent concepts, 12 positive
cases and 4 relational negatives. Every positive has one fully supporting
session and three sessions satisfying only two of the three required
conditions. All 16 cases and all failures are reported.

Run the no-call validation first:

```bash
node benchmarks/file-search/targeted-skill-v1/run-agent-targeted.mjs \
  --dataset benchmarks/file-search/targeted-skill-v1/corpus.mjs \
  --max-cases 16 \
  --concurrency 2 \
  --dry-run \
  --results-dir benchmarks/file-search/results/agent-targeted-skill-v1-dryrun
```

The executed 2026-08-16 run completed 32/32 calls with no run-level, MCP,
parse, or cleanup failures. Some runs emitted non-fatal environment messages on
stderr (for example model-list refresh, WebSocket, or telemetry messages), but
all 32 runs completed. The complete method scored **14/16 (87.5%)**, compared
with **12/16 (75.0%)** for the same MCP without the Skill: a paired observed
difference of **+12.5 percentage points**, with 2 D-only wins, 0 losses and 14
ties. Positive exact-set success was 12/12 versus 11/12; actual wrong-file
returns on the four relational negatives were 2/4 versus 3/4.

The concept-cluster bootstrap interval was [0.0,+31.3] percentage points and the
exact paired McNemar p-value was 0.50. This is exploratory mechanism evidence,
not a statistically confirmed overall effect. The distribution is synthetic
and deliberately enriched, the model is `gpt-5.6-luna`, and each arm ran once.
Do not pool these results with the earlier factorial, formal or rapid studies.

Reproduction and audit artifacts:

- [`targeted-skill-v1/PREREGISTRATION.md`](targeted-skill-v1/PREREGISTRATION.md)
- [`targeted-skill-v1/LOCK.json`](targeted-skill-v1/LOCK.json)
- [`TARGETED-RESULTS-ZH.md`](results/agent-targeted-skill-v1-20260816/TARGETED-RESULTS-ZH.md)
- [`manifest.json`](results/agent-targeted-skill-v1-20260816/manifest.json)
- [`summary.json`](results/agent-targeted-skill-v1-20260816/summary.json)
- [`runs.ndjson`](results/agent-targeted-skill-v1-20260816/runs.ndjson)
- [`SHA256SUMS`](results/agent-targeted-skill-v1-20260816/SHA256SUMS)

## Interpretation boundaries

- The corpus is synthetic, inspectable, and versioned. Results are engineering
  regression evidence, not a production-user or hidden-benchmark claim.
- The deterministic legacy arm is a fixed comparison workflow, not an estimate
  of how every historical VESTI Agent behaved.
- Deterministic timing uses in-memory JSON-RPC and excludes model latency,
  filesystem reads, and production stdio/network framing.
- Historical stale-path retrieval does not prove a file currently exists. The
  Agent is explicitly scored on preserving that distinction.
- Model-visible bytes in deterministic runs and model usage Tokens in Agent
  runs are different quantities and must not be compared as if they were the
  same unit.
- The targeted Skill study holds the MCP fixed and estimates only the frozen
  instruction treatment in an intentionally enriched synthetic distribution.
  It does not estimate the average effect for natural user requests, and its
  16 cases must not be pooled with the other datasets.
