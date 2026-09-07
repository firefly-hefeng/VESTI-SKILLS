import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureRuntime } from '../src/runtime/CaptureRuntime.js';
import { resolveRuntimePaths } from '../src/runtime/paths.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function syncResult() {
  return {
    sessionsProcessed: 1,
    messagesStored: 1,
    toolExecutionsStored: 0,
    turnsStored: 1,
    errors: [],
  };
}

async function runtimePaths() {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-runtime-life-'));
  temporaryDirectories.push(basePath);
  return resolveRuntimePaths({ basePath, env: {} });
}

describe('CaptureRuntime lifecycle', () => {
  it('serializes shutdown with an in-flight initial sync and drains the vault', async () => {
    const paths = await runtimePaths();
    const syncEntered = deferred();
    const releaseSync = deferred();
    const database = {
      initialize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      refreshForkLineage: vi.fn(),
    };
    const adapter = {
      detect: vi.fn(async () => ({ installed: true })),
      getSessionFiles: vi.fn(async () => ['session.jsonl']),
    };
    const adapters = {
      getAdapter: vi.fn(() => adapter),
      setWslHomes: vi.fn(),
      startWatching: vi.fn(async () => []),
      stopWatching: vi.fn(async () => undefined),
    };
    const vault = {
      initialize: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => undefined),
    };
    const syncEngine = {
      syncPlatform: vi.fn(async () => {
        syncEntered.resolve();
        await releaseSync.promise;
        return syncResult();
      }),
      resolveSubagentLinks: vi.fn(async () => 0),
    };
    const runtime = new CaptureRuntime({
      paths,
      enabledPlatforms: ['codex'],
      watch: false,
      wslPollIntervalMs: 0,
      reconcileIntervalMs: 0,
      factories: {
        createDatabase: () => database as never,
        createAdapters: () => adapters as never,
        createVault: () => vault as never,
        createSyncEngine: () => syncEngine as never,
        createWslDetector: () => ({
          detect: async () => ({ supported: false, distros: [], homes: [] }),
        }) as never,
      },
    });

    const starting = runtime.start();
    await syncEntered.promise;
    const closing = runtime.close();
    releaseSync.resolve();

    await expect(starting).rejects.toThrow('cancelled by shutdown');
    await expect(closing).resolves.toBeUndefined();
    expect(runtime.getStatus().state).toBe('stopped');
    expect(database.close).toHaveBeenCalledOnce();
    expect(adapters.stopWatching).toHaveBeenCalledOnce();
    expect(vault.waitForIdle).toHaveBeenCalledOnce();
  });

  it('re-plans native watchers during reconciliation for late installations', async () => {
    const paths = await runtimePaths();
    const database = {
      initialize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      refreshForkLineage: vi.fn(),
    };
    const adapter = {
      detect: vi.fn(async () => ({ installed: false })),
      getSessionFiles: vi.fn(async () => []),
    };
    const startWatching = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue(['codex']);
    const adapters = {
      getAdapter: vi.fn(() => adapter),
      setWslHomes: vi.fn(),
      startWatching,
      stopWatching: vi.fn(async () => undefined),
    };
    const vault = {
      initialize: vi.fn(async () => undefined),
      waitForIdle: vi.fn(async () => undefined),
    };
    const syncEngine = {
      resolveSubagentLinks: vi.fn(async () => 0),
    };
    const runtime = new CaptureRuntime({
      paths,
      enabledPlatforms: ['codex'],
      watch: true,
      wslPollIntervalMs: 0,
      reconcileIntervalMs: 0,
      factories: {
        createDatabase: () => database as never,
        createAdapters: () => adapters as never,
        createVault: () => vault as never,
        createSyncEngine: () => syncEngine as never,
        createWslDetector: () => ({
          detect: async () => ({ supported: false, distros: [], homes: [] }),
        }) as never,
      },
    });

    await runtime.start();
    expect(runtime.getStatus().watching).toBe(false);
    await (runtime as unknown as { reconcile(): Promise<void> }).reconcile();
    expect(startWatching).toHaveBeenCalledTimes(2);
    expect(runtime.getStatus().watching).toBe(true);
    await runtime.close();
  });
});
