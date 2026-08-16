# VESTI targeted Skill capability B/D engineering study

> Pre-defined synthetic enriched capability study: 16 cases, one repeat and two matched arms. It estimates Skill behavior only in the targeted scenarios and is not evidence of overall or production-wide superiority.

- Mode: **executed**
- Dataset: vesti-file-search-targeted-skill-v1; 16 cases × 1 repeat × 2 arms = 32 runs
- Model: gpt-5.6-luna; concurrency 2
- Fixture SHA-256: 92943e9e4da4f2b141197295cdf5b4fcdec599d7dabd87e03692089b79a567a7
- V3 Skill SHA-256: f428864022e0f42904e9aafec10a935d44f17bf2743beedd2d21c0384a81ad91
- APP MCP dist SHA-256: aaeb73e447aea2f2641e3e1bc8f2e26a771581eb5e437f803c146b2ac83502bb

## Aggregate

| Arm | Exact success | Retrieval exact | Completed | Actual wrong-file returns | Tool calls | Input tokens | Duration (s) |
|---|---:|---:|---:|---:|---:|---:|---:|
| B: modern-none | 75.0% | 75.0% | 16/16 | 3 (75.0%) | 142 | 1851957 | 637.7 |
| D: modern-vesti-v3 | 87.5% | 87.5% | 16/16 | 2 (50.0%) | 134 | 1862114 | 663.2 |

## Paired direction

- D wins / losses / ties: **2 / 0 / 14**.
- Exact-success D − B: **12.5%**, descriptive cluster-bootstrap 95% CI [0.0%, 31.3%], exact paired McNemar p=0.5000.
- Retrieval-exact D − B: **12.5%**, descriptive cluster-bootstrap 95% CI [0.0%, 31.3%].
- All uncertainty diagnostics are exploratory because this is a small, single-repeat targeted capability study.

## Categories

| Category | B exact | D exact | D wins | D losses | Ties |
|---|---:|---:|---:|---:|---:|
| minimal-multi-file | 75.0% | 100.0% | 1 | 0 | 3 |
| project-isolation | 100.0% | 100.0% | 0 | 0 | 4 |
| relational-negative | 25.0% | 50.0% | 1 | 0 | 3 |
| triple-single | 100.0% | 100.0% | 0 | 0 | 4 |

## Negative safety

| Arm | Negative N | Affirmative FP | Actual wrong-file returns |
|---|---:|---:|---:|
| modern-none | 4 | 75.0% | 3 (75.0%) |
| modern-vesti-v3 | 4 | 50.0% | 2 (50.0%) |

## Boundaries

- B and D receive the identical four-tool VESTI MCP surface. Only D receives the frozen V3 Skill.
- Each case/arm uses a fresh ephemeral Codex process and a byte-identical fixture database copy.
- Shell, web, apps, plugins, user config and repository rules are excluded.
- Positive success requires the exact complete gold file set, zero extras, correct project, supporting session evidence, and historical_only=true.
- Negative success requires answerable=false and files=[]; actual wrong-file FP separately counts responses returning paths.
- The task definitions, scoring and complete 16-case set are fixed before model execution; results are reported regardless of direction and may not be tuned after inspection.
- The synthetic corpus is deliberately enriched for Skill-relevant ambiguity, evidence verification, minimal-set and abstention decisions; results must not be generalized to the overall task distribution.
