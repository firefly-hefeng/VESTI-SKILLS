import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { extractFilePaths } from '@vesti/search-files-core';

import {
  cases,
  DATASET_ID,
  DATASET_SEED,
  datasetIntegrity,
  projects,
  sessions,
} from './large-corpus.mjs';
import { buildFixtureDb } from './build-fixture.mjs';
import {
  pairedTaskStats,
  summarizeArm,
  summarizeBy,
} from './stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MCP_ENTRY = resolve(HERE, '..', '..', '..', 'VESTI-APP', 'packages', 'vesti-mcp', 'dist', 'index.js');
const DEFAULT_RESULTS_DIR = resolve(HERE, 'results');
const MAX_BASELINE_SESSIONS = 5;
const RESULT_LIMIT = 10;
const EVALUATION_K = 5;
const CALL_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const options = {
    mcpEntry: DEFAULT_MCP_ENTRY,
    resultsDir: DEFAULT_RESULTS_DIR,
    repeats: 10,
    warmups: 2,
    split: 'all',
    searchFilesRecallLimit: 12,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--mcp-entry' && next) {
      options.mcpEntry = resolve(next);
      index += 1;
    } else if (arg === '--results-dir' && next) {
      options.resultsDir = resolve(next);
      index += 1;
    } else if (arg === '--repeats' && next) {
      options.repeats = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--warmups' && next) {
      options.warmups = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--split' && next) {
      options.split = next;
      index += 1;
    } else if (arg === '--search-files-recall-limit' && next) {
      options.searchFilesRecallLimit = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node run-mcp-large.mjs [options]',
        '  --mcp-entry <path>   built VESTI MCP public entry',
        '  --results-dir <dir>  artifact directory',
        '  --repeats <n>        timed repetitions per case (default 10)',
        '  --warmups <n>        discarded warm-up repetitions (default 2)',
        '  --split <name|all>   dev, test, provisional-holdout, or all',
        '  --search-files-recall-limit <12|30>  internal session candidate cap',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 20) {
    throw new Error('--repeats must be an integer from 1 to 20');
  }
  if (!Number.isInteger(options.warmups) || options.warmups < 0 || options.warmups > 10) {
    throw new Error('--warmups must be an integer from 0 to 10');
  }
  if (![12, 30].includes(options.searchFilesRecallLimit)) {
    throw new Error('--search-files-recall-limit must be 12 or 30');
  }
  return options;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sha256Directory(directory) {
  const files = [];
  const visit = current => {
    for (const name of readdirSync(current).sort()) {
      const absolute = resolve(current, name);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else files.push(absolute);
    }
  };
  visit(directory);
  const hashes = files.map(file => ({
    path: file.slice(directory.length + 1).replaceAll('\\', '/'),
    sha256: sha256File(file),
  }));
  const sha256 = createHash('sha256');
  for (const entry of hashes) sha256.update(`${entry.path}\0${entry.sha256}\n`);
  return { sha256: sha256.digest('hex'), files: hashes };
}

