import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { serializeVector } from '../src/search/VectorSearch.js';
import type { SessionDigest, WorkSession } from '../src/types.js';

const tempDirs: string[] = [];

async function createManager(): Promise<DatabaseManager> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesti-token-upsert-'));
  tempDirs.push(dir);
  const manager = new DatabaseManager(path.join(dir, 'vesti.db'));
  await manager.initialize();
  return manager;
}

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 'codex:active-session',
    sessionId: 'active-session',
    platform: 'codex',
    projectPath: 'C:/workspace/project',
    title: 'Active session',
    tags: [],
    status: 'active',
    sessionType: 'conversation',
    startedAt: 1_000,
    lastActivityAt: 2_000,
    durationMs: 1_000,
    messageCount: 20,
    userInputCount: 5,
    assistantMessageCount: 10,
    thinkingCount: 3,
    toolCallCount: 2,
    codeBlockCount: 1,
    turnCount: 5,
    totalInputTokens: 300_000_000,
    totalOutputTokens: 4_000_000,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 290_000_000,
    hasSubagents: false,
    hasContextCompaction: false,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('DatabaseManager work-session token totals', () => {
  it('does not let an older concurrent parse reduce cumulative usage', async () => {
    const manager = await createManager();
    manager.upsertWorkSession(session());

    manager.upsertWorkSession(session({
      lastActivityAt: 1_500,
      durationMs: 500,
      messageCount: 8,
      userInputCount: 2,
      assistantMessageCount: 4,
      thinkingCount: 1,
      toolCallCount: 1,
      codeBlockCount: 0,
      turnCount: 2,
      totalInputTokens: 40_000_000,
      totalOutputTokens: 800_000,
      totalCacheReadTokens: 35_000_000,
      updatedAt: 1_500,
    }));

    const stored = manager.getWorkSession('codex:active-session');
    expect(stored).toMatchObject({
      lastActivityAt: 2_000,
      messageCount: 20,
      totalInputTokens: 300_000_000,
      totalOutputTokens: 4_000_000,
      totalCacheReadTokens: 290_000_000,
    });

    await manager.close();
  });

  it('still accepts a newer larger cumulative total', async () => {
    const manager = await createManager();
    manager.upsertWorkSession(session());
    manager.upsertWorkSession(session({
      lastActivityAt: 3_000,
      messageCount: 25,
      totalInputTokens: 320_000_000,
      totalOutputTokens: 4_500_000,
      totalCacheReadTokens: 310_000_000,
      updatedAt: 3_000,
    }));

    expect(manager.getWorkSession('codex:active-session')).toMatchObject({
      lastActivityAt: 3_000,
      messageCount: 25,
      totalInputTokens: 320_000_000,
      totalOutputTokens: 4_500_000,
      totalCacheReadTokens: 310_000_000,
    });

    await manager.close();
  });

});

describe('DatabaseManager subagent folding (A1)', () => {
  async function seedParentAndChild(manager: DatabaseManager): Promise<void> {
    manager.upsertWorkSession(session({
      id: 'codex:parent',
      sessionId: 'parent',
      title: 'Parent session',
      totalInputTokens: 100,
      totalOutputTokens: 10,
      totalCacheReadTokens: 0,
    }));
    manager.upsertWorkSession(session({
      id: 'codex:child',
      sessionId: 'child',
      title: 'Review the renderer',
      messageCount: 7,
      totalInputTokens: 50,
      totalOutputTokens: 5,
      totalCacheReadTokens: 0,
    }));
    manager.insertSubagentLink({
      id: 'link-1',
      parentSessionId: 'codex:parent',
      childSessionId: 'codex:child',
      agentId: 'child',
      agentRole: 'bugbot',
      slug: null as unknown as string,
      filePath: 'C:/x/child.jsonl',
      messageCount: 7,
      spawnedAt: 1_500,
    });
  }

  it('exposes child ids, lineage and briefs for downstream folding', async () => {
    const manager = await createManager();
    await seedParentAndChild(manager);

    expect([...manager.getSubagentChildIds()]).toEqual(['codex:child']);
    expect(manager.getSubagentLineageByChild().get('codex:child')).toEqual({
      parentSessionId: 'codex:parent',
      agentRole: 'bugbot',
    });
    expect(manager.getSubagentBriefs('codex:parent')).toEqual([
      {
        childSessionId: 'codex:child',
        agentRole: 'bugbot',
        title: 'Review the renderer',
        messageCount: 7,
        oneLiner: null,
      },
    ]);

    await manager.close();
  });
});

describe('DatabaseManager active embedding index', () => {
  function semanticDigest(updatedAt: string): SessionDigest {
    return {
      sessionId: 'codex:active-session',
      host: 'native',
      platform: 'codex',
      projectKey: 'cli_test',
      oneLiner: 'Implement token rotation',
      keyTopics: ['authentication'],
      keyFiles: [],
      decisions: [],
      openQuestions: [],
      embedding: null,
      embeddingStatus: 'skipped',
      digestVersion: 1,
      messageCount: 20,
      updatedAt,
    };
  }

  it('promotes atomically and treats vectors older than the digest as missing', async () => {
    const manager = await createManager();
    manager.upsertWorkSession(session());
    manager.upsertSessionDigest(semanticDigest('2026-01-01T00:00:00.000Z'));
    manager.upsertDigestEmbedding({
      sessionId: 'codex:active-session',
      provider: 'provider',
      model: 'model',
      dimensions: 2,
      indexVersion: 'provider:model:2',
      embedding: serializeVector(new Float32Array([1, 0])),
      createdAt: '2026-01-01T00:00:01.000Z',
    });

    expect(manager.getEmbeddingIndexState().activeVersion).toBeNull();
    expect(manager.listDigestEmbeddingSessionIds('provider:model:2')).toEqual([
      'codex:active-session',
    ]);
    manager.promoteEmbeddingIndex('provider:model:2', '2026-01-01T00:00:02.000Z');
    expect(manager.getEmbeddingIndexState()).toMatchObject({
      activeVersion: 'provider:model:2',
      promotedAt: '2026-01-01T00:00:02.000Z',
    });

    manager.upsertSessionDigest(semanticDigest('2026-01-02T00:00:00.000Z'));
    expect(manager.listDigestEmbeddingSessionIds('provider:model:2')).toEqual([]);
    expect(manager.listThinkingMapEmbeddings(
      'provider:model:2',
      ['codex:active-session'],
    )).toEqual([]);

    manager.upsertDigestEmbedding({
      sessionId: 'codex:active-session',
      provider: 'provider',
      model: 'model',
      dimensions: 2,
      indexVersion: 'provider:model:2',
      embedding: serializeVector(new Float32Array([0.9, 0.1])),
      createdAt: '2026-01-02T00:00:01.000Z',
    });
    expect(manager.listThinkingMapEmbeddings(
      'provider:model:2',
      ['codex:active-session'],
    )).toHaveLength(1);
    await manager.close();
  });
});
