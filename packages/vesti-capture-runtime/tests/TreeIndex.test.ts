/**
 * TreeIndex Tests
 * Builds the 来源(platform+host) → 项目 → 会话 hierarchy from a database with
 * multiple platforms, hosts and projects, with and without digest rows.
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { deriveProjectKey } from '../src/storage/projectRegistry.js';
import type { WorkSession } from '../src/types/unified.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

function makeSession(overrides: Partial<WorkSession>): WorkSession {
  return {
    id: 'codex:s1',
    sessionId: 's1',
    platform: 'codex',
    projectPath: 'C:\\work\\alpha',
    title: 'Session',
    tags: [],
    status: 'active',
    sessionType: 'conversation',
    startedAt: 1000,
    lastActivityAt: 2000,
    durationMs: 0,
    messageCount: 5,
    userInputCount: 2,
    assistantMessageCount: 3,
    thinkingCount: 0,
    toolCallCount: 0,
    codeBlockCount: 0,
    turnCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    hasSubagents: false,
    hasContextCompaction: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

async function withManager<T>(fn: (manager: DatabaseManager) => T | Promise<T>): Promise<T> {
  const dir = await makeTempDir('vesti-tree-');
  const manager = new DatabaseManager(path.join(dir, 'vesti.db'));
  await manager.initialize();
  try {
    return await fn(manager);
  } finally {
    await manager.close();
  }
}

describe('buildConversationTree', () => {
  it('groups sessions by platform+host, then project, with digest fields', async () => {
    await withManager(async manager => {
      // codex / native / alpha (with digest)
      manager.upsertWorkSession(makeSession({}));
      manager.upsertSessionDigest({
        sessionId: 'codex:s1',
        host: 'native',
        platform: 'codex',
        projectKey: deriveProjectKey({ platform: 'codex', host: 'native', projectPath: 'C:\\work\\alpha' }),
        oneLiner: '实现登录页',
        keyTopics: ['认证', 'UI'],
        keyFiles: ['src/Login.tsx'],
        decisions: ['用 JWT'],
        openQuestions: [],
        embedding: null,
        embeddingStatus: 'skipped',
        digestVersion: 1,
        messageCount: 5,
        updatedAt: new Date(2000).toISOString(),
      });
      // codex / native / beta (no digest)
      manager.upsertWorkSession(makeSession({
        id: 'codex:s2',
        sessionId: 's2',
        projectPath: 'C:\\work\\beta',
        title: 'Beta session',
        lastActivityAt: 3000,
      }));
      // claude-code / wsl:Ubuntu / alpha-path (same path, different platform+host)
      manager.upsertWorkSession(makeSession({
        id: 'claude-code:wsl-Ubuntu-s3',
        sessionId: 'wsl-Ubuntu-s3',
        platform: 'claude-code',
        host: 'wsl:Ubuntu',
        title: 'WSL session',
        lastActivityAt: 1500,
      }));

      const tree = manager.buildConversationTree();
      expect(tree.generatedAt).toBeTruthy();
      expect(tree.sources).toHaveLength(2);

      const codexNative = tree.sources.find(
        source => source.platform === 'codex' && source.host === 'native',
      );
      expect(codexNative).toBeDefined();
      expect(codexNative!.projects).toHaveLength(2);

      const alpha = codexNative!.projects.find(project => project.label === 'alpha');
      const beta = codexNative!.projects.find(project => project.label === 'beta');
      expect(alpha?.pathOrDomain).toBe('c:/work/alpha');
      expect(beta?.sessions.map(session => session.id)).toEqual(['codex:s2']);

      expect(alpha?.sessions).toHaveLength(1);
      const digested = alpha!.sessions[0];
      expect(digested.oneLiner).toBe('实现登录页');
      expect(digested.keyTopics).toEqual(['认证', 'UI']);
      expect(digested.keyFiles).toEqual(['src/Login.tsx']);
      expect(digested.decisions).toEqual(['用 JWT']);
      expect(digested.messageCount).toBe(5);

      const undigested = beta!.sessions[0];
      expect(undigested.oneLiner).toBeNull();
      expect(undigested.keyTopics).toEqual([]);

      const wslSource = tree.sources.find(
        source => source.platform === 'claude-code' && source.host === 'wsl:Ubuntu',
      );
      expect(wslSource?.projects).toHaveLength(1);
      expect(wslSource?.projects[0].sessions[0].title).toBe('WSL session');
      // Same path but different platform+host → different project key.
      expect(wslSource!.projects[0].projectKey).not.toBe(alpha!.projectKey);
    });
  });

  it('orders sessions by last activity, newest first', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession({ id: 'codex:old', sessionId: 'old', lastActivityAt: 1000 }));
      manager.upsertWorkSession(makeSession({ id: 'codex:new', sessionId: 'new', lastActivityAt: 9000 }));

      const tree = manager.buildConversationTree();
      expect(tree.sources[0].projects[0].sessions.map(session => session.id))
        .toEqual(['codex:new', 'codex:old']);
    });
  });

  it('returns an empty source list for an empty database', async () => {
    await withManager(async manager => {
      expect(manager.buildConversationTree().sources).toEqual([]);
    });
  });
});

describe('buildConversationTree — subagent folding (A1)', () => {
  it('mounts subagent sessions under their parent with aggregate counts', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession({ id: 'codex:parent', sessionId: 'parent', messageCount: 10 }));
      manager.upsertWorkSession(makeSession({
        id: 'codex:child',
        sessionId: 'child',
        title: 'Explore agent',
        messageCount: 4,
        lastActivityAt: 2500,
      }));
      manager.upsertWorkSession(makeSession({
        id: 'codex:grandchild',
        sessionId: 'grandchild',
        title: 'Nested agent',
        messageCount: 3,
        lastActivityAt: 2600,
      }));
      manager.insertSubagentLink({
        id: 'link1',
        parentSessionId: 'codex:parent',
        childSessionId: 'codex:child',
        agentId: 'a1',
        agentRole: 'generalPurpose',
        filePath: 'C:\\work\\alpha\\child.jsonl',
        messageCount: 4,
      });
      // Nested: the child is itself a parent of another subagent.
      manager.insertSubagentLink({
        id: 'link2',
        parentSessionId: 'codex:child',
        childSessionId: 'codex:grandchild',
        agentId: 'a2',
        filePath: 'C:\\work\\alpha\\grandchild.jsonl',
        messageCount: 3,
      });

      const tree = manager.buildConversationTree();
      const project = tree.sources[0].projects[0];
      // Only the main session is listed at the project level.
      expect(project.sessions.map(session => session.id)).toEqual(['codex:parent']);

      const parent = project.sessions[0];
      expect(parent.role).toBe('main');
      expect(parent.childCount).toBe(1);
      // 4 (child) + 3 (grandchild), own 10 excluded.
      expect(parent.descendantMessageCount).toBe(7);

      const child = parent.children?.[0];
      expect(child?.id).toBe('codex:child');
      expect(child?.role).toBe('subagent');
      expect(child?.parentSessionId).toBe('codex:parent');
      // Display label from the link's agent_role (falls back to slug).
      expect(child?.subagentRole).toBe('generalPurpose');
      expect(child?.childCount).toBe(1);
      expect(child?.descendantMessageCount).toBe(3);
      expect(child?.children?.[0].id).toBe('codex:grandchild');
      // No role recorded on the nested link — the field stays absent.
      expect(child?.children?.[0].subagentRole).toBeUndefined();
    });
  });

  it('degrades subagents that cannot mount to orphan mains', async () => {
    await withManager(async manager => {
      // Parent lives in a different project — cross-project mounting is not
      // allowed, so the child falls back to a standalone main node.
      manager.upsertWorkSession(makeSession({ id: 'codex:parent', sessionId: 'parent' }));
      manager.upsertWorkSession(makeSession({
        id: 'codex:lone',
        sessionId: 'lone',
        projectPath: 'C:\\work\\beta',
      }));
      manager.insertSubagentLink({
        id: 'link-orphan',
        parentSessionId: 'codex:parent',
        childSessionId: 'codex:lone',
        agentId: 'a1',
        filePath: 'C:\\work\\beta\\lone.jsonl',
        messageCount: 5,
      });
      // A link cycle (a→b, b→a) must not recurse; both degrade to mains.
      manager.upsertWorkSession(makeSession({ id: 'codex:cycleA', sessionId: 'cycleA' }));
      manager.upsertWorkSession(makeSession({ id: 'codex:cycleB', sessionId: 'cycleB' }));
      manager.insertSubagentLink({
        id: 'link-cycle-ab',
        parentSessionId: 'codex:cycleA',
        childSessionId: 'codex:cycleB',
        agentId: 'a2',
        filePath: 'C:\\work\\alpha\\b.jsonl',
        messageCount: 1,
      });
      manager.insertSubagentLink({
        id: 'link-cycle-ba',
        parentSessionId: 'codex:cycleB',
        childSessionId: 'codex:cycleA',
        agentId: 'a3',
        filePath: 'C:\\work\\alpha\\a.jsonl',
        messageCount: 1,
      });

      const tree = manager.buildConversationTree();
      const codex = tree.sources[0];
      const alpha = codex.projects.find(project => project.pathOrDomain === 'c:/work/alpha');
      const beta = codex.projects.find(project => project.pathOrDomain === 'c:/work/beta');

      // alpha: the parent stays a main without children; the cycle pair both
      // degrade to orphan mains (neither mounts under the other).
      expect(alpha?.sessions.map(session => session.id).sort()).toEqual([
        'codex:cycleA',
        'codex:cycleB',
        'codex:parent',
      ]);
      const parent = alpha!.sessions.find(session => session.id === 'codex:parent');
      expect(parent?.role).toBe('main');
      expect(parent?.childCount).toBe(0);
      for (const id of ['codex:cycleA', 'codex:cycleB']) {
        const node = alpha!.sessions.find(session => session.id === id);
        expect(node?.role).toBe('main');
        expect(node?.orphan).toBe(true);
      }

      // beta: the cross-project child is an orphan main in its own project.
      expect(beta?.sessions).toHaveLength(1);
      const orphan = beta!.sessions[0];
      expect(orphan.id).toBe('codex:lone');
      expect(orphan.role).toBe('main');
      expect(orphan.orphan).toBe(true);
    });
  });

  it('keeps links unresolved (child_session_id NULL) out of the fold', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession({ id: 'codex:parent', sessionId: 'parent' }));
      manager.insertSubagentLink({
        id: 'link-unresolved',
        parentSessionId: 'codex:parent',
        agentId: 'a1',
        filePath: 'C:\\work\\alpha\\pending.jsonl',
        messageCount: 0,
      });

      const tree = manager.buildConversationTree();
      const parent = tree.sources[0].projects[0].sessions[0];
      expect(parent.role).toBe('main');
      expect(parent.childCount).toBe(0);
      expect(parent.children).toBeUndefined();
    });
  });
});
