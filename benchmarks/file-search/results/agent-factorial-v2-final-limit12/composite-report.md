# Integrated MCP + Skill comparison

> Post-hoc direct comparison requested after the preregistered 2 x 2
> factorial analysis. It compares the complete new method
> (`new-skill-on`) with the legacy baseline (`old-skill-off`).
> It does not estimate a Tool × Skill synergy; use the factorial
> interaction for that question.

- Bootstrap: 10000 fixed-seed samples over `conceptId` clusters (seed 1828226087)
- Baseline: `old-skill-off`
- Integrated treatment: `new-skill-on`

| Scope | Baseline | Integrated | Delta | 95% cluster CI | McNemar p |
|---|---:|---:|---:|---:|---:|
| All cases | 61/72 (84.7%) | 67/72 (93.1%) | 8.33% | [-1.39%, 15.28%] | 0.145996 |
| All positive cases | 52/60 (86.7%) | 58/60 (96.7%) | 10.00% | [1.67%, 16.67%] | 0.109375 |
| Filename-only | 4/12 (33.3%) | 12/12 (100.0%) | 66.67% | [41.67%, 91.67%] | 0.007813 |
| All negative cases | 9/12 (75.0%) | 9/12 (75.0%) | 0.00% | [-25.00%, 25.00%] | 1.000000 |
| Positive, excluding filename-only | 48/48 (100.0%) | 46/48 (95.8%) | -4.17% | [-12.50%, 0.00%] | 0.500000 |

## Interpretation

- Overall success increased from 84.7% to 93.1% (+8.33 points), but the
  clustered interval includes zero and the exact paired p-value exceeds
  0.05. Do not describe the overall composite effect as statistically
  significant.
- Filename-only retrieval improved from 33.3% to 100.0% and is the one
  stratum with a clear paired improvement in this run.
- Excluding filename-only tasks, positive success changed from 100.0% to
  95.8%; the aggregate improvement is therefore concentrated in filename
  lookup rather than a general Skill synergy.
- The corpus is synthetic and inspectable, uses one model repeat, and has
  12 concept clusters. These are engineering results, not a production-user
  effect claim.
