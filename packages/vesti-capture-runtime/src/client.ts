import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import {
  createNdjsonDecoder,
  encodeNdjson,
  parseCaptureDaemonResponse,
} from './runtime/protocol.js';
import {
  resolveRuntimePaths,
  type ResolveRuntimePathsOptions,
  type RuntimePaths,
} from './runtime/paths.js';
import {
  CAPTURE_DAEMON_PROTOCOL_VERSION,
  type CaptureDaemonPingResult,
  type CaptureDaemonRequestInput,
  type CaptureDaemonStatus,
} from './runtime/types.js';

export { resolveRuntimePaths } from './runtime/paths.js';
export type { ResolveRuntimePathsOptions, RuntimePaths } from './runtime/paths.js';
export type {
  CaptureDaemonPingResult,
  CaptureDaemonRequest,
  CaptureDaemonRequestInput,
  CaptureDaemonResponse,
  CaptureDaemonStatus,
  CaptureRuntimeStatus,
  CaptureSyncSummary,
} from './runtime/types.js';

export interface CaptureDaemonClientOptions extends ResolveRuntimePathsOptions {
  paths?: RuntimePaths;
  timeoutMs?: number;
}

export interface StartCaptureDaemonOptions extends CaptureDaemonClientOptions {
  executablePath?: string;
  daemonEntryPath?: string;
  cwd?: string;
}

export interface StartedCaptureDaemon {
  pid: number | undefined;
  paths: RuntimePaths;
}

export class CaptureDaemonRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CaptureDaemonRequestError';
  }
}

function pathsFor(options: CaptureDaemonClientOptions): RuntimePaths {
  return options.paths ?? resolveRuntimePaths(options);
}

function sameLocalPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function assertCompatibleRuntimePaths(status: CaptureDaemonStatus, paths: RuntimePaths): void {
  if (sameLocalPath(status.dbPath, paths.dbPath)) return;
  throw new CaptureDaemonRequestError(
    'RUNTIME_PATH_MISMATCH',
    `The running VESTI daemon uses ${status.dbPath}, but this client requested ${paths.dbPath}. `
      + 'Stop the existing daemon or use one consistent VESTI_HOME/VESTI_DB_PATH configuration.',
  );
}

/** Send one request over a short-lived local NDJSON connection. */
export function requestCaptureDaemon<T = unknown>(
  input: CaptureDaemonRequestInput,
  options: CaptureDaemonClientOptions = {},
): Promise<T> {
  const paths = pathsFor(options);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const request = { ...input, id: input.id ?? randomUUID() };

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(paths.socketPath);
    let settled = false;
    const finish = (error?: Error, result?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result as T);
    };
    const timer = setTimeout(() => {
      finish(new CaptureDaemonRequestError(
        'TIMEOUT',
        `Timed out waiting for VESTI capture daemon after ${timeoutMs}ms`,
      ));
    }, timeoutMs);
    timer.unref();

    const decoder = createNdjsonDecoder(value => {
      let response;
      try {
        response = parseCaptureDaemonResponse(value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (response.id !== request.id) return;
      if (!response.ok) {
        finish(new CaptureDaemonRequestError(response.error.code, response.error.message));
        return;
      }
      finish(undefined, response.result as T);
    }, error => finish(error));

    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(encodeNdjson(request)));
    socket.on('data', chunk => decoder.push(chunk));
    socket.on('error', error => finish(error));
    socket.on('end', () => {
      decoder.end();
      if (!settled) finish(new CaptureDaemonRequestError(
        'CONNECTION_CLOSED',
        'VESTI capture daemon closed the connection before replying',
      ));
    });
  });
}

export async function getCaptureDaemonStatus(
  options: CaptureDaemonClientOptions = {},
): Promise<CaptureDaemonStatus> {
  const paths = pathsFor(options);
  const status = await requestCaptureDaemon<CaptureDaemonStatus>({ command: 'status' }, {
    ...options,
    paths,
  });
  assertCompatibleRuntimePaths(status, paths);
  return status;
}

