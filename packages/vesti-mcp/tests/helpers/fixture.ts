/**
 * Build a temporary vesti.db-shaped fixture: the same tables/triggers the
 * capture engine creates (subset relevant to the MCP tools), seeded with two
 * sessions so FTS recall has something to find.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

export interface Fixture {
  dbPath: string;
  cleanup: () => void;
}

const SCHEMA = `
CREATE TABLE work_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  project_path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT 'Untitled',
  summary TEXT,
  host TEXT NOT NULL DEFAULT 'native',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  turn_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  user_input TEXT,
  assistant_response TEXT,
  message_count INTEGER DEFAULT 0,
  tool_execution_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER DEFAULT 0
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  source TEXT NOT NULL DEFAULT 'assistant_text',
  sequence INTEGER DEFAULT 0,
  role TEXT NOT NULL,
  content_text TEXT,
  content_thinking TEXT,
  content_tool_name TEXT,
  content_tool_input TEXT,
  content_tool_output TEXT,
  is_sidechain INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  sequence INTEGER DEFAULT 0,
  tool_use_message_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  outcome TEXT DEFAULT 'pending',
  input_summary TEXT,
  output_summary TEXT,
  is_error INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);
CREATE TABLE subagent_links (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT,
  agent_id TEXT,
  agent_role TEXT,
  slug TEXT,
  file_path TEXT,
  message_count INTEGER DEFAULT 0,
  spawned_at INTEGER
);
CREATE TABLE session_digests (
  session_id TEXT PRIMARY KEY,
  host TEXT,
  platform TEXT,
  one_liner TEXT,
  key_topics TEXT,
  key_files TEXT,
  decisions TEXT,
  open_questions TEXT,
  embedding BLOB,
  embedding_status TEXT NOT NULL DEFAULT 'none',
  updated_at TEXT
);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output,
  content='messages', content_rowid='rowid'
);
CREATE VIRTUAL TABLE sessions_fts USING fts5(
  title, summary, content='work_sessions', content_rowid='rowid'
);
CREATE TRIGGER msg_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
  VALUES (new.rowid, new.content_text, new.content_thinking, new.content_tool_name, new.content_tool_input, new.content_tool_output);
END;
CREATE TRIGGER ws_fts_insert AFTER INSERT ON work_sessions BEGIN
  INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;
`;

export const SESSION_A = 'ws-aaa-001';
export const SESSION_B = 'ws-bbb-002';
/** Subagent child of SESSION_A (linked via subagent_links). */
export const SESSION_SUB = 'ws-sub-003';