function gitCommit(repository) {
  try {
    return execFileSync(
      'git',
      ['-c', `safe.directory=${repository.replaceAll('\\', '/')}`, 'rev-parse', 'HEAD'],
      { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return null;
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function canonicalProject(projectPath) {
  return String(projectPath ?? '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function canonicalFile(filePath, projectPath = '') {
  const normalized = String(filePath ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/[.,;:)\]]+$/, '');
  return /^[a-z]:\//i.test(projectPath) ? normalized.toLowerCase() : normalized;
}

function candidatePathMatchesTarget(candidate, target) {
  const expectedPath = canonicalFile(target.path, target.projectPath);
  return canonicalFile(candidate.path, target.projectPath) === expectedPath;
}

function candidateProjectMatchesTarget(candidate, target) {
  if (!candidatePathMatchesTarget(candidate, target)) return false;
  const expectedProject = canonicalProject(target.projectPath);
  return candidate.projects.some(project => canonicalProject(project) === expectedProject);
}

function scoreCase(testCase, rankedResults, error = null) {
  const targets = testCase.targets;
  const top = rankedResults.slice(0, EVALUATION_K);
  if (testCase.mustAbstain) {
    const falsePositive = rankedResults.length > 0 ? 1 : 0;
    const scoredForPrimary = testCase.negativeKind !== 'hard';
    return {
      hit1: null,
      hit3: null,
      hit5: null,
      recall5: null,
      allTargets5: null,
      mrr: null,
      projectAccuracy: null,
      evidenceAccuracy: null,
      negativeFalsePositive: falsePositive,
      // A hard negative deliberately shares a broad topic. At the retrieval
      // layer, returning a lead is not yet an Agent hallucination, so keep its
      // raw no-result rate as a pressure metric and score assertion behavior
      // only in the later Agent experiment.
      taskSuccess: scoredForPrimary
        ? (error == null && falsePositive === 0 ? 1 : 0)
        : null,
    };
  }

  const ranks = targets.map(target => rankedResults.findIndex(candidate => candidatePathMatchesTarget(candidate, target)) + 1);
  const foundAt = k => ranks.some(rank => rank > 0 && rank <= k) ? 1 : 0;
  const recalled = ranks.filter(rank => rank > 0 && rank <= EVALUATION_K).length;
  const allTargets5 = recalled === targets.length ? 1 : 0;
  const firstRank = ranks.filter(rank => rank > 0).sort((a, b) => a - b)[0] ?? 0;

  const projectCorrect = targets.filter(target =>
    top.some(candidate => candidateProjectMatchesTarget(candidate, target)),
  ).length;
  const evidenceCorrect = targets.filter(target => {
    const candidate = top.find(result => candidateProjectMatchesTarget(result, target));
    if (!candidate) return false;
    const candidateSessions = new Set(candidate.sessions.map(session => session.session_id));
    return target.sessionIds.some(sessionId => candidateSessions.has(sessionId));
  }).length;

  const projectAccuracy = targets.length === 0 ? null : projectCorrect / targets.length;
  const evidenceAccuracy = targets.length === 0 ? null : evidenceCorrect / targets.length;
  return {
    hit1: foundAt(1),
    hit3: foundAt(3),
    hit5: foundAt(5),
    recall5: targets.length === 0 ? null : recalled / targets.length,
    allTargets5,
    mrr: firstRank === 0 ? 0 : 1 / firstRank,
    projectAccuracy,
    evidenceAccuracy,
    negativeFalsePositive: null,
    taskSuccess:
      error == null &&
      allTargets5 === 1 &&
      projectAccuracy === 1 &&
      evidenceAccuracy === 1
        ? 1
        : 0,
  };
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function instrumentTransport(transport, direction, state) {
  const original = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if (state.measuring) {
      const serializedBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
      state.events.push({
        direction,
        serializedBytes,
        method: message?.method ?? null,
        id: message?.id ?? null,
        timestampNs: process.hrtime.bigint().toString(),
      });
    }
    return original(message, options);
  };
}

function resultText(result) {
  const text = result?.content?.find(item => item?.type === 'text')?.text;
  return typeof text === 'string' ? text : '';
}

async function callJson(client, name, args, trace) {
  trace.toolCalls += 1;
  trace.callsByName[name] = (trace.callsByName[name] ?? 0) + 1;
  const started = process.hrtime.bigint();
  let result;
  try {
    result = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
    );
  } finally {
    trace.callLatenciesMs.push({
      name,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    });
  }
  const text = resultText(result);
  trace.modelVisiblePayloadBytes += Buffer.byteLength(text, 'utf8');
  if (result?.isError) throw new Error(`${name}: ${text || 'unknown MCP error'}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mergeCandidate(accumulator, { path, project, sessionId, title, matchedVia = [] }) {
  const key = `${canonicalProject(project)}|${canonicalFile(path, project)}`;
  let entry = accumulator.get(key);
  if (!entry) {
    entry = {
      path: String(path).replaceAll('\\', '/'),
      projects: [],
      sessions: [],
      matched_via: [...matchedVia],
    };
    accumulator.set(key, entry);
  }
  if (project && !entry.projects.includes(project)) entry.projects.push(project);
  if (sessionId && !entry.sessions.some(session => session.session_id === sessionId)) {
    entry.sessions.push({ session_id: sessionId, title: title ?? '' });
  }
  for (const source of matchedVia) {
    if (!entry.matched_via.includes(source)) entry.matched_via.push(source);
  }
}

async function runLegacy(client, testCase, trace) {
  const search = await callJson(client, 'vesti_search', {
    query: testCase.query,
    topK: RESULT_LIMIT,
  }, trace);
  const candidates = new Map();
  const selected = (search.results ?? []).slice(0, MAX_BASELINE_SESSIONS);
  for (const hit of selected) {
    const timeline = await callJson(client, 'vesti_timeline', {
      session_id: hit.session_id,
    }, trace);
    const turnIds = (timeline.turns ?? []).map(turn => turn.seq);
    if (turnIds.length === 0) continue;
    const turns = await callJson(client, 'vesti_get_turns', {
      session_id: hit.session_id,
      turn_ids: turnIds,
      max_chars: 8000,
    }, trace);
    for (const turn of turns.turns ?? []) {
      for (const tool of turn.tools ?? []) {
        for (const filePath of extractFilePaths(tool.input_summary ?? '')) {
          mergeCandidate(candidates, {
            path: filePath,
            project: hit.project_path,
            sessionId: hit.session_id,
            title: hit.title,
            matchedVia: ['session-content'],
          });
        }
      }
    }
  }
  return [...candidates.values()].slice(0, RESULT_LIMIT);
}

async function runSearchFiles(client, testCase, trace) {
  const payload = await callJson(client, 'vesti_search_files', {
    query: testCase.query,
    topK: RESULT_LIMIT,
  }, trace);
  return (payload.results ?? []).map(result => ({
    path: result.path,
    projects: Array.isArray(result.projects) ? result.projects : [],
    sessions: Array.isArray(result.sessions) ? result.sessions : [],
    matched_via: Array.isArray(result.matched_via) ? result.matched_via : [],
    score: result.score,
    touches: result.touches,
    last_touched: result.last_touched,
  }));
}

async function executeArm({ arm, testCase, dbPath, mcpModule, searchFilesRecallLimit }) {
  const state = { measuring: false, events: [] };
  let db;
  let server;
  let client;
  const trace = {
    toolCalls: 0,
    callsByName: {},
    modelVisiblePayloadBytes: 0,
    callLatenciesMs: [],
  };
  let rankedResults = [];
  let error = null;
  let internalRecallTrace = null;
  const started = process.hrtime.bigint();
  try {
    db = mcpModule.openVestiDb(dbPath);
    db.exec('PRAGMA query_only = ON');
    server = mcpModule.createVestiMcpServer(db, {
      fileSearchSessionRecallLimit: searchFilesRecallLimit,
      onFileSearchTrace: value => { internalRecallTrace = value; },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    instrumentTransport(clientTransport, 'client-to-server', state);
    instrumentTransport(serverTransport, 'server-to-client', state);
    client = new Client({ name: 'vesti-file-search-benchmark', version: '0.1.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    state.measuring = true;
    const armStarted = process.hrtime.bigint();
    rankedResults = arm === 'legacy'
      ? await runLegacy(client, testCase, trace)
      : await runSearchFiles(client, testCase, trace);
    trace.armLatencyMs = Number(process.hrtime.bigint() - armStarted) / 1e6;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    trace.armLatencyMs = Number(process.hrtime.bigint() - started) / 1e6;
  } finally {
    state.measuring = false;
    await client?.close().catch(() => {});
    await server?.close().catch(() => {});
    try { db?.close(); } catch { /* keep the original arm error */ }
  }

  trace.jsonrpcRequestBytes = state.events
    .filter(event => event.direction === 'client-to-server')
    .reduce((sum, event) => sum + event.serializedBytes, 0);
  trace.jsonrpcResponseBytes = state.events
    .filter(event => event.direction === 'server-to-client')
    .reduce((sum, event) => sum + event.serializedBytes, 0);
  trace.events = state.events;
  trace.internalRecallTrace = internalRecallTrace;
  return { rankedResults, trace, error };
}

function aggregateRepeats(testCase, arm, repeatRuns) {
  const first = repeatRuns[0];
  const signatures = new Set(repeatRuns.map(run => JSON.stringify(run.rankedResults)));
  const errors = repeatRuns.map(run => run.error).filter(Boolean);
  const error = errors[0] ?? null;
  const metrics = scoreCase(testCase, first.rankedResults, error);
  return {
    caseId: testCase.id,
    conceptId: testCase.conceptId,
    split: testCase.split,
    category: testCase.category,
    stratum: testCase.mustAbstain
      ? `negative-${testCase.negativeKind ?? 'unspecified'}`
      : testCase.category,
    negativeKind: testCase.negativeKind ?? null,
    language: testCase.language,
    arm,
    query: testCase.query,
    mustAbstain: testCase.mustAbstain,
    expectedTargets: testCase.targets,
    rankedResults: first.rankedResults,
    metrics,
    trace: {
      repeats: repeatRuns.length,
      deterministicAcrossRepeats: signatures.size === 1,
      toolCallsMedian: median(repeatRuns.map(run => run.trace.toolCalls)),
      jsonrpcRequestBytesMedian: median(repeatRuns.map(run => run.trace.jsonrpcRequestBytes)),
      jsonrpcResponseBytesMedian: median(repeatRuns.map(run => run.trace.jsonrpcResponseBytes)),
      modelVisiblePayloadBytesMedian: median(repeatRuns.map(run => run.trace.modelVisiblePayloadBytes)),
      armLatencyMsMedian: median(repeatRuns.map(run => run.trace.armLatencyMs)),
      callsByName: first.trace.callsByName,
      repeatTraces: repeatRuns.map((run, repeat) => ({
        repeat,
        order: run.order,
        error: run.error,
        toolCalls: run.trace.toolCalls,
        jsonrpcRequestBytes: run.trace.jsonrpcRequestBytes,
        jsonrpcResponseBytes: run.trace.jsonrpcResponseBytes,
        modelVisiblePayloadBytes: run.trace.modelVisiblePayloadBytes,
        armLatencyMs: run.trace.armLatencyMs,
        callLatenciesMs: run.trace.callLatenciesMs,
        internalRecallTrace: run.trace.internalRecallTrace,
      })),
    },
    error,
  };
}

function percent(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value, digits = 1) {
  return value == null ? 'n/a' : Number(value).toFixed(digits);
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildCsv(rows) {
  const columns = [
    'caseId', 'conceptId', 'split', 'category', 'stratum', 'negativeKind', 'language', 'arm', 'query', 'taskSuccess',
    'hit1', 'hit3', 'hit5', 'recall5', 'allTargets5', 'mrr',
    'projectAccuracy', 'evidenceAccuracy', 'negativeFalsePositive',
    'toolCallsMedian', 'modelVisiblePayloadBytesMedian',
    'jsonrpcRequestBytesMedian', 'jsonrpcResponseBytesMedian', 'armLatencyMsMedian',
    'deterministicAcrossRepeats', 'error',
  ];
  const lines = [columns.join(',')];
  for (const row of rows) {
    const flattened = {
      ...row,
      ...row.metrics,
      ...row.trace,
    };
    lines.push(columns.map(column => csvEscape(flattened[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function buildReport({ manifest, armSummary, categorySummary, paired, rows }) {
  const lines = [
    '# Large MCP file-search benchmark',
    '',
    `- Dataset: \`${manifest.datasetId}\` (${manifest.caseCount} paired cases, ${manifest.warmups} warm-ups + ${manifest.repeats} timed repeats per arm)`,
    `- Chain: synthetic SQLite/FTS → built VESTI-APP MCP → SDK in-memory JSON-RPC → tool result`,
    `- APP MCP dist artifact SHA-256: \`${manifest.mcpArtifactSha256}\``,
    `- Primary endpoint: paired task success at Top ${EVALUATION_K}`,
    `- Important boundary: this measures the retrieval/tool chain, not the independent effect of SKILL.md instructions.`,
    '',
    '## Overall results',
    '',
    '| Arm | Scored N | Task success | Hit@1 | Hit@3 | Recall@5 | All targets@5 | Project | Evidence | Calls | Visible bytes | Latency ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const summary of armSummary) {
    lines.push(`| ${summary.arm} | ${summary.primaryN} | ${percent(summary.taskSuccess)} | ${percent(summary.hit1)} | ${percent(summary.hit3)} | ${percent(summary.recall5)} | ${percent(summary.allTargets5)} | ${percent(summary.projectAccuracy)} | ${percent(summary.evidenceAccuracy)} | ${formatNumber(summary.toolCallsMedian)} | ${formatNumber(summary.modelVisiblePayloadBytesMedian, 0)} | ${formatNumber(summary.armLatencyMsMedian)} |`);
  }
  lines.push(
    '',
    '## Paired primary result',
    '',
    `- Treatment minus legacy task-success delta: **${percent(paired.delta)}** (concept-cluster bootstrap 95% CI ${percent(paired.ci95?.[0])} to ${percent(paired.ci95?.[1])}; ${paired.clusterCount} independent concept clusters).`,
    `- Discordant pairs: treatment-only success ${paired.treatmentOnly}; legacy-only success ${paired.baselineOnly}; both success ${paired.bothSuccess}; both fail ${paired.bothFailure}.`,
    `- Case-level exact McNemar two-sided p-value: ${formatNumber(paired.mcnemarExactP, 4)} (descriptive only because tasks share concept clusters).`,
    `- ${paired.excludedPairs} hard-negative pairs are excluded only from the primary quality endpoint; they remain in pressure and runtime summaries.`,
    '',
    '## Results by category',
    '',
    '| Stratum | Arm | N | Task success | Hit@3 | Recall@5 | Negative FP | Calls | Visible bytes |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  );
  for (const summary of categorySummary) {
    lines.push(`| ${summary.stratum} | ${summary.arm} | ${summary.n} | ${percent(summary.taskSuccess)} | ${percent(summary.hit3)} | ${percent(summary.recall5)} | ${percent(summary.negativeFalsePositive)} | ${formatNumber(summary.toolCallsMedian)} | ${formatNumber(summary.modelVisiblePayloadBytesMedian, 0)} |`);
  }
  const regressions = rows.filter(row => row.arm === 'search-files' && row.metrics.taskSuccess === 0);
  lines.push(
    '',
    '## Treatment failures for review',
    '',
  );
  if (regressions.length === 0) {
    lines.push('No treatment failures in this run.');
  } else {
    for (const row of regressions) {
      const returned = row.rankedResults.slice(0, 3).map(result => `\`${result.path}\``).join(', ') || '(no result)';
      lines.push(`- \`${row.caseId}\` (${row.category}): ${returned}${row.error ? ` — error: ${row.error}` : ''}`);
    }
  }
  lines.push(
    '',
    '## Interpretation limits',
    '',
    '- The corpus is synthetic and inspectable. It is useful for regression and engineering comparisons, not a production-user effect claim.',
    '- `provisional-holdout` is visible in source and is therefore not a true hidden holdout.',
    '- Stale-path cases score historical retrieval only. Current filesystem verification requires the later Agent experiment.',
    '- Timing uses in-process MCP transport; it excludes model latency, filesystem reads and a real stdio/network framing layer. It is descriptive, not a product-level latency claim.',
    '',
  );
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const integrity = datasetIntegrity();
  if (integrity.cases !== 72) throw new Error(`Expected 72 cases, found ${integrity.cases}`);
  const selectedCases = options.split === 'all'
    ? cases
    : cases.filter(testCase => testCase.split === options.split);
  if (selectedCases.length === 0) throw new Error(`No cases in split: ${options.split}`);

  const mcpEntry = resolve(options.mcpEntry);
  const mcpModule = await import(`${pathToFileURL(mcpEntry).href}?benchmark=${Date.now()}`);
  if (typeof mcpModule.openVestiDb !== 'function' || typeof mcpModule.createVestiMcpServer !== 'function') {
    throw new Error(`${mcpEntry} does not export openVestiDb/createVestiMcpServer`);
  }

  const fixture = buildFixtureDb();
  const runRoot = mkdtempSync(resolve(tmpdir(), 'vesti-file-search-runs-'));
  const random = seededRandom(DATASET_SEED ^ 0x51a7cafe);
  const repeatsByCase = new Map();
  const startedAt = new Date().toISOString();
  try {
    for (const [caseIndex, testCase] of selectedCases.entries()) {
      const primaryOrder = random() < 0.5
        ? ['legacy', 'search-files']
        : ['search-files', 'legacy'];
      const byArm = { legacy: [], 'search-files': [] };
      for (let iteration = -options.warmups; iteration < options.repeats; iteration += 1) {
        const order = Math.abs(iteration) % 2 === 0 ? primaryOrder : [...primaryOrder].reverse();
        for (const [orderIndex, arm] of order.entries()) {
          const phase = iteration < 0 ? `warmup${Math.abs(iteration)}` : `repeat${iteration}`;
          const dbPath = resolve(runRoot, `${testCase.id}-${phase}-${arm}.sqlite`);
          copyFileSync(fixture.dbPath, dbPath);
          const run = await executeArm({
            arm,
            testCase,
            dbPath,
            mcpModule,
            searchFilesRecallLimit: options.searchFilesRecallLimit,
          });
          run.order = orderIndex + 1;
          if (iteration >= 0) byArm[arm].push(run);
          rmSync(dbPath, { force: true });
        }
      }
      repeatsByCase.set(testCase.id, byArm);
      console.log(`[${caseIndex + 1}/${selectedCases.length}] ${testCase.id}`);
    }
  } finally {
    fixture.cleanup();
    rmSync(runRoot, { recursive: true, force: true });
  }

  const rows = selectedCases.flatMap(testCase => {
    const byArm = repeatsByCase.get(testCase.id);
    return [
      aggregateRepeats(testCase, 'legacy', byArm.legacy),
      aggregateRepeats(testCase, 'search-files', byArm['search-files']),
    ];
  });
  const armSummary = summarizeArm(rows);
  const categorySummary = summarizeBy(rows, 'stratum');
  const paired = pairedTaskStats(rows, {
    baselineArm: 'legacy',
    treatmentArm: 'search-files',
    seed: DATASET_SEED,
    expectedExcludedPairs: selectedCases.filter(testCase =>
      testCase.mustAbstain && testCase.negativeKind === 'hard',
    ).length,
  });

  const corePackagePath = resolve(HERE, '..', '..', 'packages', 'vesti-search-files-core', 'package.json');
  const mcpPackagePath = resolve(dirname(dirname(mcpEntry)), 'package.json');
  const appRepository = resolve(dirname(mcpPackagePath), '..', '..');
  const mcpArtifact = sha256Directory(dirname(mcpEntry));
  const sdkPackagePath = resolve(HERE, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
  const manifest = {
    schemaVersion: 1,
    datasetId: DATASET_ID,
    datasetSeed: DATASET_SEED,
    corpusSha256: sha256Json({ projects, sessions, cases }),
    integrity,
    split: options.split,
    caseCount: selectedCases.length,
    repeats: options.repeats,
    warmups: options.warmups,
    baselineSessionBudget: MAX_BASELINE_SESSIONS,
    resultLimit: RESULT_LIMIT,
    evaluationK: EVALUATION_K,
    searchFilesRecallLimit: options.searchFilesRecallLimit,
    nodeVersion: process.version,
    mcpEntry,
    mcpArtifactSha256: mcpArtifact.sha256,
    mcpArtifactFiles: mcpArtifact.files,
    mcpPackage: JSON.parse(readFileSync(mcpPackagePath, 'utf8')).version,
    mcpSdkPackage: JSON.parse(readFileSync(sdkPackagePath, 'utf8')).version,
    appGitCommit: gitCommit(appRepository),
    corePackage: JSON.parse(readFileSync(corePackagePath, 'utf8')).version,
    fixtureSchemaSha256: sha256File(resolve(HERE, 'fixture-schema.sql')),
    fixtureCounts: fixture.counts,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  const report = buildReport({ manifest, armSummary, categorySummary, paired, rows });
  mkdirSync(options.resultsDir, { recursive: true });
  writeFileSync(resolve(options.resultsDir, 'large-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(options.resultsDir, 'large-runs.ndjson'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(resolve(options.resultsDir, 'large-summary.json'), `${JSON.stringify({ armSummary, categorySummary, paired }, null, 2)}\n`);
  writeFileSync(resolve(options.resultsDir, 'large-results.csv'), buildCsv(rows));
  writeFileSync(resolve(options.resultsDir, 'large-report.md'), `${report}\n`);

  console.log('');
  console.log(report);
  console.log(`Artifacts: ${options.resultsDir}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
