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
import { fileURLToPath } from 'node:url';

import {
  cases,
  DATASET_ID,
  DATASET_SEED,
  datasetIntegrity,
  projects,
  sessions,
} from './large-corpus.mjs';
import { buildFixtureDb } from './build-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = fileURLToPath(import.meta.url);
const OUTPUT_SCHEMA_PATH = resolve(HERE, 'agent-output-schema.json');
const AGENT_MCP_SERVER_PATH = resolve(HERE, 'agent-mcp-server.mjs');
const DEFAULT_RESULTS_DIR = resolve(HERE, 'results', 'agent-factorial');
const DEFAULT_MCP_ENTRY = resolve(
  HERE,
  '..',
  '..',
  '..',
  'VESTI-APP',
  'packages',
  'vesti-mcp',
  'dist',
  'index.js',
);
const SKILL_PATH = resolve(HERE, '..', '..', 'skills', 'vesti-memory', 'SKILL.md');

const MODEL = 'gpt-5.6-luna';
const MODEL_TIMEOUT_MS = 180_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const EVALUATION_K = 5;
const BOOTSTRAP_ITERATIONS = 10_000;
const BOOTSTRAP_SEED = (DATASET_SEED ^ 0x61c88647) >>> 0;

const OLD_TOOLS = ['vesti_search', 'vesti_timeline', 'vesti_get_turns'];
const NEW_TOOLS = [...OLD_TOOLS, 'vesti_search_files'];

const ARMS = Object.freeze([
  Object.freeze({ id: 'old-skill-off', toolVariant: 'old', skill: false, tools: OLD_TOOLS }),
  Object.freeze({ id: 'old-skill-on', toolVariant: 'old', skill: true, tools: OLD_TOOLS }),
  Object.freeze({ id: 'new-skill-off', toolVariant: 'new', skill: false, tools: NEW_TOOLS }),
  Object.freeze({ id: 'new-skill-on', toolVariant: 'new', skill: true, tools: NEW_TOOLS }),
]);

const FACTORIAL_CONTRASTS = Object.freeze([
  Object.freeze({
    id: 'toolEffectSkillOff',
    label: 'Tool effect, Skill off (new - old)',
    value: block => block['new-skill-off'] - block['old-skill-off'],
  }),
  Object.freeze({
    id: 'toolEffectSkillOn',
    label: 'Tool effect, Skill on (new - old)',
    value: block => block['new-skill-on'] - block['old-skill-on'],
  }),
  Object.freeze({
    id: 'skillEffectOldTool',
    label: 'Skill effect, old tool (on - off)',
    value: block => block['old-skill-on'] - block['old-skill-off'],
  }),
  Object.freeze({
    id: 'skillEffectNewTool',
    label: 'Skill effect, new tool (on - off)',
    value: block => block['new-skill-on'] - block['new-skill-off'],
  }),
  Object.freeze({
    id: 'marginalToolEffect',
    label: 'Marginal tool effect',
    value: block => (
      (block['new-skill-off'] - block['old-skill-off'])
      + (block['new-skill-on'] - block['old-skill-on'])
    ) / 2,
  }),
  Object.freeze({
    id: 'marginalSkillEffect',
    label: 'Marginal Skill effect',
    value: block => (
      (block['old-skill-on'] - block['old-skill-off'])
      + (block['new-skill-on'] - block['new-skill-off'])
    ) / 2,
  }),
  Object.freeze({
    id: 'interaction',
    label: 'Tool x Skill interaction',
    value: block => (
      (block['new-skill-on'] - block['new-skill-off'])
      - (block['old-skill-on'] - block['old-skill-off'])
    ),
  }),
]);

