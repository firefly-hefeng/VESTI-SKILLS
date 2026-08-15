# VESTI file-search Agent factorial experiment

- Mode: **executed**
- Dataset: `vesti-file-search-large-v2`, split `all`, 72 cases × 1 repeat(s) × 4 arms
- Model: `gpt-5.6-luna`; concurrency 2
- Frozen fixture SHA-256: `a8943c8ff6b340f3b05d5947b55a0a7ce90b0eae7a42561135e43ef27142a6c6`
- Skill SHA-256: `9ea2fbb084cd5191709c9cb852d36a7d664cae1055cf464e3db4825ec86066a8`
- APP MCP dist SHA-256: `0e67c5c13c4ca48b680a06756b49f47ed6df96575cdef6e61eebfd200d25ca2f`

## Arms

| Arm | Tool surface | Skill | N | Completed | Task success | Hit@3 | Recall@5 | Project | Evidence | Historical | Return precision | Unsupported | Negative FP | Calls | Input tokens | Duration ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| old-skill-off | old | off | 72 | 72 | 84.7% | 86.7% | 86.7% | 86.7% | 86.7% | 86.7% | 86.7% | 0.0% | 25.0% | 7.0 | 78694 | 27655.6 |
| old-skill-on | old | on | 72 | 72 | 80.6% | 85.0% | 85.0% | 85.0% | 85.0% | 85.0% | 85.0% | 0.0% | 41.7% | 6.0 | 90095 | 29651.3 |
| new-skill-off | new | off | 72 | 72 | 95.8% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 25.0% | 5.0 | 74303 | 24988.3 |
| new-skill-on | new | on | 72 | 72 | 93.1% | 96.7% | 96.7% | 96.7% | 96.7% | 96.7% | 96.7% | 3.3% | 25.0% | 4.0 | 67069 | 26868.2 |

## Factorial task-success contrasts

Uncertainty uses a fixed-seed percentile bootstrap over `conceptId` clusters (10000 iterations, seed 1828226087).

### ITT paired estimate (failures = 0)

Intent-to-treat paired estimate: every four-arm scheduled block is retained and failed/non-numeric runs score taskSuccess=0.

Paired blocks: 72/72; excluded: 0; conceptId clusters: 12.

| Contrast | Point estimate | 95% cluster-bootstrap CI |
|---|---:|---:|
| Tool effect, Skill off (new - old) | 11.1% | [6.9%, 15.3%] |
| Tool effect, Skill on (new - old) | 12.5% | [5.6%, 19.4%] |
| Skill effect, old tool (on - off) | -4.2% | [-8.3%, 0.0%] |
| Skill effect, new tool (on - off) | -2.8% | [-12.5%, 4.2%] |
| Marginal tool effect | 11.8% | [7.6%, 15.3%] |
| Marginal Skill effect | -3.5% | [-9.7%, 0.0%] |
| Tool x Skill interaction | 1.4% | [-6.9%, 9.7%] |

### Clean-completed paired estimate

Clean-completed paired estimate: includes only blocks where all four arms have status=completed, no error, and numeric taskSuccess.

Paired blocks: 72/72; excluded: 0; conceptId clusters: 12.

| Contrast | Point estimate | 95% cluster-bootstrap CI |
|---|---:|---:|
| Tool effect, Skill off (new - old) | 11.1% | [6.9%, 15.3%] |
| Tool effect, Skill on (new - old) | 12.5% | [5.6%, 19.4%] |
| Skill effect, old tool (on - off) | -4.2% | [-8.3%, 0.0%] |
| Skill effect, new tool (on - off) | -2.8% | [-12.5%, 4.2%] |
| Marginal tool effect | 11.8% | [7.6%, 15.3%] |
| Marginal Skill effect | -3.5% | [-9.7%, 0.0%] |
| Tool x Skill interaction | 1.4% | [-6.9%, 9.7%] |


## Boundaries

- Every task/arm/repeat uses a fresh ephemeral Codex process and its own byte-identical database copy.
- The Agent prompt contains the query, neutral rules, and (only in Skill-on arms) the frozen SKILL.md; gold labels are scored only after the process exits.
- Shell, plugins, user config, project rules and web retrieval are excluded. Only the arm-specific VESTI MCP tools are enabled.
- For positive cases, a returned file is supported only when path and project match one gold target and every reported evidence session ID belongs to that target; Task success requires zero unsupported returns.
- Negative cases are evaluated with negative false-positive rate rather than returned-file precision.
- This inspectable synthetic corpus is an engineering benchmark, not a hidden production holdout.
