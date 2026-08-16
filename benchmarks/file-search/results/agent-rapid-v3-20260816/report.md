# VESTI file-search rapid B/D engineering pilot

> Exploratory rapid engineering validation only. This 24-case, single-repeat pilot is not confirmatory evidence and must not be reported as proof of statistical significance.

- Mode: **executed**
- Dataset: vesti-file-search-rapid-v3; 24 cases × 1 repeat × 2 arms = 48 runs
- Model: gpt-5.6-luna; concurrency 2
- Fixture SHA-256: dc0c42069c605cbebff489d6b4bfc481b950039e64df9e8b4cc8ec7c1b34c33b
- V3 Skill SHA-256: f428864022e0f42904e9aafec10a935d44f17bf2743beedd2d21c0384a81ad91
- APP MCP dist SHA-256: aaeb73e447aea2f2641e3e1bc8f2e26a771581eb5e437f803c146b2ac83502bb

## Aggregate

| Arm | Exact success | Retrieval exact | Completed | Actual wrong-file returns | Tool calls | Input tokens | Duration (s) |
|---|---:|---:|---:|---:|---:|---:|---:|
| B: modern-none | 95.8% | 95.8% | 24/24 | 1 (16.7%) | 182 | 2060476 | 712.9 |
| D: modern-vesti-v3 | 95.8% | 95.8% | 24/24 | 1 (16.7%) | 146 | 2161987 | 738.4 |

## Paired direction

- D wins / losses / ties: **0 / 0 / 24**.
- Exact-success D − B: **0.0%**, descriptive cluster-bootstrap 95% CI [0.0%, 0.0%], exact paired McNemar p=1.0000.
- Retrieval-exact D − B: **0.0%**, descriptive cluster-bootstrap 95% CI [0.0%, 0.0%].
- All uncertainty diagnostics are exploratory because this is a small, single-repeat pilot.

## Categories

| Category | B exact | D exact | D wins | D losses | Ties |
|---|---:|---:|---:|---:|---:|
| cross-project | 100.0% | 100.0% | 0 | 0 | 4 |
| filename-only | 100.0% | 100.0% | 0 | 0 | 4 |
| multi-file | 100.0% | 100.0% | 0 | 0 | 4 |
| negative | 83.3% | 83.3% | 0 | 0 | 6 |
| semantic-single | 100.0% | 100.0% | 0 | 0 | 4 |
| stale-path | 100.0% | 100.0% | 0 | 0 | 2 |

## Negative safety

| Arm | Negative N | Affirmative FP | Actual wrong-file returns |
|---|---:|---:|---:|
| modern-none | 6 | 16.7% | 1 (16.7%) |
| modern-vesti-v3 | 6 | 16.7% | 1 (16.7%) |

## Boundaries

- B and D receive the identical four-tool VESTI MCP surface. Only D receives the frozen V3 Skill.
- Each case/arm uses a fresh ephemeral Codex process and a byte-identical fixture database copy.
- Shell, web, apps, plugins, user config and repository rules are excluded.
- Positive success requires the exact complete gold file set, zero extras, correct project, supporting session evidence, and historical_only=true.
- Negative success requires answerable=false and files=[]; actual wrong-file FP separately counts responses returning paths.
- Results are reported regardless of direction and may not be tuned after inspection.
