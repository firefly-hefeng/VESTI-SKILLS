/**
 * Schema Migration Tests
 * Covers: fresh-database migration, upgrade of a simulated legacy database
 * (data preserved, missing column backfilled) and restart idempotency.
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { MIGRATIONS, probeFtsTokenizer } from '../src/storage/migrations.js';
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

function columnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
  } finally {
    db.close();
  }
}

function appliedMigrations(dbPath: string): Array<{ version: number; name: string; applied_at: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all() as Array<{
      version: number;
      name: string;
      applied_at: string;
    }>;
  } finally {
    db.close();
  }
}

function tableNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map(row => row.name);
  } finally {
    db.close();
  }
}

/** The work_sessions shape shipped before session_type was added. */
function createLegacyWorkSessions(db: Database.Database): void {
  db.exec(`
    CREATE TABLE work_sessions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      platform_version TEXT,
      project_path TEXT NOT NULL DEFAULT '',
      git_branch TEXT,
      git_remote TEXT,
      model TEXT,
      models TEXT,
      title TEXT NOT NULL DEFAULT 'Untitled',
      summary TEXT,
      tags TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_activity_at INTEGER NOT NULL,
      duration_ms INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      user_input_count INTEGER DEFAULT 0,
      assistant_message_count INTEGER DEFAULT 0,
      thinking_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      code_block_count INTEGER DEFAULT 0,
      turn_count INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_creation_tokens INTEGER DEFAULT 0,
      total_cache_read_tokens INTEGER DEFAULT 0,
      has_subagents INTEGER DEFAULT 0,
      has_context_compaction INTEGER DEFAULT 0,
      agent_meta TEXT,
      claude_code_version TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

describe('schema migrations', () => {
  it('creates timestamped Token usage storage and invalidates source checkpoints', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE work_sessions (id TEXT PRIMARY KEY);
        CREATE TABLE sync_state (
          file_path TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          last_position INTEGER DEFAULT 0,
          last_modified INTEGER DEFAULT 0
        );
        INSERT INTO sync_state (file_path, platform, last_position, last_modified)
        VALUES ('C:/source/session.jsonl', 'codex', 1234, 5678);
      `);

      const migration = MIGRATIONS.find(item => item.name === 'add_token_usage_events_and_rescan_sources');
      expect(migration).toBeDefined();
      migration!.up(db);

      const columns = (db.prepare('PRAGMA table_info(token_usage_events)').all() as Array<{ name: string }>)
        .map(row => row.name);
      expect(columns).toEqual(expect.arrayContaining([
        'id', 'session_id', 'dedupe_key', 'source_scope', 'timestamp', 'input_tokens', 'output_tokens',
        'cache_creation_tokens', 'cache_read_tokens', 'reasoning_tokens', 'model', 'source',
      ]));
      const indexes = (db.prepare("PRAGMA index_list('token_usage_events')").all() as Array<{ name: string }>)
        .map(row => row.name);
      expect(indexes).toEqual(expect.arrayContaining([
        'idx_token_usage_events_timestamp',
        'idx_token_usage_events_session',
        'idx_token_usage_events_dedupe',
        'idx_token_usage_events_source_scope',
      ]));
      expect((db.prepare('SELECT COUNT(*) AS c FROM sync_state').get() as { c: number }).c).toBe(0);

      // All schema operations are safe if a partially upgraded database
      // happens to run the migration body again.
      expect(() => migration!.up(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('repairs databases that already applied the earlier v11 event schema', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE token_usage_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          source_scope TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          model TEXT,
          source TEXT NOT NULL
        );
        CREATE TABLE sync_state (
          file_path TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          last_position INTEGER DEFAULT 0,
          last_modified INTEGER DEFAULT 0
        );
        INSERT INTO token_usage_events (
          id, session_id, source_scope, timestamp, input_tokens, source
        ) VALUES ('old-event', 'codex:session', 'old-scope', 1234, 99, 'codex');
        INSERT INTO sync_state (file_path, platform) VALUES ('old.jsonl', 'codex');
      `);

      const migration = MIGRATIONS.find(item => item.name === 'repair_token_usage_event_dedupe_key');
      expect(migration).toBeDefined();
      migration!.up(db);

      const columns = (db.prepare('PRAGMA table_info(token_usage_events)').all() as Array<{ name: string }>)
        .map(row => row.name);
      const indexes = (db.prepare("PRAGMA index_list('token_usage_events')").all() as Array<{ name: string }>)
        .map(row => row.name);
      expect(columns).toContain('dedupe_key');
      expect(indexes).toContain('idx_token_usage_events_dedupe');
      expect((db.prepare('SELECT COUNT(*) AS c FROM token_usage_events').get() as { c: number }).c).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS c FROM sync_state').get() as { c: number }).c).toBe(0);
      expect(() => migration!.up(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('keeps old Codex events recoverable while scheduling their corrected rebuild', () => {
    const db = new Database(':memory:');
    try {
      db.exec([
        'CREATE TABLE token_usage_events (',
        '  id TEXT PRIMARY KEY,',
        '  session_id TEXT NOT NULL,',
        '  source TEXT NOT NULL',
        ');',
        'CREATE TABLE sync_state (',
        '  file_path TEXT PRIMARY KEY,',
        '  platform TEXT NOT NULL,',
        '  last_position INTEGER DEFAULT 0,',
        '  last_modified INTEGER DEFAULT 0',
        ');',
        "INSERT INTO token_usage_events (id, session_id, source) VALUES",
        "  ('codex-event', 'codex:session', 'codex:token_count:total_token_usage'),",
        "  ('cursor-event', 'cursor:session', 'cursor:composer_usage');",
        "INSERT INTO sync_state (file_path, platform, last_position, last_modified) VALUES",
        "  ('C:/Codex/session.jsonl', 'codex', 100, 200),",
        "  ('C:/Cursor/state.vscdb', 'cursor', 300, 400);",
      ].join('\n'));

      const migration = MIGRATIONS.find(item => item.version === 13);
      expect(migration).toBeDefined();
      migration!.up(db);

      expect(db.prepare(
        'SELECT id, is_valid FROM token_usage_events ORDER BY id',
      ).all()).toEqual([
        { id: 'codex-event', is_valid: 0 },
        { id: 'cursor-event', is_valid: 1 },
      ]);
      expect(db.prepare(
        'SELECT file_path, last_position, last_modified FROM sync_state ORDER BY file_path',
      ).all()).toEqual([
        { file_path: 'C:/Codex/session.jsonl', last_position: -1, last_modified: 0 },
        { file_path: 'C:/Cursor/state.vscdb', last_position: 300, last_modified: 400 },
      ]);
      expect(() => migration!.up(db)).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('archives legacy embeddings and marks their digests for regeneration', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(`
        CREATE TABLE session_digests (
          session_id TEXT PRIMARY KEY,
          embedding BLOB,
          embedding_status TEXT NOT NULL DEFAULT 'none',
          digest_version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT
        );
        INSERT INTO session_digests (
          session_id, embedding, embedding_status, digest_version, updated_at
        ) VALUES (
          'legacy-session', zeroblob(12), 'ok', 2, '2026-07-23T00:00:00.000Z'
        );
      `);
      const migration = MIGRATIONS.find(item => item.name === 'version_session_digest_embeddings');
      expect(migration).toBeDefined();
      migration!.up(db);

      const digest = db.prepare(`
        SELECT embedding_provider, embedding_model, embedding_dimensions,
               embedding_version, digest_version
        FROM session_digests WHERE session_id = 'legacy-session'
      `).get() as Record<string, unknown>;
      expect(digest).toMatchObject({
        embedding_provider: 'legacy',
        embedding_model: 'unknown',
        embedding_dimensions: 3,
        embedding_version: 'legacy:unknown:3',
        digest_version: 0,
      });
      const archived = db.prepare(`
        SELECT provider, model, dimensions, index_version
        FROM session_digest_embeddings WHERE session_id = 'legacy-session'
      `).get();
      expect(archived).toMatchObject({
        provider: 'legacy',
        model: 'unknown',
        dimensions: 3,
        index_version: 'legacy:unknown:3',
      });
    } finally {
      db.close();
    }
  });

  it('migrates a fresh database from zero and records all versions', async () => {
    const dir = await makeTempDir('vesti-migrations-fresh-');
    const dbPath = path.join(dir, 'vesti.db');

    const manager = new DatabaseManager(dbPath);
    await manager.initialize();
    await manager.close();

    const migrations = appliedMigrations(dbPath);
    expect(migrations.map(m => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(migrations[0].name).toBe('add_work_sessions_session_type');
    expect(migrations[1].name).toBe('add_work_sessions_host');
    expect(migrations[2].name).toBe('add_session_digests_and_project_registry');
    for (const migration of migrations) {
      expect(migration.applied_at).toBeTruthy();
    }
    expect(columnNames(dbPath, 'work_sessions')).toContain('session_type');
    expect(columnNames(dbPath, 'work_sessions')).toContain('host');
    // Migration 3: conversation-tree index tables.
    expect(columnNames(dbPath, 'session_digests')).toEqual(expect.arrayContaining([
      'session_id', 'host', 'platform', 'project_key', 'one_liner',
      'key_topics', 'key_files', 'decisions', 'open_questions',
      'embedding', 'embedding_status', 'digest_version', 'message_count', 'updated_at',
    ]));
    expect(columnNames(dbPath, 'project_registry')).toEqual(expect.arrayContaining([
      'project_key', 'kind', 'label', 'path_or_domain', 'first_seen', 'last_seen',
    ]));
    // Migration 4 (memory v2): fork lineage + L1 validity + L0/L2 tables.
    expect(migrations[3].name).toBe('add_memory_v2_fork_lineage_and_project_layers');
    expect(columnNames(dbPath, 'work_sessions')).toContain('forked_from');
    expect(columnNames(dbPath, 'session_digests')).toEqual(expect.arrayContaining([
      'valid_from', 'valid_to', 'superseded_by', 'access_count',
    ]));
    expect(tableNames(dbPath)).toEqual(expect.arrayContaining(['project_state', 'project_briefs']));
    expect(columnNames(dbPath, 'session_digests')).toEqual(expect.arrayContaining([
      'embedding_provider', 'embedding_model', 'embedding_dimensions', 'embedding_version',
    ]));
    expect(tableNames(dbPath)).toContain('session_digest_embeddings');
    expect(tableNames(dbPath)).toContain('embedding_index_state');
    expect(columnNames(dbPath, 'token_usage_events')).toEqual(expect.arrayContaining([
      'id', 'session_id', 'dedupe_key', 'source_scope', 'timestamp', 'input_tokens', 'output_tokens',
      'cache_creation_tokens', 'cache_read_tokens', 'reasoning_tokens', 'model', 'source', 'is_valid',
    ]));
  });

  it('upgrades a legacy database: data preserved and session_type backfilled', async () => {
    const dir = await makeTempDir('vesti-migrations-legacy-');
    const dbPath = path.join(dir, 'vesti.db');

    // Simulate a database created before the session_type column existed.
    const legacy = new Database(dbPath);
    createLegacyWorkSessions(legacy);
    legacy.prepare(`
      INSERT INTO work_sessions (id, session_id, platform, title, started_at, last_activity_at, created_at, updated_at)
      VALUES ('ws-legacy', 'session-legacy', 'codex', 'Legacy session', 1000, 2000, 1000, 2000)
    `).run();
    legacy.close();

    expect(columnNames(dbPath, 'work_sessions')).not.toContain('session_type');

    const manager = new DatabaseManager(dbPath);
    await manager.initialize();

    const preserved = manager.getWorkSession('ws-legacy');
    expect(preserved).not.toBeNull();
    expect(preserved!.title).toBe('Legacy session');
    expect(preserved!.sessionType).toBe('conversation');
    // Migration 2 backfills pre-WSL rows as native.
    expect(preserved!.host).toBe('native');

    // The backfilled column must accept writes through the normal upsert path.
    const fresh: WorkSession = {
      id: 'ws-new',
      sessionId: 'session-new',
      platform: 'codex',
      projectPath: '',
      title: 'New session',
      tags: [],
      status: 'active',
      sessionType: 'conversation',
      startedAt: 3000,
      lastActivityAt: 3000,
      durationMs: 0,
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
      createdAt: 3000,
      updatedAt: 3000,
    };
    manager.upsertWorkSession(fresh);
    expect(manager.getWorkSession('ws-new')?.sessionType).toBe('conversation');
    expect(manager.getWorkSession('ws-new')?.host).toBe('native');
    await manager.close();

    expect(columnNames(dbPath, 'work_sessions')).toContain('session_type');
    expect(columnNames(dbPath, 'work_sessions')).toContain('host');
    expect(appliedMigrations(dbPath).map(m => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    // Migration 3 creates the index tables on legacy databases too.
    expect(tableNames(dbPath)).toEqual(expect.arrayContaining(['session_digests', 'project_registry']));
    // Legacy rows get a project registry entry from the normal upsert path.
    const registry = new Database(dbPath, { readonly: true });
    try {
      const row = registry.prepare('SELECT * FROM project_registry').get() as { kind: string } | undefined;
      expect(row?.kind).toBe('cli_path');
    } finally {
      registry.close();
    }
  });

  it('repairs beta databases where legacy Cursor rescan already occupied migration v4', async () => {
    const dir = await makeTempDir('vesti-migrations-v4-collision-');
    const dbPath = path.join(dir, 'vesti.db');

    // Reproduce the schema found in released beta installs. Those installs
    // recorded the old Cursor rescan under version 4, so the later Memory v2
    // migration with the same version was considered applied without ever
    // adding its columns or tables.
    const baseline = new DatabaseManager(dbPath);
    await baseline.initialize();
    await baseline.close();

    const seeded = new Database(dbPath);
    seeded.exec(`
      ALTER TABLE work_sessions DROP COLUMN forked_from;
      ALTER TABLE session_digests DROP COLUMN valid_from;
      ALTER TABLE session_digests DROP COLUMN valid_to;
      ALTER TABLE session_digests DROP COLUMN superseded_by;
      ALTER TABLE session_digests DROP COLUMN access_count;
      DROP TABLE project_state;
      DROP TABLE project_briefs;
      UPDATE schema_migrations
      SET name = 'rescan_cursor_reported_token_usage'
      WHERE version = 4;
      DELETE FROM schema_migrations WHERE version = 10;
    `);
    seeded.prepare(`
      INSERT INTO work_sessions (
        id, session_id, platform, project_path, title, started_at,
        last_activity_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'ws-before-repair',
      'session-before-repair',
      'codex',
      'C:/projects/preserved',
      'Preserved beta session',
      1000,
      2000,
      1000,
      2000,
    );
    seeded.close();

    expect(columnNames(dbPath, 'work_sessions')).not.toContain('forked_from');
    expect(tableNames(dbPath)).not.toContain('project_state');

    const repaired = new DatabaseManager(dbPath);
    await repaired.initialize();

    expect(repaired.getWorkSession('ws-before-repair')?.title).toBe('Preserved beta session');
    expect(columnNames(dbPath, 'work_sessions')).toContain('forked_from');
    expect(columnNames(dbPath, 'session_digests')).toEqual(expect.arrayContaining([
      'valid_from', 'valid_to', 'superseded_by', 'access_count',
    ]));
    expect(tableNames(dbPath)).toEqual(expect.arrayContaining(['project_state', 'project_briefs']));

    // Most importantly, the normal capture write that failed on affected
    // installs must work again after the repair migration.
    repaired.upsertWorkSession({
      id: 'ws-after-repair',
      sessionId: 'session-after-repair',
      platform: 'codex',
      projectPath: 'C:/projects/repaired',
      title: 'Newly captured session',
      tags: [],
      status: 'active',
      sessionType: 'conversation',
      forkedFrom: 'ws-before-repair',
      startedAt: 3000,
      lastActivityAt: 4000,
      durationMs: 1000,
      messageCount: 1,
      userInputCount: 1,
      assistantMessageCount: 0,
      thinkingCount: 0,
      toolCallCount: 0,
      codeBlockCount: 0,
      turnCount: 1,
      totalInputTokens: 10,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      hasSubagents: true,
      hasContextCompaction: false,
      createdAt: 3000,
      updatedAt: 4000,
    });
    expect(repaired.getWorkSession('ws-after-repair')?.forkedFrom).toBe('ws-before-repair');
    expect(repaired.listProjectStates()).toEqual([]);
    expect(() => repaired.buildConversationTree()).not.toThrow();
    await repaired.close();

    const migrations = appliedMigrations(dbPath);
    expect(migrations.find(item => item.version === 4)?.name)
      .toBe('rescan_cursor_reported_token_usage');
    expect(migrations.find(item => item.version === 10)?.name)
      .toBe('repair_memory_v2_schema_after_legacy_v4_collision');
  });

  it('is idempotent across restarts', async () => {
    const dir = await makeTempDir('vesti-migrations-idem-');
    const dbPath = path.join(dir, 'vesti.db');

    const first = new DatabaseManager(dbPath);
    await first.initialize();
    await first.close();

    const second = new DatabaseManager(dbPath);
    await second.initialize();
    await second.close();

    expect(appliedMigrations(dbPath)).toHaveLength(15);
  });

  it('migration 6 reclassifies degraded digest rows as skipped', async () => {
    const dir = await makeTempDir('vesti-migrations-v6-');
    const dbPath = path.join(dir, 'vesti.db');

    // Build a full schema, then simulate the pre-v6 state: rows locked out
    // as 'degraded' by LLM transport failures.
    const setup = new DatabaseManager(dbPath);
    await setup.initialize();
    await setup.close();
    const seed = new Database(dbPath);
    seed.exec("DELETE FROM schema_migrations WHERE version = 6");
    seed.prepare(`
      INSERT INTO session_digests (session_id, embedding_status, digest_version) VALUES
        ('s-degraded', 'degraded', 2), ('s-ok', 'ok', 2), ('s-skipped', 'skipped', 2)
    `).run();
    seed.close();

    const manager = new DatabaseManager(dbPath);
    await manager.initialize();
    await manager.close();

    const db = new Database(dbPath, { readonly: true });
    try {
      const statuses = db.prepare(
        'SELECT session_id, embedding_status FROM session_digests ORDER BY session_id',
      ).all() as Array<{ session_id: string; embedding_status: string }>;
      expect(statuses).toEqual([
        { session_id: 's-degraded', embedding_status: 'skipped' },
        { session_id: 's-ok', embedding_status: 'ok' },
        { session_id: 's-skipped', embedding_status: 'skipped' },
      ]);
      const note = db.prepare('SELECT note FROM schema_migrations WHERE version = 6').get() as { note: string | null };
      expect(note.note).toContain('reclassified 1');
    } finally {
      db.close();
    }
  });

  it('migration 8 adds sync_state.parser_version to legacy databases', async () => {
    const dir = await makeTempDir('vesti-migrations-v8-');
    const dbPath = path.join(dir, 'vesti.db');

    // Full schema, then simulate the pre-v7 state: no parser_version column.
    const setup = new DatabaseManager(dbPath);
    await setup.initialize();
    await setup.close();
    const seed = new Database(dbPath);
    seed.exec('DELETE FROM schema_migrations WHERE version = 8');
    seed.exec('ALTER TABLE sync_state DROP COLUMN parser_version');
    seed.prepare(
      'INSERT INTO sync_state (file_path, platform, last_position, last_modified) VALUES (?, ?, ?, ?)'
    ).run('C:/x/state.vscdb', 'cursor', 100, 1_000);
    seed.close();

    const manager = new DatabaseManager(dbPath);
    await manager.initialize();
    // Existing rows read back as version 0, so any adapter with a declared
    // parserVersion re-parses them on the next sync.
    expect(manager.getSyncState('C:/x/state.vscdb')?.parserVersion).toBe(0);
    manager.setSyncState('C:/x/state.vscdb', 'cursor', 100, 1_000, undefined, undefined, 2);
    expect(manager.getSyncState('C:/x/state.vscdb')?.parserVersion).toBe(2);
    await manager.close();
  });
});

