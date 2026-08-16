import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildFixtureDb } from '../build-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = fileURLToPath(import.meta.url);
const OUTPUT_SCHEMA_PATH = resolve(HERE, '..', 'rapid-v3', 'agent-output-schema.json');
const DEFAULT_DATASET = resolve(HERE, 'corpus.mjs');
const SKILL_PATH = resolve(HERE, 'vesti-file-locator-v3-frozen.md');
const BENCHMARK_MCP_PATH = resolve(HERE, '..', 'agent-mcp-server.mjs');
const DEFAULT_MCP_ENTRY = resolve(
  HERE, '..', '..', '..', '..', '..',
  'vesti', 'VESTI-APP', 'packages', 'vesti-mcp', 'dist', 'index.js',
);

const MODEL = 'gpt-5.6-luna';
const MODEL_TIMEOUT_MS = 180_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const BOOTSTRAP_ITERATIONS = 10_000;
const TOOLS = ['vesti_search', 'vesti_timeline', 'vesti_get_turns', 'vesti_search_files'];
const ARMS = Object.freeze([
  Object.freeze({ id: 'modern-none', label: 'B', skill: 'none' }),
  Object.freeze({ id: 'modern-vesti-v3', label: 'D', skill: 'vestiV3' }),
]);
const COMMON_INSTRUCTIONS = [
  'Use enabled read-only VESTI tools to answer the request.',
  'Return only JSON conforming to schema.',
].join('\n');
const SERVER_INSTRUCTIONS = 'VESTI provides read-only access to captured historical sessions.';
const ARTIFACT_NAMES = ['manifest.json', 'runs.ndjson', 'summary.json', 'report.md'];

let DATASET_SEED = 0;
let MCP_ENTRY = DEFAULT_MCP_ENTRY;