/** Start the package's daemon entry as an independent background process. */
export async function startCaptureDaemonDetached(
  options: StartCaptureDaemonOptions = {},
): Promise<StartedCaptureDaemon> {
  const paths = pathsFor(options);
  // A clean installation has no ~/.vesti yet. child_process.spawn reports an
  // opaque ENOENT when cwd does not exist, so establish it before launching.
  await fs.mkdir(paths.basePath, { recursive: true, mode: 0o700 });
  const executablePath = options.executablePath ?? process.execPath;
  const daemonEntryPath = options.daemonEntryPath
    ?? fileURLToPath(new URL('./daemon-cli.js', import.meta.url));
  const args = [daemonEntryPath, '--data-dir', paths.basePath, '--db-path', paths.dbPath];

  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      cwd: options.cwd ?? paths.basePath,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...options.env,
        VESTI_HOME: paths.basePath,
        VESTI_DB_PATH: paths.dbPath,
      },
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid, paths });
    });
  });
}

export interface EnsureCaptureDaemonOptions extends StartCaptureDaemonOptions {
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
}

export interface EnsureCaptureDaemonDependencies {
  request<T>(input: CaptureDaemonRequestInput, options: CaptureDaemonClientOptions): Promise<T>;
  start(options: StartCaptureDaemonOptions): Promise<StartedCaptureDaemon>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

const defaultEnsureDependencies: EnsureCaptureDaemonDependencies = {
  request: requestCaptureDaemon,
  start: startCaptureDaemonDetached,
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
};

/**
 * Ensure a single daemon is alive and query-ready. The promise does not
 * resolve merely because the process/socket exists: the database schema and
 * initial reconciliation must both be complete.
 */
export async function ensureCaptureDaemon(
  options: EnsureCaptureDaemonOptions = {},
  dependencies: EnsureCaptureDaemonDependencies = defaultEnsureDependencies,
): Promise<CaptureDaemonStatus> {
  const paths = pathsFor(options);
  const startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const probeTimeoutMs = options.probeTimeoutMs ?? 750;
  const deadline = dependencies.now() + startupTimeoutMs;
  let launched = false;
  let lastError: unknown;

  while (dependencies.now() <= deadline) {
    try {
      const ping = await dependencies.request<CaptureDaemonPingResult>(
        { command: 'ping' },
        { paths, timeoutMs: probeTimeoutMs },
      );
      if (ping.protocolVersion !== CAPTURE_DAEMON_PROTOCOL_VERSION) {
        throw new CaptureDaemonRequestError(
          'PROTOCOL_MISMATCH',
          `Capture daemon protocol ${ping.protocolVersion} is incompatible with client protocol ${CAPTURE_DAEMON_PROTOCOL_VERSION}`,
        );
      }
      if (ping.ready) {
        const status = await dependencies.request<CaptureDaemonStatus>(
          { command: 'status' },
          { paths, timeoutMs: Math.max(probeTimeoutMs, 2_000) },
        );
        assertCompatibleRuntimePaths(status, paths);
        if (status.state === 'running' && status.initialSyncComplete) return status;
      }
    } catch (error) {
      lastError = error;
      if (
        error instanceof CaptureDaemonRequestError
        && (error.code === 'PROTOCOL_MISMATCH' || error.code === 'RUNTIME_PATH_MISMATCH')
      ) {
        throw error;
      }
      if (!launched) {
        launched = true;
        try {
          await dependencies.start({ ...options, paths });
        } catch (startError) {
          // Another client may have won the launch race. Keep probing its
          // socket until the common deadline before reporting failure.
          lastError = startError;
        }
      }
    }
    if (dependencies.now() > deadline) break;
    await dependencies.sleep(pollIntervalMs);
  }

  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new CaptureDaemonRequestError(
    'STARTUP_TIMEOUT',
    `VESTI capture daemon did not become query-ready within ${startupTimeoutMs}ms.${detail}`,
  );
}
