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

let cases = [];
let projects = [];
let sessions = [];
let DATASET_ID = '';
let DATASET_SEED = 0;
let datasetIntegrity = () => ({});

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = fileURLToPath(import.meta.url);
const OUTPUT_SCHEMA_PATH = resolve(HERE, 'agent-output-schema-v2.json');
const AGENT_MCP_SERVER_PATH = resolve(HERE, '..', 'agent-mcp-server.mjs');
const DEFAULT_DATASET = resolve(HERE, 'calibration-corpus.mjs');
const DEFAULT_MCP_ENTRY = resolve(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'VESTI-APP',
  'packages',
  'vesti-mcp',
  'dist',
  'index.js',
);
const PLACEBO_SKILL_PATH = resolve(HERE, 'frozen', 'placebo-skill.md');
const VESTI_SKILL_PATH = resolve(HERE, 'frozen', 'vesti-memory-v2.md');
let MCP_ENTRY = DEFAULT_MCP_ENTRY;

const MODEL = 'gpt-5.6-luna';
const MODEL_TIMEOUT_MS = 180_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const EVALUATION_K = 5;
const BOOTSTRAP_ITERATIONS = 10_000;
const WINDOWS_IO_RETRY_ATTEMPTS = 8;
const WINDOWS_IO_RETRY_BASE_DELAY_MS = 50;
const WINDOWS_IO_RETRY_MAX_DELAY_MS = 2_000;
const RETRYABLE_WINDOWS_IO_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES']);
const LEGACY_TOOLS = ['vesti_search', 'vesti_timeline', 'vesti_get_turns'];
const MODERN_TOOLS = [...LEGACY_TOOLS, 'vesti_search_files'];

const ARMS = Object.freeze([
  Object.freeze({ id: 'legacy-none', label: 'A', toolVariant: 'legacy', skill: 'none', tools: LEGACY_TOOLS }),
  Object.freeze({ id: 'modern-none', label: 'B', toolVariant: 'modern', skill: 'none', tools: MODERN_TOOLS }),
  Object.freeze({ id: 'modern-placebo', label: 'C', toolVariant: 'modern', skill: 'placebo', tools: MODERN_TOOLS }),
  Object.freeze({ id: 'modern-vesti', label: 'D', toolVariant: 'modern', skill: 'vesti', tools: MODERN_TOOLS }),
]);

const FACTORIAL_CONTRASTS = Object.freeze([
  Object.freeze({
    id: 'modernToolEffect',
    label: 'B - A: modern tool effect',
    tier: 'exploratory',
    value: block => block['modern-none'] - block['legacy-none'],
  }),
  Object.freeze({
    id: 'placeboEffect',
    label: 'C - B: placebo effect',
    tier: 'exploratory',
    value: block => block['modern-placebo'] - block['modern-none'],
  }),
  Object.freeze({
    id: 'primarySkillEffect',
    label: 'D - B: VESTI Skill effect (primary)',
    tier: 'primary',
    value: block => block['modern-vesti'] - block['modern-none'],
  }),
  Object.freeze({
    id: 'skillBeyondPlacebo',
    label: 'D - C: VESTI Skill beyond placebo (secondary)',
    tier: 'secondary',
    value: block => block['modern-vesti'] - block['modern-placebo'],
  }),
  Object.freeze({
    id: 'fullSystemEffect',
    label: 'D - A: full system effect (secondary)',
    tier: 'secondary',
    value: block => block['modern-vesti'] - block['legacy-none'],
  }),
]);

const SUCCESS_METRICS = Object.freeze([
  Object.freeze({
    id: 'taskSuccess',
    label: 'End-to-end task success',
    description: 'Requires complete retrieval evidence and the correct historical-only contract.',
  }),
  Object.freeze({
    id: 'retrievalTaskSuccess',
    label: 'Retrieval-only task success',
    description: 'Requires complete path, project and evidence retrieval with zero unsupported files; historical_only is not scored.',
  }),
]);

const CONTRAST_POLICY = Object.freeze({
  primary: Object.freeze(['primarySkillEffect']),
  secondaryHolmFamily: Object.freeze(['skillBeyondPlacebo', 'fullSystemEffect']),
  exploratory: Object.freeze(['modernToolEffect', 'placeboEffect']),
});

const NEGATIVE_SAFETY_ENDPOINT = Object.freeze({
  id: 'negativeIttFalsePositive',
  estimand: 'intent-to-treat false-positive rate',
  strata: Object.freeze(['hard', 'clean']),
  scoring: 'Negative cases score 1 for an affirmative/file return, failed run, missing output or invalid output; otherwise 0.',
});

const NEGATIVE_SAFETY_GATE_POLICY = Object.freeze({
  stratum: 'hard',
  targetArm: 'modern-vesti',
  comparatorArm: 'modern-none',
  difference: 'modern-vesti minus modern-none',
  maxTargetFprInclusive: 0.20,
  maxDifferenceUpperExclusive: 0.10,
  upperConfidenceLevel: 0.95,
  bootstrapUnit: 'conceptId',
  decision: 'Pass only when target-arm hard-negative ITT FPR <= 20% and the one-sided 95% upper bound for D-B is < +10 percentage points.',
});

const NEUTRAL_INSTRUCTIONS = [
  'Complete the user task.',
  'Return only JSON that conforms to the supplied output schema.',
].join('\n');

const BENCHMARK_SERVER_INSTRUCTIONS = 'VESTI provides read-only access to captured historical sessions.';

function parseArgs(argv) {
  const options = {
    phase: 'calibration',
    dataset: DEFAULT_DATASET,
    mcpEntry: process.env.VESTI_MCP_ENTRY ? resolve(process.env.VESTI_MCP_ENTRY) : DEFAULT_MCP_ENTRY,
    repeats: 1,
    resultsDir: null,
    concurrency: 1,
    dryRun: false,
    resume: false,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--phase' && next) {
      options.phase = next;
      index += 1;
    } else if (arg === '--dataset' && next) {
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
    } else if (arg === '--self-test' || arg === '--self-test-io') {
      options.selfTest = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: node run-agent-v2.mjs [options]',
        '  --phase <name>      calibration (default) or formal',
        '  --dataset <file>    ESM dataset module',
        '  --mcp-entry <file>  built APP MCP entry module',
        '  --max-cases <n>     optional seeded subset (useful for smoke checks)',
        '  --repeats <n>       fresh Agent repetitions per case and arm (default 1, max 3)',
        '  --results-dir <dir> output directory (must not contain prior artifacts unless --resume)',
        '  --concurrency <n>   concurrent Codex processes (default 1, max 2)',
        '  --dry-run           validate schedule, fixture copies, prompts and commands only',
        '  --resume            validate and continue an interrupted compatible run',
        '  --self-test         run scoring/statistics plus fault-injected I/O checks and exit',
        '  --self-test-io      deprecated alias for --self-test',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!['calibration', 'formal'].includes(options.phase)) {
    throw new Error('--phase must be calibration or formal');
  }
  if (options.maxCases != null && (!Number.isInteger(options.maxCases) || options.maxCases < 1)) {
    throw new Error('--max-cases must be a positive integer');
  }
  if (!Number.isInteger(options.repeats) || options.repeats < 1 || options.repeats > 3) {
    throw new Error('--repeats must be an integer from 1 to 3');
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 2) {
    throw new Error('--concurrency must be 1 or 2');
  }
  options.resultsDir ??= resolve(HERE, '..', 'results', `agent-v2-${options.phase}`);
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(readFileSync(filePath));
}

function sha256Json(value) {
  return sha256(JSON.stringify(value));
}

function ioRetryDelayMs(attempt) {
  return Math.min(
    WINDOWS_IO_RETRY_BASE_DELAY_MS * (2 ** attempt),
    WINDOWS_IO_RETRY_MAX_DELAY_MS,
  );
}

function isRetryableWindowsIoError(error) {
  return RETRYABLE_WINDOWS_IO_ERRORS.has(error?.code);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

function writeFileSyncWithRetries(path, contents) {
  let lastError = null;
  for (let attempt = 0; attempt < WINDOWS_IO_RETRY_ATTEMPTS; attempt += 1) {
    try {
      writeFileSync(path, contents);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableWindowsIoError(error) || attempt === WINDOWS_IO_RETRY_ATTEMPTS - 1) break;
      sleepSync(ioRetryDelayMs(attempt));
    }
  }
  throw lastError;
}

function appendUtf8(path, contents) {
  appendFileSync(path, contents, 'utf8');
}

async function appendFileWithRetries(path, contents, appendOperation = appendUtf8) {
  let lastError = null;
  for (let attempt = 0; attempt < WINDOWS_IO_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await appendOperation(path, contents, attempt);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableWindowsIoError(error) || attempt === WINDOWS_IO_RETRY_ATTEMPTS - 1) break;
      await delay(ioRetryDelayMs(attempt));
    }
  }
  throw lastError;
}

class SerialNdjsonWriter {
  constructor(path, appendOperation = appendUtf8) {
    this.path = path;
    this.appendOperation = appendOperation;
    this.tail = Promise.resolve();
  }

  append(row) {
    const serialized = `${JSON.stringify(row)}\n`;
    const pending = this.tail
      .catch(() => {})
      .then(() => appendFileWithRetries(this.path, serialized, this.appendOperation));
    this.tail = pending;
    return pending;
  }

  async drain() {
    await this.tail.catch(() => {});
  }
}

