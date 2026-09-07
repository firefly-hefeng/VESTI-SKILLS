import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { serializeVector } from '../src/search/VectorSearch.js';
import type { SessionDigest, TokenUsageEvent, WorkSession } from '../src/types/unified.js';

const tempDirs: string[] = [];

async function createManager(): Promise<DatabaseManager> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-token-upsert-'));
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
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
    expect(manager.getStats().totalInputTokens).toBe(300_000_000);
    expect(manager.getStats().totalOutputTokens).toBe(4_000_000);

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

  it('groups Token usage by each event local day instead of session last activity', async () => {
    const manager = await createManager();
    const localNoonDaysAgo = (days: number): number => {
      const value = new Date();
      value.setHours(12, 0, 0, 0);
      value.setDate(value.getDate() - days);
      return value.getTime();
    };
    const firstDay = localNoonDaysAgo(5);
    const secondDay = localNoonDaysAgo(3);
    const lastActivityDay = localNoonDaysAgo(0);
    manager.upsertWorkSession(session({
      startedAt: firstDay,
      lastActivityAt: lastActivityDay,
      updatedAt: lastActivityDay,
      // Simulate one logical conversation whose physical rollouts together
      // report more than the legacy per-session MAX counter.
      totalInputTokens: 800,
      totalOutputTokens: 80,
    }));

    const firstEvent: TokenUsageEvent = {
      id: 'codex:active-session:usage:first',
      sessionId: 'codex:active-session',
      dedupeKey: 'transition:first',
      sourceScope: 'codex:native:C:/sessions/active.jsonl',
      timestamp: firstDay,
      inputTokens: 300,
      outputTokens: 30,
      cacheCreationTokens: 0,
      cacheReadTokens: 200,
      reasoningTokens: 0,
      model: 'gpt-test',
      source: 'codex:token_count',
    };
    const secondEvent: TokenUsageEvent = {
        ...firstEvent,
        id: 'codex:active-session:usage:second',
        dedupeKey: 'transition:second',
        timestamp: secondDay,
        inputTokens: 700,
        outputTokens: 70,
        cacheReadTokens: 600,
      };
    manager.replaceTokenUsageEvents(firstEvent.sourceScope, [
      firstEvent,
      secondEvent,
    ]);

    // Replaying the same stable event id updates it; it must not add a third
    // copy to the daily total.
    manager.replaceTokenUsageEvents(firstEvent.sourceScope, [
      { ...firstEvent, inputTokens: 310, outputTokens: 31 },
      secondEvent,
    ]);

    const stats = manager.getStats();
    const usageByDate = Object.fromEntries(stats.dailyTokenUsage.map(row => [row.date, row]));
    const localDate = (timestamp: number): string => {
      const value = new Date(timestamp);
      return [
        value.getFullYear(),
        String(value.getMonth() + 1).padStart(2, '0'),
        String(value.getDate()).padStart(2, '0'),
      ].join('-');
    };
    const firstDate = localDate(firstDay);
    const secondDate = localDate(secondDay);
    const lastActivityDate = localDate(lastActivityDay);
    expect(usageByDate[firstDate]).toMatchObject({ inputTokens: 310, outputTokens: 31 });
    expect(usageByDate[secondDate]).toMatchObject({ inputTokens: 700, outputTokens: 70 });
    expect(usageByDate[lastActivityDate]).toBeUndefined();

    // The all-time/platform totals use the larger of the legacy cumulative
    // session value and the event sum, avoiding both rollout loss and a dip
    // while an upgrade is still backfilling historical events.
    expect(stats.totalInputTokens).toBe(1_010);
    expect(stats.totalOutputTokens).toBe(101);
    expect(stats.platformTokenBreakdown.codex).toMatchObject({
      inputTokens: 1_010,
      outputTokens: 101,
    });
    expect(stats.modelTokenBreakdown['gpt-test']).toMatchObject({
      inputTokens: 1_010,
      outputTokens: 101,
    });
    expect(Object.values(stats.modelTokenBreakdown).reduce(
      (sum, row) => sum + row.inputTokens,
      0,
    )).toBe(stats.totalInputTokens);
    expect(Object.values(stats.modelTokenBreakdown).reduce(
      (sum, row) => sum + row.outputTokens,
      0,
    )).toBe(stats.totalOutputTokens);

    await manager.close();
  });

  it('atomically removes stale events and repairs inflated Codex session totals', async () => {
    const manager = await createManager();
    // Reproduces the pre-v11 state where replayed spawned-thread counters had
    // already been persisted into the session summary. Corrected event
    // replacement must be allowed to lower this derived value.
    manager.upsertWorkSession(session({ totalInputTokens: 9_999, totalOutputTokens: 999 }));
    const scope = 'codex:native:C:/sessions/rewrite.jsonl';
    const event = (id: string, inputTokens: number): TokenUsageEvent => ({
      id,
      sessionId: 'codex:active-session',
      dedupeKey: id,
      sourceScope: scope,
      timestamp: Date.now(),
      inputTokens,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      source: 'test',
    });

    manager.replaceTokenUsageEvents(scope, [event('old-a', 10), event('old-b', 20)]);
    let stats = manager.getStats();
    expect(stats.totalInputTokens).toBe(30);
    expect(stats.totalOutputTokens).toBe(2);

    manager.replaceTokenUsageEvents(scope, [event('new-a', 7)]);
    stats = manager.getStats();
    expect(stats.totalInputTokens).toBe(7);
    expect(stats.totalOutputTokens).toBe(1);

    manager.replaceTokenUsageEvents(scope, []);
    stats = manager.getStats();
    expect(stats.totalInputTokens).toBe(0);
    expect(stats.dailyTokenUsage).toEqual([]);
    await manager.close();
  });

  it('returns token time-series events only from the latest 30 local calendar days', async () => {
    const manager = await createManager();
    manager.upsertWorkSession(session({ totalInputTokens: 0, totalOutputTokens: 0 }));
    const scope = 'codex:native:C:/sessions/window.jsonl';
    const localNoonDaysAgo = (days: number): number => {
      const value = new Date();
      value.setHours(12, 0, 0, 0);
      value.setDate(value.getDate() - days);
      return value.getTime();
    };
    const base: TokenUsageEvent = {
      id: 'recent', sessionId: 'codex:active-session', dedupeKey: 'recent', sourceScope: scope,
      timestamp: localNoonDaysAgo(29), inputTokens: 3, outputTokens: 1,
      cacheCreationTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, source: 'test',
    };
    manager.replaceTokenUsageEvents(scope, [
      base,
      { ...base, id: 'old', dedupeKey: 'old', timestamp: localNoonDaysAgo(30), inputTokens: 99 },
    ]);
    expect(manager.getStats().dailyTokenUsage).toHaveLength(1);
    expect(manager.getStats().dailyTokenUsage[0]).toMatchObject({ inputTokens: 3 });
    await manager.close();
  });

  it('deduplicates replayed Codex fork transitions and keeps their earliest real day', async () => {
    const manager = await createManager();
    manager.upsertWorkSession(session({ totalInputTokens: 0, totalOutputTokens: 0 }));
    const localNoonDaysAgo = (days: number): number => {
      const value = new Date();
      value.setHours(12, 0, 0, 0);
      value.setDate(value.getDate() - days);
      return value.getTime();
    };
    const mainScope = 'codex:native:C:/sessions/main.jsonl';
    const forkScope = 'codex:native:C:/sessions/fork.jsonl';
    const makeEvent = (
      id: string,
      dedupeKey: string,
      sourceScope: string,
      timestamp: number,
      inputTokens: number,
    ): TokenUsageEvent => ({
      id,
      dedupeKey,
      sourceScope,
      sessionId: 'codex:active-session',
      timestamp,
      inputTokens,
      outputTokens: 1,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      source: 'codex:token_count',
    });

    manager.replaceTokenUsageEvents(mainScope, [
      makeEvent('main-shared', 'transition:shared', mainScope, localNoonDaysAgo(5), 100),
      makeEvent('main-tail', 'transition:main-tail', mainScope, localNoonDaysAgo(3), 50),
    ]);
    manager.replaceTokenUsageEvents(forkScope, [
      // A fork replays the shared transition later. It must not move or add it.
      makeEvent('fork-shared', 'transition:shared', forkScope, localNoonDaysAgo(1), 100),
      makeEvent('fork-tail', 'transition:fork-tail', forkScope, localNoonDaysAgo(1), 70),
    ]);

    const stats = manager.getStats();
    expect(stats.totalInputTokens).toBe(220);
    expect(stats.totalOutputTokens).toBe(3);
    const byDate = Object.fromEntries(stats.dailyTokenUsage.map(row => [row.date, row]));
    const localDate = (timestamp: number): string => {
      const value = new Date(timestamp);
      return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
    };
    expect(byDate[localDate(localNoonDaysAgo(5))]).toMatchObject({ inputTokens: 100, outputTokens: 1 });
    expect(byDate[localDate(localNoonDaysAgo(3))]).toMatchObject({ inputTokens: 50, outputTokens: 1 });
    expect(byDate[localDate(localNoonDaysAgo(1))]).toMatchObject({ inputTokens: 70, outputTokens: 1 });

    await manager.close();
  });

  it('does not pull an old shared transition into the 30-day chart when a fork replays it today', async () => {
    const manager = await createManager();
    manager.upsertWorkSession(session({ totalInputTokens: 0, totalOutputTokens: 0 }));
    const atLocalNoon = (daysAgo: number): number => {
      const value = new Date();
      value.setHours(12, 0, 0, 0);
      value.setDate(value.getDate() - daysAgo);
      return value.getTime();
    };
    const base: TokenUsageEvent = {
      id: 'old-original',
      sessionId: 'codex:active-session',
      dedupeKey: 'shared-old-transition',
      sourceScope: 'codex:native:C:/sessions/old.jsonl',
      timestamp: atLocalNoon(40),
      inputTokens: 100,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      source: 'codex:token_count',
    };
    manager.replaceTokenUsageEvents(base.sourceScope, [base]);
    const replayScope = 'codex:native:C:/sessions/replay.jsonl';
    manager.replaceTokenUsageEvents(replayScope, [{
      ...base,
      id: 'recent-replay',
      sourceScope: replayScope,
      timestamp: atLocalNoon(0),
    }]);

    const stats = manager.getStats();
    expect(stats.totalInputTokens).toBe(100);
    expect(stats.dailyTokenUsage).toEqual([]);
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

  it('counts only main sessions as conversations but keeps full token sums', async () => {
    const manager = await createManager();
    await seedParentAndChild(manager);

    const stats = manager.getStats();
    expect(stats.totalConversations).toBe(1);
    expect(stats.totalInputTokens).toBe(150);
    expect(stats.totalOutputTokens).toBe(15);
    expect(stats.platformBreakdown.codex).toBe(1);
    expect(stats.platformTokenBreakdown.codex).toMatchObject({
      conversations: 1,
      inputTokens: 150,
      outputTokens: 15,
    });

    await manager.close();
  });

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
