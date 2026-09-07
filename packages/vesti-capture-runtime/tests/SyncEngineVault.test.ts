import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterManager } from '../src/adapters/AdapterManager.js';
import type { DatabaseManager } from '../src/storage/DatabaseManager.js';
import type { VaultManager } from '../src/storage/VaultManager.js';
import { SyncEngine } from '../src/sync/SyncEngine.js';
import type { ParsedSession } from '../src/types/agent.js';

const tempRoots: string[] = [];

async function makeSource(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-sync-vault-'));
  tempRoots.push(root);
  const source = path.join(root, 'session.jsonl');
  await fs.outputFile(source, '{"message":"hello"}\n');
  return source;
}

function parsedSession(): ParsedSession {
  return {
    sessionId: 'session-1',
    platform: 'codex',
    projectPath: '/project',
    messages: [{
      uuid: 'message-1',
      type: 'user',
      role: 'user',
      timestamp: 1_000,
      contentText: 'hello world',
      isToolResult: false,
      depth: 0,
    }],
    toolExecutions: [],
    subagents: [],
    tokenUsage: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      models: new Set(),
    },
    startTime: 1_000,
  };
}

function makeAdapters(session: ParsedSession): AdapterManager {
  return {
    parseSessions: vi.fn().mockResolvedValue([session]),
    getAdapter: vi.fn().mockReturnValue({ shouldBackupSource: true }),
  } as unknown as AdapterManager;
}

function makeDatabase(order: string[]): DatabaseManager {
  return {
    getSyncState: vi.fn().mockReturnValue(null),
    getSyncFilesForConversation: vi.fn().mockReturnValue([]),
    getWorkSession: vi.fn().mockReturnValue(null),
    getSessionMessageCount: vi.fn().mockReturnValue(0),
    getUnifiedToolExecutions: vi.fn().mockReturnValue([]),
    getTurns: vi.fn().mockReturnValue([]),
    upsertWorkSession: vi.fn(() => { order.push('session'); }),
    insertSessionMessages: vi.fn(() => { order.push('messages'); }),
    insertUnifiedToolExecutions: vi.fn(() => { order.push('tools'); }),
    insertTurns: vi.fn(() => { order.push('turns'); }),
    insertSystemEvents: vi.fn(() => { order.push('events'); }),
    insertContextCompactions: vi.fn(() => { order.push('compactions'); }),
    replaceSessionSnapshot: vi.fn(() => { order.push('session'); }),
    replaceTokenUsageEvents: vi.fn(() => { order.push('token-events'); }),
    insertSubagentLink: vi.fn(),
    setSyncState: vi.fn(() => { order.push('sync-state'); }),
  } as unknown as DatabaseManager;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map(root => fs.remove(root)));
});

describe('SyncEngine vault scheduling', () => {
  it('stores data and the checkpoint before starting a non-blocking backup', async () => {
    const source = await makeSource();
    const order: string[] = [];
    const db = makeDatabase(order);
    let rejectBackup!: (error: Error) => void;
    const backup = vi.fn(() => {
      order.push('backup');
      return new Promise<string>((_resolve, reject) => { rejectBackup = reject; });
    });
    const vault = { backup } as unknown as VaultManager;
    const engine = new SyncEngine(makeAdapters(parsedSession()), db, vault);

    const result = await engine.syncFile('codex', source);

    expect(result).toMatchObject({ sessions: 1, messages: 1 });
    expect(order.indexOf('session')).toBeLessThan(order.indexOf('sync-state'));
    expect(order.indexOf('sync-state')).toBeLessThan(order.indexOf('backup'));
    expect(backup).toHaveBeenCalledOnce();

    // A later asynchronous archival failure is consumed by SyncEngine.
    rejectBackup(new Error('archive failed'));
    await Promise.resolve();
  });

  it('does not enqueue a backup when database storage fails', async () => {
    const source = await makeSource();
    const order: string[] = [];
    const db = makeDatabase(order);
    vi.mocked(db.replaceSessionSnapshot).mockImplementation(() => {
      throw new Error('database failed');
    });
    const backup = vi.fn().mockResolvedValue('unused');
    const engine = new SyncEngine(
      makeAdapters(parsedSession()),
      db,
      { backup } as unknown as VaultManager,
    );

    await expect(engine.syncFile('codex', source)).rejects.toThrow('database failed');
    expect(db.setSyncState).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
  });
});
