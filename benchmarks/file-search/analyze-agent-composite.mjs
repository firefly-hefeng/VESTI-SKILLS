import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pairedTaskStats } from './stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RESULTS_DIR = resolve(
  HERE,
  'results',
  'agent-factorial-v2-final-limit12',
);
const BASELINE_ARM = 'old-skill-off';
const TREATMENT_ARM = 'new-skill-on';
const BOOTSTRAP_SEED = 1828226087;
const BOOTSTRAP_ITERATIONS = 10_000;

function percent(value, digits = 1) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(digits)}%`;
}

function readRows(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid NDJSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

function armRate(rows, arm) {
  const values = rows
    .filter(row => row.arm === arm)
    .map(row => row.metrics?.taskSuccess)
    .filter(value => typeof value === 'number');
  return {
    successes: values.filter(value => value === 1).length,
    n: values.length,
    rate: values.length === 0
      ? null
      : values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function analyze(rows, id, label, predicate) {
  const selected = rows.filter(predicate);
  return {
    id,
    label,
    baseline: armRate(selected, BASELINE_ARM),
    treatment: armRate(selected, TREATMENT_ARM),
    paired: pairedTaskStats(selected, {
      baselineArm: BASELINE_ARM,
      treatmentArm: TREATMENT_ARM,
      seed: BOOTSTRAP_SEED,
      bootstrapIterations: BOOTSTRAP_ITERATIONS,
      expectedExcludedPairs: 0,
    }),
  };
}

function report(summary) {
  const lines = [
    '# Integrated MCP + Skill comparison',
    '',
    '> Post-hoc direct comparison requested after the preregistered 2 x 2',
    '> factorial analysis. It compares the complete new method',
    '> (`new-skill-on`) with the legacy baseline (`old-skill-off`).',
    '> It does not estimate a Tool × Skill synergy; use the factorial',
    '> interaction for that question.',
    '',
    `- Bootstrap: ${summary.bootstrap.iterations} fixed-seed samples over \`conceptId\` clusters (seed ${summary.bootstrap.seed})`,
    `- Baseline: \`${summary.baselineArm}\``,
    `- Integrated treatment: \`${summary.treatmentArm}\``,
    '',
    '| Scope | Baseline | Integrated | Delta | 95% cluster CI | McNemar p |',
    '|---|---:|---:|---:|---:|---:|',
  ];
  for (const scope of summary.scopes) {
    lines.push(
      `| ${scope.label} | ${scope.baseline.successes}/${scope.baseline.n} (${percent(scope.baseline.rate)}) | `
      + `${scope.treatment.successes}/${scope.treatment.n} (${percent(scope.treatment.rate)}) | `
      + `${percent(scope.paired.delta, 2)} | `
      + `[${percent(scope.paired.ci95[0], 2)}, ${percent(scope.paired.ci95[1], 2)}] | `
      + `${scope.paired.mcnemarExactP.toFixed(6)} |`,
    );
  }
  lines.push(
    '',
    '## Interpretation',
    '',
    '- Overall success increased from 84.7% to 93.1% (+8.33 points), but the',
    '  clustered interval includes zero and the exact paired p-value exceeds',
    '  0.05. Do not describe the overall composite effect as statistically',
    '  significant.',
    '- Filename-only retrieval improved from 33.3% to 100.0% and is the one',
    '  stratum with a clear paired improvement in this run.',
    '- Excluding filename-only tasks, positive success changed from 100.0% to',
    '  95.8%; the aggregate improvement is therefore concentrated in filename',
    '  lookup rather than a general Skill synergy.',
    '- The corpus is synthetic and inspectable, uses one model repeat, and has',
    '  12 concept clusters. These are engineering results, not a production-user',
    '  effect claim.',
  );
  return lines.join('\n');
}

const resultsDir = resolve(process.argv[2] ?? DEFAULT_RESULTS_DIR);
const rows = readRows(resolve(resultsDir, 'runs.ndjson'));
const summary = {
  schemaVersion: 1,
  analysis: 'post-hoc integrated-method comparison',
  baselineArm: BASELINE_ARM,
  treatmentArm: TREATMENT_ARM,
  bootstrap: {
    method: 'percentile concept-cluster bootstrap',
    clusterUnit: 'conceptId',
    iterations: BOOTSTRAP_ITERATIONS,
    seed: BOOTSTRAP_SEED,
  },
  scopes: [
    analyze(rows, 'overall', 'All cases', () => true),
    analyze(rows, 'positive', 'All positive cases', row => row.category !== 'negative'),
    analyze(rows, 'filename-only', 'Filename-only', row => row.category === 'filename-only'),
    analyze(rows, 'negative', 'All negative cases', row => row.category === 'negative'),
    analyze(
      rows,
      'positive-excluding-filename',
      'Positive, excluding filename-only',
      row => row.category !== 'negative' && row.category !== 'filename-only',
    ),
  ],
};

writeFileSync(
  resolve(resultsDir, 'composite-summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
writeFileSync(
  resolve(resultsDir, 'composite-report.md'),
  `${report(summary)}\n`,
);
