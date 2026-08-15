import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  extractFilePaths,
  searchFiles,
} from '../../packages/vesti-search-files-core/dist/index.js';
import { cases, createDataSource, recall, sessions } from './corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(__dirname, 'results');
const POSITIVE_CASES = cases.filter(testCase => testCase.expected.length > 0);
const REPEATS = 200;

function canonical(file) {
  return file.replace(/\\/g, '/').toLowerCase();
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
}

function measure(run) {
  for (let i = 0; i < 20; i += 1) run();
  const samples = [];
  let result;
  for (let i = 0; i < REPEATS; i += 1) {
    const started = performance.now();
    result = run();
    samples.push((performance.now() - started) * 1000);
  }
  return {
    result,
    latency_us: {
      median: Number(percentile(samples, 0.5).toFixed(2)),
      p95: Number(percentile(samples, 0.95).toFixed(2)),
    },
  };
}

function legacyWorkflow(query, topK = 10) {
  const hits = recall(query, 12);
  const trace = [];
  const searchResult = hits.map(({ session, score }) => ({
    session_id: session.id,
    title: session.title,
    project: session.projectPath,
    score,
  }));
  trace.push({ tool: 'vesti_search', args: { query, topK: 12 }, result: searchResult });

  const files = new Map();
  for (const { session } of hits) {
    const timeline = [{
      sequence: 1,
      user_intent: session.searchText,
      tool_execution_count: session.toolInputs.length,
    }];
    trace.push({
      tool: 'vesti_timeline',
      args: { session_id: session.id },
      result: timeline,
    });

    const turns = [{
      sequence: 1,
      user_input: session.searchText,
      assistant_response: `Completed work for ${session.title}.`,
      tool_calls: session.toolInputs,
    }];
    trace.push({
      tool: 'vesti_get_turns',
      args: { session_id: session.id, turn_ids: [1] },
      result: turns,
    });

    const candidates = [
      ...session.keyFiles,
      ...session.toolInputs.flatMap(row => extractFilePaths(row.inputSummary)),
    ];
    for (const file of candidates) {
      const key = canonical(file);
      const existing = files.get(key);
      if (!existing) {
        files.set(key, {
          path: file.replace(/\\/g, '/'),
          projects: new Set([session.projectPath]),
          sessions: new Set([session.id]),
        });
      } else {
        existing.projects.add(session.projectPath);
        existing.sessions.add(session.id);
      }
    }
  }

  const results = [...files.values()].slice(0, topK).map(file => ({
    path: file.path,
    projects: [...file.projects],
    sessions: [...file.sessions],
  }));
  return {
    results,
    tool_calls: trace.length,
    context_chars: trace.reduce((total, item) => total + JSON.stringify(item.result).length, 0),
    trace,
  };
}

function fileLookup(query, topK = 10) {
  const payload = searchFiles(createDataSource(), { query, topK });
  const trace = [{
    tool: 'vesti_search_files',
    args: { query, topK },
    result: payload,
  }];
  return {
    results: payload.results.map(result => ({
      path: result.path,
      projects: result.projects,
      sessions: result.sessions.map(session => session.session_id),
      matched_via: result.matched_via,
      score: result.score,
    })),
    tool_calls: 1,
    context_chars: JSON.stringify(payload).length,
    trace,
  };
}

