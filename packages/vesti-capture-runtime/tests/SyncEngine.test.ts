/**
 * SyncEngine subagent-link resolution.
 *
 * Link rows are written when the parent session syncs; the child side only
 * resolves against sync_state. These tests cover the two paths every sync
 * route depends on:
 *   1. resolveSubagentLinks() resolves from sync_state after both files
 *      synced (the syncAll path);
 *   2. a transcript that exists on disk but was never synced is synced
 *      on demand inside resolveSubagentLinks(), so watch/poll routes that
 *      only saw the parent file still mount the subagent.
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterManager } from '../src/adapters/AdapterManager.js';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { SyncEngine } from '../src/sync/SyncEngine.js';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../src/types/agent.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

/** Minimal fixture adapter: each file is a JSON-serialized ParsedSession. */
class FixtureAdapter implements AgentAdapter {
  readonly platform = 'claude-code' as const;
  readonly name = 'Fixture';
  parserVersion = 0;
  parseCount = 0;
  constructor(private dir: string) {}
  async detect(): Promise<AgentDetectResult> {
    return { installed: true };
  }
  async parseSession(filePath: string): Promise<ParsedSession> {
    this.parseCount++;
    const raw = await fs.readJSON(filePath) as ParsedSession;
    raw.tokenUsage = { ...raw.tokenUsage, models: new Set() };
    return raw;
  }
  async getSessionFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.dir);
    return entries.filter(name => name.endsWith('.json')).map(name => path.join(this.dir, name));
  }
  getWatchPatterns(): string[] {
    return [];
  }
}

class CodexFixtureAdapter implements AgentAdapter {
  readonly platform = 'codex' as const;
  readonly name = 'Codex fixture';
  parserVersion = 0;
  parseCount = 0;
  constructor(private dir: string) {}
  async detect(): Promise<AgentDetectResult> { return { installed: true }; }
  async parseSession(filePath: string): Promise<ParsedSession> {
    this.parseCount++;
    const raw = await fs.readJSON(filePath) as ParsedSession;
    raw.platform = 'codex';
    raw.tokenUsage = { ...raw.tokenUsage, models: new Set() };
    return raw;
  }
  async getSessionFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.dir);
    return entries.filter(name => name.endsWith('.json')).map(name => path.join(this.dir, name));
  }
  getWatchPatterns(): string[] { return []; }
}