// ---------------------------------------------------------------------------
// Migration 5: FTS5 trigram tokenizer rebuild
// ---------------------------------------------------------------------------

function ftsTableSql(dbPath: string, table: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as
      | { sql: string }
      | undefined;
    return row?.sql ?? '';
  } finally {
    db.close();
  }
}

function tableCount(dbPath: string, table: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

function migrationNote(dbPath: string, version: number): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT note FROM schema_migrations WHERE version = ?').get(version) as
      | { note: string | null }
      | undefined;
    return row?.note ?? null;
  } finally {
    db.close();
  }
}

/**
 * Build a faithful schema-v4 database: today's base tables, but the FTS
 * tables still on the default unicode61 tokenizer, and migrations 1–4
 * recorded as applied. Returns with the connection closed.
 */
function createSchemaV4Database(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE work_sessions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      platform_version TEXT,
      project_path TEXT NOT NULL DEFAULT '',
      git_branch TEXT,
      git_remote TEXT,
      model TEXT,
      models TEXT,
      title TEXT NOT NULL DEFAULT 'Untitled',
      summary TEXT,
      tags TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_activity_at INTEGER NOT NULL,
      duration_ms INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      user_input_count INTEGER DEFAULT 0,
      assistant_message_count INTEGER DEFAULT 0,
      thinking_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      code_block_count INTEGER DEFAULT 0,
      turn_count INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_creation_tokens INTEGER DEFAULT 0,
      total_cache_read_tokens INTEGER DEFAULT 0,
      has_subagents INTEGER DEFAULT 0,
      has_context_compaction INTEGER DEFAULT 0,
      agent_meta TEXT,
      claude_code_version TEXT,
      session_type TEXT DEFAULT 'conversation',
      host TEXT NOT NULL DEFAULT 'native',
      forked_from TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
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
      content_tool_error TEXT,
      cwd TEXT,
      git_branch TEXT,
      token_input INTEGER,
      token_output INTEGER,
      token_cache_creation INTEGER,
      token_cache_read INTEGER,
      token_reasoning INTEGER,
      model TEXT,
      stop_reason TEXT,
      parent_id TEXT,
      depth INTEGER DEFAULT 0,
      is_sidechain INTEGER DEFAULT 0,
      agent_id TEXT,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE session_digests (
      session_id TEXT PRIMARY KEY,
      host TEXT,
      platform TEXT,
      project_key TEXT,
      one_liner TEXT,
      key_topics TEXT,
      key_files TEXT,
      decisions TEXT,
      open_questions TEXT,
      embedding BLOB,
      embedding_status TEXT NOT NULL DEFAULT 'none',
      digest_version INTEGER NOT NULL DEFAULT 1,
      message_count INTEGER,
      updated_at TEXT,
      valid_from TEXT,
      valid_to TEXT,
      superseded_by TEXT,
      access_count INTEGER NOT NULL DEFAULT 0
    );
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
    -- Pre-migration-5 FTS shape: default (unicode61) tokenizer.
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
    CREATE TRIGGER msg_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
      VALUES ('delete', old.rowid, old.content_text, old.content_thinking, old.content_tool_name, old.content_tool_input, old.content_tool_output);
    END;
    CREATE TRIGGER msg_fts_update AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
      VALUES ('delete', old.rowid, old.content_text, old.content_thinking, old.content_tool_name, old.content_tool_input, old.content_tool_output);
      INSERT INTO messages_fts(rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
      VALUES (new.rowid, new.content_text, new.content_thinking, new.content_tool_name, new.content_tool_input, new.content_tool_output);
    END;
    CREATE TRIGGER ws_fts_insert AFTER INSERT ON work_sessions BEGIN
      INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
    END;
    CREATE TRIGGER ws_fts_delete AFTER DELETE ON work_sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, title, summary)
      VALUES ('delete', old.rowid, old.title, old.summary);
    END;
    CREATE TRIGGER ws_fts_update AFTER UPDATE ON work_sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, title, summary)
      VALUES ('delete', old.rowid, old.title, old.summary);
      INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
    END;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations (version, name, applied_at) VALUES
      (1, 'add_work_sessions_session_type', '2026-01-01T00:00:00.000Z'),
      (2, 'add_work_sessions_host', '2026-01-01T00:00:00.000Z'),
      (3, 'add_session_digests_and_project_registry', '2026-01-01T00:00:00.000Z'),
      (4, 'add_memory_v2_fork_lineage_and_project_layers', '2026-01-01T00:00:00.000Z');
  `);

  // Seed data: one session whose needle fact is written CJK-tight (no
  // spaces) — invisible to unicode61 token matching, the baseline failure.
  db.prepare(`
    INSERT INTO work_sessions (id, session_id, platform, title, started_at, last_activity_at, created_at, updated_at)
    VALUES ('ws-v4', 'session-v4', 'kimi-code', '前端状态管理库选型讨论', 1000, 2000, 1000, 2000)
  `).run();
  db.prepare(`
    INSERT INTO messages (id, session_id, role, content_text, timestamp, created_at)
    VALUES ('m-v4', 'ws-v4', 'assistant', '关于前端状态管理库，团队最终决定用Zustand了，后续不再讨论。', 1500, 1500)
  `).run();
  db.close();
}

describe('migration 5: fts5 trigram tokenizer', () => {
  it('probeFtsTokenizer detects trigram support and rejects bogus tokenizers', () => {
    const db = new Database(':memory:');
    try {
      expect(probeFtsTokenizer(db, 'trigram')).toBe(true);
      expect(probeFtsTokenizer(db, 'no-such-tokenizer-xyz')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('fresh databases get trigram FTS tables and a clean migration record', async () => {
    const dir = await makeTempDir('vesti-m5-fresh-');
    const dbPath = path.join(dir, 'vesti.db');

    const manager = new DatabaseManager(dbPath);
    await manager.initialize();
    await manager.close();

    expect(ftsTableSql(dbPath, 'messages_fts').toLowerCase()).toContain('trigram');
    expect(ftsTableSql(dbPath, 'sessions_fts').toLowerCase()).toContain('trigram');
    const migrations = appliedMigrations(dbPath);
    expect(migrations.map(m => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(migrations[4].name).toBe('fts5_trigram_tokenizer');
    // Applied (not skipped) → no note.
    expect(migrationNote(dbPath, 5)).toBeNull();
  });

  it('upgrades a v4 database: trigram rebuild, complete backfill, CJK recall fixed', async () => {
    const dir = await makeTempDir('vesti-m5-upgrade-');
    const dbPath = path.join(dir, 'vesti.db');
    createSchemaV4Database(dbPath);
    expect(ftsTableSql(dbPath, 'messages_fts').toLowerCase()).not.toContain('trigram');
    // Sanity: the tight-CJK fact is unfindable before the migration.
    {
      const before = new Database(dbPath, { readonly: true });
      try {
        const hits = before.prepare(
          `SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH '"前端状态管理库"'`,
        ).get() as { c: number };
        expect(hits.c).toBe(0);
      } finally {
        before.close();
      }
    }

    const manager = new DatabaseManager(dbPath);
    await manager.initialize();

    // Rebuilt with trigram; schema_migrations records v5 without a skip note.
    expect(ftsTableSql(dbPath, 'messages_fts').toLowerCase()).toContain('trigram');
    expect(ftsTableSql(dbPath, 'sessions_fts').toLowerCase()).toContain('trigram');
    expect(appliedMigrations(dbPath).map(m => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(migrationNote(dbPath, 5)).toBeNull();

    // Backfill完整性: every content row re-indexed (rebuild, not incremental).
    expect(tableCount(dbPath, 'messages_fts')).toBe(tableCount(dbPath, 'messages'));
    expect(tableCount(dbPath, 'sessions_fts')).toBe(tableCount(dbPath, 'work_sessions'));

    // The baseline bug: tight-CJK statement, spaced query — now recalled.
    const hits = manager.recallSessions('前端状态管理库 最终选了什么方案？', { topK: 5 });
    expect(hits.map(hit => hit.sessionId)).toContain('ws-v4');

    // Triggers recreated: post-migration writes stay in sync.
    manager.insertSessionMessages([{
      id: 'm-after',
      sessionId: 'ws-v4',
      source: 'assistant_text',
      sequence: 1,
      role: 'assistant',
      contentText: '支付模块的负责人正式改为李娜，周会上已经同步。',
      depth: 0,
      timestamp: 3000,
      createdAt: 3000,
    }]);
    const after = manager.recallSessions('支付模块 负责人是谁？', { topK: 5 });
    expect(after.map(hit => hit.sessionId)).toContain('ws-v4');
    await manager.close();

    // The recreated update trigger keeps edits in sync too.
    const raw = new Database(dbPath);
    try {
      raw.prepare(`UPDATE messages SET content_text = '超算集群的配额已经翻倍' WHERE id = 'm-v4'`).run();
      const hits = raw.prepare(
        `SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH '"超算集群"'`,
      ).get() as { c: number };
      expect(hits.c).toBe(1);
    } finally {
      raw.close();
    }
  });

  it('skips with a recorded reason when the SQLite build lacks trigram', () => {
    // Exercise the degradation path directly: the probe override simulates a
    // SQLite without the trigram tokenizer. Tables must stay untouched and
    // the migration must return the skip note for schema_migrations.
    const migration = MIGRATIONS.find(m => m.version === 5);
    expect(migration).toBeDefined();

    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE messages (id TEXT PRIMARY KEY, content_text TEXT);
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content_text, content='messages', content_rowid='rowid'
        );
        INSERT INTO messages (id, content_text) VALUES ('m1', 'unicode61 indexed text');
        INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
      `);
      const note = (migration!.up as (db: Database.Database, probe?: () => boolean) => string | void)(
        db,
        () => false,
      );
      expect(note).toMatch(/skipped/);
      expect(note).toMatch(/trigram/);
      const sql = (db.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'messages_fts'",
      ).get() as { sql: string }).sql;
      expect(sql.toLowerCase()).not.toContain('trigram');
      // Old index still intact and queryable.
      const hits = db.prepare(
        `SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH '"indexed"'`,
      ).get() as { c: number };
      expect(hits.c).toBe(1);
    } finally {
      db.close();
    }
  });

  // Migration 6: existing Cursor sessions must be scanned again after the
  // parser starts reading model-reported token usage.
  it('invalidates only the Cursor checkpoint when token capture is upgraded', async () => {
    const dir = await makeTempDir('vesti-migrations-cursor-token-');
    const dbPath = path.join(dir, 'vesti.db');

    const first = new DatabaseManager(dbPath);
    await first.initialize();
    await first.close();

    const seeded = new Database(dbPath);
    seeded.prepare("DELETE FROM schema_migrations WHERE version = 7").run();
    seeded.prepare(`
      INSERT INTO sync_state (file_path, platform, last_position, last_modified)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      'C:/Cursor/state.vscdb', 'cursor', 100, 200,
      'C:/Codex/session.jsonl', 'codex', 300, 400,
    );
    seeded.close();

    const upgraded = new DatabaseManager(dbPath);
    await upgraded.initialize();
    expect(upgraded.getSyncState('C:/Cursor/state.vscdb')).toBeNull();
    expect(upgraded.getSyncState('C:/Codex/session.jsonl')).toMatchObject({
      lastPosition: 300,
      lastModified: 400,
    });
    await upgraded.close();
  });
});
