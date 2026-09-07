#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  getCaptureDaemonStatus,
  requestCaptureDaemon,
  resolveRuntimePaths,
} from '../../vesti-capture-runtime/dist/client.js';

const mcpEntry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const daemonEntry = fileURLToPath(new URL('../../vesti-capture-runtime/dist/daemon-cli.js', import.meta.url));
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-standalone-smoke-'));
const homeDir = path.join(scratch, 'home');
const dataDir = path.join(scratch, 'vesti-data');
const sessionFile = path.join(
  homeDir,
  '.codex',
  'sessions',
  '2026',
  '09',
  '07',
  'rollout-standalone-smoke.jsonl',
);
const projectPath = path.join(scratch, 'demo-project');

const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
);
delete environment.VESTI_DB_PATH;
delete environment.VESTI_DATA_DIR;
delete environment.VESTI_CAPTURE_DISABLED;
Object.assign(environment, {
  HOME: homeDir,
  USERPROFILE: homeDir,
  APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
  XDG_CONFIG_HOME: path.join(homeDir, '.config'),
  XDG_CACHE_HOME: path.join(homeDir, '.cache'),
  XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
  XDG_STATE_HOME: path.join(homeDir, '.local', 'state'),
  CODEX_HOME: path.join(homeDir, '.codex'),
  CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
  KIMI_CODE_HOME: path.join(homeDir, '.kimi-code'),
  VESTI_HOME: dataDir,
  VESTI_CAPTURE_STARTUP_TIMEOUT_MS: '30000',
});
const runtimePaths = resolveRuntimePaths({ basePath: dataDir, env: environment });

const metadata = (turnId) => ({ turn_id: turnId });
const initialRows = [
  {
    timestamp: '2026-09-07T08:00:00Z',
    type: 'session_meta',
    payload: { id: 'standalone-smoke-session', cwd: projectPath, cli_version: 'smoke' },
  },
  {
    timestamp: '2026-09-07T08:00:01Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'task-1' },
  },
  {
    timestamp: '2026-09-07T08:00:02Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '请记住星河报销联系人电话是18600001111，后续填写报销申请时复用。' }],
      internal_chat_message_metadata_passthrough: metadata('task-1'),
    },
  },
  {
    timestamp: '2026-09-07T08:00:03Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: '已了解这次填写所需的联系人信息。' }],
      internal_chat_message_metadata_passthrough: metadata('task-1'),
    },
  },
  {
    timestamp: '2026-09-07T08:00:04Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'task-1' },
  },
];
const appendedRows = [
  {
    timestamp: '2026-09-07T08:01:01Z',
    type: 'event_msg',
    payload: { type: 'task_started', turn_id: 'task-2' },
  },
  {
    timestamp: '2026-09-07T08:01:02Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '补充：紫藤开票抬头是杭州示例有限公司。' }],
      internal_chat_message_metadata_passthrough: metadata('task-2'),
    },
  },
  {
    timestamp: '2026-09-07T08:01:03Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: '已补充本次使用的开票抬头。' }],
      internal_chat_message_metadata_passthrough: metadata('task-2'),
    },
  },
  {
    timestamp: '2026-09-07T08:01:04Z',
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'task-2' },
  },
];

function asText(result) {
  const block = result.content?.find((item) => item.type === 'text');
  if (!block || typeof block.text !== 'string') {
    throw new Error(`MCP tool returned no text block: ${JSON.stringify(result)}`);
  }
  return block.text;
}

async function callJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${asText(result)}`);
  return JSON.parse(asText(result));
}

async function waitForRecall(client, query, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() <= deadline) {
    latest = await callJson(client, 'vesti_search', { query, topK: 5 });
    if (JSON.stringify(latest).includes(expected)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for live recall of ${JSON.stringify(expected)}: ${JSON.stringify(latest)}`);
}

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function childIsRunning(child) {
  return Boolean(child?.pid && child.exitCode === null && child.signalCode === null);
}

async function waitForChildExit(child, timeoutMs) {
  if (!childIsRunning(child)) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once('exit', onExit);
    if (!childIsRunning(child)) finish(true);
  });
}