function fixtureSession(sessionId: string, overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId,
    platform: 'claude-code',
    projectPath: 'C:/work/demo',
    messages: [{
      uuid: `${sessionId}-m1`,
      type: 'user',
      role: 'user',
      timestamp: 1000,
      contentText: `hello from ${sessionId}`,
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
    startTime: 1000,
    endTime: 2000,
    ...overrides,
  };
}

async function setup() {
  const dir = await makeTempDir('vesti-syncengine-');
  const sessionsDir = path.join(dir, 'sessions');
  await fs.ensureDir(sessionsDir);
  const db = new DatabaseManager(path.join(dir, 'vesti.db'));
  await db.initialize();
  const adapters = new AdapterManager();
  const adapter = new FixtureAdapter(sessionsDir);
  adapters.register(adapter);
  const engine = new SyncEngine(adapters, db);
  return { sessionsDir, db, engine, adapter };
}

async function setupCodex() {
  const dir = await makeTempDir('vesti-syncengine-codex-');
  const sessionsDir = path.join(dir, 'sessions');
  await fs.ensureDir(sessionsDir);
  const db = new DatabaseManager(path.join(dir, 'vesti.db'));
  await db.initialize();
  const adapters = new AdapterManager();
  const adapter = new CodexFixtureAdapter(sessionsDir);
  adapters.register(adapter);
  const engine = new SyncEngine(adapters, db);
  return { sessionsDir, db, engine, adapter };
}

describe('SyncEngine.resolveSubagentLinks', () => {
  it('resolves links from sync_state once parent and child are synced', async () => {
    const { sessionsDir, db, engine } = await setup();
    const childPath = path.join(sessionsDir, 'child.json');
    await fs.writeJSON(childPath, fixtureSession('agent-a1'));
    const parentPath = path.join(sessionsDir, 'parent.json');
    await fs.writeJSON(
      parentPath,
      fixtureSession('parent-1', { subagents: [{ agentId: 'a1', filePath: childPath }] }),
    );

    // syncAll shape without touching the other adapters' real home dirs.
    await engine.syncPlatform('claude-code', [parentPath, childPath]);
    await engine.resolveSubagentLinks();

    const links = db.getSubagentLinks('claude-code:parent-1');
    expect(links).toHaveLength(1);
    expect(links[0].childSessionId).toBe('claude-code:agent-a1');
    expect(db.getUnresolvedSubagentLinks()).toHaveLength(0);
    await db.close();
  });

  it('syncs a never-synced transcript on demand and then resolves it', async () => {
    const { sessionsDir, db, engine } = await setup();
    const childPath = path.join(sessionsDir, 'child.json');
    await fs.writeJSON(childPath, fixtureSession('agent-a2'));
    const parentPath = path.join(sessionsDir, 'parent.json');
    await fs.writeJSON(
      parentPath,
      fixtureSession('parent-2', { subagents: [{ agentId: 'a2', filePath: childPath }] }),
    );

    // Watch-route shape: only the parent file event was seen.
    await engine.syncFile('claude-code', parentPath);
    expect(db.getUnresolvedSubagentLinks()).toHaveLength(1);
    expect(db.getWorkSession('claude-code:agent-a2')).toBeNull();

    const resolved = await engine.resolveSubagentLinks();

    expect(resolved).toBe(1);
    expect(db.getWorkSession('claude-code:agent-a2')).not.toBeNull();
    expect(db.getSubagentLinks('claude-code:parent-2')[0].childSessionId).toBe('claude-code:agent-a2');
    await db.close();
  });

  it('leaves links whose transcript is gone unresolved without failing', async () => {
    const { sessionsDir, db, engine } = await setup();
    const missingPath = path.join(sessionsDir, 'deleted-child.json');
    const parentPath = path.join(sessionsDir, 'parent.json');
    await fs.writeJSON(
      parentPath,
      fixtureSession('parent-3', { subagents: [{ agentId: 'a3', filePath: missingPath }] }),
    );

    await engine.syncPlatform('claude-code', [parentPath]);
    await engine.resolveSubagentLinks();

    expect(db.getUnresolvedSubagentLinks()).toHaveLength(1);
    await db.close();
  });
});

describe('SyncEngine parser-version re-parse', () => {
  it('re-parses an unchanged file after the adapter parserVersion bumps', async () => {
    const { sessionsDir, db, engine, adapter } = await setup();
    const filePath = path.join(sessionsDir, 'session.json');
    await fs.writeJSON(filePath, fixtureSession('reparse-1'));

    await engine.syncFile('claude-code', filePath);
    expect(adapter.parseCount).toBe(1);

    // Unchanged file + same parser: the size/mtime short-circuit holds.
    expect(await engine.syncFile('claude-code', filePath)).toBeNull();
    expect(adapter.parseCount).toBe(1);

    // Parser upgrade: the same bytes must be parsed again (new extraction),
    // and the stored version advances so it only happens once.
    adapter.parserVersion = 2;
    expect(await engine.syncFile('claude-code', filePath)).not.toBeNull();
    expect(adapter.parseCount).toBe(2);
    expect(db.getSyncState(filePath)?.parserVersion).toBe(2);
    expect(await engine.syncFile('claude-code', filePath)).toBeNull();
    expect(adapter.parseCount).toBe(2);
    await db.close();
  });

  it('replaces the stored snapshot and invalidates its digest on a parser upgrade', async () => {
    const { sessionsDir, db, engine, adapter } = await setup();
    const filePath = path.join(sessionsDir, 'snapshot.json');
    const parsed = fixtureSession('snapshot-1');
    await fs.writeJSON(filePath, parsed);
    const stat = await fs.stat(filePath);

    db.upsertWorkSession({
      id: 'claude-code:snapshot-1',
      sessionId: 'snapshot-1',
      platform: 'claude-code',
      projectPath: parsed.projectPath,
      title: '<recommended_plugins>polluted</recommended_plugins>',
      tags: [],
      status: 'active',
      sessionType: 'conversation',
      startedAt: 500,
      lastActivityAt: 2000,
      durationMs: 1500,
      messageCount: 2,
      userInputCount: 2,
      assistantMessageCount: 0,
      thinkingCount: 0,
      toolCallCount: 0,
      codeBlockCount: 0,
      turnCount: 2,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      hasSubagents: false,
      hasContextCompaction: false,
      createdAt: 500,
      updatedAt: 2000,
    });
    db.insertSessionMessages([
      {
        id: 'polluted-message',
        sessionId: 'claude-code:snapshot-1',
        source: 'user_input',
        sequence: 0,
        role: 'user',
        contentText: '<recommended_plugins>polluted</recommended_plugins>',
        depth: 0,
        timestamp: 500,
        createdAt: 500,
      },
    ]);
    db.upsertSessionDigest({
      sessionId: 'claude-code:snapshot-1',
      host: 'native',
      platform: 'claude-code',
      projectKey: 'path:c:/work/demo',
      oneLiner: 'polluted digest',
      keyTopics: [],
      keyFiles: [],
      decisions: [],
      openQuestions: [],
      embedding: Buffer.from(new Float32Array([0.25, 0.75]).buffer),
      embeddingProvider: 'fixture',
      embeddingModel: 'fixture-model',
      embeddingDimensions: 2,
      embeddingVersion: 'fixture-index-v1',
      embeddingStatus: 'ok',
      digestVersion: 1,
      messageCount: 2,
      updatedAt: '2026-08-18T00:00:00.000Z',
    });
    const revisionBeforeReplacement = db.getEmbeddingIndexState().revision;
    db.setSyncState(filePath, 'claude-code', stat.size, stat.mtimeMs, 'snapshot-1', 'claude-code:snapshot-1', 0);

    adapter.parserVersion = 1;
    await engine.syncFile('claude-code', filePath);

    expect(db.getSessionMessages('claude-code:snapshot-1').map(message => message.id)).toEqual(['snapshot-1-m1']);
    expect(db.getWorkSession('claude-code:snapshot-1')).toMatchObject({
      title: 'hello from snapshot-1',
      messageCount: 1,
      userInputCount: 1,
      turnCount: 1,
    });
    expect(db.getSessionDigest('claude-code:snapshot-1')).toBeNull();
    expect(db.listDigestEmbeddingSessionIds('fixture-index-v1')).not.toContain('claude-code:snapshot-1');
    expect(db.getEmbeddingIndexState().revision).toBe(revisionBeforeReplacement + 1);
    expect(db.getSyncState(filePath)?.parserVersion).toBe(1);
    await db.close();
  });

  it('replaces the root snapshot before appending child-rollout rows on an upgrade', async () => {
    const { sessionsDir, db, engine, adapter } = await setup();
    const rootPath = path.join(sessionsDir, '01-root.json');
    const childPath = path.join(sessionsDir, '02-child.json');
    await fs.writeJSON(rootPath, fixtureSession('shared-upgrade', {
      messages: [{
        uuid: 'root-message',
        type: 'user',
        role: 'user',
        timestamp: 1_000,
        contentText: 'root prompt',
        isToolResult: false,
        depth: 0,
      }],
    }));
    await fs.writeJSON(childPath, fixtureSession('shared-upgrade', {
      messages: [{
        uuid: 'child-message',
        type: 'assistant',
        role: 'assistant',
        timestamp: 1_100,
        contentText: 'child report',
        isToolResult: false,
        depth: 0,
      }],
      meta: { capture_append_only: true },
    }));

    await engine.syncPlatform('claude-code', [childPath, rootPath]);
    expect(db.getSessionMessages('claude-code:shared-upgrade').map(item => item.id).sort())
      .toEqual(['child-message', 'root-message']);

    adapter.parserVersion = 1;
    await engine.syncPlatform('claude-code', [childPath, rootPath]);

    expect(db.getSessionMessages('claude-code:shared-upgrade').map(item => item.id).sort())
      .toEqual(['child-message', 'root-message']);
    expect(db.getSyncState(rootPath)?.parserVersion).toBe(1);
    expect(db.getSyncState(childPath)?.parserVersion).toBe(1);
    await db.close();
  });

  it('atomically rebuilds one Codex logical session and maps child runs to parent tasks', async () => {
    const { sessionsDir, db, engine, adapter } = await setupCodex();
    const rootPath = path.join(sessionsDir, 'z-root.json');
    const childPath = path.join(sessionsDir, 'a-child.json');
    await fs.writeJSON(rootPath, fixtureSession('shared-codex', {
      platform: 'codex',
      messages: [
        {
          uuid: 'root-user', type: 'user', role: 'user', timestamp: 1_000,
          contentText: '主任务标题内容', sourceTurnId: 'parent-task', isToolResult: false, depth: 0,
        },
        {
          uuid: 'root-final', type: 'assistant', role: 'assistant', timestamp: 1_300,
          contentText: '主任务结论', sourceTurnId: 'parent-task', assistantPhase: 'final_answer',
          isToolResult: false, depth: 0,
        },
      ],
      meta: {
        codex_rollout_id: 'root-thread',
        capture_strict_native_turns: true,
        codex_child_activities: [{
          childThreadId: 'child-thread', parentSourceTurnId: 'parent-task', timestamp: 1_050, callId: 'spawn',
        }],
      },
    }));
    await fs.writeJSON(childPath, fixtureSession('shared-codex', {
      platform: 'codex',
      messages: [{
        uuid: 'child-final', type: 'assistant', role: 'assistant', timestamp: 1_200,
        contentText: '子代理结论', sourceTurnId: 'child-run', assistantPhase: 'final_answer',
        isToolResult: false, depth: 0,
      }],
      meta: {
        capture_append_only: true,
        capture_strict_native_turns: true,
        codex_rollout_id: 'child-thread',
        codex_child_task_runs: [{ sourceTurnId: 'child-run', timestamp: 1_100 }],
      },
    }));

    // Deliberately supply the child first: ordering must not affect replacement.
    await engine.syncPlatform('codex', [childPath, rootPath]);
    expect(db.getWorkSession('codex:shared-codex')).toMatchObject({
      title: '主任务标题内容', messageCount: 3, userInputCount: 1, assistantMessageCount: 2, turnCount: 1,
    });
    const messages = db.getSessionMessages('codex:shared-codex');
    expect(messages.map(message => message.id).sort()).toEqual(['child-final', 'root-final', 'root-user']);
    expect(new Set(messages.map(message => message.turnId)).size).toBe(1);

    // Mixed upgrade state: even when the changed child is already current,
    // its stale root sibling must force one complete logical-session rebuild.
    adapter.parserVersion = 1;
    const childStat = await fs.stat(childPath);
    db.setSyncState(childPath, 'codex', childStat.size, childStat.mtimeMs, 'shared-codex', 'codex:shared-codex', 1);
    expect(db.getSyncState(rootPath)?.parserVersion).toBe(0);
    await engine.syncFile('codex', childPath);

    expect(db.getSyncState(rootPath)?.parserVersion).toBe(1);
    expect(db.getSyncState(childPath)?.parserVersion).toBe(1);
    expect(db.getWorkSession('codex:shared-codex')).toMatchObject({
      title: '主任务标题内容', messageCount: 3, turnCount: 1,
    });
    await db.close();
  });

  it('isolates a failed Codex rollout and continues unrelated logical sessions', async () => {
    const { sessionsDir, db, engine, adapter } = await setupCodex();
    const healthyPath = path.join(sessionsDir, 'healthy.json');
    const blockedRootPath = path.join(sessionsDir, 'blocked-root.json');
    const brokenChildPath = path.join(sessionsDir, 'blocked-child.json');
    await fs.writeJSON(healthyPath, fixtureSession('healthy', { platform: 'codex' }));
    await fs.writeJSON(blockedRootPath, fixtureSession('blocked', { platform: 'codex' }));
    await fs.writeFile(brokenChildPath, '{ invalid fixture');
    const brokenStat = await fs.stat(brokenChildPath);
    db.setSyncState(
      brokenChildPath,
      'codex',
      brokenStat.size,
      brokenStat.mtimeMs,
      'blocked',
      'codex:blocked',
      0,
    );
    adapter.parserVersion = 1;

    const result = await engine.syncPlatform('codex', [healthyPath, blockedRootPath, brokenChildPath]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(brokenChildPath);
    expect(db.getWorkSession('codex:healthy')).not.toBeNull();
    expect(db.getSyncState(healthyPath)?.parserVersion).toBe(1);
    expect(db.getWorkSession('codex:blocked')).toBeNull();
    expect(db.getSyncState(blockedRootPath)).toBeNull();
    expect(db.getSyncState(brokenChildPath)?.parserVersion).toBe(0);
    await db.close();
  });

  it('retires a moved Codex checkpoint and syncs its archived rollout path', async () => {
    const { sessionsDir, db, engine } = await setupCodex();
    const activePath = path.join(sessionsDir, 'active.json');
    const archivedDir = path.join(sessionsDir, 'archived_sessions');
    const archivedPath = path.join(archivedDir, 'active.json');
    const session = fixtureSession('moved-codex', { platform: 'codex' });
    await fs.writeJSON(activePath, session);
    await engine.syncFile('codex', activePath);
    expect(db.getSyncState(activePath)).not.toBeNull();

    await fs.ensureDir(archivedDir);
    await fs.move(activePath, archivedPath);
    await fs.writeJSON(archivedPath, {
      ...session,
      messages: [
        ...session.messages,
        {
          uuid: 'archived-answer', type: 'assistant', role: 'assistant', timestamp: 1_100,
          contentText: 'archived answer', isToolResult: false, depth: 0,
        },
      ],
    });

    const result = await engine.syncPlatform('codex', [archivedPath]);

    expect(result.errors).toEqual([]);
    expect(db.getSyncState(activePath)).toBeNull();
    expect(db.getSyncState(archivedPath)).not.toBeNull();
    expect(db.getSessionMessages('codex:moved-codex').map(message => message.id).sort())
      .toEqual(['archived-answer', 'moved-codex-m1']);
    await db.close();
  });
});

describe('SyncEngine usage-only sessions', () => {
  it('records usage without overwriting the visible parent conversation', async () => {
    const { sessionsDir, db, engine } = await setup();
    const parentPath = path.join(sessionsDir, 'parent.json');
    await fs.writeJSON(parentPath, fixtureSession('shared-session'));
    await engine.syncFile('claude-code', parentPath);

    const guardianPath = path.join(sessionsDir, 'guardian.json');
    await fs.writeJSON(guardianPath, fixtureSession('shared-session', {
      messages: [{
        uuid: 'internal-history',
        type: 'user',
        role: 'user',
        timestamp: 1500,
        contentText: 'internal approval transcript',
        isToolResult: false,
        depth: 0,
      }],
      tokenUsageEvents: [{
        id: 'guardian-usage',
        timestamp: 1500,
        inputTokens: 25,
        outputTokens: 3,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        source: 'fixture:guardian',
      }],
      meta: { capture_usage_only: true },
    }));

    await engine.syncFile('claude-code', guardianPath);

    expect(db.getWorkSession('claude-code:shared-session')).toMatchObject({
      title: 'hello from shared-session',
      messageCount: 1,
    });
    expect(db.getSessionMessages('claude-code:shared-session').map(message => message.id))
      .toEqual(['shared-session-m1']);
    await db.close();
  });
});