function parseArgs(argv) {
  const options = {
    dataset: DEFAULT_DATASET,
    mcpEntry: process.env.VESTI_MCP_ENTRY ? resolve(process.env.VESTI_MCP_ENTRY) : DEFAULT_MCP_ENTRY,
    maxCases: null,
    repeats: 1,
    resultsDir: resolve(HERE, '..', 'results', 'agent-targeted-skill-v1'),
    concurrency: 1,
    dryRun: false,
    resume: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--dataset' && next) {
      options.dataset = resolve(next);
      index += 1;
    } else if (arg === '--mcp-entry' && next) {
      options.mcpEntry = resolve(next);
      index += 1;
    } else if (arg === '--max-cases' && next) {
      options.maxCases = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--repeats' && next) {
      options.repeats = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--results-dir' && next) {
      options.resultsDir = resolve(next);
      index += 1;
    } else if (arg === '--concurrency' && next) {
      options.concurrency = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--resume') {
      options.resume = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node run-agent-targeted.mjs [options]',
        '  --dataset <file>    dataset ESM module',
        '  --mcp-entry <file>  built APP MCP entry module',
        '  --max-cases <n>     optional seeded subset for smoke checks',
        '  --repeats <n>       fixed at 1',
        '  --results-dir <dir> output directory',
        '  --concurrency <n>   1 or 2',
        '  --dry-run           validate and emit no-call artifacts',
        '  --resume            continue an interrupted compatible run',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (options.repeats !== 1) throw new Error('--repeats is fixed at 1');
  if (![1, 2].includes(options.concurrency)) throw new Error('--concurrency must be 1 or 2');
  if (options.maxCases != null && (!Number.isInteger(options.maxCases) || options.maxCases < 1)) {
    throw new Error('--max-cases must be a positive integer');
  }
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function sha256Json(value) {
  return sha256(JSON.stringify(value));
}

function slash(value) {
  return String(value).replaceAll('\\', '/');
}

function hashDirectory(root) {
  const files = [];
  const visit = current => {
    for (const name of readdirSync(current).sort()) {
      const absolute = resolve(current, name);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else files.push(absolute);
    }
  };
  visit(root);
  const entries = files.map(path => ({
    path: slash(path.slice(root.length + 1)),
    sha256: sha256File(path),
  }));
  return { sha256: sha256Json(entries), files: entries };
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

function shuffled(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

function resolveCodexInvocation() {
  const override = process.env.VESTI_CODEX_BIN?.trim();
  if (override) {
    const absolute = resolve(override);
    return absolute.toLowerCase().endsWith('.js')
      ? { command: process.execPath, prefixArgs: [absolute] }
      : { command: absolute, prefixArgs: [] };
  }
  if (process.platform !== 'win32') return { command: 'codex', prefixArgs: [] };
  let candidates = [];
  try {
    candidates = execFileSync('where.exe', ['codex'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  } catch {}
  const shim = candidates.find(candidate => candidate.toLowerCase().endsWith('.cmd'));
  if (shim) {
    const cli = resolve(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(cli)) return { command: process.execPath, prefixArgs: [cli] };
  }
  const executable = candidates.find(candidate => candidate.toLowerCase().endsWith('.exe'));
  return executable ? { command: executable, prefixArgs: [] } : { command: 'codex', prefixArgs: [] };
}

function codexVersion(invocation) {
  try {
    return execFileSync(invocation.command, [...invocation.prefixArgs, '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    return `unavailable: ${String(error)}`;
  }
}

function buildCodexArgs(dbPath) {
  const toml = value => JSON.stringify(value);
  return [
    '-a', 'never', '-m', MODEL, '-s', 'read-only',
    '--disable', 'apps', '--disable', 'plugins',
    '-c', 'tools.shell=false',
    '-c', `mcp_servers.vesti.command=${toml('node')}`,
    '-c', `mcp_servers.vesti.args=${toml(['--experimental-sqlite', slash(BENCHMARK_MCP_PATH)])}`,
    '-c', `mcp_servers.vesti.env.VESTI_DB_PATH=${toml(slash(dbPath))}`,
    '-c', `mcp_servers.vesti.env.VESTI_MCP_ENTRY=${toml(slash(MCP_ENTRY))}`,
    '-c', `mcp_servers.vesti.env.VESTI_MCP_SERVER_INSTRUCTIONS=${toml(SERVER_INSTRUCTIONS)}`,
    '-c', `mcp_servers.vesti.enabled_tools=${toml(TOOLS)}`,
    '-c', 'mcp_servers.vesti.startup_timeout_sec=30',
    '-c', 'mcp_servers.vesti.tool_timeout_sec=60',
    'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--skip-git-repo-check', '--color', 'never', '--json',
    '--output-schema', OUTPUT_SCHEMA_PATH, '-',
  ];
}

function sanitizeArgs(args, dbPath) {
  return args.map(arg => String(arg).replaceAll(slash(dbPath), '<FROZEN_RUN_DB>'));
}

function buildPrompt(testCase, skillText, arm) {
  const prompt = [
    COMMON_INSTRUCTIONS,
    ...(arm.skill === 'vestiV3' ? ['', '<task-guidance>', skillText, '</task-guidance>'] : []),
    '', 'User task:', testCase.query,
  ].join('\n');
  const query = slash(testCase.query).toLowerCase();
  const normalized = slash(prompt).toLowerCase();
  const forbidden = new Set(testCase.targets.flatMap(target => [
    target.path,
    target.projectPath,
    target.replacementPath,
    ...(target.sessionIds ?? []),
  ]).filter(Boolean));
  for (const value of forbidden) {
    const candidate = slash(value).toLowerCase();
    if (normalized.includes(candidate) && !query.includes(candidate)) {
      throw new Error(`Gold leakage detected in prompt for ${testCase.id}`);
    }
  }
  return prompt;
}

function terminateProcessTree(child) {
  if (!Number.isInteger(child.pid) || child.pid <= 0 || child.exitCode != null) return;
  if (process.platform === 'win32') {
    spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false, stdio: 'ignore', windowsHide: true,
    }).on('error', () => {
      try { child.kill(); } catch {}
    });
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function runCodex(invocation, args, prompt, cwd) {
  return new Promise(resolveRun => {
    const started = process.hrtime.bigint();
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError = null;
    let settled = false;
    let timer = null;
    const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
      cwd, env: process.env, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun({
        exitCode, signal, timedOut, outputLimitExceeded, spawnError,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
    };
    const capture = (target, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_CAPTURE_BYTES) {
        outputLimitExceeded = true;
        terminateProcessTree(child);
      } else {
        target.push(buffer);
      }
    };
    child.stdout.on('data', chunk => capture(stdout, chunk));
    child.stderr.on('data', chunk => capture(stderr, chunk));
    child.on('error', error => {
      spawnError = String(error);
      finish(null, null);
    });
    child.on('close', finish);
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');
    timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, MODEL_TIMEOUT_MS);
  });
}

function parseCodexJsonl(stdout) {
  const events = [];
  const parseErrors = [];
  for (const [index, raw] of stdout.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push({ line: index + 1, message: String(error), text: line.slice(0, 500) });
    }
  }
  const completed = events
    .filter(event => event?.type === 'item.completed')
    .map(event => event.item)
    .filter(Boolean);
  const mcpCalls = completed
    .filter(item => item.type === 'mcp_tool_call')
    .map(item => ({
      id: item.id ?? null,
      server: item.server ?? null,
      tool: item.tool ?? null,
      arguments: item.arguments ?? null,
      status: item.status ?? null,
      error: item.error ?? null,
    }));
  const agentMessages = completed
    .filter(item => item.type === 'agent_message' && typeof item.text === 'string')
    .map(item => item.text);
  return {
    parseErrors,
    mcpCalls,
    agentMessages,
    finalText: agentMessages.at(-1) ?? null,
    usage: events.filter(event => event?.type === 'turn.completed').at(-1)?.usage ?? null,
  };
}

function validateOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'output is not an object';
  if (typeof value.answerable !== 'boolean') return 'answerable is not boolean';
  if (!Array.isArray(value.files) || value.files.length > 10) return 'files must be an array of at most 10 items';
  if (value.files.length === 0 && value.answerable !== false) return 'answerable must be false when files is empty';
  if (!['low', 'medium', 'high'].includes(value.confidence)) return 'confidence is invalid';
  if (typeof value.explanation !== 'string') return 'explanation is not a string';
  for (const [index, file] of value.files.entries()) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return `files[${index}] is invalid`;
    if (typeof file.path !== 'string' || !file.path.trim()) return `files[${index}].path is invalid`;
    if (file.project != null && typeof file.project !== 'string') return `files[${index}].project is invalid`;
    if (!Array.isArray(file.evidence_session_ids) || file.evidence_session_ids.length < 1) {
      return `files[${index}].evidence_session_ids is invalid`;
    }
    if (!file.evidence_session_ids.every(id => typeof id === 'string' && id.trim())) {
      return `files[${index}].evidence_session_ids is invalid`;
    }
    if (typeof file.historical_only !== 'boolean') return `files[${index}].historical_only is invalid`;
  }
  return null;
}

function parseFinalOutput(finalText) {
  if (typeof finalText !== 'string') return { value: null, error: 'missing final Agent message' };
  try {
    const value = JSON.parse(finalText);
    return { value, error: validateOutput(value) };
  } catch (error) {
    return { value: null, error: `final Agent message is not JSON: ${String(error)}` };
  }
}

function executionFailure(execution, parsed, final) {
  const errors = [];
  let kind = 'agent';
  if (execution.spawnError) {
    kind = 'infrastructure';
    errors.push(`spawn: ${execution.spawnError}`);
  }
  if (execution.timedOut) {
    kind = 'infrastructure';
    errors.push('timeout');
  }
  if (execution.outputLimitExceeded) {
    kind = 'infrastructure';
    errors.push('output limit exceeded');
  }
  if (execution.exitCode != null && execution.exitCode !== 0) {
    kind = 'infrastructure';
    errors.push(`exit code ${execution.exitCode}`);
  }
  if (execution.exitCode == null && execution.signal) {
    kind = 'infrastructure';
    errors.push(`signal ${execution.signal}`);
  }
  if (parsed.parseErrors.length > 0) {
    kind = 'infrastructure';
    errors.push(`${parsed.parseErrors.length} invalid JSONL line(s)`);
  }
  const failedCalls = parsed.mcpCalls.filter(call => call.status === 'failed' || call.error);
  if (failedCalls.length > 0) errors.push(`${failedCalls.length} MCP call(s) failed`);
  if (/MCP startup failed|failed to initialize MCP client/i.test(execution.stderr)) {
    kind = 'infrastructure';
    errors.push('VESTI MCP failed to initialize');
  }
  if (final.error) errors.push(final.error);
  return errors.length > 0 ? { kind, message: errors.join('; ') } : null;
}

function canonicalProject(value) {
  return slash(value ?? '').trim().replace(/\/$/, '').toLowerCase();
}

function canonicalFile(value) {
  return slash(value ?? '')
    .trim()
    .replace(/^['"\x60]+|['"\x60]+$/g, '')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/[.,;:)\]]+$/, '')
    .toLowerCase();
}

function pathMatches(file, target) {
  const actual = canonicalFile(file.path);
  const project = canonicalProject(target.projectPath);
  const relative = actual.startsWith(`${project}/`) ? actual.slice(project.length + 1) : actual;
  return relative === canonicalFile(target.path);
}

function projectMatches(file, target) {
  if (!pathMatches(file, target)) return false;
  const actual = canonicalProject(file.project);
  const expected = canonicalProject(target.projectPath);
  return actual === expected || basename(actual) === basename(expected);
}

function evidenceMatches(file, target) {
  return Array.isArray(file.evidence_session_ids)
    && file.evidence_session_ids.length > 0
    && file.evidence_session_ids.every(id => target.sessionIds.includes(id));
}

function supports(file, target, requireHistorical) {
  return projectMatches(file, target)
    && evidenceMatches(file, target)
    && (!requireHistorical || file.historical_only === true);
}

function score(testCase, output, runError) {
  const files = output?.files ?? [];
  if (testCase.mustAbstain) {
    const affirmative = output ? (output.answerable || files.length > 0 ? 1 : 0) : null;
    const actualWrongFileReturn = output ? (files.length > 0 ? 1 : 0) : null;
    const taskSuccess = !runError && output && affirmative === 0 ? 1 : 0;
    return {
      taskSuccess,
      retrievalTaskSuccess: taskSuccess,
      negativeIttFalsePositive: runError || !output ? 1 : affirmative,
      negativeFalsePositive: affirmative,
      actualWrongFileReturn,
      projectAccuracy: null,
      evidenceAccuracy: null,
      historicalAccuracy: null,
      returnedFilePrecision: null,
      unsupportedReturnRate: null,
    };
  }
  const targets = testCase.targets;
  const exactRetrieval =
    files.length === targets.length
    && targets.every(target => files.filter(file => supports(file, target, false)).length === 1)
    && files.every(file => targets.filter(target => supports(file, target, false)).length === 1);
  const exactHistorical = exactRetrieval && files.every(file => file.historical_only === true);
  const projectAccuracy = targets.filter(target =>
    files.some(file => projectMatches(file, target)),
  ).length / targets.length;
  const evidenceAccuracy = targets.filter(target =>
    files.some(file => projectMatches(file, target) && evidenceMatches(file, target)),
  ).length / targets.length;
  const historicalAccuracy = targets.filter(target =>
    files.some(file => projectMatches(file, target) && file.historical_only === true),
  ).length / targets.length;
  const supported = files.filter(file => targets.some(target => supports(file, target, true))).length;
  const precision = files.length === 0 ? 0 : supported / files.length;
  return {
    taskSuccess: !runError && output?.answerable === true && exactHistorical ? 1 : 0,
    retrievalTaskSuccess: !runError && output?.answerable === true && exactRetrieval ? 1 : 0,
    negativeIttFalsePositive: null,
    negativeFalsePositive: null,
    actualWrongFileReturn: null,
    projectAccuracy,
    evidenceAccuracy,
    historicalAccuracy,
    returnedFilePrecision: precision,
    unsupportedReturnRate: files.length === 0 ? 0 : 1 - precision,
  };
}

function buildSchedule(cases, experimentHash, armHashes) {
  const random = seededRandom(DATASET_SEED ^ 0xa63e2b91);
  const schedule = [];
  for (const [blockOrder, testCase] of shuffled(cases, random).entries()) {
    for (const [armOrder, arm] of shuffled(ARMS, random).entries()) {
      const runHash = sha256(`${DATASET_SEED}:${testCase.id}:${arm.id}`).slice(0, 12);
      schedule.push({
        scheduleIndex: schedule.length,
        blockOrder,
        armOrder,
        repeat: 0,
        runId: `${experimentHash.slice(0, 10)}-${armHashes[arm.id].slice(0, 10)}-${runHash}`,
        experimentHash,
        armHash: armHashes[arm.id],
        testCase,
        arm,
      });
    }
  }
  return schedule;
}

function baseRow(run, prompt, fixtureSha256, codexArgs) {
  return {
    scheduleIndex: run.scheduleIndex,
    blockOrder: run.blockOrder,
    armOrder: run.armOrder,
    repeat: 0,
    runId: run.runId,
    experimentHash: run.experimentHash,
    armHash: run.armHash,
    caseId: run.testCase.id,
    conceptId: run.testCase.conceptId,
    split: run.testCase.split ?? run.testCase.phase ?? 'rapid',
    category: run.testCase.category,
    negativeKind: run.testCase.negativeKind ?? null,
    arm: run.arm.id,
    skill: run.arm.skill,
    query: run.testCase.query,
    expectedTargets: run.testCase.targets,
    promptSha256: sha256(prompt),
    fixtureSha256,
    codexArgs,
  };
}

function removeWithRetries(path, recursive) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(path, { recursive, force: true, maxRetries: 2, retryDelay: 100 });
      return null;
    } catch (error) {
      if (attempt === 5) return String(error);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
  return null;
}

async function executeRun({ run, fixture, fixtureSha256, skillText, invocation, runRoot, dryRun }) {
  const dbPath = resolve(runRoot, 'databases', `${run.runId}.sqlite`);
  const cwd = resolve(runRoot, 'workspaces', run.runId);
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  let row;
  try {
    copyFileSync(fixture.dbPath, dbPath);
    if (sha256File(dbPath) !== fixtureSha256) throw new Error('fixture copy hash mismatch');
    const prompt = buildPrompt(run.testCase, skillText, run.arm);
    const args = buildCodexArgs(dbPath);
    const base = baseRow(run, prompt, fixtureSha256, sanitizeArgs(args, dbPath));
    if (dryRun) {
      row = {
        ...base,
        status: 'dry-run',
        finalOutput: null,
        metrics: null,
        trace: { durationMs: 0, mcpCalls: [], usage: null, stderr: '', cleanupErrors: [] },
        failureKind: null,
        error: null,
      };
    } else {
      const execution = await runCodex(invocation, args, prompt, cwd);
      const parsed = parseCodexJsonl(execution.stdout);
      const final = parseFinalOutput(parsed.finalText);
      const failure = executionFailure(execution, parsed, final);
      row = {
        ...base,
        status: failure ? 'failed' : 'completed',
        finalOutput: final.value,
        metrics: score(run.testCase, final.value, failure?.message ?? null),
        trace: {
          durationMs: execution.durationMs,
          exitCode: execution.exitCode,
          signal: execution.signal,
          mcpCalls: parsed.mcpCalls,
          usage: parsed.usage,
          stdoutSha256: sha256(execution.stdout),
          stderrSha256: sha256(execution.stderr),
          stderr: execution.stderr.slice(0, 32_000),
          jsonlParseErrors: parsed.parseErrors,
          cleanupErrors: [],
        },
        failureKind: failure?.kind ?? null,
        error: failure?.message ?? null,
      };
    }
  } catch (error) {
    const prompt = buildPrompt(run.testCase, skillText, run.arm);
    row = {
      ...baseRow(run, prompt, fixtureSha256, []),
      status: 'failed',
      finalOutput: null,
      metrics: dryRun ? null : score(run.testCase, null, String(error)),
      trace: { durationMs: 0, mcpCalls: [], usage: null, stderr: '', cleanupErrors: [] },
      failureKind: 'infrastructure',
      error: String(error),
    };
  }
  row.trace.cleanupErrors = [
    removeWithRetries(dbPath, false),
    removeWithRetries(cwd, true),
  ].filter(Boolean);
  return row;
}

async function runPool(schedule, concurrency, execute, onComplete) {
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= schedule.length) return;
      const row = await execute(schedule[index]);
      await onComplete(row);
      completed += 1;
      console.log(`[${completed}/${schedule.length}] ${row.caseId} ${row.arm} ${row.status}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, schedule.length) }, worker));
}

function parseExistingRuns(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const rows = [];
  for (const [index, raw] of lines.entries()) {
    if (!raw.trim()) continue;
    try {
      rows.push(JSON.parse(raw));
    } catch (error) {
      const trailingPartial = lines.slice(index + 1).every(line => !line.trim());
      if (!trailingPartial) throw new Error(`Invalid runs.ndjson line ${index + 1}: ${String(error)}`);
    }
  }
  return rows;
}

function resultPaths(directory) {
  mkdirSync(directory, { recursive: true });
  return Object.fromEntries(ARTIFACT_NAMES.map(name => [name, resolve(directory, name)]));
}

function prepareResults(directory, resume) {
  const paths = resultPaths(directory);
  const existing = ARTIFACT_NAMES.filter(name => existsSync(paths[name]));
  if (!resume && existing.length > 0) {
    throw new Error(`Refusing to overwrite existing artifacts: ${existing.join(', ')}`);
  }
  if (resume && (!existsSync(paths['manifest.json']) || !existsSync(paths['runs.ndjson']))) {
    throw new Error('--resume requires manifest.json and runs.ndjson');
  }
  return paths;
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numeric(rows, getter) {
  return rows.map(getter).filter(value => typeof value === 'number' && Number.isFinite(value));
}

function summarizeRows(rows) {
  const calls = numeric(rows, row => row.trace?.mcpCalls?.length);
  const input = numeric(rows, row => row.trace?.usage?.input_tokens);
  const durations = numeric(rows, row => row.trace?.durationMs);
  const wrongFiles = numeric(rows, row => row.metrics?.actualWrongFileReturn);
  return {
    n: rows.length,
    completed: rows.filter(row => row.status === 'completed').length,
    failures: rows.filter(row => row.error).length,
    taskSuccess: mean(numeric(rows, row => row.metrics?.taskSuccess)),
    retrievalTaskSuccess: mean(numeric(rows, row => row.metrics?.retrievalTaskSuccess)),
    projectAccuracy: mean(numeric(rows, row => row.metrics?.projectAccuracy)),
    evidenceAccuracy: mean(numeric(rows, row => row.metrics?.evidenceAccuracy)),
    historicalAccuracy: mean(numeric(rows, row => row.metrics?.historicalAccuracy)),
    returnedFilePrecision: mean(numeric(rows, row => row.metrics?.returnedFilePrecision)),
    unsupportedReturnRate: mean(numeric(rows, row => row.metrics?.unsupportedReturnRate)),
    negativeFalsePositive: mean(numeric(rows, row => row.metrics?.negativeFalsePositive)),
    actualWrongFileReturn: mean(wrongFiles),
    actualWrongFileReturns: wrongFiles.reduce((left, right) => left + right, 0),
    toolCallsMedian: median(calls),
    toolCallsTotal: calls.reduce((left, right) => left + right, 0),
    inputTokensMedian: median(input),
    inputTokensTotal: input.reduce((left, right) => left + right, 0),
    durationMsMedian: median(durations),
    durationMsTotal: durations.reduce((left, right) => left + right, 0),
  };
}

function pairedBlocks(rows, metric) {
  const map = new Map();
  for (const row of rows) {
    const block = map.get(row.caseId) ?? {
      caseId: row.caseId,
      conceptId: row.conceptId,
      values: {},
    };
    block.values[row.arm] = row.metrics?.[metric];
    map.set(row.caseId, block);
  }
  return [...map.values()].filter(block =>
    ARMS.every(arm => [0, 1].includes(block.values[arm.id])),
  );
}

function bootstrapEffect(blocks) {
  const byConcept = new Map();
  for (const block of blocks) {
    const list = byConcept.get(block.conceptId) ?? [];
    list.push(block);
    byConcept.set(block.conceptId, list);
  }
  const concepts = [...byConcept.keys()].sort();
  if (concepts.length === 0) {
    return { lower: null, upper: null, iterations: 0, clusters: 0 };
  }
  const random = seededRandom(DATASET_SEED ^ 0x61c88647);
  const samples = [];
  for (let iteration = 0; iteration < BOOTSTRAP_ITERATIONS; iteration += 1) {
    const sampled = [];
    for (let draw = 0; draw < concepts.length; draw += 1) {
      sampled.push(...byConcept.get(concepts[Math.floor(random() * concepts.length)]));
    }
    samples.push(mean(sampled.map(block =>
      block.values['modern-vesti-v3'] - block.values['modern-none'],
    )));
  }
  samples.sort((left, right) => left - right);
  const quantile = probability => {
    const position = (samples.length - 1) * probability;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return samples[lower] + (samples[upper] - samples[lower]) * (position - lower);
  };
  return {
    lower: quantile(0.025),
    upper: quantile(0.975),
    iterations: BOOTSTRAP_ITERATIONS,
    clusters: concepts.length,
  };
}

function exactMcNemarP(wins, losses) {
  const discordant = wins + losses;
  if (discordant === 0) return 1;
  const k = Math.min(wins, losses);
  const choose = (n, r) => {
    let value = 1;
    for (let index = 1; index <= r; index += 1) {
      value = value * (n - r + index) / index;
    }
    return value;
  };
  let tail = 0;
  for (let index = 0; index <= k; index += 1) {
    tail += choose(discordant, index) * (0.5 ** discordant);
  }
  return Math.min(1, 2 * tail);
}

function pairedSummary(rows, metric) {
  const blocks = pairedBlocks(rows, metric);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const block of blocks) {
    const difference = block.values['modern-vesti-v3'] - block.values['modern-none'];
    if (difference > 0) wins += 1;
    else if (difference < 0) losses += 1;
    else ties += 1;
  }
  const bootstrap = bootstrapEffect(blocks);
  return {
    metric,
    completePairs: blocks.length,
    treatmentWins: wins,
    treatmentLosses: losses,
    ties,
    estimate: mean(blocks.map(block =>
      block.values['modern-vesti-v3'] - block.values['modern-none'],
    )),
    ci95: { lower: bootstrap.lower, upper: bootstrap.upper },
    conceptClusters: bootstrap.clusters,
    bootstrapIterations: bootstrap.iterations,
    exactMcNemarP: exactMcNemarP(wins, losses),
  };
}

function buildSummary(rows, dryRun) {
  const categories = [...new Set(rows.map(row => row.category).filter(Boolean))].sort();
  return {
    exploratory: true,
    dryRun,
    schedule: {
      runs: rows.length,
      completePairs: rows.length / 2,
      arms: Object.fromEntries(ARMS.map(arm => [
        arm.id,
        rows.filter(row => row.arm === arm.id).length,
      ])),
    },
    arms: Object.fromEntries(ARMS.map(arm => [
      arm.id,
      summarizeRows(rows.filter(row => row.arm === arm.id)),
    ])),
    paired: dryRun ? null : {
      taskSuccess: pairedSummary(rows, 'taskSuccess'),
      retrievalTaskSuccess: pairedSummary(rows, 'retrievalTaskSuccess'),
    },
    categories: categories.map(category => ({
      category,
      arms: Object.fromEntries(ARMS.map(arm => [
        arm.id,
        summarizeRows(rows.filter(row => row.category === category && row.arm === arm.id)),
      ])),
      pairedTaskSuccess: dryRun
        ? null
        : pairedSummary(rows.filter(row => row.category === category), 'taskSuccess'),
    })),
    negativeSafety: Object.fromEntries(ARMS.map(arm => {
      const negative = rows.filter(row => row.arm === arm.id && row.negativeKind != null);
      return [arm.id, {
        all: summarizeRows(negative),
        hard: summarizeRows(negative.filter(row => row.negativeKind === 'hard')),
        clean: summarizeRows(negative.filter(row => row.negativeKind === 'clean')),
      }];
    })),
  };
}

function percent(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function seconds(milliseconds) {
  return Number.isFinite(milliseconds) ? (milliseconds / 1000).toFixed(1) : 'n/a';
}

function report(manifest, summary) {
  const lines = [
    '# VESTI targeted Skill capability B/D engineering study',
    '',
    '> Pre-defined synthetic enriched capability study: 16 cases, one repeat and two matched arms. It estimates Skill behavior only in the targeted scenarios and is not evidence of overall or production-wide superiority.',
    '',
    `- Mode: **${manifest.dryRun ? 'dry-run (no model calls)' : 'executed'}**`,
    `- Dataset: ${manifest.datasetId}; ${manifest.caseCount} cases × 1 repeat × 2 arms = ${manifest.runCount} runs`,
    `- Model: ${manifest.model}; concurrency ${manifest.concurrency}`,
    `- Fixture SHA-256: ${manifest.fixtureSha256}`,
    `- V3 Skill SHA-256: ${manifest.skillSha256}`,
    `- APP MCP dist SHA-256: ${manifest.mcpArtifactSha256}`,
    '',
    '## Aggregate',
    '',
    '| Arm | Exact success | Retrieval exact | Completed | Actual wrong-file returns | Tool calls | Input tokens | Duration (s) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const arm of ARMS) {
    const value = summary.arms[arm.id];
    lines.push(`| ${arm.label}: ${arm.id} | ${percent(value.taskSuccess)} | ${percent(value.retrievalTaskSuccess)} | ${value.completed}/${value.n} | ${value.actualWrongFileReturns} (${percent(value.actualWrongFileReturn)}) | ${value.toolCallsTotal} | ${value.inputTokensTotal} | ${seconds(value.durationMsTotal)} |`);
  }
  if (summary.paired) {
    const task = summary.paired.taskSuccess;
    const retrieval = summary.paired.retrievalTaskSuccess;
    lines.push(
      '',
      '## Paired direction',
      '',
      `- D wins / losses / ties: **${task.treatmentWins} / ${task.treatmentLosses} / ${task.ties}**.`,
      `- Exact-success D − B: **${percent(task.estimate)}**, descriptive cluster-bootstrap 95% CI [${percent(task.ci95.lower)}, ${percent(task.ci95.upper)}], exact paired McNemar p=${task.exactMcNemarP.toFixed(4)}.`,
      `- Retrieval-exact D − B: **${percent(retrieval.estimate)}**, descriptive cluster-bootstrap 95% CI [${percent(retrieval.ci95.lower)}, ${percent(retrieval.ci95.upper)}].`,
      '- All uncertainty diagnostics are exploratory because this is a small, single-repeat targeted capability study.',
    );
  }
  lines.push(
    '', '## Categories', '',
    '| Category | B exact | D exact | D wins | D losses | Ties |',
    '|---|---:|---:|---:|---:|---:|',
  );
  for (const category of summary.categories) {
    const paired = category.pairedTaskSuccess;
    lines.push(`| ${category.category} | ${percent(category.arms['modern-none'].taskSuccess)} | ${percent(category.arms['modern-vesti-v3'].taskSuccess)} | ${paired?.treatmentWins ?? 'n/a'} | ${paired?.treatmentLosses ?? 'n/a'} | ${paired?.ties ?? 'n/a'} |`);
  }
  lines.push(
    '', '## Negative safety', '',
    '| Arm | Negative N | Affirmative FP | Actual wrong-file returns |',
    '|---|---:|---:|---:|',
  );
  for (const arm of ARMS) {
    const negative = summary.negativeSafety[arm.id].all;
    lines.push(`| ${arm.id} | ${negative.n} | ${percent(negative.negativeFalsePositive)} | ${negative.actualWrongFileReturns} (${percent(negative.actualWrongFileReturn)}) |`);
  }
  lines.push(
    '', '## Boundaries', '',
    '- B and D receive the identical four-tool VESTI MCP surface. Only D receives the frozen V3 Skill.',
    '- Each case/arm uses a fresh ephemeral Codex process and a byte-identical fixture database copy.',
    '- Shell, web, apps, plugins, user config and repository rules are excluded.',
    '- Positive success requires the exact complete gold file set, zero extras, correct project, supporting session evidence, and historical_only=true.',
    '- Negative success requires answerable=false and files=[]; actual wrong-file FP separately counts responses returning paths.',
    '- The task definitions, scoring and complete 16-case set are fixed before model execution; results are reported regardless of direction and may not be tuned after inspection.',
    '- The synthetic corpus is deliberately enriched for Skill-relevant ambiguity, evidence verification, minimal-set and abstention decisions; results must not be generalized to the overall task distribution.',
    '',
  );
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  MCP_ENTRY = options.mcpEntry;
  for (const required of [
    options.dataset,
    MCP_ENTRY,
    BENCHMARK_MCP_PATH,
    OUTPUT_SCHEMA_PATH,
    SKILL_PATH,
  ]) {
    if (!existsSync(required)) throw new Error(`Required file does not exist: ${required}`);
  }
  JSON.parse(readFileSync(OUTPUT_SCHEMA_PATH, 'utf8'));
  const datasetSha256 = sha256File(options.dataset);
  const dataset = await import(`${pathToFileURL(options.dataset).href}?sha=${datasetSha256}`);
  const { cases, projects, sessions, DATASET_ID, datasetIntegrity } = dataset;
  DATASET_SEED = dataset.DATASET_SEED;
  if (!Array.isArray(cases) || !Array.isArray(projects) || !Array.isArray(sessions)) {
    throw new Error('Dataset must export cases, projects and sessions arrays');
  }
  if (
    typeof DATASET_ID !== 'string'
    || !Number.isInteger(DATASET_SEED)
    || typeof datasetIntegrity !== 'function'
  ) {
    throw new Error('Dataset must export DATASET_ID, integer DATASET_SEED and datasetIntegrity()');
  }
  if (options.maxCases == null && cases.length !== 16) {
    throw new Error(`Full targeted Skill capability set requires exactly 16 cases; found ${cases.length}`);
  }

  const random = seededRandom(DATASET_SEED ^ 0x1140fac7);
  const selectedCases = shuffled(cases, random).slice(0, options.maxCases ?? cases.length);
  const skillText = readFileSync(SKILL_PATH, 'utf8');
  const skillSha256 = sha256(skillText);
  const mcpArtifact = hashDirectory(dirname(MCP_ENTRY));
  const fixture = buildFixtureDb({ sessions });
  const fixtureSha256 = sha256File(fixture.dbPath);
  const invocation = resolveCodexInvocation();
  const runnerSha256 = sha256File(RUNNER_PATH);
  const outputSchemaSha256 = sha256File(OUTPUT_SCHEMA_PATH);
  const benchmarkMcpSha256 = sha256File(BENCHMARK_MCP_PATH);
  const corpusSha256 = sha256Json({ projects, sessions, cases });
  const armHashes = {
    'modern-none': sha256Json({ id: 'modern-none', tools: TOOLS, skill: null }),
    'modern-vesti-v3': sha256Json({
      id: 'modern-vesti-v3',
      tools: TOOLS,
      skill: skillSha256,
    }),
  };
  const experimentHash = sha256Json({
    protocol: 'vesti-file-search-targeted-skill-v1',
    datasetSha256,
    corpusSha256,
    selectedCaseIds: selectedCases.map(testCase => testCase.id),
    model: MODEL,
    skillSha256,
    mcpArtifactSha256: mcpArtifact.sha256,
    runnerSha256,
    outputSchemaSha256,
    benchmarkMcpSha256,
    commonInstructionsSha256: sha256(COMMON_INSTRUCTIONS),
    armHashes,
  });
  const schedule = buildSchedule(selectedCases, experimentHash, armHashes);
  if (options.maxCases == null && schedule.length !== 32) {
    throw new Error(`Full targeted Skill capability set requires 32 scheduled runs; found ${schedule.length}`);
  }

  const paths = prepareResults(options.resultsDir, options.resume);
  const manifest = {
    schemaVersion: 1,
    protocol: 'targeted-skill-capability-enriched-v1',
    status: 'running',
    exploratory: true,
    confirmatory: false,
    dryRun: options.dryRun,
    datasetId: DATASET_ID,
    datasetSeed: DATASET_SEED,
    datasetIntegrity: datasetIntegrity(),
    datasetPath: slash(options.dataset),
    datasetSha256,
    corpusSha256,
    selectedCaseIds: selectedCases.map(testCase => testCase.id),
    caseCount: selectedCases.length,
    repeats: 1,
    arms: ARMS.map(arm => arm.id),
    runCount: schedule.length,
    scheduleSha256: sha256Json(schedule.map(run => ({
      runId: run.runId,
      caseId: run.testCase.id,
      arm: run.arm.id,
      scheduleIndex: run.scheduleIndex,
    }))),
    experimentHash,
    model: MODEL,
    codexVersion: codexVersion(invocation),
    concurrency: options.concurrency,
    timeoutMs: MODEL_TIMEOUT_MS,
    toolSurface: TOOLS,
    commonInstructionsSha256: sha256(COMMON_INSTRUCTIONS),
    skillPath: slash(SKILL_PATH),
    skillSha256,
    outputSchemaPath: slash(OUTPUT_SCHEMA_PATH),
    outputSchemaSha256,
    runnerSha256,
    fixtureSha256,
    fixtureCounts: fixture.counts,
    mcpEntry: slash(MCP_ENTRY),
    mcpArtifactSha256: mcpArtifact.sha256,
    mcpArtifactFiles: mcpArtifact.files,
    benchmarkMcpPath: slash(BENCHMARK_MCP_PATH),
    benchmarkMcpSha256,
    armHashes,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  const frozenArtifacts = () => {
    const checks = [
      ['runner', sha256File(RUNNER_PATH), runnerSha256],
      ['output schema', sha256File(OUTPUT_SCHEMA_PATH), outputSchemaSha256],
      ['Skill', sha256File(SKILL_PATH), skillSha256],
      ['benchmark MCP', sha256File(BENCHMARK_MCP_PATH), benchmarkMcpSha256],
      ['APP MCP dist', hashDirectory(dirname(MCP_ENTRY)).sha256, mcpArtifact.sha256],
    ];
    for (const [label, actual, expected] of checks) {
      if (actual !== expected) {
        throw new Error(`Frozen artifact changed during run (${label}): ${actual} != ${expected}`);
      }
    }
  };

  let rows = [];
  let runRoot = null;
  try {
    if (options.resume) {
      const existingManifest = JSON.parse(readFileSync(paths['manifest.json'], 'utf8'));
      for (const field of [
        'dryRun',
        'datasetSha256',
        'corpusSha256',
        'selectedCaseIds',
        'runCount',
        'scheduleSha256',
        'experimentHash',
        'model',
        'skillSha256',
        'outputSchemaSha256',
        'runnerSha256',
        'fixtureSha256',
        'mcpArtifactSha256',
        'benchmarkMcpSha256',
        'armHashes',
      ]) {
        if (JSON.stringify(existingManifest[field]) !== JSON.stringify(manifest[field])) {
          throw new Error(`Resume manifest mismatch: ${field}`);
        }
      }
      const byId = new Map(schedule.map(run => [run.runId, run]));
      const seen = new Set();
      rows = parseExistingRuns(paths['runs.ndjson']).filter(row => {
        const scheduled = byId.get(row.runId);
        if (!scheduled) throw new Error(`Unknown resumed runId: ${row.runId}`);
        if (seen.has(row.runId)) throw new Error(`Duplicate resumed runId: ${row.runId}`);
        seen.add(row.runId);
        if (
          row.caseId !== scheduled.testCase.id
          || row.arm !== scheduled.arm.id
          || row.experimentHash !== experimentHash
          || row.armHash !== scheduled.armHash
          || row.fixtureSha256 !== fixtureSha256
        ) {
          throw new Error(`Resume row identity mismatch: ${row.runId}`);
        }
        return row.failureKind !== 'infrastructure';
      });
      writeFileSync(
        paths['runs.ndjson'],
        rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '',
      );
      console.log(`Resume validated: ${rows.length} retained run(s).`);
    } else {
      writeFileSync(paths['runs.ndjson'], '');
    }

    writeFileSync(paths['manifest.json'], `${JSON.stringify(manifest, null, 2)}\n`);
    runRoot = mkdtempSync(resolve(tmpdir(), 'vesti-targeted-skill-v1-'));
    const completedIds = new Set(rows.map(row => row.runId));
    const pending = schedule.filter(run => !completedIds.has(run.runId));
    await runPool(
      pending,
      options.concurrency,
      run => {
        frozenArtifacts();
        return executeRun({
          run,
          fixture,
          fixtureSha256,
          skillText,
          invocation,
          runRoot,
          dryRun: options.dryRun,
        });
      },
      row => {
        appendFileSync(paths['runs.ndjson'], `${JSON.stringify(row)}\n`, 'utf8');
        rows.push(row);
      },
    );

    const infrastructureFailures = rows.filter(row => row.failureKind === 'infrastructure');
    if (infrastructureFailures.length > 0) {
      throw new Error(`${infrastructureFailures.length} infrastructure failure(s); rerun with --resume`);
    }
    if (rows.length !== schedule.length || new Set(rows.map(row => row.runId)).size !== schedule.length) {
      throw new Error(`Incomplete run set: expected ${schedule.length}, got ${rows.length}`);
    }
    rows.sort((left, right) => left.scheduleIndex - right.scheduleIndex);
    writeFileSync(
      paths['runs.ndjson'],
      `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
    );
    const summary = buildSummary(rows, options.dryRun);
    const completedManifest = {
      ...manifest,
      status: rows.some(row => row.error) ? 'completed-with-agent-errors' : 'completed',
      completedAt: new Date().toISOString(),
    };
    writeFileSync(
      paths['manifest.json'],
      `${JSON.stringify(completedManifest, null, 2)}\n`,
    );
    writeFileSync(paths['summary.json'], `${JSON.stringify(summary, null, 2)}\n`);
    const markdown = report(completedManifest, summary);
    writeFileSync(paths['report.md'], `${markdown}\n`);
    console.log('');
    console.log(markdown);
    console.log(`Artifacts: ${options.resultsDir}`);
  } catch (error) {
    if (existsSync(paths['manifest.json'])) {
      writeFileSync(paths['manifest.json'], `${JSON.stringify({
        ...manifest,
        status: 'running',
        lastInterruptedAt: new Date().toISOString(),
        lastInterruption: String(error),
      }, null, 2)}\n`);
    }
    throw error;
  } finally {
    fixture.cleanup();
    if (runRoot) removeWithRetries(runRoot, true);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