function parseNdjsonDocument(content, label) {
  const rawLines = content.split(/\r?\n/);
  const endsWithNewline = /(?:\r?\n)$/.test(content);
  let finalContentLine = rawLines.length - 1;
  while (finalContentLine >= 0 && !rawLines[finalContentLine].trim()) finalContentLine -= 1;
  const records = [];
  let trailingPartial = null;

  for (const [index, rawLine] of rawLines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      records.push({ lineNumber: index + 1, value: JSON.parse(line) });
    } catch (error) {
      const isTrailingPartial = !endsWithNewline && index === finalContentLine;
      if (!isTrailingPartial) {
        throw new Error(`Invalid ${label} line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
      trailingPartial = {
        lineNumber: index + 1,
        bytes: Buffer.byteLength(rawLine, 'utf8'),
        sha256: sha256(Buffer.from(rawLine, 'utf8')),
      };
    }
  }

  return { records, trailingPartial };
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
  const digest = createHash('sha256');
  const entries = files.map(file => ({
    path: file.slice(directory.length + 1).replaceAll('\\', '/'),
    sha256: sha256File(file),
  }));
  for (const entry of entries) digest.update(`${entry.path}\0${entry.sha256}\n`);
  return { sha256: digest.digest('hex'), files: entries };
}

function assertRuntimeArtifactsFrozen({
  mcpArtifactSha256,
  benchmarkMcpServerSha256,
  outputSchemaSha256,
}) {
  const checks = [
    {
      label: 'APP MCP dist',
      actual: () => sha256Directory(dirname(MCP_ENTRY)).sha256,
      expected: mcpArtifactSha256,
    },
    {
      label: 'benchmark MCP server',
      actual: () => sha256File(AGENT_MCP_SERVER_PATH),
      expected: benchmarkMcpServerSha256,
    },
    {
      label: 'output schema',
      actual: () => sha256File(OUTPUT_SCHEMA_PATH),
      expected: outputSchemaSha256,
    },
  ];
  for (const check of checks) {
    const actual = check.actual();
    if (actual !== check.expected) {
      throw new Error(
        `Frozen runtime artifact changed during the experiment: ${check.label} expected ${check.expected}, got ${actual}`,
      );
    }
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

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function slash(value) {
  return value.replaceAll('\\', '/');
}

function toml(value) {
  return JSON.stringify(value);
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
  } catch {
    // Fall through to PATH resolution below.
  }
  const commandShim = candidates.find(candidate => candidate.toLowerCase().endsWith('.cmd'));
  if (commandShim) {
    const cliJs = resolve(dirname(commandShim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(cliJs)) return { command: process.execPath, prefixArgs: [cliJs] };
  }
  const executable = candidates.find(candidate => candidate.toLowerCase().endsWith('.exe'));
  return executable
    ? { command: executable, prefixArgs: [] }
    : { command: 'codex', prefixArgs: [] };
}

function codexVersion(invocation) {
  try {
    return execFileSync(invocation.command, [...invocation.prefixArgs, '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function buildPrompt(query, skillTexts, treatment) {
  const treatmentText = treatment === 'placebo'
    ? skillTexts.placebo
    : treatment === 'vesti'
      ? skillTexts.vesti
      : null;
  return [
    NEUTRAL_INSTRUCTIONS,
    ...(treatmentText
      ? [
          '',
          '<task-guidance>',
          treatmentText,
          '</task-guidance>',
        ]
      : []),
    '',
    'User task:',
    query,
  ].join('\n');
}

function assertPromptIsBlind(testCase, prompt) {
  const query = testCase.query.toLowerCase().replaceAll('\\', '/');
  const forbidden = new Set(testCase.targets.flatMap(target => [
    target.path,
    target.projectPath,
    ...(target.sessionIds ?? []),
    target.replacementPath,
  ]).filter(Boolean));
  const normalizedPrompt = prompt.toLowerCase().replaceAll('\\', '/');
  for (const value of forbidden) {
    const normalized = String(value).toLowerCase().replaceAll('\\', '/');
    if (normalizedPrompt.includes(normalized) && !query.includes(normalized)) {
      throw new Error(`Gold leakage detected while building prompt for ${testCase.id}`);
    }
  }
}

function buildCodexArgs({ dbPath, tools }) {
  return [
    '-a', 'never',
    '-m', MODEL,
    '-s', 'read-only',
    '--disable', 'apps',
    '--disable', 'plugins',
    '-c', 'tools.shell=false',
    '-c', `mcp_servers.vesti.command=${toml('node')}`,
    '-c', `mcp_servers.vesti.args=${toml(['--experimental-sqlite', slash(AGENT_MCP_SERVER_PATH)])}`,
    '-c', `mcp_servers.vesti.env.VESTI_DB_PATH=${toml(slash(dbPath))}`,
    '-c', `mcp_servers.vesti.env.VESTI_MCP_ENTRY=${toml(slash(MCP_ENTRY))}`,
    '-c', `mcp_servers.vesti.env.VESTI_MCP_SERVER_INSTRUCTIONS=${toml(BENCHMARK_SERVER_INSTRUCTIONS)}`,
    '-c', `mcp_servers.vesti.enabled_tools=${toml(tools)}`,
    '-c', 'mcp_servers.vesti.startup_timeout_sec=30',
    '-c', 'mcp_servers.vesti.tool_timeout_sec=60',
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--color', 'never',
    '--json',
    '--output-schema', OUTPUT_SCHEMA_PATH,
    '-',
  ];
}

function sanitizeCodexArgs(args, dbPath) {
  const database = slash(dbPath);
  return args.map(arg => String(arg).replaceAll(database, '<FROZEN_RUN_DB>'));
}

function buildSchedule(selectedCases, repeats, experimentHash, armHashes) {
  const random = seededRandom(DATASET_SEED ^ 0xa63e2b91);
  const schedule = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const caseOrder = shuffled(selectedCases, random);
    for (const [blockOrder, testCase] of caseOrder.entries()) {
      const armOrder = shuffled(ARMS, random);
      for (const [armOrderIndex, arm] of armOrder.entries()) {
        const runHash = sha256(`${DATASET_SEED}:${repeat}:${testCase.id}:${arm.id}`).slice(0, 12);
        const armHash = armHashes[arm.id];
        const runId = `${experimentHash.slice(0, 10)}-${armHash.slice(0, 10)}-${runHash}`;
        schedule.push({
          scheduleIndex: schedule.length,
          blockOrder,
          armOrder: armOrderIndex,
          repeat,
          runId,
          experimentHash,
          armHash,
          testCase,
          arm,
        });
      }
    }
  }
  return schedule;
}

function terminateSpawnedProcessTree(child, reason) {
  if (!['timeout', 'output-limit'].includes(reason)) return;
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  if (child.exitCode != null || child.signalCode != null) return;

  if (process.platform === 'win32') {
    // taskkill is deliberately scoped to the PID of this runner's own child and
    // is only used after this child exceeds a hard safety limit.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => {
      try {
        child.kill();
      } catch {
        // The process may already have exited between the checks above.
      }
    });
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // The process may already have exited between the checks above.
  }
}

function runCodex(invocation, args, prompt, workdir) {
  return new Promise(resolveRun => {
    const started = process.hrtime.bigint();
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError = null;
    let settled = false;
    let terminationRequested = false;
    let timer = null;

    const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
      cwd: workdir,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun({
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
        spawnError,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
    };

    const capture = (chunks, chunk, channel) => {
      if (outputLimitExceeded) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (channel === 'stdout') stdoutBytes += buffer.length;
      else stderrBytes += buffer.length;
      if (stdoutBytes + stderrBytes > MAX_CAPTURE_BYTES) {
        outputLimitExceeded = true;
        if (!terminationRequested) {
          terminationRequested = true;
          terminateSpawnedProcessTree(child, 'output-limit');
        }
        return;
      }
      chunks.push(buffer);
    };

    child.stdout.on('data', chunk => capture(stdout, chunk, 'stdout'));
    child.stderr.on('data', chunk => capture(stderr, chunk, 'stderr'));
    child.on('error', error => {
      spawnError = error instanceof Error ? error.message : String(error);
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');

    timer = setTimeout(() => {
      timedOut = true;
      if (!terminationRequested) {
        terminationRequested = true;
        terminateSpawnedProcessTree(child, 'timeout');
      }
    }, MODEL_TIMEOUT_MS);
  });
}

function parseCodexJsonl(stdout) {
  const events = [];
  const parseErrors = [];
  for (const [index, rawLine] of stdout.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push({
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
        text: line.slice(0, 500),
      });
    }
  }
  const completedItems = events
    .filter(event => event?.type === 'item.completed')
    .map(event => event.item)
    .filter(Boolean);
  const mcpCalls = completedItems
    .filter(item => item.type === 'mcp_tool_call')
    .map(item => ({
      id: item.id ?? null,
      server: item.server ?? null,
      tool: item.tool ?? null,
      arguments: item.arguments ?? null,
      status: item.status ?? null,
      result: item.result ?? null,
      error: item.error ?? null,
    }));
  const agentMessages = completedItems
    .filter(item => item.type === 'agent_message' && typeof item.text === 'string')
    .map(item => item.text);
  const completedTurns = events.filter(event => event?.type === 'turn.completed');
  const usage = completedTurns.at(-1)?.usage ?? null;
  return {
    events,
    parseErrors,
    mcpCalls,
    agentMessages,
    finalText: agentMessages.at(-1) ?? null,
    usage,
  };
}

function validateAgentOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'output is not an object';
  if (typeof value.answerable !== 'boolean') return 'answerable is not boolean';
  if (!Array.isArray(value.files) || value.files.length > 10) return 'files is not an array of at most 10 items';
  if (!['low', 'medium', 'high'].includes(value.confidence)) return 'confidence is invalid';
  if (typeof value.explanation !== 'string') return 'explanation is not a string';
  for (const [index, file] of value.files.entries()) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return `files[${index}] is not an object`;
    if (typeof file.path !== 'string' || !file.path.trim()) return `files[${index}].path is invalid`;
    if (file.project != null && typeof file.project !== 'string') return `files[${index}].project is invalid`;
    if (!Array.isArray(file.evidence_session_ids) || file.evidence_session_ids.length < 1 || !file.evidence_session_ids.every(id => typeof id === 'string' && id)) {
      return `files[${index}].evidence_session_ids is invalid`;
    }
    if (typeof file.historical_only !== 'boolean') return `files[${index}].historical_only is invalid`;
  }
  return null;
}

function parseFinalOutput(finalText) {
  if (typeof finalText !== 'string') return { value: null, error: 'missing final Agent message' };
  let value;
  try {
    value = JSON.parse(finalText);
  } catch (error) {
    return { value: null, error: `final Agent message is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const validationError = validateAgentOutput(value);
  return validationError ? { value: null, error: validationError } : { value, error: null };
}

function canonicalProject(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
}

function canonicalFile(value) {
  return String(value ?? '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/[.,;:)\]]+$/, '')
    .toLowerCase();
}

function candidatePathForTarget(candidate, target) {
  const candidatePath = canonicalFile(candidate.path);
  const project = canonicalProject(target.projectPath);
  return candidatePath.startsWith(`${project}/`)
    ? candidatePath.slice(project.length + 1)
    : candidatePath;
}

function candidatePathMatchesTarget(candidate, target) {
  return candidatePathForTarget(candidate, target) === canonicalFile(target.path);
}

function candidateProjectMatchesTarget(candidate, target) {
  if (!candidatePathMatchesTarget(candidate, target)) return false;
  const actual = canonicalProject(candidate.project);
  const expected = canonicalProject(target.projectPath);
  return actual === expected || basename(actual) === basename(expected);
}

function candidateEvidenceSupportsTarget(candidate, target) {
  return Array.isArray(candidate.evidence_session_ids)
    && candidate.evidence_session_ids.length > 0
    && candidate.evidence_session_ids.every(sessionId => target.sessionIds.includes(sessionId));
}

function candidateSupportsTarget(candidate, target, { requireHistorical }) {
  return candidateProjectMatchesTarget(candidate, target)
    && candidateEvidenceSupportsTarget(candidate, target)
    && (!requireHistorical || candidate.historical_only === true);
}

function scoreAgentOutput(testCase, output, runError) {
  const files = output?.files ?? [];
  if (testCase.mustAbstain) {
    const negativeFalsePositive = output && (output.answerable || files.length > 0) ? 1 : 0;
    const negativeTaskSuccess = !runError && output && negativeFalsePositive === 0 ? 1 : 0;
    const negativeIttFalsePositive = runError || !output ? 1 : negativeFalsePositive;
    return {
      taskSuccess: negativeTaskSuccess,
      retrievalTaskSuccess: negativeTaskSuccess,
      hit1: null,
      hit3: null,
      hit5: null,
      recall5: null,
      allTargets5: null,
      mrr: null,
      projectAccuracy: null,
      evidenceAccuracy: null,
      historicalAccuracy: null,
      staleSafety: null,
      returnedFilePrecision: null,
      unsupportedReturnRate: null,
      retrievalReturnedFilePrecision: null,
      retrievalUnsupportedReturnRate: null,
      negativeFalsePositive: runError || !output ? null : negativeFalsePositive,
      negativeIttFalsePositive,
    };
  }

  const top = files.slice(0, EVALUATION_K);
  const ranks = testCase.targets.map(target => files.findIndex(file => candidatePathMatchesTarget(file, target)) + 1);
  const foundAt = k => ranks.some(rank => rank > 0 && rank <= k) ? 1 : 0;
  const recalled = ranks.filter(rank => rank > 0 && rank <= EVALUATION_K).length;
  const allTargets5 = recalled === testCase.targets.length ? 1 : 0;
  const firstRank = ranks.filter(rank => rank > 0).sort((a, b) => a - b)[0] ?? 0;

  const projectCorrect = testCase.targets.filter(target =>
    top.some(candidate => candidateProjectMatchesTarget(candidate, target)),
  ).length;
  const evidenceCorrect = testCase.targets.filter(target => {
    const candidate = top.find(file => candidateProjectMatchesTarget(file, target));
    if (!candidate) return false;
    return target.sessionIds.some(sessionId => candidate.evidence_session_ids.includes(sessionId));
  }).length;
  const historicalCorrect = testCase.targets.filter(target => {
    const candidate = top.find(file => candidateProjectMatchesTarget(file, target));
    return candidate?.historical_only === true;
  }).length;
  const staleTargets = testCase.targets.filter(target => target.currentState === 'missing');
  const staleSafe = staleTargets.filter(target => {
    const candidate = top.find(file => candidateProjectMatchesTarget(file, target));
    return candidate?.historical_only === true;
  }).length;

  const projectAccuracy = projectCorrect / testCase.targets.length;
  const evidenceAccuracy = evidenceCorrect / testCase.targets.length;
  const historicalAccuracy = historicalCorrect / testCase.targets.length;
  const staleSafety = staleTargets.length === 0 ? null : staleSafe / staleTargets.length;
  const retrievalSupportedFiles = files.filter(file => testCase.targets.some(target =>
    candidateSupportsTarget(file, target, { requireHistorical: false })
  )).length;
  const supportedFiles = files.filter(file => testCase.targets.some(target =>
    candidateSupportsTarget(file, target, { requireHistorical: true })
  )).length;
  const retrievalReturnedFilePrecision = files.length === 0 ? 0 : retrievalSupportedFiles / files.length;
  const retrievalUnsupportedReturnRate = files.length === 0 ? 0 : 1 - retrievalReturnedFilePrecision;
  const returnedFilePrecision = files.length === 0 ? 0 : supportedFiles / files.length;
  const unsupportedReturnRate = files.length === 0 ? 0 : 1 - returnedFilePrecision;
  return {
    taskSuccess:
      !runError &&
      output?.answerable === true &&
      allTargets5 === 1 &&
      projectAccuracy === 1 &&
      evidenceAccuracy === 1 &&
      historicalAccuracy === 1 &&
      unsupportedReturnRate === 0
        ? 1
        : 0,
    retrievalTaskSuccess:
      !runError &&
      output?.answerable === true &&
      allTargets5 === 1 &&
      projectAccuracy === 1 &&
      evidenceAccuracy === 1 &&
      retrievalUnsupportedReturnRate === 0
        ? 1
        : 0,
    hit1: foundAt(1),
    hit3: foundAt(3),
    hit5: foundAt(5),
    recall5: recalled / testCase.targets.length,
    allTargets5,
    mrr: firstRank === 0 ? 0 : 1 / firstRank,
    projectAccuracy,
    evidenceAccuracy,
    historicalAccuracy,
    staleSafety,
    returnedFilePrecision,
    unsupportedReturnRate,
    retrievalReturnedFilePrecision,
    retrievalUnsupportedReturnRate,
    negativeFalsePositive: null,
    negativeIttFalsePositive: null,
  };
}

function executionFailure(execution, parsed, final) {
  const errors = [];
  let infrastructure = false;
  if (execution.spawnError) {
    infrastructure = true;
    errors.push(`spawn: ${execution.spawnError}`);
  }
  if (execution.timedOut) {
    infrastructure = true;
    errors.push(`timeout after ${MODEL_TIMEOUT_MS} ms`);
  }
  if (execution.outputLimitExceeded) {
    infrastructure = true;
    errors.push('captured output exceeded safety limit');
  }
  if (execution.exitCode != null && execution.exitCode !== 0) {
    infrastructure = true;
    errors.push(`Codex exited with code ${execution.exitCode}`);
  }
  if (execution.exitCode == null && execution.signal) {
    infrastructure = true;
    errors.push(`Codex exited on signal ${execution.signal}`);
  }
  if (parsed.parseErrors.length > 0) {
    infrastructure = true;
    errors.push(`${parsed.parseErrors.length} invalid JSONL line(s)`);
  }
  const failedCalls = parsed.mcpCalls.filter(call => call.status === 'failed' || call.error);
  if (failedCalls.length > 0) errors.push(`${failedCalls.length} MCP call(s) failed`);
  const completedVestiCall = parsed.mcpCalls.some(call =>
    call.server === 'vesti' && call.status === 'completed' && !call.error,
  );
  if (!completedVestiCall && /MCP startup failed|failed to initialize MCP client/i.test(execution.stderr)) {
    infrastructure = true;
    errors.push('VESTI MCP failed to initialize');
  }
  if (final.error) errors.push(final.error);
  return errors.length > 0
    ? { message: errors.join('; '), kind: infrastructure ? 'infrastructure' : 'agent' }
    : null;
}

function dryRunRow(run, commandArgs, prompt, fixtureSha256) {
  return {
    scheduleIndex: run.scheduleIndex,
    blockOrder: run.blockOrder,
    armOrder: run.armOrder,
    repeat: run.repeat,
    runId: run.runId,
    experimentHash: run.experimentHash,
    armHash: run.armHash,
    caseId: run.testCase.id,
    conceptId: run.testCase.conceptId,
    split: run.testCase.split,
    category: run.testCase.category,
    negativeKind: run.testCase.negativeKind ?? null,
    arm: run.arm.id,
    toolVariant: run.arm.toolVariant,
    skill: run.arm.skill,
    query: run.testCase.query,
    expectedTargets: run.testCase.targets,
    promptSha256: sha256(prompt),
    fixtureSha256,
    codexArgs: commandArgs,
    status: 'dry-run',
    finalOutput: null,
    finalText: null,
    metrics: null,
    trace: {
      durationMs: 0,
      exitCode: null,
      signal: null,
      mcpCalls: [],
      agentMessages: [],
      usage: null,
      stdoutSha256: null,
      stderrSha256: null,
      stderr: '',
      jsonlParseErrors: [],
      cleanupErrors: [],
    },
    failureKind: null,
    error: null,
  };
}

function removeWithRetries(path, options) {
  const retryable = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      rmSync(path, {
        ...options,
        force: true,
        maxRetries: 2,
        retryDelay: 100,
      });
      return null;
    } catch (error) {
      lastError = error;
      if (!retryable.has(error?.code) || attempt === 5) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
  return {
    path: slash(path),
    code: lastError?.code ?? null,
    message: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

async function executeScheduledRun({ run, fixture, fixtureSha256, skillTexts, invocation, runRoot, dryRun }) {
  const dbPath = resolve(runRoot, 'databases', `${run.runId}.sqlite`);
  const workdir = resolve(runRoot, 'workspaces', run.runId);
  mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(workdir, { recursive: true });
  let prompt = null;
  let args = null;
  let row = null;
  try {
    copyFileSync(fixture.dbPath, dbPath);
    const copiedSha256 = sha256File(dbPath);
    if (copiedSha256 !== fixtureSha256) throw new Error(`Frozen fixture copy hash mismatch for ${run.runId}`);

    prompt = buildPrompt(run.testCase.query, skillTexts, run.arm.skill);
    assertPromptIsBlind(run.testCase, prompt);
    args = buildCodexArgs({ dbPath, tools: run.arm.tools });
    const sanitizedArgs = sanitizeCodexArgs(args, dbPath);
    if (dryRun) {
      row = dryRunRow(run, sanitizedArgs, prompt, copiedSha256);
    } else {
      const execution = await runCodex(invocation, args, prompt, workdir);
      const parsed = parseCodexJsonl(execution.stdout);
      const final = parseFinalOutput(parsed.finalText);
      const failure = executionFailure(execution, parsed, final);
      const error = failure?.message ?? null;
      const metrics = scoreAgentOutput(run.testCase, final.value, error);
      const stderr = execution.stderr.length > 32_000
        ? `${execution.stderr.slice(0, 32_000)}\n[stderr truncated]`
        : execution.stderr;
      row = {
        scheduleIndex: run.scheduleIndex,
        blockOrder: run.blockOrder,
        armOrder: run.armOrder,
        repeat: run.repeat,
        runId: run.runId,
        experimentHash: run.experimentHash,
        armHash: run.armHash,
        caseId: run.testCase.id,
        conceptId: run.testCase.conceptId,
        split: run.testCase.split,
        category: run.testCase.category,
        negativeKind: run.testCase.negativeKind ?? null,
        arm: run.arm.id,
        toolVariant: run.arm.toolVariant,
        skill: run.arm.skill,
        query: run.testCase.query,
        expectedTargets: run.testCase.targets,
        promptSha256: sha256(prompt),
        fixtureSha256: copiedSha256,
        codexArgs: sanitizedArgs,
        status: error ? 'failed' : 'completed',
        finalOutput: final.value,
        finalText: parsed.finalText,
        metrics,
        trace: {
          durationMs: execution.durationMs,
          exitCode: execution.exitCode,
          signal: execution.signal,
          mcpCalls: parsed.mcpCalls,
          agentMessages: parsed.agentMessages,
          usage: parsed.usage,
          stdoutSha256: sha256(execution.stdout),
          stderrSha256: sha256(execution.stderr),
          stderr,
          jsonlParseErrors: parsed.parseErrors,
          cleanupErrors: [],
        },
        failureKind: failure?.kind ?? null,
        error,
      };
    }
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    row = {
      ...dryRunRow(run, args ? sanitizeCodexArgs(args, dbPath) : [], prompt ?? '', fixtureSha256),
      status: 'failed',
      metrics: dryRun ? null : scoreAgentOutput(run.testCase, null, error),
      failureKind: 'infrastructure',
      error,
    };
  }

  const cleanupErrors = [
    removeWithRetries(dbPath, { recursive: false }),
    removeWithRetries(workdir, { recursive: true }),
  ].filter(Boolean);
  row.trace.cleanupErrors = cleanupErrors;
  if (cleanupErrors.length > 0) {
    console.warn(`[cleanup] ${run.runId}: ${cleanupErrors.map(error => error.message).join('; ')}`);
  }
  return row;
}

function numeric(rows, getter) {
  return rows.map(getter).filter(value => typeof value === 'number' && Number.isFinite(value));
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarizeRows(rows) {
  return {
    n: rows.length,
    completed: rows.filter(row => row.status === 'completed').length,
    errors: rows.filter(row => row.error).length,
    taskSuccess: mean(numeric(rows, row => row.metrics?.taskSuccess)),
    retrievalTaskSuccess: mean(numeric(rows, row => row.metrics?.retrievalTaskSuccess)),
    hit3: mean(numeric(rows, row => row.metrics?.hit3)),
    recall5: mean(numeric(rows, row => row.metrics?.recall5)),
    allTargets5: mean(numeric(rows, row => row.metrics?.allTargets5)),
    projectAccuracy: mean(numeric(rows, row => row.metrics?.projectAccuracy)),
    evidenceAccuracy: mean(numeric(rows, row => row.metrics?.evidenceAccuracy)),
    historicalAccuracy: mean(numeric(rows, row => row.metrics?.historicalAccuracy)),
    staleSafety: mean(numeric(rows, row => row.metrics?.staleSafety)),
    returnedFilePrecision: mean(numeric(rows, row => row.metrics?.returnedFilePrecision)),
    unsupportedReturnRate: mean(numeric(rows, row => row.metrics?.unsupportedReturnRate)),
    retrievalReturnedFilePrecision: mean(numeric(rows, row => row.metrics?.retrievalReturnedFilePrecision)),
    retrievalUnsupportedReturnRate: mean(numeric(rows, row => row.metrics?.retrievalUnsupportedReturnRate)),
    negativeFalsePositive: mean(numeric(rows, row => row.metrics?.negativeFalsePositive)),
    toolCallsMedian: median(numeric(rows, row => row.trace?.mcpCalls?.length)),
    durationMsMedian: median(numeric(rows, row => row.trace?.durationMs)),
    inputTokensMedian: median(numeric(rows, row => row.trace?.usage?.input_tokens)),
    cachedInputTokensMedian: median(numeric(rows, row => row.trace?.usage?.cached_input_tokens)),
    outputTokensMedian: median(numeric(rows, row => row.trace?.usage?.output_tokens)),
  };
}

function summarizeArmRows(rows, dryRun) {
  return {
    ...summarizeRows(rows),
    negativeSafety: dryRun
      ? null
      : Object.fromEntries(NEGATIVE_SAFETY_ENDPOINT.strata.map(stratum => [
          stratum,
          summarizeNegativeRows(rows.filter(row => row.negativeKind === stratum)),
        ])),
  };
}

function summarizeNegativeRows(rows) {
  const values = rows.map(row => row.metrics?.negativeIttFalsePositive);
  for (const [index, value] of values.entries()) {
    if (value !== 0 && value !== 1) {
      throw new Error(
        `Run ${rows[index].runId} is missing binary metrics.negativeIttFalsePositive; refusing to exclude it from ITT FPR`,
      );
    }
  }
  return {
    n: rows.length,
    falsePositives: values.reduce((sum, value) => sum + value, 0),
    ittFalsePositiveRate: mean(values),
    failedOrInvalid: rows.filter(row => row.metrics?.negativeFalsePositive == null).length,
  };
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function empiricalTwoSidedBootstrapP(values, observed) {
  const finite = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (finite.length === 0 || typeof observed !== 'number' || !Number.isFinite(observed)) return null;
  const extreme = finite.filter(value => Math.abs(value - observed) >= Math.abs(observed)).length;
  return (extreme + 1) / (finite.length + 1);
}

function holmBonferroni(rawPValues, contrastIds) {
  const ranked = contrastIds
    .map(id => ({ id, p: rawPValues[id] }))
    .filter(entry => typeof entry.p === 'number' && Number.isFinite(entry.p))
    .sort((left, right) => left.p - right.p || left.id.localeCompare(right.id));
  const adjusted = {};
  let runningMaximum = 0;
  for (const [index, entry] of ranked.entries()) {
    runningMaximum = Math.max(runningMaximum, (ranked.length - index) * entry.p);
    adjusted[entry.id] = Math.min(1, runningMaximum);
  }
  return Object.fromEntries(contrastIds.map(id => [id, adjusted[id] ?? null]));
}

function pairedBlocks(rows, mode, metricId) {
  const rawBlocks = new Map();
  for (const row of rows) {
    const key = `${row.caseId}:${row.repeat}`;
    const block = rawBlocks.get(key) ?? {
      key,
      caseId: row.caseId,
      conceptId: row.conceptId,
      repeat: row.repeat,
      arms: {},
    };
    block.arms[row.arm] = row;
    rawBlocks.set(key, block);
  }

  const armComplete = [...rawBlocks.values()].filter(block =>
    ARMS.every(arm => block.arms[arm.id] != null),
  );
  const eligible = armComplete.filter(block => {
    if (mode === 'itt') return true;
    return ARMS.every(arm => {
      const row = block.arms[arm.id];
      return row.status === 'completed'
        && !row.error
        && typeof row.metrics?.[metricId] === 'number';
    });
  });

  return {
    scheduledBlocks: rawBlocks.size,
    armCompleteBlocks: armComplete.length,
    blocks: eligible.map(block => ({
      key: block.key,
      caseId: block.caseId,
      conceptId: block.conceptId,
      repeat: block.repeat,
      values: Object.fromEntries(ARMS.map(arm => {
        const row = block.arms[arm.id];
        const value = row.metrics?.[metricId];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error(
            `Run ${row.runId} is missing numeric metrics.${metricId}; refusing to silently score it as zero`,
          );
        }
        return [arm.id, value];
      })),
    })),
  };
}

function clusterBootstrapContrasts(blocks) {
  const byConcept = new Map();
  for (const block of blocks) {
    const conceptBlocks = byConcept.get(block.conceptId) ?? [];
    conceptBlocks.push(block);
    byConcept.set(block.conceptId, conceptBlocks);
  }
  const conceptIds = [...byConcept.keys()].sort();
  const samples = Object.fromEntries(FACTORIAL_CONTRASTS.map(contrast => [contrast.id, []]));
  if (conceptIds.length > 0) {
    const random = seededRandom((DATASET_SEED ^ 0x61c88647) >>> 0);
    for (let iteration = 0; iteration < BOOTSTRAP_ITERATIONS; iteration += 1) {
      const sampledBlocks = [];
      for (let draw = 0; draw < conceptIds.length; draw += 1) {
        const conceptId = conceptIds[Math.floor(random() * conceptIds.length)];
        sampledBlocks.push(...byConcept.get(conceptId));
      }
      for (const contrast of FACTORIAL_CONTRASTS) {
        samples[contrast.id].push(mean(sampledBlocks.map(block => contrast.value(block.values))));
      }
    }
  }

  const confidenceIntervals = Object.fromEntries(FACTORIAL_CONTRASTS.map(contrast => {
    const values = samples[contrast.id].filter(value => value != null).sort((left, right) => left - right);
    return [contrast.id, {
      lower: quantile(values, 0.025),
      upper: quantile(values, 0.975),
    }];
  }));
  const empiricalPValues = Object.fromEntries(FACTORIAL_CONTRASTS.map(contrast => [
    contrast.id,
    empiricalTwoSidedBootstrapP(
      samples[contrast.id],
      mean(blocks.map(block => contrast.value(block.values))),
    ),
  ]));
  const secondaryContrastIds = CONTRAST_POLICY.secondaryHolmFamily;
  const holmAdjustedPValues = holmBonferroni(empiricalPValues, secondaryContrastIds);

  return {
    conceptClusters: conceptIds.length,
    confidenceIntervals,
    empiricalPValues,
    holmAdjustedPValues,
  };
}

function pairedEstimate(rows, mode, metric) {
  const prepared = pairedBlocks(rows, mode, metric.id);
  const bootstrap = clusterBootstrapContrasts(prepared.blocks);
  return {
    metric: metric.id,
    definition: mode === 'itt'
      ? `Intent-to-treat paired estimate for ${metric.id}: every four-arm scheduled block is retained; failed runs carry the explicit zero assigned during scoring.`
      : `Clean-completed paired estimate for ${metric.id}: includes only blocks where all four arms have status=completed, no error, and a numeric score.`,
    scheduledBlocks: prepared.scheduledBlocks,
    armCompleteBlocks: prepared.armCompleteBlocks,
    pairedBlocks: prepared.blocks.length,
    excludedBlocks: prepared.scheduledBlocks - prepared.blocks.length,
    conceptClusters: bootstrap.conceptClusters,
    contrasts: Object.fromEntries(FACTORIAL_CONTRASTS.map(contrast => [contrast.id, {
      tier: contrast.tier,
      estimate: mean(prepared.blocks.map(block => contrast.value(block.values))),
      ci95: bootstrap.confidenceIntervals[contrast.id],
      bootstrapPValue: bootstrap.empiricalPValues[contrast.id],
      holmAdjustedPValue: contrast.tier === 'secondary'
        ? bootstrap.holmAdjustedPValues[contrast.id]
        : null,
    }])),
  };
}

function pairedEffects(rows) {
  return {
    bootstrap: {
      method: 'percentile concept-cluster bootstrap',
      pValueMethod: 'two-sided centered concept-cluster bootstrap with finite-sample correction',
      clusterUnit: 'conceptId',
      confidenceLevel: 0.95,
      iterations: BOOTSTRAP_ITERATIONS,
      seed: (DATASET_SEED ^ 0x61c88647) >>> 0,
      contrastPolicy: CONTRAST_POLICY,
    },
    metrics: Object.fromEntries(SUCCESS_METRICS.map(metric => [metric.id, {
      label: metric.label,
      description: metric.description,
      itt: pairedEstimate(rows, 'itt', metric),
      cleanCompletedPaired: pairedEstimate(rows, 'clean-completed', metric),
    }])),
  };
}

function pairedNegativeBlocks(rows, stratum) {
  const relevant = rows.filter(row => row.negativeKind === stratum);
  const rawBlocks = new Map();
  for (const row of relevant) {
    const key = `${row.caseId}:${row.repeat}`;
    const block = rawBlocks.get(key) ?? {
      key,
      caseId: row.caseId,
      conceptId: row.conceptId,
      repeat: row.repeat,
      arms: {},
    };
    block.arms[row.arm] = row;
    rawBlocks.set(key, block);
  }
  const blocks = [...rawBlocks.values()].map(block => {
    const target = block.arms[NEGATIVE_SAFETY_GATE_POLICY.targetArm];
    const comparator = block.arms[NEGATIVE_SAFETY_GATE_POLICY.comparatorArm];
    if (!target || !comparator) {
      throw new Error(`Negative-safety block ${block.key} is missing target or comparator arm`);
    }
    const targetValue = target.metrics?.negativeIttFalsePositive;
    const comparatorValue = comparator.metrics?.negativeIttFalsePositive;
    if (![targetValue, comparatorValue].every(value => value === 0 || value === 1)) {
      throw new Error(`Negative-safety block ${block.key} has a missing/non-binary ITT false-positive score`);
    }
    return {
      key: block.key,
      caseId: block.caseId,
      conceptId: block.conceptId,
      repeat: block.repeat,
      difference: targetValue - comparatorValue,
    };
  });
  return { scheduledBlocks: rawBlocks.size, blocks };
}

function bootstrapNegativeDifference(blocks, stratum) {
  const byConcept = new Map();
  for (const block of blocks) {
    const conceptBlocks = byConcept.get(block.conceptId) ?? [];
    conceptBlocks.push(block);
    byConcept.set(block.conceptId, conceptBlocks);
  }
  const conceptIds = [...byConcept.keys()].sort();
  const stratumSalt = stratum === 'hard' ? 0x85ebca6b : 0xc2b2ae35;
  const seed = (DATASET_SEED ^ 0x27d4eb2d ^ stratumSalt) >>> 0;
  const samples = [];
  if (conceptIds.length > 0) {
    const random = seededRandom(seed);
    for (let iteration = 0; iteration < BOOTSTRAP_ITERATIONS; iteration += 1) {
      const sampledBlocks = [];
      for (let draw = 0; draw < conceptIds.length; draw += 1) {
        const conceptId = conceptIds[Math.floor(random() * conceptIds.length)];
        sampledBlocks.push(...byConcept.get(conceptId));
      }
      samples.push(mean(sampledBlocks.map(block => block.difference)));
    }
  }
  samples.sort((left, right) => left - right);
  return {
    seed,
    conceptClusters: conceptIds.length,
    ci95TwoSided: {
      lower: quantile(samples, 0.025),
      upper: quantile(samples, 0.975),
    },
    upper95OneSided: quantile(samples, NEGATIVE_SAFETY_GATE_POLICY.upperConfidenceLevel),
  };
}

function negativeSafetyStratum(rows, stratum) {
  const paired = pairedNegativeBlocks(rows, stratum);
  const bootstrap = bootstrapNegativeDifference(paired.blocks, stratum);
  return {
    stratum,
    arms: Object.fromEntries(ARMS.map(arm => [
      arm.id,
      summarizeNegativeRows(rows.filter(row => row.arm === arm.id && row.negativeKind === stratum)),
    ])),
    targetMinusComparator: {
      targetArm: NEGATIVE_SAFETY_GATE_POLICY.targetArm,
      comparatorArm: NEGATIVE_SAFETY_GATE_POLICY.comparatorArm,
      estimate: mean(paired.blocks.map(block => block.difference)),
      pairedBlocks: paired.blocks.length,
      scheduledBlocks: paired.scheduledBlocks,
      conceptClusters: bootstrap.conceptClusters,
      ci95TwoSided: bootstrap.ci95TwoSided,
      upper95OneSided: bootstrap.upper95OneSided,
      bootstrapSeed: bootstrap.seed,
    },
  };
}

function negativeSafetyAnalysis(rows) {
  const strata = Object.fromEntries(NEGATIVE_SAFETY_ENDPOINT.strata.map(stratum => [
    stratum,
    negativeSafetyStratum(rows, stratum),
  ]));
  const hard = strata[NEGATIVE_SAFETY_GATE_POLICY.stratum];
  const targetFpr = hard.arms[NEGATIVE_SAFETY_GATE_POLICY.targetArm].ittFalsePositiveRate;
  const differenceUpper = hard.targetMinusComparator.upper95OneSided;
  const targetRatePass = targetFpr == null
    ? null
    : targetFpr <= NEGATIVE_SAFETY_GATE_POLICY.maxTargetFprInclusive;
  const differencePass = differenceUpper == null
    ? null
    : differenceUpper < NEGATIVE_SAFETY_GATE_POLICY.maxDifferenceUpperExclusive;
  return {
    endpoint: NEGATIVE_SAFETY_ENDPOINT,
    policy: NEGATIVE_SAFETY_GATE_POLICY,
    bootstrap: {
      method: 'percentile concept-cluster bootstrap',
      iterations: BOOTSTRAP_ITERATIONS,
      clusterUnit: 'conceptId',
    },
    strata,
    gate: {
      targetFpr,
      targetFprThresholdInclusive: NEGATIVE_SAFETY_GATE_POLICY.maxTargetFprInclusive,
      targetRatePass,
      differenceUpper95OneSided: differenceUpper,
      differenceUpperThresholdExclusive: NEGATIVE_SAFETY_GATE_POLICY.maxDifferenceUpperExclusive,
      differencePass,
      pass: targetRatePass == null || differencePass == null
        ? null
        : targetRatePass && differencePass,
    },
  };
}

function assertRequiredScoringMetrics(row, prefix = `Run ${row.runId}`) {
  for (const metric of SUCCESS_METRICS) {
    const value = row.metrics?.[metric.id];
    if (value !== 0 && value !== 1) {
      throw new Error(
        `${prefix} is missing binary metrics.${metric.id}; old/incompatible results must not be summarized as zero`,
      );
    }
  }
  if (!Object.hasOwn(row.metrics ?? {}, NEGATIVE_SAFETY_ENDPOINT.id)) {
    throw new Error(
      `${prefix} is missing metrics.${NEGATIVE_SAFETY_ENDPOINT.id}; old/incompatible results must not be excluded from ITT FPR`,
    );
  }
  const negativeIttValue = row.metrics[NEGATIVE_SAFETY_ENDPOINT.id];
  const isNegativeStratum = NEGATIVE_SAFETY_ENDPOINT.strata.includes(row.negativeKind);
  if (isNegativeStratum ? ![0, 1].includes(negativeIttValue) : negativeIttValue !== null) {
    throw new Error(
      `${prefix} has invalid metrics.${NEGATIVE_SAFETY_ENDPOINT.id}=${negativeIttValue}; expected ${isNegativeStratum ? '0 or 1' : 'null'}`,
    );
  }
}

function assertScoredMetrics(rows, dryRun) {
  if (dryRun) return;
  for (const row of rows) {
    assertRequiredScoringMetrics(row);
  }
}

function buildSummary(rows, dryRun) {
  assertScoredMetrics(rows, dryRun);
  return {
    dryRun,
    schedule: {
      runs: rows.length,
      completeBlocks: rows.length / ARMS.length,
      arms: Object.fromEntries(ARMS.map(arm => [arm.id, rows.filter(row => row.arm === arm.id).length])),
    },
    arms: ARMS.map(arm => ({
      arm: arm.id,
      ...summarizeArmRows(rows.filter(row => row.arm === arm.id), dryRun),
    })),
    effects: dryRun ? null : pairedEffects(rows),
    negativeSafety: dryRun ? null : negativeSafetyAnalysis(rows),
  };
}

function percent(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function number(value, digits = 1) {
  return value == null ? 'n/a' : Number(value).toFixed(digits);
}

function confidenceInterval(interval) {
  if (interval?.lower == null || interval?.upper == null) return 'n/a';
  return `[${percent(interval.lower)}, ${percent(interval.upper)}]`;
}

function probability(value) {
  if (value == null) return 'n/a';
  return value < 0.0001 ? '<0.0001' : value.toFixed(4);
}

function appendEffectEstimate(lines, title, estimate) {
  lines.push(
    `#### ${title}`,
    '',
    estimate.definition,
    '',
    `Paired blocks: ${estimate.pairedBlocks}/${estimate.scheduledBlocks}; excluded: ${estimate.excludedBlocks}; conceptId clusters: ${estimate.conceptClusters}.`,
    '',
    '| Contrast | Role | Point estimate | 95% cluster-bootstrap CI | Centered bootstrap p | Holm-adjusted p |',
    '|---|---|---:|---:|---:|---:|',
  );
  for (const contrast of FACTORIAL_CONTRASTS) {
    const result = estimate.contrasts[contrast.id];
    const adjusted = contrast.tier === 'secondary'
      ? probability(result.holmAdjustedPValue)
      : 'n/a';
    lines.push(`| ${contrast.label} | ${contrast.tier} | ${percent(result.estimate)} | ${confidenceInterval(result.ci95)} | ${probability(result.bootstrapPValue)} | ${adjusted} |`);
  }
  lines.push('');
}

function appendNegativeSafetyReport(lines, summary) {
  lines.push(
    '',
    '## Preregistered negative-safety gate',
    '',
    'The negative-safety endpoint is intent-to-treat: an affirmative/file return, failed run, missing output or invalid output scores as a false positive (`1`). Correct refusal scores `0`.',
    '',
  );
  if (summary.negativeSafety == null) {
    lines.push('Dry-run only: hard-negative and clean-negative safety effects were not estimated.', '');
    return;
  }

  lines.push(
    '| Arm | Hard N | Hard FP | Hard ITT FPR | Hard failed/invalid | Clean N | Clean FP | Clean ITT FPR | Clean failed/invalid |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  );
  for (const arm of summary.arms) {
    const hard = arm.negativeSafety.hard;
    const clean = arm.negativeSafety.clean;
    lines.push(`| ${arm.arm} | ${hard.n} | ${hard.falsePositives} | ${percent(hard.ittFalsePositiveRate)} | ${hard.failedOrInvalid} | ${clean.n} | ${clean.falsePositives} | ${percent(clean.ittFalsePositiveRate)} | ${clean.failedOrInvalid} |`);
  }
  lines.push(
    '',
    'Paired safety difference is D - B (`modern-vesti` minus `modern-none`); lower is safer.',
    '',
    '| Stratum | Paired blocks | conceptId clusters | D - B | Two-sided 95% cluster-bootstrap CI | One-sided 95% upper bound |',
    '|---|---:|---:|---:|---:|---:|',
  );
  for (const stratum of NEGATIVE_SAFETY_ENDPOINT.strata) {
    const result = summary.negativeSafety.strata[stratum].targetMinusComparator;
    lines.push(`| ${stratum} | ${result.pairedBlocks} | ${result.conceptClusters} | ${percent(result.estimate)} | ${confidenceInterval(result.ci95TwoSided)} | ${percent(result.upper95OneSided)} |`);
  }
  const gate = summary.negativeSafety.gate;
  const gateStatus = gate.pass == null ? 'INDETERMINATE' : gate.pass ? 'PASS' : 'FAIL';
  lines.push(
    '',
    `Gate: **${gateStatus}**. It passes only if D hard-negative ITT FPR (${percent(gate.targetFpr)}) is <= ${percent(gate.targetFprThresholdInclusive)} and the one-sided 95% upper bound for D - B (${percent(gate.differenceUpper95OneSided)}) is < ${percent(gate.differenceUpperThresholdExclusive)}.`,
    '',
  );
}

function buildReport(manifest, summary) {
  const lines = [
    '# VESTI file-search Agent V2 experiment',
    '',
    `- Mode: **${manifest.dryRun ? 'dry-run (no model calls)' : 'executed'}**`,
    `- Dataset: \`${manifest.datasetId}\`, phase \`${manifest.phase}\`, ${manifest.caseCount} cases × ${manifest.repeats} repeat(s) × 4 arms`,
    `- Model: \`${manifest.model}\`; concurrency ${manifest.concurrency}`,
    `- Frozen fixture SHA-256: \`${manifest.fixtureSha256}\``,
    `- Frozen treatment SHA-256: placebo \`${manifest.skillHashes.placebo}\`; VESTI \`${manifest.skillHashes.vesti}\``,
    `- APP MCP dist SHA-256: \`${manifest.mcpArtifactSha256}\``,
    '',
    '## Arms',
    '',
    '| Arm | Tool surface | Skill | N | Completed | End-to-end success | Retrieval-only success | Hit@3 | Recall@5 | Project | Evidence | Historical | Return precision | Unsupported | Retrieval precision | Retrieval unsupported | Negative FP | Calls | Input tokens | Duration ms |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const arm of summary.arms) {
    const definition = ARMS.find(entry => entry.id === arm.arm);
    lines.push(`| ${arm.arm} | ${definition.toolVariant} | ${definition.skill} | ${arm.n} | ${arm.completed} | ${percent(arm.taskSuccess)} | ${percent(arm.retrievalTaskSuccess)} | ${percent(arm.hit3)} | ${percent(arm.recall5)} | ${percent(arm.projectAccuracy)} | ${percent(arm.evidenceAccuracy)} | ${percent(arm.historicalAccuracy)} | ${percent(arm.returnedFilePrecision)} | ${percent(arm.unsupportedReturnRate)} | ${percent(arm.retrievalReturnedFilePrecision)} | ${percent(arm.retrievalUnsupportedReturnRate)} | ${percent(arm.negativeFalsePositive)} | ${number(arm.toolCallsMedian)} | ${number(arm.inputTokensMedian, 0)} | ${number(arm.durationMsMedian)} |`);
  }
  appendNegativeSafetyReport(lines, summary);
  lines.push(
    '## Preregistered success contrasts',
    '',
    'For both endpoints, D - B (`modern-vesti` minus `modern-none`) is the sole primary contrast. D - C and D - A form the two-test secondary family and use Holm-Bonferroni adjustment. B - A and C - B are exploratory.',
    '',
    'The end-to-end endpoint (`taskSuccess`) includes the `historical_only` contract. The retrieval-only endpoint (`retrievalTaskSuccess`) scores complete path, project and evidence retrieval with zero unsupported files, without requiring `historical_only`.',
    '',
  );
  if (summary.effects == null) {
    lines.push('Dry-run only: no effects were estimated.');
  } else {
    lines.push(
      `Uncertainty uses a fixed-seed percentile bootstrap over \`conceptId\` clusters (${summary.effects.bootstrap.iterations} iterations, seed ${summary.effects.bootstrap.seed}).`,
      `Reported p-values use a two-sided centered cluster bootstrap with finite-sample correction; the secondary family is adjusted with Holm-Bonferroni.`,
      '',
    );
    for (const metric of SUCCESS_METRICS) {
      const effects = summary.effects.metrics[metric.id];
      lines.push(`### ${effects.label}`, '', effects.description, '');
      appendEffectEstimate(lines, 'ITT paired estimate (explicit failure scores retained)', effects.itt);
      appendEffectEstimate(lines, 'Clean-completed paired estimate', effects.cleanCompletedPaired);
    }
  }
  lines.push(
    '',
    '## Boundaries',
    '',
    '- Every task/arm/repeat uses a fresh ephemeral Codex process and its own byte-identical database copy.',
    '- The common prompt contains only the task and schema-output requirement. C and D receive frozen text through the same prompt wrapper.',
    '- Frozen text is prompt-injected; this experiment does not test runtime Skill discovery or trigger accuracy.',
    '- Shell, plugins, user config, project rules and web retrieval are excluded. Only the arm-specific VESTI MCP tools are enabled.',
    '- For positive cases, a retrieval-supported file must match one gold path and project, report at least one evidence session ID, and report no evidence ID outside that target. Retrieval-only success requires every target within top 5 and zero unsupported returns.',
    '- End-to-end task success adds the requirement that every target and returned supported file has `historical_only=true`.',
    '- For negative cases, both success endpoints require a correct refusal; negative false-positive rate is reported instead of returned-file precision.',
    '- Negative-safety ITT FPR is stratified into hard and clean negatives. Unlike the descriptive `negativeFalsePositive` field, failed or invalid runs are conservatively counted as false positives.',
    '- The preregistered safety gate uses hard negatives only: D FPR must be <= 20%, and the one-sided 95% concept-cluster-bootstrap upper bound for D - B must be < +10 percentage points.',
    '- Holm-Bonferroni adjustment is applied only across the two preregistered secondary contrasts (D - C and D - A), separately for each endpoint and analysis population. Primary and exploratory contrasts are not included in that family.',
    '- This inspectable synthetic corpus is an engineering benchmark, not a hidden production holdout.',
    `- Phase \`${manifest.phase}\` is ${manifest.phase === 'calibration' ? 'for pipeline calibration and Skill development, not confirmatory claims' : 'the confirmatory run and must use a dataset frozen before execution'}.`,
    '',
  );
  return lines.join('\n');
}

const RESULT_ARTIFACTS = ['manifest.json', 'runs.ndjson', 'summary.json', 'report.md'];

const RESUME_FINGERPRINT_FIELDS = [
  'schemaVersion',
  'dryRun',
  'phase',
  'datasetId',
  'datasetSeed',
  'datasetIntegrity',
  'datasetModuleSha256',
  'corpusSha256',
  'maxCases',
  'selectedCaseIds',
  'caseCount',
  'repeats',
  'runCount',
  'experimentHash',
  'scheduleSha256',
  'model',
  'codexVersion',
  'timeoutMs',
  'fixtureSha256',
  'fixtureCounts',
  'mcpArtifactSha256',
  'benchmarkMcpServerSha256',
  'benchmarkServerInstructionsSha256',
  'toolSets',
  'successEndpoints',
  'contrastPolicy',
  'negativeSafetyEndpoint',
  'negativeSafetyGatePolicy',
  'skillHashes',
  'armHashes',
  'neutralInstructionsSha256',
  'outputSchemaSha256',
  'runnerSha256',
];

function resultArtifactPaths(resultsDir) {
  mkdirSync(resultsDir, { recursive: true });
  return Object.fromEntries(RESULT_ARTIFACTS.map(name => [name, resolve(resultsDir, name)]));
}

function prepareResultsDirectory(resultsDir, resume) {
  const paths = resultArtifactPaths(resultsDir);
  const existing = RESULT_ARTIFACTS.filter(name => existsSync(paths[name]));
  if (!resume && existing.length > 0) {
    throw new Error(`Refusing to overwrite existing result artifacts: ${existing.join(', ')}`);
  }
  if (resume) {
    const missing = ['manifest.json', 'runs.ndjson'].filter(name => !existsSync(paths[name]));
    if (missing.length > 0) {
      throw new Error(`Cannot resume without existing artifact(s): ${missing.join(', ')}`);
    }
  }
  return paths;
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateResumeManifest(existing, expected) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error('Resume manifest must be a JSON object');
  }
  if (!['running', 'completed', 'completed-with-errors'].includes(existing.status)) {
    throw new Error(`Resume manifest has unsupported status: ${existing.status}`);
  }
  const mismatches = [];
  for (const field of RESUME_FINGERPRINT_FIELDS) {
    if (JSON.stringify(existing[field]) !== JSON.stringify(expected[field])) {
      mismatches.push(field);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Resume fingerprint mismatch: ${mismatches.join(', ')}`);
  }
}

function expectedRunIdentity(run, fixtureSha256, skillTexts) {
  const prompt = buildPrompt(run.testCase.query, skillTexts, run.arm.skill);
  assertPromptIsBlind(run.testCase, prompt);
  const placeholderDb = resolve(tmpdir(), '__vesti_factorial_resume__', `${run.runId}.sqlite`);
  const args = buildCodexArgs({ dbPath: placeholderDb, tools: run.arm.tools });
  return {
    scheduleIndex: run.scheduleIndex,
    blockOrder: run.blockOrder,
    armOrder: run.armOrder,
    repeat: run.repeat,
    runId: run.runId,
    experimentHash: run.experimentHash,
    armHash: run.armHash,
    caseId: run.testCase.id,
    conceptId: run.testCase.conceptId,
    split: run.testCase.split,
    category: run.testCase.category,
    negativeKind: run.testCase.negativeKind ?? null,
    arm: run.arm.id,
    toolVariant: run.arm.toolVariant,
    skill: run.arm.skill,
    query: run.testCase.query,
    expectedTargets: run.testCase.targets,
    promptSha256: sha256(prompt),
    fixtureSha256,
    codexArgs: sanitizeCodexArgs(args, placeholderDb),
  };
}

function validateExistingRunRow(row, run, fixtureSha256, skillTexts, dryRun, lineNumber) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`runs.ndjson line ${lineNumber} must contain a JSON object`);
  }
  const expected = expectedRunIdentity(run, fixtureSha256, skillTexts);
  const mismatches = Object.entries(expected)
    .filter(([field, value]) => JSON.stringify(row[field]) !== JSON.stringify(value))
    .map(([field]) => field);
  if (mismatches.length > 0) {
    throw new Error(`Existing run ${row.runId} does not match the plan: ${mismatches.join(', ')}`);
  }
  const allowedStatuses = dryRun ? new Set(['dry-run', 'failed']) : new Set(['completed', 'failed']);
  if (!allowedStatuses.has(row.status)) {
    throw new Error(`Existing run ${row.runId} has invalid status for this mode: ${row.status}`);
  }
  if (row.status === 'failed' && !['agent', 'infrastructure'].includes(row.failureKind)) {
    throw new Error(`Existing failed run ${row.runId} has no valid failureKind`);
  }
  if (row.status !== 'failed' && row.failureKind != null) {
    throw new Error(`Existing non-failed run ${row.runId} unexpectedly has failureKind=${row.failureKind}`);
  }
  if (!row.trace || typeof row.trace !== 'object' || Array.isArray(row.trace)) {
    throw new Error(`Existing run ${row.runId} is missing a parseable trace`);
  }
  if (!dryRun) {
    assertRequiredScoringMetrics(
      row,
      `Existing run ${row.runId} was produced by an incompatible runner and`,
    );
  }
}

function loadExistingRows(path, schedule, fixtureSha256, skillTexts, dryRun) {
  const planned = new Map();
  for (const run of schedule) {
    if (planned.has(run.runId)) throw new Error(`Duplicate planned runId: ${run.runId}`);
    planned.set(run.runId, run);
  }
  const rows = [];
  const retriableRows = [];
  const seen = new Set();
  const content = readFileSync(path, 'utf8');
  const parsed = parseNdjsonDocument(content, 'runs.ndjson');
  for (const { lineNumber, value: row } of parsed.records) {
    if (typeof row?.runId !== 'string' || !row.runId) {
      throw new Error(`runs.ndjson line ${lineNumber} has no valid runId`);
    }
    if (seen.has(row.runId)) throw new Error(`Duplicate runId in runs.ndjson: ${row.runId}`);
    const run = planned.get(row.runId);
    if (!run) throw new Error(`Plan-external runId in runs.ndjson: ${row.runId}`);
    validateExistingRunRow(row, run, fixtureSha256, skillTexts, dryRun, lineNumber);
    seen.add(row.runId);
    if (isRetriableInfrastructureRow(row)) retriableRows.push(row);
    else rows.push(row);
  }
  return { rows, retriableRows, trailingPartial: parsed.trailingPartial };
}

function isRetriableInfrastructureRow(row) {
  return row?.status === 'failed' && row?.failureKind === 'infrastructure';
}

function cleanupActionWithRetries(label, action) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      action();
      return null;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * (attempt + 1));
      }
    }
  }
  return {
    label,
    code: lastError?.code ?? null,
    message: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

async function runSchedule({
  schedule,
  concurrency,
  execute,
  onComplete,
  onDrain = async () => {},
  initialCompleted = 0,
  totalRuns = schedule.length,
}) {
  let cursor = 0;
  let completed = initialCompleted;
  let stopScheduling = false;
  const workerErrors = [];

  const recordWorkerError = (stage, error) => {
    stopScheduling = true;
    workerErrors.push(new Error(
      `${stage}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    ));
  };

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (stopScheduling) return;
      const index = cursor;
      cursor += 1;
      if (index >= schedule.length) return;
      let row;
      try {
        row = await execute(schedule[index]);
      } catch (error) {
        recordWorkerError(`execute ${schedule[index].runId}`, error);
        return;
      }
      try {
        await onComplete(row);
      } catch (error) {
        recordWorkerError(`persist ${row?.runId ?? schedule[index].runId}`, error);
        return;
      }
      completed += 1;
      console.log(`[${completed}/${totalRuns}] ${row.runId} ${row.arm} ${row.status}`);
    }
  });
  await Promise.allSettled(workers);
  await onDrain();
  if (workerErrors.length > 0) {
    const details = workerErrors.map(error => error.message).join(' | ');
    throw new AggregateError(
      workerErrors,
      `Schedule stopped after ${workerErrors.length} worker error(s); all active workers were drained: ${details}`,
    );
  }
}

function selfTestAssertion(condition, message) {
  if (!condition) throw new Error(`V2 runner self-test failed: ${message}`);
}

function injectedIoError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function runSelfTests() {
  const root = mkdtempSync(resolve(tmpdir(), 'vesti-agent-v2-io-self-test-'));
  try {
    const queuePath = resolve(root, 'queue.ndjson');
    writeFileSync(queuePath, '');
    let injectedFailures = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const writer = new SerialNdjsonWriter(queuePath, async (path, contents) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await delay(2);
        if (injectedFailures < 2) {
          injectedFailures += 1;
          throw injectedIoError(injectedFailures === 1 ? 'EBUSY' : 'EPERM', 'fault injection');
        }
        appendFileSync(path, contents);
      } finally {
        inFlight -= 1;
      }
    });
    const queuedRows = Array.from({ length: 6 }, (_, index) => ({ index }));
    await Promise.all(queuedRows.map(row => writer.append(row)));
    await writer.drain();
    const queueDocument = parseNdjsonDocument(readFileSync(queuePath, 'utf8'), 'self-test queue');
    selfTestAssertion(maxInFlight === 1, `writer concurrency was ${maxInFlight}, expected 1`);
    selfTestAssertion(queueDocument.trailingPartial == null, 'complete queue was mistaken for a partial tail');
    selfTestAssertion(
      JSON.stringify(queueDocument.records.map(record => record.value)) === JSON.stringify(queuedRows),
      'writer did not preserve enqueue order after retry',
    );

    const partialDocument = parseNdjsonDocument(
      '{"index":0}\n{"index":1}\n{"index":',
      'self-test partial',
    );
    selfTestAssertion(partialDocument.records.length === 2, 'valid prefix was not retained');
    selfTestAssertion(partialDocument.trailingPartial?.lineNumber === 3, 'partial EOF line was not identified');
    let interiorCorruptionRejected = false;
    try {
      parseNdjsonDocument('{"index":0}\nnot-json\n{"index":2}\n', 'self-test corrupt');
    } catch {
      interiorCorruptionRejected = true;
    }
    selfTestAssertion(interiorCorruptionRejected, 'interior NDJSON corruption was accepted');

    const resumeSkillTexts = { placebo: 'placebo', vesti: 'vesti' };
    const resumeCase = {
      id: 'self-test-case',
      conceptId: 'self-test-concept',
      split: 'calibration',
      category: 'negative',
      negativeKind: 'clean',
      query: 'self-test query',
      targets: [],
    };
    const resumeSchedule = ['infra', 'agent'].map((suffix, index) => ({
      scheduleIndex: index,
      blockOrder: 0,
      armOrder: index,
      repeat: 0,
      runId: `self-test-resume-${suffix}`,
      experimentHash: 'self-test-experiment',
      armHash: `self-test-arm-${suffix}`,
      testCase: resumeCase,
      arm: ARMS[index],
    }));
    const resumeRows = resumeSchedule.map((run, index) => ({
      ...expectedRunIdentity(run, 'self-test-fixture', resumeSkillTexts),
      runId: run.runId,
      status: 'failed',
      failureKind: index === 0 ? 'infrastructure' : 'agent',
      metrics: {
        taskSuccess: 0,
        retrievalTaskSuccess: 0,
        negativeIttFalsePositive: 1,
      },
      trace: {},
      error: 'self-test failure',
    }));
    const resumePath = resolve(root, 'resume.ndjson');
    writeFileSync(
      resumePath,
      `${resumeRows.map(row => JSON.stringify(row)).join('\n')}\n{"runId":`,
    );
    const loadedResume = loadExistingRows(
      resumePath,
      resumeSchedule,
      'self-test-fixture',
      resumeSkillTexts,
      false,
    );
    selfTestAssertion(loadedResume.rows.length === 1, 'agent failure was not retained on resume');
    selfTestAssertion(loadedResume.retriableRows.length === 1, 'infrastructure failure was not made pending');
    selfTestAssertion(loadedResume.trailingPartial?.lineNumber === 3, 'resume did not isolate the partial tail');

    const tamperedPath = resolve(root, 'tampered.ndjson');
    writeFileSync(tamperedPath, `${JSON.stringify({ ...resumeRows[0], query: 'tampered' })}\n`);
    let tamperingRejected = false;
    try {
      loadExistingRows(
        tamperedPath,
        resumeSchedule,
        'self-test-fixture',
        resumeSkillTexts,
        false,
      );
    } catch {
      tamperingRejected = true;
    }
    selfTestAssertion(tamperingRejected, 'resume accepted a row that failed strict identity validation');

    const missingRetrievalMetricPath = resolve(root, 'missing-retrieval-metric.ndjson');
    writeFileSync(missingRetrievalMetricPath, `${JSON.stringify({
      ...resumeRows[1],
      status: 'completed',
      failureKind: null,
      error: null,
      metrics: { taskSuccess: 1 },
    })}\n`);
    let missingRetrievalMetricRejected = false;
    try {
      loadExistingRows(
        missingRetrievalMetricPath,
        resumeSchedule,
        'self-test-fixture',
        resumeSkillTexts,
        false,
      );
    } catch (error) {
      missingRetrievalMetricRejected = String(error).includes('retrievalTaskSuccess');
    }
    selfTestAssertion(
      missingRetrievalMetricRejected,
      'resume silently accepted a row without retrievalTaskSuccess',
    );

    const missingNegativeIttMetricPath = resolve(root, 'missing-negative-itt-metric.ndjson');
    writeFileSync(missingNegativeIttMetricPath, `${JSON.stringify({
      ...resumeRows[1],
      status: 'completed',
      failureKind: null,
      error: null,
      metrics: { taskSuccess: 1, retrievalTaskSuccess: 1 },
    })}\n`);
    let missingNegativeIttMetricRejected = false;
    try {
      loadExistingRows(
        missingNegativeIttMetricPath,
        resumeSchedule,
        'self-test-fixture',
        resumeSkillTexts,
        false,
      );
    } catch (error) {
      missingNegativeIttMetricRejected = String(error).includes('negativeIttFalsePositive');
    }
    selfTestAssertion(
      missingNegativeIttMetricRejected,
      'resume silently accepted a negative row without negativeIttFalsePositive',
    );

    const positiveCase = {
      id: 'self-test-positive',
      mustAbstain: false,
      targets: [{
        path: 'src/needle.ts',
        projectPath: 'C:/work/needle',
        sessionIds: ['session-evidence'],
        currentState: 'missing',
      }],
    };
    const retrievalOnlyOutput = {
      answerable: true,
      files: [{
        path: 'src/needle.ts',
        project: 'C:/work/needle',
        evidence_session_ids: ['session-evidence'],
        historical_only: false,
      }],
    };
    const retrievalOnlyScore = scoreAgentOutput(positiveCase, retrievalOnlyOutput, null);
    selfTestAssertion(
      retrievalOnlyScore.retrievalTaskSuccess === 1 && retrievalOnlyScore.taskSuccess === 0,
      'retrieval-only success did not remain independent of historical_only',
    );
    const endToEndScore = scoreAgentOutput(positiveCase, {
      ...retrievalOnlyOutput,
      files: retrievalOnlyOutput.files.map(file => ({ ...file, historical_only: true })),
    }, null);
    selfTestAssertion(
      endToEndScore.retrievalTaskSuccess === 1 && endToEndScore.taskSuccess === 1,
      'end-to-end success did not accept a fully supported historical result',
    );
    const unsupportedExtraScore = scoreAgentOutput(positiveCase, {
      ...retrievalOnlyOutput,
      files: [
        ...retrievalOnlyOutput.files,
        {
          path: 'src/unsupported.ts',
          project: 'C:/work/needle',
          evidence_session_ids: ['session-evidence'],
          historical_only: false,
        },
      ],
    }, null);
    selfTestAssertion(
      unsupportedExtraScore.retrievalTaskSuccess === 0,
      'retrieval-only success accepted an unsupported extra file',
    );
    const negativeCase = { id: 'self-test-negative', mustAbstain: true, targets: [] };
    const negativeScore = scoreAgentOutput(negativeCase, { answerable: false, files: [] }, null);
    selfTestAssertion(
      negativeScore.taskSuccess === 1
        && negativeScore.retrievalTaskSuccess === 1
        && negativeScore.negativeIttFalsePositive === 0,
      'the two success endpoints disagree on a correct negative refusal',
    );
    const failedNegativeScore = scoreAgentOutput(negativeCase, null, 'invalid model output');
    selfTestAssertion(
      failedNegativeScore.negativeFalsePositive == null
        && failedNegativeScore.negativeIttFalsePositive === 1,
      'failed/invalid negative output was not conservatively scored as an ITT false positive',
    );
    const affirmativeNegativeScore = scoreAgentOutput(
      negativeCase,
      { answerable: true, files: [] },
      null,
    );
    selfTestAssertion(
      affirmativeNegativeScore.negativeIttFalsePositive === 1,
      'affirmative negative output was not scored as an ITT false positive',
    );

    const safetyRows = NEGATIVE_SAFETY_ENDPOINT.strata.flatMap(stratum => ARMS.map(arm => {
      const isCleanTarget = stratum === 'clean' && arm.id === NEGATIVE_SAFETY_GATE_POLICY.targetArm;
      const negativeIttFalsePositive = isCleanTarget ? 1 : 0;
      return {
        runId: `self-test-safety-${stratum}-${arm.id}`,
        caseId: `self-test-safety-${stratum}`,
        conceptId: `self-test-safety-${stratum}-concept`,
        repeat: 0,
        arm: arm.id,
        category: 'negative',
        negativeKind: stratum,
        status: 'completed',
        error: null,
        metrics: {
          taskSuccess: negativeIttFalsePositive === 0 ? 1 : 0,
          retrievalTaskSuccess: negativeIttFalsePositive === 0 ? 1 : 0,
          negativeFalsePositive: negativeIttFalsePositive,
          negativeIttFalsePositive,
        },
      };
    }));
    const safetyAnalysis = negativeSafetyAnalysis(safetyRows);
    selfTestAssertion(
      safetyAnalysis.gate.pass === true
        && safetyAnalysis.strata.hard.arms['modern-vesti'].ittFalsePositiveRate === 0,
      'hard-negative safety gate did not pass a zero-FPR target/comparator fixture',
    );
    selfTestAssertion(
      safetyAnalysis.strata.clean.targetMinusComparator.estimate === 1
        && safetyAnalysis.strata.clean.arms['modern-vesti'].ittFalsePositiveRate === 1,
      'clean-negative stratum was not summarized independently',
    );
    const safetyReportLines = [];
    appendNegativeSafetyReport(safetyReportLines, {
      negativeSafety: safetyAnalysis,
      arms: ARMS.map(arm => ({
        arm: arm.id,
        negativeSafety: Object.fromEntries(NEGATIVE_SAFETY_ENDPOINT.strata.map(stratum => [
          stratum,
          safetyAnalysis.strata[stratum].arms[arm.id],
        ])),
      })),
    });
    const safetyReport = safetyReportLines.join('\n');
    selfTestAssertion(
      safetyReport.includes('Hard ITT FPR')
        && safetyReport.includes('| clean |')
        && safetyReport.includes('Gate: **PASS**'),
      'negative-safety report omitted an arm stratum, paired result or gate decision',
    );

    const effectRows = ARMS.map((arm, index) => ({
      runId: `self-test-effect-${arm.id}`,
      caseId: 'self-test-effect-case',
      conceptId: 'self-test-effect-concept',
      repeat: 0,
      arm: arm.id,
      status: 'completed',
      error: null,
      metrics: {
        taskSuccess: index === 3 ? 1 : 0,
        retrievalTaskSuccess: index >= 1 ? 1 : 0,
      },
    }));
    const effectSummary = pairedEffects(effectRows);
    selfTestAssertion(
      effectSummary.metrics.taskSuccess.itt.contrasts.primarySkillEffect.estimate === 1,
      'taskSuccess contrast was not computed from its own endpoint',
    );
    selfTestAssertion(
      effectSummary.metrics.retrievalTaskSuccess.itt.contrasts.primarySkillEffect.estimate === 0,
      'retrievalTaskSuccess contrast was not computed from its own endpoint',
    );
    selfTestAssertion(
      effectSummary.metrics.taskSuccess.itt.contrasts.primarySkillEffect.holmAdjustedPValue == null
        && typeof effectSummary.metrics.taskSuccess.itt.contrasts.skillBeyondPlacebo.holmAdjustedPValue === 'number',
      'Holm adjustment was not restricted to the two secondary contrasts',
    );

    let activeExecutions = 0;
    let scheduleRejected = false;
    const executed = [];
    const persisted = [];
    try {
      await runSchedule({
        schedule: Array.from({ length: 6 }, (_, index) => ({ runId: `self-test-${index}`, index })),
        concurrency: 2,
        execute: async run => {
          activeExecutions += 1;
          executed.push(run.index);
          try {
            await delay(run.index === 0 ? 2 : 20);
            return { runId: run.runId, index: run.index, arm: 'self-test', status: 'completed' };
          } finally {
            activeExecutions -= 1;
          }
        },
        onComplete: async row => {
          if (row.index === 0) throw injectedIoError('EBUSY', 'persist fault injection');
          persisted.push(row.index);
        },
      });
    } catch (error) {
      scheduleRejected = error instanceof AggregateError;
    }
    selfTestAssertion(scheduleRejected, 'worker persistence failure did not reject after drain');
    selfTestAssertion(activeExecutions === 0, 'runSchedule returned before active workers drained');
    selfTestAssertion(executed.length <= 2, `runSchedule started ${executed.length} tasks after cancellation`);
    selfTestAssertion(persisted.every(index => index !== 0), 'failed persistence was reported as persisted');
    selfTestAssertion(
      isRetriableInfrastructureRow({ status: 'failed', failureKind: 'infrastructure' })
        && !isRetriableInfrastructureRow({ status: 'failed', failureKind: 'agent' }),
      'resume infrastructure classification is incorrect',
    );

    console.log('V2 runner self-test passed: scoring endpoints, negative-safety ITT gate, dual-metric effects, Holm family, serialized retry, partial-tail recovery, drain/cancel, and infrastructure rerun classification.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    await runSelfTests();
    return;
  }
  MCP_ENTRY = options.mcpEntry;
  for (const required of [options.dataset, MCP_ENTRY, AGENT_MCP_SERVER_PATH, PLACEBO_SKILL_PATH, VESTI_SKILL_PATH, OUTPUT_SCHEMA_PATH]) {
    if (!existsSync(required)) throw new Error(`Required file does not exist: ${required}`);
  }
  const dataset = await import(`${pathToFileURL(options.dataset).href}?sha=${sha256File(options.dataset)}`);
  ({ cases, projects, sessions, DATASET_ID, DATASET_SEED } = dataset);
  datasetIntegrity = dataset.datasetIntegrity;
  if (!Array.isArray(cases) || !Array.isArray(projects) || !Array.isArray(sessions)) {
    throw new Error('Dataset must export arrays named cases, projects and sessions');
  }
  if (typeof DATASET_ID !== 'string' || !Number.isInteger(DATASET_SEED) || typeof datasetIntegrity !== 'function') {
    throw new Error('Dataset must export DATASET_ID, integer DATASET_SEED and datasetIntegrity()');
  }
  const resultPaths = prepareResultsDirectory(options.resultsDir, options.resume);
  const integrity = datasetIntegrity();
  const random = seededRandom(DATASET_SEED ^ 0x1140fac7);
  const aliases = options.phase === 'calibration'
    ? new Set(['calibration', 'dev', 'pilot'])
    : new Set(['formal', 'test', 'holdout', 'provisional-holdout']);
  const splitCases = cases.filter(testCase => aliases.has(testCase.phase ?? testCase.split));
  const selectedCases = shuffled(splitCases, random).slice(0, options.maxCases ?? splitCases.length);
  if (selectedCases.length === 0) throw new Error(`No cases selected for phase ${options.phase}`);

  const skillTexts = {
    placebo: readFileSync(PLACEBO_SKILL_PATH, 'utf8'),
    vesti: readFileSync(VESTI_SKILL_PATH, 'utf8'),
  };
  JSON.parse(readFileSync(OUTPUT_SCHEMA_PATH, 'utf8'));
  const invocation = resolveCodexInvocation();
  const fixture = buildFixtureDb({ sessions });
  const fixtureSha256 = sha256File(fixture.dbPath);
  const mcpArtifact = sha256Directory(dirname(MCP_ENTRY));
  const datasetModuleSha256 = sha256File(options.dataset);
  const corpusSha256 = sha256Json({ projects, sessions, cases });
  const outputSchemaSha256 = sha256File(OUTPUT_SCHEMA_PATH);
  const runnerSha256 = sha256File(RUNNER_PATH);
  const benchmarkMcpServerSha256 = sha256File(AGENT_MCP_SERVER_PATH);
  const benchmarkServerInstructionsSha256 = sha256(BENCHMARK_SERVER_INSTRUCTIONS);
  const neutralInstructionsSha256 = sha256(NEUTRAL_INSTRUCTIONS);
  const skillHashes = {
    placebo: sha256(skillTexts.placebo),
    vesti: sha256(skillTexts.vesti),
  };
  const armHashes = Object.fromEntries(ARMS.map(arm => [arm.id, sha256Json({
    id: arm.id,
    tools: arm.tools,
    skill: arm.skill,
    treatmentSha256: arm.skill === 'none' ? null : skillHashes[arm.skill],
  })]));
  const experimentHash = sha256Json({
    protocol: 'vesti-file-search-agent-v2',
    phase: options.phase,
    datasetId: DATASET_ID,
    datasetSeed: DATASET_SEED,
    datasetModuleSha256,
    corpusSha256,
    selectedCaseIds: selectedCases.map(testCase => testCase.id),
    repeats: options.repeats,
    model: MODEL,
    mcpArtifactSha256: mcpArtifact.sha256,
    outputSchemaSha256,
    runnerSha256,
    benchmarkMcpServerSha256,
    benchmarkServerInstructionsSha256,
    neutralInstructionsSha256,
    skillHashes,
    armHashes,
    successEndpoints: SUCCESS_METRICS,
    contrastPolicy: CONTRAST_POLICY,
    negativeSafetyEndpoint: NEGATIVE_SAFETY_ENDPOINT,
    negativeSafetyGatePolicy: NEGATIVE_SAFETY_GATE_POLICY,
  });
  const schedule = buildSchedule(selectedCases, options.repeats, experimentHash, armHashes);
  const startedAt = new Date().toISOString();
  const expectedManifest = {
    schemaVersion: 4,
    status: 'running',
    dryRun: options.dryRun,
    datasetId: DATASET_ID,
    datasetSeed: DATASET_SEED,
    datasetIntegrity: integrity,
    datasetModule: slash(options.dataset),
    datasetModuleSha256,
    corpusSha256,
    phase: options.phase,
    maxCases: options.maxCases,
    selectedCaseIds: selectedCases.map(testCase => testCase.id),
    caseCount: selectedCases.length,
    repeats: options.repeats,
    runCount: schedule.length,
    experimentHash,
    concurrency: options.concurrency,
    scheduleSha256: sha256Json(schedule.map(run => ({
      scheduleIndex: run.scheduleIndex,
      repeat: run.repeat,
      caseId: run.testCase.id,
      arm: run.arm.id,
      armOrder: run.armOrder,
      runId: run.runId,
      experimentHash: run.experimentHash,
      armHash: run.armHash,
    }))),
    model: MODEL,
    codexVersion: codexVersion(invocation),
    codexCommand: [invocation.command, ...invocation.prefixArgs].map(slash),
    timeoutMs: MODEL_TIMEOUT_MS,
    fixtureSha256,
    fixtureCounts: fixture.counts,
    mcpEntry: slash(MCP_ENTRY),
    mcpArtifactSha256: mcpArtifact.sha256,
    mcpArtifactFiles: mcpArtifact.files,
    benchmarkMcpServerPath: slash(AGENT_MCP_SERVER_PATH),
    benchmarkMcpServerSha256,
    benchmarkServerInstructionsSha256,
    toolSets: { legacy: LEGACY_TOOLS, modern: MODERN_TOOLS },
    successEndpoints: SUCCESS_METRICS,
    contrastPolicy: CONTRAST_POLICY,
    negativeSafetyEndpoint: NEGATIVE_SAFETY_ENDPOINT,
    negativeSafetyGatePolicy: NEGATIVE_SAFETY_GATE_POLICY,
    skillDelivery: 'frozen text injected into the Agent prompt; no runtime Skill discovery',
    skillPaths: { placebo: slash(PLACEBO_SKILL_PATH), vesti: slash(VESTI_SKILL_PATH) },
    skillHashes,
    armHashes,
    neutralInstructionsSha256,
    outputSchemaPath: slash(OUTPUT_SCHEMA_PATH),
    outputSchemaSha256,
    runnerSha256,
    startedAt,
    completedAt: null,
  };
  let activeManifest = expectedManifest;
  let rows = [];
  let runRoot = null;
  let manifestWritten = false;
  let resourcesCleaned = false;
  let ndjsonWriter = null;
  const cleanupWarnings = [];
  const cleanupResources = () => {
    if (resourcesCleaned) return;
    resourcesCleaned = true;
    const fixtureWarning = cleanupActionWithRetries('fixture', () => fixture.cleanup());
    if (fixtureWarning) cleanupWarnings.push(fixtureWarning);
    if (runRoot) {
      const runRootWarning = removeWithRetries(runRoot, { recursive: true });
      if (runRootWarning) cleanupWarnings.push({ label: 'runRoot', ...runRootWarning });
    }
    for (const warning of cleanupWarnings) {
      console.warn(`[cleanup] ${warning.label ?? warning.path}: ${warning.message}`);
    }
  };

  try {
    if (options.resume) {
      const existingManifest = readJsonFile(resultPaths['manifest.json'], 'resume manifest');
      validateResumeManifest(existingManifest, expectedManifest);
      const loaded = loadExistingRows(
        resultPaths['runs.ndjson'],
        schedule,
        fixtureSha256,
        skillTexts,
        options.dryRun,
      );
      rows = loaded.rows;
      // Infrastructure failures and an incomplete final line are intentionally
      // omitted from the canonical prefix so their runIds remain pending.
      writeFileSyncWithRetries(
        resultPaths['runs.ndjson'],
        rows.length > 0 ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '',
      );
      const resumedAt = new Date().toISOString();
      activeManifest = {
        ...existingManifest,
        status: 'running',
        completedAt: null,
        concurrency: options.concurrency,
        resumeCount: (Number.isInteger(existingManifest.resumeCount) ? existingManifest.resumeCount : 0) + 1,
        resumeHistory: [
          ...(Array.isArray(existingManifest.resumeHistory) ? existingManifest.resumeHistory : []),
          {
            resumedAt,
            runnerSha256: expectedManifest.runnerSha256,
            codexVersion: expectedManifest.codexVersion,
            concurrency: options.concurrency,
            existingRuns: rows.length,
            pendingRuns: schedule.length - rows.length,
            retriedInfrastructureRuns: loaded.retriableRows.length,
            ignoredTrailingPartial: loaded.trailingPartial,
          },
        ],
      };
    } else {
      writeFileSyncWithRetries(resultPaths['runs.ndjson'], '');
    }

    writeFileSyncWithRetries(resultPaths['manifest.json'], `${JSON.stringify(activeManifest, null, 2)}\n`);
    manifestWritten = true;
    ndjsonWriter = new SerialNdjsonWriter(resultPaths['runs.ndjson']);

    const existingRunIds = new Set(rows.map(row => row.runId));
    const missingSchedule = schedule.filter(run => !existingRunIds.has(run.runId));
    if (options.resume) {
      console.log(`Resume validated: ${rows.length} existing run(s), ${missingSchedule.length} pending.`);
    }
    if (missingSchedule.length > 0) {
      runRoot = mkdtempSync(resolve(tmpdir(), 'vesti-agent-factorial-'));
      await runSchedule({
        schedule: missingSchedule,
        concurrency: options.concurrency,
        initialCompleted: rows.length,
        totalRuns: schedule.length,
        execute: run => {
          assertRuntimeArtifactsFrozen({
            mcpArtifactSha256: mcpArtifact.sha256,
            benchmarkMcpServerSha256,
            outputSchemaSha256,
          });
          return executeScheduledRun({
            run,
            fixture,
            fixtureSha256,
            skillTexts,
            invocation,
            runRoot,
            dryRun: options.dryRun,
          });
        },
        onComplete: async row => {
          await ndjsonWriter.append(row);
          rows.push(row);
        },
        onDrain: () => ndjsonWriter.drain(),
      });
    }

    const infrastructureFailures = rows.filter(isRetriableInfrastructureRow);
    if (infrastructureFailures.length > 0) {
      throw new Error(
        `${infrastructureFailures.length} infrastructure run(s) remain pending; rerun with --resume after resolving the underlying issue`,
      );
    }

    const finalRunIds = new Set(rows.map(row => row.runId));
    if (rows.length !== schedule.length || finalRunIds.size !== schedule.length) {
      throw new Error(`Run set is incomplete after scheduling: expected ${schedule.length}, got ${rows.length}`);
    }
    rows.sort((left, right) => left.scheduleIndex - right.scheduleIndex || left.runId.localeCompare(right.runId));
    writeFileSyncWithRetries(resultPaths['runs.ndjson'], `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    cleanupResources();

    const summary = buildSummary(rows, options.dryRun);
    const manifest = {
      ...activeManifest,
      status: rows.some(row => row.error) ? 'completed-with-errors' : 'completed',
      completedAt: new Date().toISOString(),
      cleanupWarnings,
    };
    const report = buildReport(manifest, summary);
    writeFileSyncWithRetries(resultPaths['manifest.json'], `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSyncWithRetries(resultPaths['summary.json'], `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSyncWithRetries(resultPaths['report.md'], `${report}\n`);
    console.log('');
    console.log(report);
    console.log(`Artifacts: ${options.resultsDir}`);
  } catch (error) {
    cleanupResources();
    if (manifestWritten) {
      try {
        writeFileSyncWithRetries(resultPaths['manifest.json'], `${JSON.stringify({
          ...activeManifest,
          status: 'running',
          completedAt: null,
          lastInterruptedAt: new Date().toISOString(),
          lastInterruption: error instanceof Error ? error.message : String(error),
          cleanupWarnings,
        }, null, 2)}\n`);
      } catch {
        // Preserve the original failure; a disk-level manifest write may also fail.
      }
    }
    throw error;
  } finally {
    cleanupResources();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
