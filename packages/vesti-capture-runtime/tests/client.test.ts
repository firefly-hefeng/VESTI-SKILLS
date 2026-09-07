import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CaptureDaemonRequestError,
  ensureCaptureDaemon,
  startCaptureDaemonDetached,
  type EnsureCaptureDaemonDependencies,
} from '../src/client.js';
import { resolveRuntimePaths } from '../src/runtime/paths.js';
import {
  CAPTURE_DAEMON_PROTOCOL_VERSION,
  type CaptureDaemonPingResult,
  type CaptureDaemonStatus,
} from '../src/runtime/types.js';

const paths = resolveRuntimePaths({
  platform: 'linux',
  basePath: '/tmp/vesti-client-test',
  env: {},
});

function readyStatus(): CaptureDaemonStatus {
  return {
    protocolVersion: CAPTURE_DAEMON_PROTOCOL_VERSION,
    socketPath: paths.socketPath,
    lockPath: paths.lockPath,
    state: 'running',
    pid: 42,
    basePath: paths.basePath,
    dbPath: paths.dbPath,
    vaultPath: paths.vaultPath,
    startedAt: 1,
    uptimeMs: 100,
    watching: true,
    syncing: false,
    initialSyncComplete: true,
    enabledPlatforms: ['codex'],
    sources: [],
    wsl: null,
    lastSync: null,
    lastError: null,
    wslPollIntervalMs: 60_000,
    reconcileIntervalMs: 300_000,
  };
}

describe('ensureCaptureDaemon', () => {
  it('creates a missing data directory before detached spawn uses it as cwd', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-capture-client-'));
    const basePath = path.join(parent, 'missing', '.vesti');
    try {
      expect(await fs.stat(basePath).catch(() => null)).toBeNull();
      await startCaptureDaemonDetached({
        basePath,
        env: {},
        daemonEntryPath: fileURLToPath(new URL('./fixtures/noop-daemon.mjs', import.meta.url)),
      });
      expect((await fs.stat(basePath)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  });

  it('starts once and waits for schema creation plus initial sync readiness', async () => {
    let now = 0;
    let started = false;
    let probesAfterStart = 0;
    const start = vi.fn(async () => ({ pid: 42, paths }));
    const dependencies: EnsureCaptureDaemonDependencies = {
      request: async <T>(request, options): Promise<T> => {
        expect(options.paths).toBe(paths);
        if (!started) throw new Error('ENOENT');
        if (request.command === 'ping') {
          probesAfterStart += 1;
          return {
            protocolVersion: CAPTURE_DAEMON_PROTOCOL_VERSION,
            pid: 42,
            ready: probesAfterStart >= 2,
            state: probesAfterStart >= 2 ? 'running' : 'starting',
          } as T;
        }
        return readyStatus() as T;
      },
      start: async options => {
        const result = await start(options);
        started = true;
        return result;
      },
      sleep: async milliseconds => { now += milliseconds; },
      now: () => now,
    };

    const status = await ensureCaptureDaemon({
      paths,
      startupTimeoutMs: 1_000,
      pollIntervalMs: 10,
    }, dependencies);
    expect(status.initialSyncComplete).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(probesAfterStart).toBe(2);
  });

  it('does not launch another process when an existing daemon is ready', async () => {
    const start = vi.fn(async () => ({ pid: 1, paths }));
    const dependencies: EnsureCaptureDaemonDependencies = {
      request: async <T>(request): Promise<T> => (
        request.command === 'ping'
          ? {
              protocolVersion: CAPTURE_DAEMON_PROTOCOL_VERSION,
              pid: 42,
              ready: true,
              state: 'running',
            } satisfies CaptureDaemonPingResult
          : readyStatus()
      ) as T,
      start,
      sleep: async () => undefined,
      now: () => 0,
    };
    expect((await ensureCaptureDaemon({ paths }, dependencies)).pid).toBe(42);
    expect(start).not.toHaveBeenCalled();
  });

  it('times out when the daemon never becomes reachable', async () => {
    let now = 0;
    const dependencies: EnsureCaptureDaemonDependencies = {
      request: async () => { throw new Error('ECONNREFUSED'); },
      start: async () => ({ pid: 42, paths }),
      sleep: async milliseconds => { now += milliseconds; },
      now: () => now,
    };
    await expect(ensureCaptureDaemon({
      paths,
      startupTimeoutMs: 20,
      pollIntervalMs: 10,
    }, dependencies)).rejects.toMatchObject({ code: 'STARTUP_TIMEOUT' });
  });

  it('fails immediately on a protocol mismatch', async () => {
    const start = vi.fn(async () => ({ pid: 42, paths }));
    const dependencies: EnsureCaptureDaemonDependencies = {
      request: async <T>(): Promise<T> => ({
        protocolVersion: 999,
        pid: 1,
        ready: true,
        state: 'running',
      } as T),
      start,
      sleep: async () => undefined,
      now: () => 0,
    };
    await expect(ensureCaptureDaemon({ paths }, dependencies))
      .rejects.toBeInstanceOf(CaptureDaemonRequestError);
    expect(start).not.toHaveBeenCalled();
  });

  it('fails immediately when a ready daemon owns a different database', async () => {
    const start = vi.fn(async () => ({ pid: 42, paths }));
    const dependencies: EnsureCaptureDaemonDependencies = {
      request: async <T>(request): Promise<T> => (
        request.command === 'ping'
          ? {
              protocolVersion: CAPTURE_DAEMON_PROTOCOL_VERSION,
              pid: 42,
              ready: true,
              state: 'running',
            }
          : { ...readyStatus(), dbPath: `${paths.dbPath}.other` }
      ) as T,
      start,
      sleep: async () => undefined,
      now: () => 0,
    };

    await expect(ensureCaptureDaemon({ paths }, dependencies))
      .rejects.toMatchObject({ code: 'RUNTIME_PATH_MISMATCH' });
    expect(start).not.toHaveBeenCalled();
  });

  it('reuses a ready daemon for the same database even when VESTI_HOME differs', async () => {
    const alternatePaths = resolveRuntimePaths({
      platform: 'linux',
      basePath: '/tmp/a-different-vesti-home',
      dbPath: paths.dbPath,
      env: {},
    });
    const start = vi.fn(async () => ({ pid: 42, paths: alternatePaths }));
    const dependencies: EnsureCaptureDaemonDependencies = {
      request: async <T>(request): Promise<T> => (
        request.command === 'ping'
          ? {
              protocolVersion: CAPTURE_DAEMON_PROTOCOL_VERSION,
              pid: 42,
              ready: true,
              state: 'running',
            }
          : readyStatus()
      ) as T,
      start,
      sleep: async () => undefined,
      now: () => 0,
    };

    const status = await ensureCaptureDaemon({ paths: alternatePaths }, dependencies);
    expect(status.dbPath).toBe(paths.dbPath);
    expect(start).not.toHaveBeenCalled();
  });
});
