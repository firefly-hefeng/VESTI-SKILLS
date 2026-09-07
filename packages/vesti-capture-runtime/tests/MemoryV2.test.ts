/**
 * Memory v2 integration tests against a real (temp-file) database.
 * Covers: fork lineage refresh (codex overlap), fork-deduped tree counts,
 * recall dedup, the L0 project_state generator (ranking / window / caps),
 * the deterministic file timeline and the title chain (session_title meta).
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { MessageConverter } from '../src/storage/MessageConverter.js';
import { deriveProjectKey } from '../src/storage/projectRegistry.js';
import { renderProjectStateMarkdown } from '../src/state/projectState.js';
import type { ParsedSession } from '../src/types/agent.js';
import type { SessionDigest, SessionMessage, UnifiedToolExecution, WorkSession } from '../src/types/unified.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

async function makeDb(): Promise<DatabaseManager> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-memv2-'));
  tempDirs.push(dir);
  const manager = new DatabaseManager(path.join(dir, 'vesti.db'));
  await manager.initialize();
  return manager;
}

let sessionSeq = 0;
function workSession(overrides: Partial<WorkSession> & { id: string }): WorkSession {
  sessionSeq += 1;
  return {
    sessionId: overrides.id,
    platform: 'codex',
    projectPath: 'C:/work/demo',
    title: overrides.id,
    tags: [],
    status: 'active',
    sessionType: 'conversation',
    startedAt: 1_000 + sessionSeq,
    lastActivityAt: 2_000 + sessionSeq,
    durationMs: 1_000,
    messageCount: 0,
    userInputCount: 0,
    assistantMessageCount: 0,
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
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function message(sessionId: string, id: string, text: string, timestamp = 1_500): SessionMessage {
  return {
    id,
    sessionId,
    source: 'user_input',
    sequence: 0,
    role: 'user',
    contentText: text,
    depth: 0,
    timestamp,
    createdAt: timestamp,
  };
}

function toolExec(sessionId: string, id: string, inputSummary: string, timestamp: number): UnifiedToolExecution {
  return {
    id,
    sessionId,
    sequence: 0,
    toolUseMessageId: `${id}-use`,
    toolUseId: id,
    toolName: 'Edit',
    toolCategory: 'file_edit',
    outcome: 'success',
    inputSummary,
    isError: false,
    timestamp,
  };
}

function digest(sessionId: string, projectKey: string, overrides: Partial<SessionDigest> = {}): SessionDigest {
  return {
    sessionId,
    host: 'native',
    platform: 'codex',
    projectKey,
    oneLiner: `digest of ${sessionId}`,
    keyTopics: [],
    keyFiles: [],
    decisions: [],
    openQuestions: [],
    embedding: null,
    embeddingStatus: 'none',
    digestVersion: 1,
    messageCount: 1,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const PROJECT_KEY = deriveProjectKey({ platform: 'codex', host: 'native', projectPath: 'C:/work/demo' });

describe('fork lineage refresh + tree dedup', () => {
  it('detects a codex fork by message overlap and dedups tree counts', async () => {
    const db = await makeDb();
    const parent = workSession({ id: 'codex:parent', sessionId: 'parent', startedAt: 1_000, lastActivityAt: 2_000 });
    const child = workSession({ id: 'codex:child', sessionId: 'child', startedAt: 3_000, lastActivityAt: 4_000 });
    db.upsertWorkSession(parent);
    db.upsertWorkSession(child);
    // The fork copies the parent's history verbatim (same response-item ids).
    const shared = ['a', 'b', 'c', 'd', 'e', 'f'];
    db.insertSessionMessages(shared.map(id => message('codex:parent', `codex-parent-message-${id}`, `shared ${id}`)));
    db.insertSessionMessages([
      ...shared.map(id => message('codex:child', `codex-child-message-${id}`, `shared ${id}`)),
      message('codex:child', 'codex-child-message-new', 'brand new work'),
    ]);

    expect(db.refreshForkLineage()).toBe(1);
    expect(db.getWorkSession('codex:child')?.forkedFrom).toBe('codex:parent');
    // Explicit lineage is sticky: a second refresh must not rewrite it.
    expect(db.refreshForkLineage()).toBe(0);

    const tree = db.buildConversationTree();
    const project = tree.sources.flatMap(s => s.projects).find(p => p.projectKey === PROJECT_KEY)!;
    const childNode = project.sessions.find(s => s.id === 'codex:child')!;
    const parentNode = project.sessions.find(s => s.id === 'codex:parent')!;
    expect(childNode.forkedFrom).toBe('codex:parent');
    expect(childNode.uniqueMessageCount).toBe(1);
    expect(childNode.duplicatedMessageCount).toBe(6);
    expect(parentNode.uniqueMessageCount).toBeUndefined();
    await db.close();
  });

  it('recall does not double-count a message copied into a fork', async () => {
    const db = await makeDb();
    db.upsertWorkSession(workSession({ id: 'codex:p', sessionId: 'p' }));
    db.upsertWorkSession(workSession({ id: 'codex:c', sessionId: 'c', forkedFrom: 'codex:p' }));
    const copied = 'zebraquark memorable phrase';
    db.insertSessionMessages([
      message('codex:p', 'codex-p-message-1', copied),
      message('codex:c', 'codex-c-message-1', copied),
      message('codex:c', 'codex-c-message-2', 'child-only falcon topic'),
    ]);

    const hits = db.recallSessions('zebraquark', { topK: 5 });
    // The copied message hits once — the fork enters the ranking only via its
    // own unique content.
    expect(hits.map(h => h.sessionId)).toEqual(['codex:p']);
    const childHits = db.recallSessions('falcon', { topK: 5 });
    expect(childHits.map(h => h.sessionId)).toEqual(['codex:c']);
    await db.close();
  });
});

describe('L0 project_state generator', () => {
  it('builds the card: newest one-liner, ranked active files, merged questions', async () => {
    const db = await makeDb();
    const now = new Date('2026-07-19T00:00:00.000Z');
    const dayMs = 24 * 60 * 60 * 1000;
    const nowMs = now.getTime();

    const s1 = workSession({ id: 'codex:s1', sessionId: 's1', lastActivityAt: nowMs - 2 * dayMs });
    const s2 = workSession({ id: 'codex:s2', sessionId: 's2', lastActivityAt: nowMs - dayMs });
    db.upsertWorkSession(s1);
    db.upsertWorkSession(s2);
    db.upsertSessionDigest(digest('codex:s1', PROJECT_KEY, {
      oneLiner: 'older one-liner',
      openQuestions: ['q-old', 'q-shared'],
      updatedAt: '2026-07-10T00:00:00.000Z',
    }));
    db.upsertSessionDigest(digest('codex:s2', PROJECT_KEY, {
      oneLiner: 'newest one-liner',
      openQuestions: ['q-shared', 'q-new'],
      updatedAt: '2026-07-18T00:00:00.000Z',
    }));

    db.insertUnifiedToolExecutions([
      // alpha: 3 touches (most frequent), beta: 2 but newest, gamma: 1.
      toolExec('codex:s1', 't1', 'Edit C:/work/demo/src/alpha.ts', nowMs - 5 * dayMs),
      toolExec('codex:s1', 't2', 'Edit C:/work/demo/src/alpha.ts again', nowMs - 4 * dayMs),
      toolExec('codex:s2', 't3', 'Read C:/work/demo/src/alpha.ts', nowMs - 3 * dayMs),
      toolExec('codex:s2', 't4', 'Edit C:/work/demo/src/beta.ts', nowMs - dayMs),
      toolExec('codex:s2', 't5', 'Edit C:/work/demo/src/beta.ts', nowMs - dayMs),
      toolExec('codex:s1', 't6', 'Edit C:/work/demo/src/gamma.ts', nowMs - 2 * dayMs),
      // Outside the 30-day window — must not appear.
      toolExec('codex:s1', 't7', 'Edit C:/work/demo/src/ancient.ts', nowMs - 45 * dayMs),
    ]);

    expect(db.rebuildProjectStates(now)).toBe(1);
    const state = db.getProjectState(PROJECT_KEY)!;
    expect(state.oneLiner).toBe('newest one-liner');
    expect(state.sessionCount).toBe(2);
    expect(state.lastActive).toBe(new Date(nowMs - dayMs).toISOString());
    expect(state.openQuestions).toEqual(['q-shared', 'q-new', 'q-old']);

    const paths = state.activeFiles.map(file => file.path);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe('C:/work/demo/src/alpha.ts');
    // beta and gamma tie on recency of last touch? beta has 2 touches > gamma 1.
    expect(paths[1]).toBe('C:/work/demo/src/beta.ts');
    expect(paths[2]).toBe('C:/work/demo/src/gamma.ts');
    expect(paths).not.toContain('C:/work/demo/src/ancient.ts');
    expect(state.activeFiles[0].touches).toBe(3);

    // The markdown fallback render mentions the headline fields.
    const markdown = renderProjectStateMarkdown(state, 'demo');
    expect(markdown).toContain('newest one-liner');
    expect(markdown).toContain('alpha.ts');
    expect(markdown).toContain('q-shared');
    await db.close();
  });

  it('caps active files at 10 and open questions at 8', async () => {
    const db = await makeDb();
    const now = new Date('2026-07-19T00:00:00.000Z');
    const session = workSession({ id: 'codex:busy', sessionId: 'busy', lastActivityAt: now.getTime() });
    db.upsertWorkSession(session);
    db.upsertSessionDigest(digest('codex:busy', PROJECT_KEY, {
      openQuestions: Array.from({ length: 12 }, (_, i) => `question-${i}`),
    }));
    db.insertUnifiedToolExecutions(
      Array.from({ length: 14 }, (_, i) =>
        toolExec('codex:busy', `f${i}`, `Edit C:/work/demo/src/file-${String(i).padStart(2, '0')}.ts`, now.getTime() - i * 1000)),
    );

    db.rebuildProjectStates(now);
    const state = db.getProjectState(PROJECT_KEY)!;
    expect(state.activeFiles).toHaveLength(10);
    expect(state.openQuestions).toHaveLength(8);
    await db.close();
  });
});

describe('file timeline', () => {
  it('lists every touch of one file across sessions, confirmed by extraction', async () => {
    const db = await makeDb();
    db.upsertWorkSession(workSession({ id: 'codex:a', sessionId: 'a', title: 'session A' }));
    db.upsertWorkSession(workSession({ id: 'codex:b', sessionId: 'b', title: 'session B' }));
    db.insertUnifiedToolExecutions([
      toolExec('codex:a', 'x1', 'Edit C:/work/demo/src/target.ts', 1_000),
      toolExec('codex:a', 'x2', 'Edit C:/work/demo/src/target.tsx (a look-alike)', 2_000),
      toolExec('codex:b', 'x3', 'Read C:/work/demo/src/target.ts', 3_000),
      toolExec('codex:b', 'x4', 'Edit C:/work/demo/src/other.ts', 4_000),
    ]);

    const events = db.getFileTimeline({ projectKey: PROJECT_KEY, filePath: 'src/target.ts' });
    expect(events.map(e => e.sessionId)).toEqual(['codex:a', 'codex:b']);
    expect(events[0].sessionTitle).toBe('session A');
    expect(events[1].toolName).toBe('Edit');
    await db.close();
  });
});

describe('title chain (memory v2)', () => {
  it('prefers session.meta.session_title over the first user message', () => {
    const parsed: ParsedSession = {
      sessionId: 's1',
      platform: 'kimi-code',
      projectPath: 'C:/work/demo',
      messages: [{
        uuid: 'm1',
        type: 'user',
        role: 'user',
        timestamp: 1_000,
        contentText: 'the raw first user message that is quite long',
        isToolResult: false,
        depth: 0,
      }],
      toolExecutions: [],
      subagents: [],
      tokenUsage: { totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0, models: new Set() },
      startTime: 1_000,
      meta: { session_title: '圆桌讨论：AI 行业趋势' },
    };
    const converted = MessageConverter.convertV2(parsed);
    expect(converted.session.title).toBe('圆桌讨论：AI 行业趋势');
  });

  it('maps meta.forked_from to a qualified work_sessions id', () => {
    const parsed: ParsedSession = {
      sessionId: 'child',
      platform: 'kimi-code',
      projectPath: 'C:/work/demo',
      messages: [{
        uuid: 'm1',
        type: 'user',
        role: 'user',
        timestamp: 1_000,
        contentText: 'forked session content here',
        isToolResult: false,
        depth: 0,
      }],
      toolExecutions: [],
      subagents: [],
      tokenUsage: { totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0, models: new Set() },
      startTime: 1_000,
      meta: { forked_from: 'parent' },
    };
    const converted = MessageConverter.convertV2(parsed);
    expect(converted.session.forkedFrom).toBe('kimi-code:parent');
  });
});
