import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdapterManager,
  normalizeAdapterWatchEvent,
} from '../src/adapters/AdapterManager.js';
import { TraeAdapter } from '../src/adapters/trae/adapter.js';
import { SyncEngine } from '../src/sync/SyncEngine.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
  vi.restoreAllMocks();
});

describe('capture watcher planning', () => {
  it('does not detect or watch disabled adapters', async () => {
    const manager = new AdapterManager();
    const codex = manager.getAdapter('codex')!;
    const aider = manager.getAdapter('aider')!;
    const enabledDetect = vi.spyOn(codex, 'detect').mockResolvedValue({ installed: false });
    const disabledDetect = vi.spyOn(aider, 'detect').mockRejectedValue(
      new Error('disabled adapter must never be touched'),
    );

    await manager.startWatching(() => undefined, new Set(['codex']));

    expect(enabledDetect).toHaveBeenCalledOnce();
    expect(disabledDetect).not.toHaveBeenCalled();
    await manager.stopWatching();
  });

  it('isolates detection failures so another enabled platform is still planned', async () => {
    const manager = new AdapterManager();
    const codex = manager.getAdapter('codex')!;
    const cursor = manager.getAdapter('cursor')!;
    vi.spyOn(codex, 'detect').mockRejectedValue(new Error('broken codex home'));
    const cursorDetect = vi.spyOn(cursor, 'detect').mockResolvedValue({ installed: false });
    const onError = vi.fn();

    await expect(manager.startWatching(
      () => undefined,
      new Set(['codex', 'cursor']),
      onError,
    )).resolves.toEqual([]);
    expect(cursorDetect).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('codex', expect.any(Error));
  });

  it('adds a watcher during reconciliation when a platform appears after startup', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-late-watch-'));
    temporaryDirectories.push(directory);
    const sessionPath = path.join(directory, 'session.jsonl');
    await fs.writeFile(sessionPath, '{}\n');
    const manager = new AdapterManager();
    const codex = manager.getAdapter('codex')!;
    const detect = vi.spyOn(codex, 'detect')
      .mockResolvedValueOnce({ installed: false })
      .mockResolvedValue({ installed: true });
    vi.spyOn(codex, 'getWatchPatterns').mockReturnValue([sessionPath]);

    expect(await manager.startWatching(() => undefined, new Set(['codex']))).toEqual([]);
    expect(await manager.startWatching(() => undefined, new Set(['codex']))).toEqual(['codex']);
    expect(await manager.startWatching(() => undefined, new Set(['codex']))).toEqual(['codex']);
    expect(detect).toHaveBeenCalledTimes(2);
    await manager.stopWatching();
  });

  it('attempts to close every watcher when one close fails', async () => {
    const manager = new AdapterManager();
    const firstClose = vi.fn(async () => { throw new Error('first close failed'); });
    const secondClose = vi.fn(async () => undefined);
    const internals = manager as unknown as {
      watchers: Map<string, { platform: string; watcher: { close(): Promise<void> } }>;
    };
    internals.watchers.set('codex', {
      platform: 'codex',
      watcher: { close: firstClose },
    });
    internals.watchers.set('cursor', {
      platform: 'cursor',
      watcher: { close: secondClose },
    });

    await expect(manager.stopWatching()).rejects.toBeInstanceOf(AggregateError);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    expect(internals.watchers.size).toBe(0);
  });

  it('watches every Trae database together with its WAL and SHM sidecars', () => {
    const patterns = new TraeAdapter().getWatchPatterns();
    const databases = patterns.filter(pattern => pattern.endsWith('state.vscdb'));
    expect(databases).toHaveLength(6); // 3 Trae products × global/workspace DB
    expect(patterns).toHaveLength(databases.length * 3);
    for (const database of databases) {
      expect(patterns).toContain(`${database}-wal`);
      expect(patterns).toContain(`${database}-shm`);
    }
  });

  it('normalizes only Trae sidecar events to their canonical database', () => {
    expect(normalizeAdapterWatchEvent('trae', 'C:\\Trae\\state.vscdb-wal')).toEqual({
      sourcePath: 'C:\\Trae\\state.vscdb-wal',
      filePath: 'C:\\Trae\\state.vscdb',
      force: true,
    });
    expect(normalizeAdapterWatchEvent('trae', '/tmp/state.vscdb-SHM')).toEqual({
      sourcePath: '/tmp/state.vscdb-SHM',
      filePath: '/tmp/state.vscdb',
      force: true,
    });
    expect(normalizeAdapterWatchEvent('cursor', '/tmp/state.vscdb-wal')).toEqual({
      sourcePath: '/tmp/state.vscdb-wal',
      filePath: '/tmp/state.vscdb-wal',
      force: false,
    });
  });

  it('forces a canonical Trae reread when only its WAL changed', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-trae-watch-'));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, 'state.vscdb');
    await fs.writeFile(databasePath, 'database-placeholder');
    const stat = await fs.stat(databasePath);
    const parseSessions = vi.fn(async () => []);
    const adapters = {
      getAdapter: () => ({ parserVersion: 1 }),
      parseSessions,
    };
    const db = {
      getSyncState: () => ({
        lastPosition: stat.size,
        lastModified: stat.mtimeMs,
        parserVersion: 1,
      }),
      replaceTokenUsageEvents: vi.fn(),
      setSyncState: vi.fn(),
    };
    const sync = new SyncEngine(adapters as never, db as never);

    await sync.syncFile('trae', databasePath);
    expect(parseSessions).not.toHaveBeenCalled();

    const walEvent = normalizeAdapterWatchEvent('trae', `${databasePath}-wal`);
    await sync.syncFile('trae', walEvent.filePath, { force: walEvent.force });
    expect(parseSessions).toHaveBeenCalledOnce();
    expect(parseSessions).toHaveBeenCalledWith('trae', databasePath);
  });
});