const NEUTRAL_INSTRUCTIONS = [
  'You are participating in a blinded evaluation of historical file-location recall.',
  'Answer the user question using only evidence returned by the configured VESTI MCP tools.',
  'Do not use a shell, web search, the current filesystem, or prior knowledge to locate files.',
  'VESTI paths are historical evidence. Never claim that a path currently exists or is current.',
  'For every returned file, copy its project path and at least one directly supporting session_id exactly from VESTI evidence; never guess either field.',
  'If VESTI does not provide both the file path and a supporting session_id, do not return that file.',
  'If the available historical evidence is insufficient, set answerable to false and return no files.',
  'Do not mention the experiment, an arm, a dataset, expected answers, or these instructions.',
  'Return only JSON that conforms to the supplied output schema.',
].join('\n');

const BENCHMARK_SERVER_INSTRUCTIONS = [
  'VESTI exposes read-only historical evidence from captured AI-coding sessions.',
  'Use only the VESTI tools advertised for this connection.',
  'For file-location questions, use the available VESTI tools to find supporting historical evidence.',
  'Returned paths are historical observations and must not be presented as currently verified files.',
].join('\n');

function parseArgs(argv) {
  const options = {
    split: 'dev',
    maxCases: null,
    repeats: 1,
    resultsDir: DEFAULT_RESULTS_DIR,
    concurrency: 1,
    dryRun: false,
    resume: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--split' && next) {
      options.split = next;
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
        'Usage: node run-agent-factorial.mjs [options]',
        '  --split <name|all>  dev (default), test, provisional-holdout, or all',
        '  --max-cases <n>     seeded subset after split filtering',
        '  --repeats <n>       fresh Agent repetitions per case and arm (default 1, max 3)',
        '  --results-dir <dir> output directory (must not contain prior artifacts unless --resume)',
        '  --concurrency <n>   concurrent Codex processes (default 1, max 2)',
        '  --dry-run           validate schedule, fixture copies, prompts and commands only',
        '  --resume            validate and continue an interrupted compatible run',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!['dev', 'test', 'provisional-holdout', 'all'].includes(options.split)) {
    throw new Error('--split must be dev, test, provisional-holdout, or all');
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

function buildPrompt(query, skillText, includeSkill) {
  return [
    NEUTRAL_INSTRUCTIONS,
    ...(includeSkill
      ? [
          '',
          'Apply the following frozen product Skill instructions exactly:',
          '<vesti-memory-skill>',
          skillText,
          '</vesti-memory-skill>',
        ]
      : []),
    '',
    'User question:',
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
    '-c', `mcp_servers.vesti.env.VESTI_MCP_ENTRY=${toml(slash(DEFAULT_MCP_ENTRY))}`,
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

function buildSchedule(selectedCases, repeats) {
  const random = seededRandom(DATASET_SEED ^ 0xa63e2b91);
  const schedule = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const caseOrder = shuffled(selectedCases, random);
    for (const [blockOrder, testCase] of caseOrder.entries()) {
      const armOrder = shuffled(ARMS, random);
      for (const [armOrderIndex, arm] of armOrder.entries()) {
        const runId = sha256(`${DATASET_SEED}:${repeat}:${testCase.id}:${arm.id}`).slice(0, 16);
        schedule.push({
          scheduleIndex: schedule.length,
          blockOrder,
          armOrder: armOrderIndex,
          repeat,
          runId,
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

function scoreAgentOutput(testCase, output, runError) {
  const files = output?.files ?? [];
  if (testCase.mustAbstain) {
    const negativeFalsePositive = output && (output.answerable || files.length > 0) ? 1 : 0;
    return {
      taskSuccess: !runError && output && negativeFalsePositive === 0 ? 1 : 0,
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
      negativeFalsePositive,
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
  const supportedFiles = files.filter(file => testCase.targets.some(target =>
    candidateProjectMatchesTarget(file, target)
      && file.evidence_session_ids.length > 0
      && file.evidence_session_ids.every(sessionId => target.sessionIds.includes(sessionId)),
  )).length;
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
    negativeFalsePositive: null,
  };
}

function executionError(execution, parsed, final) {
  const errors = [];
  if (execution.spawnError) errors.push(`spawn: ${execution.spawnError}`);
  if (execution.timedOut) errors.push(`timeout after ${MODEL_TIMEOUT_MS} ms`);
  if (execution.outputLimitExceeded) errors.push('captured output exceeded safety limit');
  if (execution.exitCode != null && execution.exitCode !== 0) {
    errors.push(`Codex exited with code ${execution.exitCode}`);
  }
  if (execution.exitCode == null && execution.signal) errors.push(`Codex exited on signal ${execution.signal}`);
  if (parsed.parseErrors.length > 0) errors.push(`${parsed.parseErrors.length} invalid JSONL line(s)`);
  const failedCalls = parsed.mcpCalls.filter(call => call.status === 'failed' || call.error);
  if (failedCalls.length > 0) errors.push(`${failedCalls.length} MCP call(s) failed`);
  const completedVestiCall = parsed.mcpCalls.some(call =>
    call.server === 'vesti' && call.status === 'completed' && !call.error,
  );
  if (!completedVestiCall && /MCP startup failed|failed to initialize MCP client/i.test(execution.stderr)) {
    errors.push('VESTI MCP failed to initialize');
  }
  if (final.error) errors.push(final.error);
  return errors.length > 0 ? errors.join('; ') : null;
}

function dryRunRow(run, commandArgs, prompt, fixtureSha256) {
  return {
    scheduleIndex: run.scheduleIndex,
    blockOrder: run.blockOrder,
    armOrder: run.armOrder,
    repeat: run.repeat,
    runId: run.runId,
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

async function executeScheduledRun({ run, fixture, fixtureSha256, skillText, invocation, runRoot, dryRun }) {
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

    prompt = buildPrompt(run.testCase.query, skillText, run.arm.skill);
    assertPromptIsBlind(run.testCase, prompt);
    args = buildCodexArgs({ dbPath, tools: run.arm.tools });
    const sanitizedArgs = sanitizeCodexArgs(args, dbPath);
    if (dryRun) {
      row = dryRunRow(run, sanitizedArgs, prompt, copiedSha256);
    } else {
      const execution = await runCodex(invocation, args, prompt, workdir);
      const parsed = parseCodexJsonl(execution.stdout);
      const final = parseFinalOutput(parsed.finalText);
      const error = executionError(execution, parsed, final);
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
        error,
      };
    }
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : String(caught);
    row = {
      ...dryRunRow(run, args ? sanitizeCodexArgs(args, dbPath) : [], prompt ?? '', fixtureSha256),
      status: 'failed',
      metrics: dryRun ? null : scoreAgentOutput(run.testCase, null, error),
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
    hit3: mean(numeric(rows, row => row.metrics?.hit3)),
    recall5: mean(numeric(rows, row => row.metrics?.recall5)),
    allTargets5: mean(numeric(rows, row => row.metrics?.allTargets5)),
    projectAccuracy: mean(numeric(rows, row => row.metrics?.projectAccuracy)),
    evidenceAccuracy: mean(numeric(rows, row => row.metrics?.evidenceAccuracy)),
    historicalAccuracy: mean(numeric(rows, row => row.metrics?.historicalAccuracy)),
    staleSafety: mean(numeric(rows, row => row.metrics?.staleSafety)),
    returnedFilePrecision: mean(numeric(rows, row => row.metrics?.returnedFilePrecision)),
    unsupportedReturnRate: mean(numeric(rows, row => row.metrics?.unsupportedReturnRate)),
    negativeFalsePositive: mean(numeric(rows, row => row.metrics?.negativeFalsePositive)),
    toolCallsMedian: median(numeric(rows, row => row.trace?.mcpCalls?.length)),
    durationMsMedian: median(numeric(rows, row => row.trace?.durationMs)),
    inputTokensMedian: median(numeric(rows, row => row.trace?.usage?.input_tokens)),
    cachedInputTokensMedian: median(numeric(rows, row => row.trace?.usage?.cached_input_tokens)),
    outputTokensMedian: median(numeric(rows, row => row.trace?.usage?.output_tokens)),
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

function pairedBlocks(rows, mode) {
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
        && typeof row.metrics?.taskSuccess === 'number';
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
        const value = block.arms[arm.id].metrics?.taskSuccess;
        return [arm.id, typeof value === 'number' && Number.isFinite(value) ? value : 0];
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
    const random = seededRandom(BOOTSTRAP_SEED);
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

  return {
    conceptClusters: conceptIds.length,
    confidenceIntervals: Object.fromEntries(FACTORIAL_CONTRASTS.map(contrast => {
      const values = samples[contrast.id].filter(value => value != null).sort((left, right) => left - right);
      return [contrast.id, {
        lower: quantile(values, 0.025),
        upper: quantile(values, 0.975),
      }];
    })),
  };
}

function pairedEstimate(rows, mode) {
  const prepared = pairedBlocks(rows, mode);
  const bootstrap = clusterBootstrapContrasts(prepared.blocks);
  return {
    definition: mode === 'itt'
      ? 'Intent-to-treat paired estimate: every four-arm scheduled block is retained and failed/non-numeric runs score taskSuccess=0.'
      : 'Clean-completed paired estimate: includes only blocks where all four arms have status=completed, no error, and numeric taskSuccess.',
    scheduledBlocks: prepared.scheduledBlocks,
    armCompleteBlocks: prepared.armCompleteBlocks,
    pairedBlocks: prepared.blocks.length,
    excludedBlocks: prepared.scheduledBlocks - prepared.blocks.length,
    conceptClusters: bootstrap.conceptClusters,
    contrasts: Object.fromEntries(FACTORIAL_CONTRASTS.map(contrast => [contrast.id, {
      estimate: mean(prepared.blocks.map(block => contrast.value(block.values))),
      ci95: bootstrap.confidenceIntervals[contrast.id],
    }])),
  };
}

function pairedEffects(rows) {
  return {
    bootstrap: {
      method: 'percentile concept-cluster bootstrap',
      clusterUnit: 'conceptId',
      confidenceLevel: 0.95,
      iterations: BOOTSTRAP_ITERATIONS,
      seed: BOOTSTRAP_SEED,
    },
    itt: pairedEstimate(rows, 'itt'),
    cleanCompletedPaired: pairedEstimate(rows, 'clean-completed'),
  };
}

function buildSummary(rows, dryRun) {
  return {
    dryRun,
    schedule: {
      runs: rows.length,
      completeBlocks: rows.length / ARMS.length,
      arms: Object.fromEntries(ARMS.map(arm => [arm.id, rows.filter(row => row.arm === arm.id).length])),
    },
    arms: ARMS.map(arm => ({ arm: arm.id, ...summarizeRows(rows.filter(row => row.arm === arm.id)) })),
    effects: dryRun ? null : pairedEffects(rows),
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

function appendEffectEstimate(lines, title, estimate) {
  lines.push(
    `### ${title}`,
    '',
    estimate.definition,
    '',
    `Paired blocks: ${estimate.pairedBlocks}/${estimate.scheduledBlocks}; excluded: ${estimate.excludedBlocks}; conceptId clusters: ${estimate.conceptClusters}.`,
    '',
    '| Contrast | Point estimate | 95% cluster-bootstrap CI |',
    '|---|---:|---:|',
  );
  for (const contrast of FACTORIAL_CONTRASTS) {
    const result = estimate.contrasts[contrast.id];
    lines.push(`| ${contrast.label} | ${percent(result.estimate)} | ${confidenceInterval(result.ci95)} |`);
  }
  lines.push('');
}

function buildReport(manifest, summary) {
  const lines = [
    '# VESTI file-search Agent factorial experiment',
    '',
    `- Mode: **${manifest.dryRun ? 'dry-run (no model calls)' : 'executed'}**`,
    `- Dataset: \`${manifest.datasetId}\`, split \`${manifest.split}\`, ${manifest.caseCount} cases × ${manifest.repeats} repeat(s) × 4 arms`,
    `- Model: \`${manifest.model}\`; concurrency ${manifest.concurrency}`,
    `- Frozen fixture SHA-256: \`${manifest.fixtureSha256}\``,
    `- Skill SHA-256: \`${manifest.skillSha256}\``,
    `- APP MCP dist SHA-256: \`${manifest.mcpArtifactSha256}\``,
    '',
    '## Arms',
    '',
    '| Arm | Tool surface | Skill | N | Completed | Task success | Hit@3 | Recall@5 | Project | Evidence | Historical | Return precision | Unsupported | Negative FP | Calls | Input tokens | Duration ms |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const arm of summary.arms) {
    const definition = ARMS.find(entry => entry.id === arm.arm);
    lines.push(`| ${arm.arm} | ${definition.toolVariant} | ${definition.skill ? 'on' : 'off'} | ${arm.n} | ${arm.completed} | ${percent(arm.taskSuccess)} | ${percent(arm.hit3)} | ${percent(arm.recall5)} | ${percent(arm.projectAccuracy)} | ${percent(arm.evidenceAccuracy)} | ${percent(arm.historicalAccuracy)} | ${percent(arm.returnedFilePrecision)} | ${percent(arm.unsupportedReturnRate)} | ${percent(arm.negativeFalsePositive)} | ${number(arm.toolCallsMedian)} | ${number(arm.inputTokensMedian, 0)} | ${number(arm.durationMsMedian)} |`);
  }
  lines.push('', '## Factorial task-success contrasts', '');
  if (summary.effects == null) {
    lines.push('Dry-run only: no effects were estimated.');
  } else {
    lines.push(
      `Uncertainty uses a fixed-seed percentile bootstrap over \`conceptId\` clusters (${summary.effects.bootstrap.iterations} iterations, seed ${summary.effects.bootstrap.seed}).`,
      '',
    );
    appendEffectEstimate(lines, 'ITT paired estimate (failures = 0)', summary.effects.itt);
    appendEffectEstimate(lines, 'Clean-completed paired estimate', summary.effects.cleanCompletedPaired);
  }
  lines.push(
    '',
    '## Boundaries',
    '',
    '- Every task/arm/repeat uses a fresh ephemeral Codex process and its own byte-identical database copy.',
    '- The Agent prompt contains the query, neutral rules, and (only in Skill-on arms) the frozen SKILL.md; gold labels are scored only after the process exits.',
    '- Shell, plugins, user config, project rules and web retrieval are excluded. Only the arm-specific VESTI MCP tools are enabled.',
    '- For positive cases, a returned file is supported only when path and project match one gold target and every reported evidence session ID belongs to that target; Task success requires zero unsupported returns.',
    '- Negative cases are evaluated with negative false-positive rate rather than returned-file precision.',
    '- This inspectable synthetic corpus is an engineering benchmark, not a hidden production holdout.',
    '',
  );
  return lines.join('\n');
}

const RESULT_ARTIFACTS = ['manifest.json', 'runs.ndjson', 'summary.json', 'report.md'];

const RESUME_FINGERPRINT_FIELDS = [
  'schemaVersion',
  'dryRun',
  'datasetId',
  'datasetSeed',
  'datasetIntegrity',
  'corpusSha256',
  'split',
  'maxCases',
  'selectedCaseIds',
  'caseCount',
  'repeats',
  'runCount',
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
  'skillSha256',
  'neutralInstructionsSha256',
  'outputSchemaSha256',
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

function expectedRunIdentity(run, fixtureSha256, skillText) {
  const prompt = buildPrompt(run.testCase.query, skillText, run.arm.skill);
  assertPromptIsBlind(run.testCase, prompt);
  const placeholderDb = resolve(tmpdir(), '__vesti_factorial_resume__', `${run.runId}.sqlite`);
  const args = buildCodexArgs({ dbPath: placeholderDb, tools: run.arm.tools });
  return {
    scheduleIndex: run.scheduleIndex,
    blockOrder: run.blockOrder,
    armOrder: run.armOrder,
    repeat: run.repeat,
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

function validateExistingRunRow(row, run, fixtureSha256, skillText, dryRun, lineNumber) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`runs.ndjson line ${lineNumber} must contain a JSON object`);
  }
  const expected = expectedRunIdentity(run, fixtureSha256, skillText);
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
  if (!row.trace || typeof row.trace !== 'object' || Array.isArray(row.trace)) {
    throw new Error(`Existing run ${row.runId} is missing a parseable trace`);
  }
}

function loadExistingRows(path, schedule, fixtureSha256, skillText, dryRun) {
  const planned = new Map();
  for (const run of schedule) {
    if (planned.has(run.runId)) throw new Error(`Duplicate planned runId: ${run.runId}`);
    planned.set(run.runId, run);
  }
  const rows = [];
  const seen = new Set();
  const content = readFileSync(path, 'utf8');
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid runs.ndjson line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof row?.runId !== 'string' || !row.runId) {
      throw new Error(`runs.ndjson line ${index + 1} has no valid runId`);
    }
    if (seen.has(row.runId)) throw new Error(`Duplicate runId in runs.ndjson: ${row.runId}`);
    const run = planned.get(row.runId);
    if (!run) throw new Error(`Plan-external runId in runs.ndjson: ${row.runId}`);
    validateExistingRunRow(row, run, fixtureSha256, skillText, dryRun, index + 1);
    seen.add(row.runId);
    rows.push(row);
  }
  return rows;
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

async function runSchedule({ schedule, concurrency, execute, onComplete, initialCompleted = 0, totalRuns = schedule.length }) {
  let cursor = 0;
  let completed = initialCompleted;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= schedule.length) return;
      const row = await execute(schedule[index]);
      completed += 1;
      onComplete(row);
      console.log(`[${completed}/${totalRuns}] ${row.runId} ${row.arm} ${row.status}`);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const required of [DEFAULT_MCP_ENTRY, AGENT_MCP_SERVER_PATH, SKILL_PATH, OUTPUT_SCHEMA_PATH]) {
    if (!existsSync(required)) throw new Error(`Required file does not exist: ${required}`);
  }
  const resultPaths = prepareResultsDirectory(options.resultsDir, options.resume);
  const integrity = datasetIntegrity();
  const random = seededRandom(DATASET_SEED ^ 0x1140fac7);
  const splitCases = options.split === 'all' ? cases : cases.filter(testCase => testCase.split === options.split);
  const selectedCases = shuffled(splitCases, random).slice(0, options.maxCases ?? splitCases.length);
  if (selectedCases.length === 0) throw new Error(`No cases selected for split ${options.split}`);

  const skillText = readFileSync(SKILL_PATH, 'utf8');
  JSON.parse(readFileSync(OUTPUT_SCHEMA_PATH, 'utf8'));
  const schedule = buildSchedule(selectedCases, options.repeats);
  const invocation = resolveCodexInvocation();
  const fixture = buildFixtureDb();
  const fixtureSha256 = sha256File(fixture.dbPath);
  const mcpArtifact = sha256Directory(dirname(DEFAULT_MCP_ENTRY));
  const startedAt = new Date().toISOString();
  const expectedManifest = {
    schemaVersion: 1,
    status: 'running',
    dryRun: options.dryRun,
    datasetId: DATASET_ID,
    datasetSeed: DATASET_SEED,
    datasetIntegrity: integrity,
    corpusSha256: sha256Json({ projects, sessions, cases }),
    split: options.split,
    maxCases: options.maxCases,
    selectedCaseIds: selectedCases.map(testCase => testCase.id),
    caseCount: selectedCases.length,
    repeats: options.repeats,
    runCount: schedule.length,
    concurrency: options.concurrency,
    scheduleSha256: sha256Json(schedule.map(run => ({
      scheduleIndex: run.scheduleIndex,
      repeat: run.repeat,
      caseId: run.testCase.id,
      arm: run.arm.id,
      armOrder: run.armOrder,
    }))),
    model: MODEL,
    codexVersion: codexVersion(invocation),
    codexCommand: [invocation.command, ...invocation.prefixArgs].map(slash),
    timeoutMs: MODEL_TIMEOUT_MS,
    fixtureSha256,
    fixtureCounts: fixture.counts,
    mcpEntry: slash(DEFAULT_MCP_ENTRY),
    mcpArtifactSha256: mcpArtifact.sha256,
    mcpArtifactFiles: mcpArtifact.files,
    benchmarkMcpServerPath: slash(AGENT_MCP_SERVER_PATH),
    benchmarkMcpServerSha256: sha256File(AGENT_MCP_SERVER_PATH),
    benchmarkServerInstructionsSha256: sha256(BENCHMARK_SERVER_INSTRUCTIONS),
    toolSets: { old: OLD_TOOLS, new: NEW_TOOLS },
    skillPath: slash(SKILL_PATH),
    skillSha256: sha256(skillText),
    neutralInstructionsSha256: sha256(NEUTRAL_INSTRUCTIONS),
    outputSchemaPath: slash(OUTPUT_SCHEMA_PATH),
    outputSchemaSha256: sha256File(OUTPUT_SCHEMA_PATH),
    runnerSha256: sha256File(RUNNER_PATH),
    startedAt,
    completedAt: null,
  };
  let activeManifest = expectedManifest;
  let rows = [];
  let runRoot = null;
  let manifestWritten = false;
  let resourcesCleaned = false;
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
      rows = loadExistingRows(
        resultPaths['runs.ndjson'],
        schedule,
        fixtureSha256,
        skillText,
        options.dryRun,
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
          },
        ],
      };
    } else {
      writeFileSync(resultPaths['runs.ndjson'], '');
    }

    writeFileSync(resultPaths['manifest.json'], `${JSON.stringify(activeManifest, null, 2)}\n`);
    manifestWritten = true;

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
        execute: run => executeScheduledRun({
          run,
          fixture,
          fixtureSha256,
          skillText,
          invocation,
          runRoot,
          dryRun: options.dryRun,
        }),
        onComplete: row => {
          rows.push(row);
          appendFileSync(resultPaths['runs.ndjson'], `${JSON.stringify(row)}\n`);
        },
      });
    }

    const finalRunIds = new Set(rows.map(row => row.runId));
    if (rows.length !== schedule.length || finalRunIds.size !== schedule.length) {
      throw new Error(`Run set is incomplete after scheduling: expected ${schedule.length}, got ${rows.length}`);
    }
    rows.sort((left, right) => left.scheduleIndex - right.scheduleIndex || left.runId.localeCompare(right.runId));
    writeFileSync(resultPaths['runs.ndjson'], `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    cleanupResources();

    const summary = buildSummary(rows, options.dryRun);
    const manifest = {
      ...activeManifest,
      status: rows.some(row => row.error) ? 'completed-with-errors' : 'completed',
      completedAt: new Date().toISOString(),
      cleanupWarnings,
    };
    const report = buildReport(manifest, summary);
    writeFileSync(resultPaths['manifest.json'], `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(resultPaths['summary.json'], `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(resultPaths['report.md'], `${report}\n`);
    console.log('');
    console.log(report);
    console.log(`Artifacts: ${options.resultsDir}`);
  } catch (error) {
    cleanupResources();
    if (manifestWritten) {
      try {
        writeFileSync(resultPaths['manifest.json'], `${JSON.stringify({
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