export function createFixtureDb(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesti-mcp-test-'));
  const dbPath = path.join(dir, 'vesti.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA);

  const now = Date.UTC(2026, 0, 10, 12, 0, 0);

  const insertSession = db.prepare(
    `INSERT INTO work_sessions (id, session_id, platform, project_path, title, summary, host, started_at, ended_at, last_activity_at, message_count, turn_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'native', ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertSession.run(
    SESSION_A, 'platform-a-1', 'claude-code', 'C:/work/vesti',
    'Refactoring the sqlite storage layer', 'Storage refactor session',
    now, now + 3_600_000, now + 3_600_000, 6, 3, now, now,
  );
  insertSession.run(
    SESSION_B, 'platform-b-1', 'codex', 'C:/work/blog',
    'Deploying a static site', 'Deploy session',
    now + 86_400_000, null, now + 86_400_000, 2, 1, now + 86_400_000, now + 86_400_000,
  );

  const insertTurn = db.prepare(
    `INSERT INTO turns (id, session_id, sequence, user_input, assistant_response, message_count, tool_execution_count, input_tokens, output_tokens, started_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= 3; i++) {
    insertTurn.run(
      `${SESSION_A}-t${i}`, SESSION_A, i,
      i === 1 ? 'please refactor the database migrations to be transactional' : `follow-up question ${i}`,
      `assistant response ${i}`, 2, i === 1 ? 1 : 0, 1200 * i, 340 * i, now + i * 60_000, 45_000,
    );
  }
  insertTurn.run(
    `${SESSION_B}-t1`, SESSION_B, 1,
    'help me deploy the blog to gh-pages', 'sure, here is the plan', 2, 1, 900, 210,
    now + 86_400_000, 30_000,
  );

  const insertMessage = db.prepare(
    `INSERT INTO messages (id, session_id, turn_id, source, sequence, role, content_text, content_thinking, timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertMessage.run(
    'm-a1-u', SESSION_A, `${SESSION_A}-t1`, 'user_input', 1, 'user',
    'please refactor the database migrations to be transactional', null, now + 60_000, now + 60_000,
  );
  insertMessage.run(
    'm-a1-think', SESSION_A, `${SESSION_A}-t1`, 'assistant_think', 2, 'assistant',
    null, 'the migration runner should wrap each step in BEGIN/COMMIT', now + 61_000, now + 61_000,
  );
  insertMessage.run(
    'm-a1-a', SESSION_A, `${SESSION_A}-t1`, 'assistant_text', 3, 'assistant',
    'I wrapped every migration step in a transaction and added rollback handling.', null, now + 62_000, now + 62_000,
  );
  insertMessage.run(
    'm-a2-u', SESSION_A, `${SESSION_A}-t2`, 'user_input', 1, 'user',
    'follow-up question 2', null, now + 120_000, now + 120_000,
  );
  insertMessage.run(
    'm-a2-a', SESSION_A, `${SESSION_A}-t2`, 'assistant_text', 2, 'assistant',
    'answer two', null, now + 121_000, now + 121_000,
  );
  insertMessage.run(
    'm-a3-u', SESSION_A, `${SESSION_A}-t3`, 'user_input', 1, 'user',
    'follow-up question 3', null, now + 180_000, now + 180_000,
  );
  insertMessage.run(
    'm-a3-a', SESSION_A, `${SESSION_A}-t3`, 'assistant_text', 2, 'assistant',
    `a very long answer three. ${'detail '.repeat(300)}`, null, now + 181_000, now + 181_000,
  );
  insertMessage.run(
    'm-b1-u', SESSION_B, `${SESSION_B}-t1`, 'user_input', 1, 'user',
    'help me deploy the blog to gh-pages', null, now + 86_400_000, now + 86_400_000,
  );
  insertMessage.run(
    'm-b1-a', SESSION_B, `${SESSION_B}-t1`, 'assistant_text', 2, 'assistant',
    'sure, here is the plan', null, now + 86_401_000, now + 86_401_000,
  );

  const insertTool = db.prepare(
    `INSERT INTO tool_executions (id, session_id, turn_id, sequence, tool_use_message_id, tool_name, outcome, input_summary, output_summary, is_error, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertTool.run(
    'te-a1-1', SESSION_A, `${SESSION_A}-t1`, 1, 'm-a1-a', 'Edit', 'success',
    'packages/capture-core/src/storage/migrations.ts', 'wrapped migration in transaction', 0, now + 62_500,
  );
  insertTool.run(
    'te-b1-1', SESSION_B, `${SESSION_B}-t1`, 1, 'm-b1-a', 'Bash', 'error',
    'npm run deploy', 'npm ERR! missing script: deploy', 1, now + 86_402_000,
  );

  const insertDigest = db.prepare(
    `INSERT INTO session_digests (session_id, host, platform, one_liner, key_topics, key_files, embedding_status, updated_at)
     VALUES (?, 'native', ?, ?, ?, ?, 'none', ?)`,
  );
  insertDigest.run(
    SESSION_A, 'claude-code',
    'Made the sqlite migration runner transactional',
    JSON.stringify(['sqlite', 'migrations', 'transactions']),
    JSON.stringify(['packages/capture-core/src/storage/migrations.ts']),
    new Date(now + 3_600_000).toISOString(),
  );
  // SESSION_B intentionally has no digest row: search must still work.

  // Subagent line of SESSION_A: its own session row plus the resolved link.
  insertSession.run(
    SESSION_SUB, 'agent-sub-1', 'claude-code', 'C:/work/vesti',
    'Collect trigram tokenizer prior art', null,
    now + 300_000, now + 900_000, now + 900_000, 2, 1, now + 300_000, now + 300_000,
  );
  insertDigest.run(
    SESSION_SUB, 'claude-code',
    'Surveyed trigram tokenizer prior art for the FTS rebuild',
    JSON.stringify(['fts5', 'trigram']),
    JSON.stringify([]),
    new Date(now + 900_000).toISOString(),
  );
  db.prepare(
    `INSERT INTO subagent_links (id, parent_session_id, child_session_id, agent_id, agent_role, slug, file_path, message_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `${SESSION_A}:sub-1`, SESSION_A, SESSION_SUB, 'sub-1', 'generalPurpose', 'explorer',
    'C:/fixtures/agent-sub-1.jsonl', 2,
  );

  db.close();
  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export const MEM_DEPOSIT = 'mem-deposit-1';
export const MEM_DREAM = 'mem-dream-1';
export const MEM_DREAM_LOG = 'mem-dreamlog-1';
export const MEM_NOTE = 'mem-note-1';
/** An archived dream entry — invisible unless include_archived is passed. */
export const MEM_ARCHIVED = 'mem-archived-1';

export const MEM_TIMES = {
  deposit: Date.UTC(2026, 0, 5, 12, 0, 0),
  dream: Date.UTC(2026, 0, 8, 12, 0, 0),
  dreamLog: Date.UTC(2026, 0, 9, 12, 0, 0),
  note: Date.UTC(2026, 0, 10, 12, 0, 0),
  archived: Date.UTC(2026, 0, 6, 12, 0, 0),
} as const;

/**
 * Upgrade a fixture database to the schema-v14 memory space: memory_entries +
 * memory_meta + memory_entries_fts with the same triggers (and the same
 * trigram-tokenizer probe) as capture-core migration 14, seeded with one
 * entry per kind plus an archived one. Opens and closes its own connection.
 */
export function upgradeFixtureToMemorySpace(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      content_markdown TEXT NOT NULL DEFAULT '',
      summary TEXT,
      scope TEXT,
      template TEXT,
      source_session_ids TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      prev_id TEXT,
      last_ops TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      entry_date TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entries_kind ON memory_entries(kind, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_date ON memory_entries(entry_date);
    CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  let tokenizer = '';
  try {
    db.exec("CREATE VIRTUAL TABLE _fts_tokenizer_probe USING fts5(x, tokenize='trigram')");
    db.exec('DROP TABLE _fts_tokenizer_probe');
    tokenizer = ",\n  tokenize='trigram'";
  } catch {
    try { db.exec('DROP TABLE IF EXISTS _fts_tokenizer_probe'); } catch { /* probe best-effort */ }
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
      title, content_markdown, tags,
      content='memory_entries', content_rowid='rowid'${tokenizer}
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS mem_fts_insert AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(rowid, title, content_markdown, tags)
      VALUES (new.rowid, new.title, new.content_markdown, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS mem_fts_delete AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(memory_entries_fts, rowid, title, content_markdown, tags)
      VALUES ('delete', old.rowid, old.title, old.content_markdown, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS mem_fts_update AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_entries_fts(memory_entries_fts, rowid, title, content_markdown, tags)
      VALUES ('delete', old.rowid, old.title, old.content_markdown, old.tags);
      INSERT INTO memory_entries_fts(rowid, title, content_markdown, tags)
      VALUES (new.rowid, new.title, new.content_markdown, new.tags);
    END;
  `);

  const insert = db.prepare(
    `INSERT INTO memory_entries (id, kind, title, content_markdown, summary, scope, template,
                                 source_session_ids, tags, version, prev_id, last_ops, status,
                                 entry_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    MEM_DEPOSIT, 'deposit', '个人背景与写作风格',
    '# 个人背景\n\n用户是独立开发者，笔名小蜂。写作风格：短句，口语化，先结论后论证。\n\n当前项目：VESTI（本地 AI 会话记忆工具）。',
    '个人背景、写作风格与当前项目状态', 'personal', 'profile',
    '[]', JSON.stringify(['profile', 'writing']), 3, null, '[]', 'active',
    '2026-01-05', MEM_TIMES.deposit, MEM_TIMES.deposit,
  );
  insert.run(
    MEM_DREAM, 'dream', '用户偏好：简洁输出',
    '用户多次要求输出保持简洁、先给结论，对冗长解释表现出不耐烦。涉及性能话题时情绪明显更投入。',
    '偏好简洁、结论先行的回答', null, null,
    JSON.stringify([SESSION_A]), JSON.stringify(['preference', 'communication']), 1, null, '[]', 'active',
    '2026-01-08', MEM_TIMES.dream, MEM_TIMES.dream,
  );
  insert.run(
    MEM_DREAM_LOG, 'dream-log', '梦境整理日志 2026-01-09',
    '本次做梦处理了 3 个会话，提取 1 条长期记忆，归档 0 条。耗时 42 秒。',
    null, null, null,
    JSON.stringify([SESSION_A, SESSION_B]), '[]', 1, null, '[]', 'active',
    '2026-01-09', MEM_TIMES.dreamLog, MEM_TIMES.dreamLog,
  );
  insert.run(
    MEM_NOTE, 'note', '随手记：MCP 工具命名',
    '记忆空间的 MCP 工具命名定为 vesti_memory_search / vesti_memory_get。',
    null, null, null,
    '[]', JSON.stringify(['vesti']), 1, null, '[]', 'active',
    '2026-01-10', MEM_TIMES.note, MEM_TIMES.note,
  );
  insert.run(
    MEM_ARCHIVED, 'dream', '旧记忆：已归档的偏好',
    '这条关于旧编辑器快捷键的记忆已经过时并被归档 (deprecated)。',
    null, null, null,
    '[]', JSON.stringify(['preference']), 2, MEM_DREAM, '[]', 'archived',
    '2026-01-06', MEM_TIMES.archived, MEM_TIMES.archived,
  );
  db.close();
}

export const PROJECT_KEY = 'cli-path-key-vesti';

/**
 * Upgrade a fixture database to the memory-v2 shape: digest access_count,
 * project_registry / project_state / project_briefs, seeded for the "vesti"
 * project. Opens and closes its own connection.
 */
export function upgradeFixtureToMemoryV2(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    ALTER TABLE session_digests ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE project_registry (
      project_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT,
      path_or_domain TEXT,
      first_seen TEXT,
      last_seen TEXT
    );
    CREATE TABLE project_state (
      project_key TEXT PRIMARY KEY,
      one_liner TEXT,
      active_files TEXT,
      open_questions TEXT,
      session_count INTEGER,
      last_active TEXT,
      updated_at TEXT
    );
    CREATE TABLE project_briefs (
      project_key TEXT PRIMARY KEY,
      content_markdown TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      last_ops TEXT,
      updated_at TEXT
    );
  `);
  db.prepare(
    `INSERT INTO project_registry (project_key, kind, label, path_or_domain, first_seen, last_seen)
     VALUES (?, 'cli_path', 'vesti', 'C:/work/vesti', '2026-01-01T00:00:00.000Z', '2026-01-10T00:00:00.000Z')`,
  ).run(PROJECT_KEY);
  db.prepare(
    `INSERT INTO project_state (project_key, one_liner, active_files, open_questions, session_count, last_active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROJECT_KEY,
    'L0 card one-liner',
    JSON.stringify([{ path: 'src/storage/migrations.ts', touches: 4, lastTouched: '2026-01-10T12:00:00.000Z' }]),
    JSON.stringify(['是否切换到 WAL2？']),
    1,
    '2026-01-10T12:00:00.000Z',
    '2026-01-10T13:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO project_briefs (project_key, content_markdown, version, last_ops, updated_at)
     VALUES (?, ?, ?, '[]', ?)`,
  ).run(PROJECT_KEY, '# vesti 项目简报\n\n当前在做存储层重构。', 3, '2026-01-10T14:00:00.000Z');
  db.close();
}
