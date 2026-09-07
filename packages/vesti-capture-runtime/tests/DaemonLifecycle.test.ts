import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureDaemon, type CaptureRuntimeController } from '../src/runtime/daemon.js';
import { silentRuntimeLogger } from '../src/runtime/logger.js';
import { resolveRuntimePaths } from '../src/runtime/paths.js';
import type { CaptureRuntimeState, CaptureRuntimeStatus } from '../src/runtime/types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })));
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function testPaths() {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-daemon-life-'));
  temporaryDirectories.push(basePath);
  return resolveRuntimePaths({ basePath, env: {} });
}

function status(paths: ReturnType<typeof resolveRuntimePaths>, state: CaptureRuntimeState): CaptureRuntimeStatus {
  return {
    state,
    pid: process.pid,
    basePath: paths.basePath,
    dbPath: paths.dbPath,
    vaultPath: paths.vaultPath,
    startedAt: Date.now(),
    uptimeMs: 0,
    watching: false,
    syncing: state === 'starting',
    initialSyncComplete: state === 'running',
    enabledPlatforms: ['codex'],
    sources: [],
    wsl: null,
    lastSync: null,
    lastError: null,
    wslPollIntervalMs: 0,
    reconcileIntervalMs: 0,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for daemon lifecycle event');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('CaptureDaemon lifecycle', () => {
  it('signals runtime close and waits for startup to settle before releasing ownership', async () => {
    const paths = await testPaths();
    const startEntered = deferred();
    const releaseStart = deferred();
    let state: CaptureRuntimeState = 'stopped';
    let closeRequested = false;
    const runtime: CaptureRuntimeController = {
      start: vi.fn(async () => {
        state = 'starting';
        startEntered.resolve();
        await releaseStart.promise;
        if (closeRequested) throw new Error('runtime start cancelled');
        state = 'running';
      }),
      close: vi.fn(async () => {
        closeRequested = true;
        state = 'stopped';
      }),
      syncAll: vi.fn(async () => ({
        reason: 'test', startedAt: 0, completedAt: 0,
        sessions: 0, messages: 0, tools: 0, turns: 0, linksResolved: 0, errors: [],
      })),
      getStatus: () => status(paths, state),
    };
    const daemon = new CaptureDaemon({
      paths,
      runtime,
      logger: silentRuntimeLogger,
      heartbeatIntervalMs: 0,
    });

    const starting = daemon.start();
    await startEntered.promise;
    const stopping = daemon.stop();
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(await fs.stat(paths.lockPath).then(() => true, () => false)).toBe(true);
    releaseStart.resolve();

    await expect(starting).rejects.toThrow('runtime start cancelled');
    await expect(stopping).resolves.toBeUndefined();
    expect(await fs.stat(paths.lockPath).then(() => true, () => false)).toBe(false);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it('shuts the writer down when a heartbeat can no longer prove lock ownership', async () => {
    const paths = await testPaths();
    let state: CaptureRuntimeState = 'stopped';
    const close = vi.fn(async () => { state = 'stopped'; });
    const runtime: CaptureRuntimeController = {
      start: vi.fn(async () => { state = 'running'; }),
      close,
      syncAll: vi.fn(async () => ({
        reason: 'test', startedAt: 0, completedAt: 0,
        sessions: 0, messages: 0, tools: 0, turns: 0, linksResolved: 0, errors: [],
      })),
      getStatus: () => status(paths, state),
    };
    const daemon = new CaptureDaemon({
      paths,
      runtime,
      logger: silentRuntimeLogger,
      heartbeatIntervalMs: 10,
    });

    await daemon.start();
    await fs.rm(paths.lockPath, { force: true });
    await waitFor(() => close.mock.calls.length > 0);
    await daemon.stop();

    expect(close).toHaveBeenCalledOnce();
    expect(await fs.stat(paths.lockPath).then(() => true, () => false)).toBe(false);
  });
});
