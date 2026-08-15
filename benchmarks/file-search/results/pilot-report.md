# File-search pilot report

Generated: 2026-08-15T05:04:15.384Z

> Synthetic smoke test only. It validates the measurement chain; it is not a statistically significant product claim.

| Case | Expected | Legacy Top 3 | File lookup Top 3 | A calls/chars | B calls/chars |
|---|---|---|---|---:|---:|
| P1-semantic | apps/desktop/src/auth/oauthCallback.ts | apps/desktop/src/auth/oauthCallback.ts | apps/desktop/src/auth/oauthCallback.ts | 3 / 548 | 1 / 332 |
| P2-filename-only | src/membership/billingRules.ts | (none) | src/membership/billingRules.ts | 1 / 2 | 1 / 309 |
| P3-cross-project | packages/capture-core/src/adapters/codex/parser.ts<br>packages/core/src/adapters/codex/parser.ts | packages/core/src/adapters/codex/parser.ts<br>packages/capture-core/src/adapters/codex/parser.ts | src/ui/dashboard/TokenChart.tsx<br>packages/core/src/adapters/codex/parser.ts<br>packages/capture-core/src/adapters/codex/parser.ts | 5 / 1103 | 1 / 908 |
| P4-stale-history | src/export/legacyObsidianExporter.ts | src/export/legacyObsidianExporter.ts | src/export/legacyObsidianExporter.ts | 3 / 533 | 1 / 343 |
| P5-negative | (none) | (none) | (none) | 1 / 2 | 1 / 57 |

## Summary

| Metric | A — legacy | B — file lookup |
|---|---:|---:|
| Hit@1 | 75.0% | 75.0% |
| Hit@3 | 75.0% | 100.0% |
| Recall@3 | 75.0% | 100.0% |
| MRR | 0.750 | 0.875 |
| Project accuracy | 75.0% | 100.0% |
| Evidence accuracy | 75.0% | 100.0% |
| Negative FPR | 0.0% | 0.0% |
| Average visible tool calls | 2.60 | 1.00 |
| Average result characters | 438 | 390 |
| Mean of per-case median latency | 5.78 µs | 14.34 µs |

The stale-history case only verifies retrieval. Whether the historical path still exists must be checked by an Agent in the filesystem phase.