async function waitForDaemonReady(child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    if (!childIsRunning(child)) {
      throw new Error(`Isolated capture daemon exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    try {
      const status = await getCaptureDaemonStatus({
        paths: runtimePaths,
        env: environment,
        timeoutMs: 1_000,
      });
      if (status.state === 'running' && status.initialSyncComplete) return status;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Isolated capture daemon did not become ready within ${timeoutMs}ms.${detail}`);
}

async function stopOwnedDaemon(child) {
  if (!childIsRunning(child)) return true;
  try {
    child.kill('SIGTERM');
  } catch {
    return !childIsRunning(child);
  }
  if (await waitForChildExit(child, 3_000)) return true;
  try {
    child.kill('SIGKILL');
  } catch {
    return !childIsRunning(child);
  }
  return waitForChildExit(child, 3_000);
}

let client;
let transport;
let daemonProcess;
let stderr = '';
let daemonStderr = '';
let primaryError;
let cleanupError;
let keepDiagnostics = false;

const emergencyStop = () => {
  if (!childIsRunning(daemonProcess)) return;
  try { daemonProcess.kill('SIGKILL'); } catch { /* process exit is already in progress */ }
};
process.once('exit', emergencyStop);

try {
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(sessionFile, `${initialRows.map(JSON.stringify).join('\n')}\n`, 'utf8');

  // The production runtime has no WSL-disable flag yet. A local stub prevents
  // this isolated test from invoking the host's real wsl.exe; --platforms
  // keeps every actual capture/read operation scoped to the synthetic Codex
  // transcript created above.
  if (process.platform === 'win32') {
    await fs.writeFile(path.join(scratch, 'wsl.exe'), '', 'utf8');
    environment.PATH = `${scratch}${path.delimiter}${environment.PATH ?? ''}`;
  }
  daemonProcess = spawn(process.execPath, [
    daemonEntry,
    '--data-dir', dataDir,
    '--db-path', runtimePaths.dbPath,
    '--platforms', 'codex',
    '--wsl-poll-ms', '0',
    '--reconcile-ms', '0',
    '--foreground',
  ], {
    cwd: scratch,
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  daemonProcess.stderr?.on('data', (chunk) => {
    daemonStderr += chunk.toString();
  });
  await new Promise((resolve, reject) => {
    const onSpawn = () => {
      daemonProcess.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      daemonProcess.off('spawn', onSpawn);
      reject(error);
    };
    daemonProcess.once('spawn', onSpawn);
    daemonProcess.once('error', onError);
  });
  daemonProcess.on('error', (error) => {
    daemonStderr += `\nchild process error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`;
  });
  const isolatedDaemon = await waitForDaemonReady(daemonProcess);
  if (isolatedDaemon.enabledPlatforms.length !== 1 || isolatedDaemon.enabledPlatforms[0] !== 'codex') {
    throw new Error(`Smoke daemon escaped Codex-only isolation: ${JSON.stringify(isolatedDaemon.enabledPlatforms)}`);
  }
  if (process.platform === 'win32' && (isolatedDaemon.wsl?.distros.length ?? 0) > 0) {
    throw new Error(`Smoke daemon reached real WSL distributions: ${JSON.stringify(isolatedDaemon.wsl?.distros)}`);
  }

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry],
    env: environment,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  client = new Client({ name: 'vesti-standalone-smoke', version: '1.0.0' });
  await client.connect(transport);

  const connectedDaemon = await getCaptureDaemonStatus({
    paths: runtimePaths,
    env: environment,
    timeoutMs: 2_000,
  });
  if (connectedDaemon.pid !== isolatedDaemon.pid || connectedDaemon.pid !== daemonProcess.pid) {
    throw new Error(
      `MCP did not reuse the isolated capture daemon (expected pid ${daemonProcess.pid}, got ${connectedDaemon.pid})`,
    );
  }

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  for (const required of ['vesti_search', 'vesti_timeline', 'vesti_get_turns']) {
    if (!toolNames.includes(required)) throw new Error(`Missing MCP tool: ${required}`);
  }

  const initial = await waitForRecall(client, '星河报销联系人', '18600001111');
  const sessionId = initial.results?.[0]?.session_id;
  if (!sessionId) throw new Error(`Initial recall returned no session: ${JSON.stringify(initial)}`);

  await fs.appendFile(sessionFile, `${appendedRows.map(JSON.stringify).join('\n')}\n`, 'utf8');
  const live = await waitForRecall(client, '紫藤开票抬头', '杭州示例有限公司');
  const timeline = await callJson(client, 'vesti_timeline', { session_id: sessionId });
  const turns = await callJson(client, 'vesti_get_turns', {
    session_id: sessionId,
    range: { from: 1, to: 2 },
    max_chars: 8000,
  });
  const turnText = JSON.stringify(turns);
  if (!turnText.includes('18600001111') || !turnText.includes('杭州示例有限公司')) {
    throw new Error(`Progressive retrieval did not include both captured turns: ${turnText}`);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    appRequired: false,
    tools: toolNames.length,
    initialRecall: initial.count,
    liveRecall: live.count,
    turns: timeline.total_turns,
    database: path.join(dataDir, 'db', 'vesti.db'),
  }, null, 2)}\n`);
} catch (error) {
  primaryError = error;
} finally {
  const cleanupFailures = [];
  try {
    if (client) await client.close();
    else await transport?.close();
  } catch (error) {
    cleanupFailures.push(new Error(`MCP client shutdown failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  if (daemonProcess?.pid) {
    try {
      await requestCaptureDaemon(
        { command: 'shutdown' },
        { paths: runtimePaths, env: environment, timeoutMs: 2_000 },
      );
    } catch (error) {
      cleanupFailures.push(new Error(`Capture daemon shutdown request failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  const stopDeadline = Date.now() + 15_000;
  while (Date.now() <= stopDeadline) {
    let lockExists = true;
    try {
      lockExists = await pathExists(runtimePaths.lockPath);
    } catch (error) {
      cleanupFailures.push(new Error(`Could not inspect capture daemon lock: ${error instanceof Error ? error.message : String(error)}`));
      break;
    }
    if (!childIsRunning(daemonProcess) && !lockExists) break;
    await delay(100);
  }

  if (childIsRunning(daemonProcess)) {
    cleanupFailures.push(new Error('Capture daemon did not finish graceful shutdown within 15000ms'));
    if (!await stopOwnedDaemon(daemonProcess)) {
      cleanupFailures.push(new Error(`Owned capture daemon process ${daemonProcess.pid ?? '(unknown pid)'} could not be terminated`));
    }
  }
  try {
    if (await pathExists(runtimePaths.lockPath)) {
      cleanupFailures.push(new Error(`Capture daemon lock remains at ${runtimePaths.lockPath}`));
    }
  } catch (error) {
    cleanupFailures.push(new Error(`Could not inspect capture daemon lock after shutdown: ${error instanceof Error ? error.message : String(error)}`));
  }

  const resolvedScratch = path.resolve(scratch);
  const tempPrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  keepDiagnostics = cleanupFailures.length > 0;
  if (!keepDiagnostics && resolvedScratch.startsWith(tempPrefix) && path.basename(resolvedScratch).startsWith('vesti-standalone-smoke-')) {
    try {
      await fs.rm(resolvedScratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      cleanupFailures.push(new Error(`Could not remove isolated scratch directory: ${error instanceof Error ? error.message : String(error)}`));
      keepDiagnostics = true;
    }
  }

  cleanupError = cleanupFailures.length > 0
    ? new AggregateError(cleanupFailures, `Standalone smoke cleanup failed; diagnostics kept at ${scratch}`)
    : undefined;
  if (primaryError || cleanupError) {
    if (stderr.trim()) process.stderr.write(`MCP stderr:\n${stderr.trim()}\n`);
    if (daemonStderr.trim()) process.stderr.write(`Capture daemon stderr:\n${daemonStderr.trim()}\n`);
  }
  if (keepDiagnostics) process.stderr.write(`Standalone smoke diagnostics kept at ${scratch}\n`);

  if (!childIsRunning(daemonProcess)) process.off('exit', emergencyStop);
}

if (primaryError && cleanupError) {
  throw new AggregateError([primaryError, cleanupError], 'Standalone smoke failed and cleanup also reported errors');
}
if (primaryError) throw primaryError;
if (cleanupError) throw cleanupError;
