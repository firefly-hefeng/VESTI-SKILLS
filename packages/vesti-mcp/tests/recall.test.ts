/**
 * Recall parity tests: tokenizer detection (trigram vs legacy unicode61),
 * recency decay, and the confidence abstention signal — the features synced
 * from capture-core's SessionRecall (schema v5).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openVestiDb, type VestiDatabase } from '../src/db.js';
import Database from 'better-sqlite3';
import {
  buildQueryPlan,
  confidenceForCoverage,
  detectFtsTokenizer,
  effectiveTokens,
  recallSessions,
  recencyFactor,
  RECENCY_TAU_DAYS,
} from '../src/recall.js';
import { vestiSearch } from '../src/tools.js';
import { createFixtureDb, SESSION_A, type Fixture } from './helpers/fixture.js';

const DAY_MS = 24 * 3600 * 1000;

let fixture: Fixture;
let db: VestiDatabase;

beforeEach(() => {
  fixture = createFixtureDb();
  db = openVestiDb(fixture.dbPath);
});

afterEach(() => {
  db.close();
  fixture.cleanup();
});

/** Minimal schema-v5 db: trigram FTS + two sessions, one old one new. */
function createTrigramDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesti-mcp-trigram-'));
  const dbPath = path.join(dir, 'vesti.db');
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE work_sessions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, platform TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Untitled', summary TEXT,
      host TEXT NOT NULL DEFAULT 'native', project_path TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL, ended_at INTEGER, last_activity_at INTEGER NOT NULL,
      message_count INTEGER DEFAULT 0, turn_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content_text TEXT, timestamp INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE session_digests (
      session_id TEXT PRIMARY KEY, host TEXT, platform TEXT, one_liner TEXT,
      key_topics TEXT, embedding_status TEXT NOT NULL DEFAULT 'none', updated_at TEXT
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content_text, content='messages', content_rowid='rowid', tokenize='trigram'
    );
    CREATE VIRTUAL TABLE sessions_fts USING fts5(
      title, summary, content='work_sessions', content_rowid='rowid', tokenize='trigram'
    );
  `);
  const now = Date.UTC(2026, 6, 19);
  const insertSession = raw.prepare(
    `INSERT INTO work_sessions (id, session_id, platform, title, started_at, last_activity_at, created_at, updated_at)
     VALUES (?, ?, 'kimi-code', ?, ?, ?, ?, ?)`,
  );
  insertSession.run('ws-old', 'ws-old', '旧值会话', now - 40 * DAY_MS, now - 40 * DAY_MS, now - 40 * DAY_MS, now - 40 * DAY_MS);
  insertSession.run('ws-new', 'ws-new', '新值会话', now - 3 * DAY_MS, now - 3 * DAY_MS, now - 3 * DAY_MS, now - 3 * DAY_MS);
  insertSession.run('ws-tight', 'ws-tight', '连写会话', now - 5 * DAY_MS, now - 5 * DAY_MS, now - 5 * DAY_MS, now - 5 * DAY_MS);
  const insertScopedSession = raw.prepare(
    `INSERT INTO work_sessions (id, session_id, platform, title, project_path, started_at, last_activity_at, created_at, updated_at)
     VALUES (?, ?, 'codex', ?, ?, ?, ?, ?, ?)`,
  );
  insertScopedSession.run('ws-short-target', 'ws-short-target', '目标实现', 'C:/bench/vesti-skills', now - 4 * DAY_MS, now - 4 * DAY_MS, now - 4 * DAY_MS, now - 4 * DAY_MS);
  insertScopedSession.run('ws-short-capture', 'ws-short-capture', '采集看板', 'C:/bench/vesti-app', now - DAY_MS, now - DAY_MS, now - DAY_MS, now - DAY_MS);
  insertScopedSession.run('ws-short-delta', 'ws-short-delta', '增量看板', 'C:/bench/vesti-app', now - 2 * DAY_MS, now - 2 * DAY_MS, now - 2 * DAY_MS, now - 2 * DAY_MS);
  insertScopedSession.run('ws-message-flood', 'ws-message-flood', '长会话', 'C:/bench/vesti-app', now - DAY_MS, now - DAY_MS, now - DAY_MS, now - DAY_MS);
  insertScopedSession.run('ws-rare-session', 'ws-rare-session', '独立会话', 'C:/bench/vesti-app', now - 2 * DAY_MS, now - 2 * DAY_MS, now - 2 * DAY_MS, now - 2 * DAY_MS);
  const insertMessage = raw.prepare(
    `INSERT INTO messages (id, session_id, role, content_text, timestamp, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)`,
  );
  insertMessage.run('m-old', 'ws-old', '把 config.yaml 的 timeout 从默认值改成了 30s，先跑着看看。', now - 40 * DAY_MS, now - 40 * DAY_MS);
  insertMessage.run('m-new', 'ws-new', '决定把 config.yaml 的 timeout 最终定为 60s，压测大量超时。', now - 3 * DAY_MS, now - 3 * DAY_MS);
  // CJK 连写 (no spaces): the unicode61 baseline failure mode.
  insertMessage.run('m-tight', 'ws-tight', '关于前端状态管理库，团队最终决定用Zustand了，后续不再讨论。', now - 5 * DAY_MS, now - 5 * DAY_MS);
  insertMessage.run('m-short-target', 'ws-short-target', '采集流程针对增量完成校验，并补齐失败防护。', now - 4 * DAY_MS, now - 4 * DAY_MS);
  insertMessage.run('m-short-capture', 'ws-short-capture', '采集页面只调整了视觉颜色。', now - DAY_MS, now - DAY_MS);
  insertMessage.run('m-short-delta', 'ws-short-delta', '增量统计图只修改了坐标轴。', now - 2 * DAY_MS, now - 2 * DAY_MS);
  for (let index = 0; index < 80; index += 1) {
    insertMessage.run(
      `m-flood-${index}`,
      'ws-message-flood',
      `needlephrase repeated message ${index}`,
      now - DAY_MS + index,
      now - DAY_MS + index,
    );
  }
  insertMessage.run('m-rare-session', 'ws-rare-session', 'needlephrase independent result', now - 2 * DAY_MS, now - 2 * DAY_MS);
  raw.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
  raw.exec(`INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild')`);
  raw.close();
  return { dbPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('tokenizer detection', () => {
  it('detects unicode61 on the legacy fixture', () => {
    expect(detectFtsTokenizer(db)).toBe('unicode61');
  });

  it('detects trigram on a schema-v5 database', () => {
    const tri = createTrigramDb();
    const triDb = openVestiDb(tri.dbPath);
    try {
      expect(detectFtsTokenizer(triDb)).toBe('trigram');
    } finally {
      triDb.close();
      tri.cleanup();
    }
  });
});

describe('recencyFactor / effectiveTokens / confidenceForCoverage', () => {
  const NOW = Date.UTC(2026, 6, 19);

  it('recency math: 1 at age 0, 0.9+0.1/e at tau, floor 0.9, future clamped', () => {
    expect(recencyFactor(NOW, NOW)).toBe(1);
    expect(recencyFactor(NOW + DAY_MS, NOW)).toBe(1);
    expect(recencyFactor(NOW - RECENCY_TAU_DAYS * DAY_MS, NOW)).toBeCloseTo(0.9 + 0.1 / Math.E, 6);
    expect(recencyFactor(0, NOW)).toBeGreaterThanOrEqual(0.9);
  });

  it('effectiveTokens drops <3-char tokens only under trigram', () => {
    expect(effectiveTokens('生产环境 redis 的 maxmemory', 'trigram'))
      .toEqual(['生产环境', 'redis', 'maxmemory']);
    expect(effectiveTokens('生产环境 redis 的 maxmemory', 'unicode61'))
      .toEqual(['生产环境', 'redis', '的', 'maxmemory']);
  });

  it('confidence thresholds', () => {
    expect(confidenceForCoverage(0, 0)).toBe('low');
    expect(confidenceForCoverage(0.49, 3)).toBe('low');
    expect(confidenceForCoverage(0.5, 2)).toBe('high');
  });
});

describe('recallSessions on a legacy (unicode61) database', () => {
  it('still recalls with the same quoted-OR query syntax and adds confidence', () => {
    const hits = recallSessions(db, 'transactional migrations', { topK: 5 });
    expect(hits.map(hit => hit.sessionId)).toContain(SESSION_A);
    expect(hits[0].confidence).toBe('high');
  });

  it('applies recency decay using work_sessions.last_activity_at', () => {
    // SESSION_B is one day newer than SESSION_A; both titles contain words
    // that match this crafted query only through messages/title tokens.
    const hits = recallSessions(db, 'deploy the blog', { topK: 5, now: Date.UTC(2026, 0, 12) });
    expect(hits[0].sessionId).toBe('ws-bbb-002');
  });
});

describe('recallSessions on a trigram database', () => {
  let tri: ReturnType<typeof createTrigramDb>;
  let triDb: VestiDatabase;

  beforeEach(() => {
    tri = createTrigramDb();
    triDb = openVestiDb(tri.dbPath);
  });

  afterEach(() => {
    triDb.close();
    tri.cleanup();
  });

  it('recalls tight-CJK statements from spaced queries with high confidence', () => {
    const hits = recallSessions(triDb, '前端状态管理库 最终选了什么方案？', { topK: 5 });
    expect(hits.map(hit => hit.sessionId)).toContain('ws-tight');
    expect(hits.find(hit => hit.sessionId === 'ws-tight')?.confidence).toBe('high');
  });

  it('plans two-character terms as independent LIKE fallbacks, not a literal merged phrase', () => {
    const plan = buildQueryPlan('采集 增量 防护在哪个文件', 'trigram');
    expect(plan.shortFallbackTokens).toEqual(['采集', '增量', '防护']);
    expect(plan.ftsQuery).not.toContain('采集 增量');
    expect(plan.matchUnits).toEqual(expect.arrayContaining(['采集', '增量']));
  });

  it('segments a natural unspaced Chinese question into conservative semantic fallbacks', () => {
    const plan = buildQueryPlan('采集增量防护在哪个文件', 'trigram');
    expect(plan.shortFallbackTokens).toEqual(['采集', '增量', '防护']);
    expect(plan.shortFallbackTokens).not.toEqual(expect.arrayContaining(['哪个', '文件']));

    const hits = recallSessions(triDb, '采集增量防护在哪个文件', { topK: 3 });
    expect(hits[0].sessionId).toBe('ws-short-target');
    expect(hits[0].confidence).toBe('high');
  });

  it('reconstructs two-character domain terms that ICU splits into single characters', () => {
    const retryPlan = buildQueryPlan('代理重试防护在哪个文件', 'trigram');
    expect(retryPlan.shortFallbackTokens).toEqual(expect.arrayContaining([
      '代理',
      '重试',
      '防护',
    ]));

    const pollingPlan = buildQueryPlan('采集轮询旧实现以前在哪里', 'trigram');
    expect(pollingPlan.shortFallbackTokens).toEqual(expect.arrayContaining([
      '采集',
      '轮询',
      '实现',
    ]));
  });

  it('fuses two-character fallback terms above one-term distractors and records trace', () => {
    let trace: import('../src/recall.js').RecallTrace | undefined;
    const hits = recallSessions(triDb, '采集 增量 防护在哪个文件', {
      topK: 5,
      onTrace: value => { trace = value; },
    });
    expect(hits[0].sessionId).toBe('ws-short-target');
    expect(hits.map(hit => hit.sessionId)).toEqual(expect.arrayContaining([
      'ws-short-capture',
      'ws-short-delta',
    ]));
    expect(trace?.shortFallbackTokens).toEqual(['采集', '增量', '防护']);
    expect(trace?.lists.map(list => list.source)).toEqual(expect.arrayContaining([
      'like-messages:采集',
      'like-messages:增量',
    ]));
  });

  it('recalls a pure two-character query and applies project scope before topK', () => {
    const hits = recallSessions(triDb, '采集 增量', {
      topK: 1,
      projectPaths: ['C:/bench/vesti-skills'],
    });
    expect(hits.map(hit => hit.sessionId)).toEqual(['ws-short-target']);
  });

  it('deduplicates a long session to its best message before applying the candidate limit', () => {
    let trace: import('../src/recall.js').RecallTrace | undefined;
    const hits = recallSessions(triDb, 'needlephrase', {
      topK: 2,
      candidateLimit: 2,
      onTrace: value => { trace = value; },
    });
    const messageList = trace?.lists.find(list => list.source === 'fts-messages');
    expect(messageList?.sessionIds).toHaveLength(2);
    expect(messageList?.sessionIds).toEqual(expect.arrayContaining([
      'ws-message-flood',
      'ws-rare-session',
    ]));
    expect(hits.map(hit => hit.sessionId)).toContain('ws-rare-session');
  });

  it('ranks the newer statement of a fact above the stale one', () => {
    const hits = recallSessions(triDb, 'config.yaml 的 timeout 最终定为多少？', {
      topK: 5,
      now: Date.UTC(2026, 6, 19),
    });
    expect(hits.map(hit => hit.sessionId)).toEqual(['ws-new', 'ws-old']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('vesti_search surfaces the confidence field', () => {
    const result = vestiSearch(triDb, { query: '前端状态管理库 最终选了什么方案？' });
    const hit = result.results.find(entry => entry.session_id === 'ws-tight');
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe('high');
  });
});