function score(testCase, run) {
  const expected = new Set(testCase.expected.map(canonical));
  const ranked = run.results.map(result => canonical(result.path));
  const ranks = ranked
    .map((file, index) => expected.has(file) ? index + 1 : null)
    .filter(rank => rank != null);
  const firstRank = ranks.length > 0 ? Math.min(...ranks) : null;
  const expectedAt3 = ranked.slice(0, 3).filter(file => expected.has(file));
  const isNegative = expected.size === 0;

  const expectedProjectByFile = new Map(testCase.expected.map((file, index) => [
    canonical(file),
    canonical(testCase.expectedProjects[Math.min(index, testCase.expectedProjects.length - 1)] ?? ''),
  ]));
  const expectedSessionByFile = new Map(testCase.expected.map((file, index) => [
    canonical(file),
    testCase.expectedSessions[Math.min(index, testCase.expectedSessions.length - 1)] ?? '',
  ]));
  const matchedResults = run.results.filter(result => expected.has(canonical(result.path)));
  const projectCorrect = matchedResults.every(result => {
    const project = expectedProjectByFile.get(canonical(result.path));
    return !project || result.projects.map(canonical).includes(project);
  });
  const evidenceCorrect = matchedResults.every(result => {
    const sessionId = expectedSessionByFile.get(canonical(result.path));
    return !sessionId || result.sessions.includes(sessionId);
  });

  return {
    ranked_paths: run.results.map(result => result.path),
    hit_at_1: isNegative ? null : Number(firstRank === 1),
    hit_at_3: isNegative ? null : Number(firstRank != null && firstRank <= 3),
    recall_at_3: isNegative ? null : expectedAt3.length / expected.size,
    reciprocal_rank: isNegative || firstRank == null ? 0 : 1 / firstRank,
    negative_false_positive: isNegative ? Number(ranked.length > 0) : null,
    project_accuracy: isNegative ? null : Number(matchedResults.length === expected.size && projectCorrect),
    evidence_accuracy: isNegative ? null : Number(matchedResults.length === expected.size && evidenceCorrect),
    tool_calls: run.tool_calls,
    context_chars: run.context_chars,
  };
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(caseResults, arm) {
  const positive = caseResults.filter(row => row.expected.length > 0).map(row => row[arm].metrics);
  const negative = caseResults.filter(row => row.expected.length === 0).map(row => row[arm].metrics);
  const all = caseResults.map(row => row[arm].metrics);
  return {
    hit_at_1: average(positive.map(metric => metric.hit_at_1)),
    hit_at_3: average(positive.map(metric => metric.hit_at_3)),
    recall_at_3: average(positive.map(metric => metric.recall_at_3)),
    mrr: average(positive.map(metric => metric.reciprocal_rank)),
    project_accuracy: average(positive.map(metric => metric.project_accuracy)),
    evidence_accuracy: average(positive.map(metric => metric.evidence_accuracy)),
    negative_fpr: average(negative.map(metric => metric.negative_false_positive)),
    avg_tool_calls: average(all.map(metric => metric.tool_calls)),
    avg_context_chars: average(all.map(metric => metric.context_chars)),
    latency_us_median: average(caseResults.map(row => row[arm].latency_us.median)),
    latency_us_p95: average(caseResults.map(row => row[arm].latency_us.p95)),
  };
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function renderMarkdown(report) {
  const lines = [
    '# File-search pilot report',
    '',
    `Generated: ${report.generated_at}`,
    '',
    '> Synthetic smoke test only. It validates the measurement chain; it is not a statistically significant product claim.',
    '',
    '| Case | Expected | Legacy Top 3 | File lookup Top 3 | A calls/chars | B calls/chars |',
    '|---|---|---|---|---:|---:|',
  ];
  for (const row of report.cases) {
    lines.push(`| ${row.id} | ${row.expected.join('<br>') || '(none)'} | ${row.baseline.metrics.ranked_paths.slice(0, 3).join('<br>') || '(none)'} | ${row.treatment.metrics.ranked_paths.slice(0, 3).join('<br>') || '(none)'} | ${row.baseline.metrics.tool_calls} / ${row.baseline.metrics.context_chars} | ${row.treatment.metrics.tool_calls} / ${row.treatment.metrics.context_chars} |`);
  }
  lines.push(
    '',
    '## Summary',
    '',
    '| Metric | A — legacy | B — file lookup |',
    '|---|---:|---:|',
    `| Hit@1 | ${percent(report.summary.baseline.hit_at_1)} | ${percent(report.summary.treatment.hit_at_1)} |`,
    `| Hit@3 | ${percent(report.summary.baseline.hit_at_3)} | ${percent(report.summary.treatment.hit_at_3)} |`,
    `| Recall@3 | ${percent(report.summary.baseline.recall_at_3)} | ${percent(report.summary.treatment.recall_at_3)} |`,
    `| MRR | ${report.summary.baseline.mrr.toFixed(3)} | ${report.summary.treatment.mrr.toFixed(3)} |`,
    `| Project accuracy | ${percent(report.summary.baseline.project_accuracy)} | ${percent(report.summary.treatment.project_accuracy)} |`,
    `| Evidence accuracy | ${percent(report.summary.baseline.evidence_accuracy)} | ${percent(report.summary.treatment.evidence_accuracy)} |`,
    `| Negative FPR | ${percent(report.summary.baseline.negative_fpr)} | ${percent(report.summary.treatment.negative_fpr)} |`,
    `| Average visible tool calls | ${report.summary.baseline.avg_tool_calls.toFixed(2)} | ${report.summary.treatment.avg_tool_calls.toFixed(2)} |`,
    `| Average result characters | ${report.summary.baseline.avg_context_chars.toFixed(0)} | ${report.summary.treatment.avg_context_chars.toFixed(0)} |`,
    `| Mean of per-case median latency | ${report.summary.baseline.latency_us_median.toFixed(2)} µs | ${report.summary.treatment.latency_us_median.toFixed(2)} µs |`,
    '',
    'The stale-history case only verifies retrieval. Whether the historical path still exists must be checked by an Agent in the filesystem phase.',
    '',
  );
  return lines.join('\n');
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function renderCsv(report) {
  const columns = [
    'case_id', 'arm', 'query', 'expected', 'ranked_paths', 'hit_at_1', 'hit_at_3',
    'recall_at_3', 'reciprocal_rank', 'negative_false_positive', 'project_accuracy',
    'evidence_accuracy', 'tool_calls', 'context_chars', 'latency_median_us', 'latency_p95_us',
  ];
  const rows = [columns.join(',')];
  for (const testCase of report.cases) {
    for (const arm of ['baseline', 'treatment']) {
      const result = testCase[arm];
      const values = [
        testCase.id,
        arm,
        testCase.query,
        testCase.expected.join('|'),
        result.metrics.ranked_paths.join('|'),
        result.metrics.hit_at_1 ?? '',
        result.metrics.hit_at_3 ?? '',
        result.metrics.recall_at_3 ?? '',
        result.metrics.reciprocal_rank,
        result.metrics.negative_false_positive ?? '',
        result.metrics.project_accuracy ?? '',
        result.metrics.evidence_accuracy ?? '',
        result.metrics.tool_calls,
        result.metrics.context_chars,
        result.latency_us.median,
        result.latency_us.p95,
      ];
      rows.push(values.map(csvCell).join(','));
    }
  }
  return `${rows.join('\n')}\n`;
}

const caseResults = cases.map(testCase => {
  const baselineRun = measure(() => legacyWorkflow(testCase.query));
  const treatmentRun = measure(() => fileLookup(testCase.query));
  return {
    id: testCase.id,
    query: testCase.query,
    expected: testCase.expected,
    expected_projects: testCase.expectedProjects,
    expected_sessions: testCase.expectedSessions,
    historical_path_exists: testCase.historicalPathExists ?? null,
    note: testCase.note,
    baseline: {
      metrics: score(testCase, baselineRun.result),
      latency_us: baselineRun.latency_us,
      trace: baselineRun.result.trace,
    },
    treatment: {
      metrics: score(testCase, treatmentRun.result),
      latency_us: treatmentRun.latency_us,
      trace: treatmentRun.result.trace,
    },
  };
});

const report = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  corpus: {
    sessions: sessions.length,
    cases: cases.length,
    positive_cases: POSITIVE_CASES.length,
    synthetic: true,
    repeated_latency_runs: REPEATS,
  },
  arms: {
    baseline: 'legacy vesti_search -> vesti_timeline -> vesti_get_turns upper-bound simulation',
    treatment: 'single vesti_search_files call through @vesti/search-files-core',
  },
  cases: caseResults,
  summary: {
    baseline: summarize(caseResults, 'baseline'),
    treatment: summarize(caseResults, 'treatment'),
  },
};

fs.mkdirSync(resultsDir, { recursive: true });
fs.writeFileSync(path.join(resultsDir, 'pilot-results.json'), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(resultsDir, 'pilot-results.csv'), renderCsv(report));
fs.writeFileSync(path.join(resultsDir, 'pilot-report.md'), `${renderMarkdown(report)}\n`);

console.log(renderMarkdown(report));
