# Canonical file-search results

This directory versions the complete audit trails for the reference experiments
described in the benchmark README:

- `baseline-trigram-before-v2/`: diagnostic pre-v2 retrieval baseline;
- `full-v2-release-limit12/`: final 72-case deterministic MCP run at the
  selected session-recall limit;
- `full-v2-release-limit30/`: paired recall-limit ablation;
- `agent-factorial-v2-final-limit12/`: all 288 Luna runs, factorial summary,
  direct integrated-method comparison, and reports;
- `agent-targeted-skill-v1-20260816/`: the complete 16-case, two-arm
  capability-targeted Skill audit trail. This is canonical exploratory
  mechanism evidence, not a confirmatory estimate for naturally distributed
  user queries;
- `agent-rapid-v3-20260816/`: the complete 24-case V3 regression snapshot used
  to verify exact positive sets after the candidate-union fix. It is an
  exploratory engineering regression, not a confirmatory treatment estimate;
- `pilot-*`: the five-case chain smoke test.

Every canonical directory includes its raw NDJSON audit trail and a
`SHA256SUMS` file. Machine-specific repository and Codex installation paths
are replaced with explicit placeholders; synthetic `C:/bench/...` project
paths are part of the fixture and remain unchanged.

Each result is an immutable artifact snapshot. Its manifest hashes identify the
built APP MCP and frozen inputs used for that run. Later source changes do not
retroactively change these results and require a new result directory.

Development, calibration, smoke, and superseded result directories are kept
locally but ignored by Git. The targeted Skill directory above is retained as
an immutable audit snapshot because its tasks and inputs were frozen before the
first model call; its exploratory role remains unchanged. Results from
different directories must not be pooled because their experimental roles,
artifact hashes and, in some cases, corpus versions differ.
