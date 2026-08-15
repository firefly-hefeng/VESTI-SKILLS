/**
 * Database Manager v2
 * SQLite with WAL mode, FTS5
 * New schema: work_sessions, turns, messages, tool_executions, subagent_links,
 * context_compactions, system_events
 *
 * Ported from VESTI-APP packages/capture-core/src/storage/DatabaseManager.ts.
 * Trimmed to the memory domain: capture-side token-usage analytics, the v1
 * compatibility shims, the legacy FTS search helpers, the conversation-tree
 * builder and the dashboard stats rollup live with the app and are not part
 * of this package. Schema, migrations and every kept method stay byte-
 * compatible with the desktop app's database.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, hasColumn } from './migrations.js';
import { deriveProjectKey, projectBasis, projectLabel } from './projectRegistry.js';
import { recallSessions, toFtsQuery, type SessionRecallHit, type SessionRecallOptions } from '../search/SessionRecall.js';
import { detectForksByMessageOverlap } from '../tree/forks.js';
import { buildProjectState, listProjectKeys } from '../state/projectState.js';
import { getFileTimeline, type FileTimelineQuery } from '../state/fileTimeline.js';
import type {
  WorkSession,
  Turn,
  SessionMessage,
  UnifiedToolExecution,
  SubagentLink,
  ContextCompaction,
  SystemEvent,
  SessionDigest,
  SessionDigestStats,
  ProjectState,
  ProjectBrief,
  FileTimelineEvent,
  MemoryEntry,
} from '../types.js';

export class DatabaseManager {
  private dbPath: string;
  private db: Database.Database | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    if (this.db) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.createTables();
    this.runMigrations();
    this.createIndexes();
    this.createFTS();
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('Database not initialized');
    return this.db;
  }

  // ==================== Schema ====================

  private createTables(): void {
    const db = this.getDb();

    // v2: work_sessions (replaces conversations)
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_sessions (
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // v2: turns
    db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        user_input TEXT,
        user_input_message_id TEXT,
        assistant_response TEXT,
        assistant_response_message_id TEXT,
        message_count INTEGER DEFAULT 0,
        tool_execution_count INTEGER DEFAULT 0,
        thinking_tokens INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER DEFAULT 0,
        FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
      )
    `);

    // v2: messages (enhanced with source, turn_id, sequence)
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
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
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
      )
    `);

    // v2: tool_executions (enhanced with turn_id, tool_category, outcome)
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        sequence INTEGER DEFAULT 0,
        tool_use_message_id TEXT NOT NULL,
        tool_result_message_id TEXT,
        tool_use_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_category TEXT DEFAULT 'other',
        outcome TEXT DEFAULT 'pending',
        input_summary TEXT,
        output_summary TEXT,
        is_error INTEGER DEFAULT 0,
        exit_code INTEGER,
        duration_ms INTEGER,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
      )
    `);

    // v2: subagent_links (replaces subagents)
    db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_links (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        child_session_id TEXT,
        agent_id TEXT NOT NULL,
        agent_role TEXT,
        slug TEXT,
        file_path TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        spawned_at INTEGER,
        FOREIGN KEY (parent_session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
      )
    `);

    // v2: context_compactions
    db.exec(`
      CREATE TABLE IF NOT EXISTS context_compactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        compacted_at INTEGER NOT NULL,
        messages_before INTEGER,
        messages_after INTEGER,
        summary TEXT,
        FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
      )
    `);

    // v2: system_events
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        event_type TEXT NOT NULL,
        message TEXT,
        metadata TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
      )
    `);

    // Keep sync_state
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_state (
        file_path TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        last_position INTEGER DEFAULT 0,
        last_modified INTEGER DEFAULT 0,
        session_id TEXT,
        conversation_id TEXT,
        parser_version INTEGER DEFAULT 0
      )
    `);

    // Migrate old data if needed
    this.migrateFromV1();
  }

  private createIndexes(): void {
    const db = this.getDb();
    const indexes = [
      // work_sessions
      'CREATE INDEX IF NOT EXISTS idx_ws_platform ON work_sessions(platform)',
      'CREATE INDEX IF NOT EXISTS idx_ws_started ON work_sessions(started_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_ws_project ON work_sessions(project_path)',
      'CREATE INDEX IF NOT EXISTS idx_ws_session ON work_sessions(session_id)',
      // turns
      'CREATE INDEX IF NOT EXISTS idx_turn_session ON turns(session_id)',
      'CREATE INDEX IF NOT EXISTS idx_turn_seq ON turns(session_id, sequence)',
      // messages
      'CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id)',
      'CREATE INDEX IF NOT EXISTS idx_msg_turn ON messages(turn_id)',
      'CREATE INDEX IF NOT EXISTS idx_msg_source ON messages(source)',
      'CREATE INDEX IF NOT EXISTS idx_msg_timestamp ON messages(timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_msg_parent ON messages(parent_id)',
      // tool_executions
      'CREATE INDEX IF NOT EXISTS idx_tool_session ON tool_executions(session_id)',
      'CREATE INDEX IF NOT EXISTS idx_tool_turn ON tool_executions(turn_id)',
      'CREATE INDEX IF NOT EXISTS idx_tool_use_id ON tool_executions(tool_use_id)',
      'CREATE INDEX IF NOT EXISTS idx_tool_category ON tool_executions(tool_category)',
      // subagent_links
      'CREATE INDEX IF NOT EXISTS idx_sub_parent ON subagent_links(parent_session_id)',
      // system_events
      'CREATE INDEX IF NOT EXISTS idx_evt_session ON system_events(session_id)',
      'CREATE INDEX IF NOT EXISTS idx_evt_type ON system_events(event_type)',
    ];
    for (const sql of indexes) {
      db.exec(sql);
    }
  }

  private createFTS(): void {
    const db = this.getDb();
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output,
        content='messages',
        content_rowid='rowid'
      )
    `);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        title, summary,
        content='work_sessions',
        content_rowid='rowid'
      )
    `);

    // Triggers to keep FTS in sync
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS msg_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
        VALUES (new.rowid, new.content_text, new.content_thinking, new.content_tool_name, new.content_tool_input, new.content_tool_output);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS msg_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
        VALUES ('delete', old.rowid, old.content_text, old.content_thinking, old.content_tool_name, old.content_tool_input, old.content_tool_output);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS msg_fts_update AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
        VALUES ('delete', old.rowid, old.content_text, old.content_thinking, old.content_tool_name, old.content_tool_input, old.content_tool_output);
        INSERT INTO messages_fts(rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
        VALUES (new.rowid, new.content_text, new.content_thinking, new.content_tool_name, new.content_tool_input, new.content_tool_output);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ws_fts_insert AFTER INSERT ON work_sessions BEGIN
        INSERT INTO sessions_fts(rowid, title, summary)
        VALUES (new.rowid, new.title, new.summary);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ws_fts_delete AFTER DELETE ON work_sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, title, summary)
        VALUES ('delete', old.rowid, old.title, old.summary);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ws_fts_update AFTER UPDATE ON work_sessions BEGIN
        INSERT INTO sessions_fts(sessions_fts, rowid, title, summary)
        VALUES ('delete', old.rowid, old.title, old.summary);
        INSERT INTO sessions_fts(rowid, title, summary)
        VALUES (new.rowid, new.title, new.summary);
      END
    `);
  }

  // ==================== Migration ====================

  private migrateFromV1(): void {
    const db = this.getDb();
    // Check if old conversations table exists
    const hasOld = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'"
    ).get();
    if (!hasOld) return;

    // Migrate conversations → work_sessions
    const oldConvs = db.prepare('SELECT * FROM conversations').all() as any[];
    if (oldConvs.length > 0) {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO work_sessions (
          id, session_id, platform, platform_version, project_path, git_branch, git_remote, model,
          title, summary, tags, status,
          started_at, ended_at, last_activity_at, duration_ms,
          message_count, user_input_count, assistant_message_count,
          thinking_count, tool_call_count, code_block_count, turn_count,
          total_input_tokens, total_output_tokens, total_cache_creation_tokens, total_cache_read_tokens,
          has_subagents, has_context_compaction, claude_code_version, created_at, updated_at
        ) VALUES (
          @id, @session_id, @platform, @platform_version, @project_path, @git_branch, @git_remote, @model,
          @title, @summary, @tags, @status,
          @started_at, @ended_at, @last_activity_at, @duration_ms,
          @message_count, @user_input_count, @assistant_message_count,
          @thinking_count, @tool_call_count, @code_block_count, 0,
          @total_input_tokens, @total_output_tokens, @total_cache_creation_tokens, @total_cache_read_tokens,
          @has_subagents, 0, @claude_code_version, @created_at, @updated_at
        )
      `);
      const migrate = db.transaction(() => {
        for (const r of oldConvs) {
          stmt.run({
            id: r.id,
            session_id: r.session_id,
            platform: r.platform,
            platform_version: r.platform_version ?? null,
            project_path: r.project_path ?? '',
            git_branch: r.git_branch ?? null,
            git_remote: r.git_remote ?? null,
            model: r.model ?? null,
            title: r.title ?? 'Untitled',
            summary: r.summary ?? null,
            tags: r.tags ?? '[]',
            status: r.status ?? 'active',
            started_at: r.started_at,
            ended_at: r.ended_at ?? null,
            last_activity_at: r.last_activity_at,
            duration_ms: r.duration_ms ?? 0,
            message_count: r.message_count ?? 0,
            user_input_count: r.user_message_count ?? 0,
            assistant_message_count: r.assistant_message_count ?? 0,
            thinking_count: r.thinking_count ?? 0,
            tool_call_count: r.tool_call_count ?? 0,
            code_block_count: r.code_block_count ?? 0,
            total_input_tokens: r.total_input_tokens ?? 0,
            total_output_tokens: r.total_output_tokens ?? 0,
            total_cache_creation_tokens: r.total_cache_creation_tokens ?? 0,
            total_cache_read_tokens: r.total_cache_read_tokens ?? 0,
            has_subagents: r.has_subagents ?? 0,
            claude_code_version: r.claude_code_version ?? null,
            created_at: r.created_at,
            updated_at: r.updated_at,
          });
        }
      });
      migrate();
    }

    // Migrate old messages (add session_id alias, source default)
    const hasOldMsgs = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='messages' AND sql LIKE '%conversation_id%'"
    ).get();
    if (hasOldMsgs) {
      // Old messages table has conversation_id, new one has session_id
      // We need to drop old and re-sync, since schema changed significantly
      // Clear sync_state to force re-sync
      db.exec('DELETE FROM sync_state');
    }

    // Drop old tables after migration
    db.exec('DROP TABLE IF EXISTS subagents');
    db.exec('DROP TABLE IF EXISTS conversations_fts');
    // Drop old conversations table (data migrated to work_sessions)
    db.exec('DROP TABLE IF EXISTS conversations');
  }

  /**
   * Apply pending schema migrations in version order. Each migration runs
   * once inside a transaction together with its schema_migrations record.
   * A migration may return a note (e.g. migration 5 skipping itself when the
   * SQLite build has no trigram tokenizer) which is stored in the `note`
   * column — the version is still recorded so startup never retries it.
   */
  private runMigrations(): void {
    const db = this.getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    // Added with migration 5; older databases pick it up here idempotently.
    if (!hasColumn(db, 'schema_migrations', 'note')) {
      db.exec('ALTER TABLE schema_migrations ADD COLUMN note TEXT');
    }
    const applied = new Set(
      (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
        .map(row => row.version),
    );
    const record = db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at, note) VALUES (?, ?, ?, ?)'
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      db.transaction(() => {
        const note = migration.up(db);
        record.run(migration.version, migration.name, new Date().toISOString(), note ?? null);
      })();
    }
  }

  // ==================== WorkSession CRUD ====================

  upsertWorkSession(s: WorkSession): void {
    const db = this.getDb();
    db.prepare(`
      INSERT INTO work_sessions (
        id, session_id, platform, host, platform_version, project_path, git_branch, git_remote, model, models,
        title, summary, tags, status,
        started_at, ended_at, last_activity_at, duration_ms,
        message_count, user_input_count, assistant_message_count,
        thinking_count, tool_call_count, code_block_count, turn_count,
        total_input_tokens, total_output_tokens, total_cache_creation_tokens, total_cache_read_tokens,
        has_subagents, has_context_compaction, agent_meta, claude_code_version, session_type, forked_from, created_at, updated_at
      ) VALUES (
        @id, @sessionId, @platform, @host, @platformVersion, @projectPath, @gitBranch, @gitRemote, @model, @models,
        @title, @summary, @tags, @status,
        @startedAt, @endedAt, @lastActivityAt, @durationMs,
        @messageCount, @userInputCount, @assistantMessageCount,
        @thinkingCount, @toolCallCount, @codeBlockCount, @turnCount,
        @totalInputTokens, @totalOutputTokens, @totalCacheCreationTokens, @totalCacheReadTokens,
        @hasSubagents, @hasContextCompaction, @agentMeta, @claudeCodeVersion, @sessionType, @forkedFrom, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        host = excluded.host,
        platform_version = excluded.platform_version,
        project_path = excluded.project_path,
        git_branch = excluded.git_branch,
        git_remote = excluded.git_remote,
        model = excluded.model,
        title = excluded.title,
        summary = COALESCE(work_sessions.summary, excluded.summary),
        status = excluded.status,
        ended_at = excluded.ended_at,
        last_activity_at = MAX(work_sessions.last_activity_at, excluded.last_activity_at),
        duration_ms = MAX(work_sessions.duration_ms, excluded.duration_ms),
        message_count = MAX(work_sessions.message_count, excluded.message_count),
        user_input_count = MAX(work_sessions.user_input_count, excluded.user_input_count),
        assistant_message_count = MAX(work_sessions.assistant_message_count, excluded.assistant_message_count),
        thinking_count = MAX(work_sessions.thinking_count, excluded.thinking_count),
        tool_call_count = MAX(work_sessions.tool_call_count, excluded.tool_call_count),
        code_block_count = MAX(work_sessions.code_block_count, excluded.code_block_count),
        turn_count = MAX(work_sessions.turn_count, excluded.turn_count),
        total_input_tokens = MAX(work_sessions.total_input_tokens, excluded.total_input_tokens),
        total_output_tokens = MAX(work_sessions.total_output_tokens, excluded.total_output_tokens),
        total_cache_creation_tokens = MAX(work_sessions.total_cache_creation_tokens, excluded.total_cache_creation_tokens),
        total_cache_read_tokens = MAX(work_sessions.total_cache_read_tokens, excluded.total_cache_read_tokens),
        has_subagents = excluded.has_subagents,
        has_context_compaction = excluded.has_context_compaction,
        agent_meta = excluded.agent_meta,
        session_type = excluded.session_type,
        models = excluded.models,
        -- Lineage, once known (parse-time meta or fork detection), is sticky:
        -- a routine resync carries no lineage info and must not wipe it.
        forked_from = COALESCE(excluded.forked_from, work_sessions.forked_from),
        updated_at = excluded.updated_at
    `).run({
      id: s.id,
      sessionId: s.sessionId,
      platform: s.platform,
      host: s.host ?? 'native',
      platformVersion: s.platformVersion ?? null,
      projectPath: s.projectPath ?? '',
      gitBranch: s.gitBranch ?? null,
      gitRemote: s.gitRemote ?? null,
      model: s.model ?? null,
      models: s.models ?? null,
      title: s.title,
      summary: s.summary ?? null,
      tags: JSON.stringify(s.tags ?? []),
      status: s.status ?? 'active',
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      lastActivityAt: s.lastActivityAt,
      durationMs: s.durationMs ?? 0,
      messageCount: s.messageCount ?? 0,
      userInputCount: s.userInputCount ?? 0,
      assistantMessageCount: s.assistantMessageCount ?? 0,
      thinkingCount: s.thinkingCount ?? 0,
      toolCallCount: s.toolCallCount ?? 0,
      codeBlockCount: s.codeBlockCount ?? 0,
      turnCount: s.turnCount ?? 0,
      totalInputTokens: s.totalInputTokens ?? 0,
      totalOutputTokens: s.totalOutputTokens ?? 0,
      totalCacheCreationTokens: s.totalCacheCreationTokens ?? 0,
      totalCacheReadTokens: s.totalCacheReadTokens ?? 0,
      hasSubagents: s.hasSubagents ? 1 : 0,
      hasContextCompaction: s.hasContextCompaction ? 1 : 0,
      agentMeta: s.agentMeta ?? null,
      claudeCodeVersion: s.claudeCodeVersion ?? null,
      sessionType: s.sessionType ?? 'conversation',
      forkedFrom: s.forkedFrom ?? null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
    this.upsertProjectForSession(s);
  }

  /**
   * Keep project_registry in step with work_sessions (P1.5): every session
   * upsert refreshes its project's first/last_seen. The key is derived with
   * the same pure function TreeIndex uses, so both always agree.
   */
  private upsertProjectForSession(s: WorkSession): void {
    const host = s.host ?? 'native';
    const basis = projectBasis({ projectPath: s.projectPath ?? '', gitRemote: s.gitRemote });
    const projectKey = deriveProjectKey({ platform: s.platform, host, projectPath: s.projectPath ?? '', gitRemote: s.gitRemote });
    const firstSeen = new Date(s.startedAt || s.lastActivityAt || Date.now()).toISOString();
    const lastSeen = new Date(s.lastActivityAt || s.startedAt || Date.now()).toISOString();
    this.getDb().prepare(`
      INSERT INTO project_registry (project_key, kind, label, path_or_domain, first_seen, last_seen)
      VALUES (@projectKey, 'cli_path', @label, @pathOrDomain, @firstSeen, @lastSeen)
      ON CONFLICT(project_key) DO UPDATE SET
        first_seen = CASE WHEN excluded.first_seen < project_registry.first_seen
          THEN excluded.first_seen ELSE project_registry.first_seen END,
        last_seen = CASE WHEN excluded.last_seen > project_registry.last_seen
          THEN excluded.last_seen ELSE project_registry.last_seen END,
        label = excluded.label,
        path_or_domain = excluded.path_or_domain
    `).run({
      projectKey,
      label: projectLabel(basis),
      pathOrDomain: basis,
      firstSeen,
      lastSeen,
    });
  }

  getWorkSession(id: string): WorkSession | null {
    const row = this.getDb().prepare('SELECT * FROM work_sessions WHERE id = ?').get(id) as any;
    return row ? this.rowToWorkSession(row) : null;
  }

  getWorkSessionBySessionId(sessionId: string): WorkSession | null {
    const row = this.getDb().prepare('SELECT * FROM work_sessions WHERE session_id = ?').get(sessionId) as any;
    return row ? this.rowToWorkSession(row) : null;
  }

  listWorkSessions(opts?: { platform?: string; sessionType?: string; limit?: number; offset?: number }): WorkSession[] {
    let sql = 'SELECT * FROM work_sessions WHERE 1=1';
    const params: any[] = [];

    if (opts?.platform) {
      sql += ' AND platform = ?';
      params.push(opts.platform);
    }
    if (opts?.sessionType) {
      sql += ' AND session_type = ?';
      params.push(opts.sessionType);
    }
    sql += ' ORDER BY started_at DESC';
    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }
    if (opts?.offset) {
      sql += ' OFFSET ?';
      params.push(opts.offset);
    }

    return (this.getDb().prepare(sql).all(...params) as any[]).map(r => this.rowToWorkSession(r));
  }

  /**
   * Session + ordered messages bundle — the read unit of the digest pipeline
   * (implements DigestSessionStore.getSessionDetail).
   */
  getSessionDetail(id: string): { session: WorkSession; messages: SessionMessage[] } | null {
    const session = this.getWorkSession(id);
    if (!session) return null;
    return { session, messages: this.getSessionMessages(id) };
  }

  // ==================== Turns CRUD ====================

  insertTurns(turns: Turn[]): void {
    if (turns.length === 0) return;
    const db = this.getDb();

    const stmt = db.prepare(`
      INSERT INTO turns (
        id, session_id, sequence, user_input, user_input_message_id,
        assistant_response, assistant_response_message_id,
        message_count, tool_execution_count, thinking_tokens,
        input_tokens, output_tokens,
        started_at, ended_at, duration_ms
      ) VALUES (
        @id, @sessionId, @sequence, @userInput, @userInputMessageId,
        @assistantResponse, @assistantResponseMessageId,
        @messageCount, @toolExecutionCount, @thinkingTokens,
        @inputTokens, @outputTokens,
        @startedAt, @endedAt, @durationMs
      )
      ON CONFLICT(id) DO UPDATE SET
        user_input = excluded.user_input,
        user_input_message_id = excluded.user_input_message_id,
        assistant_response = excluded.assistant_response,
        assistant_response_message_id = excluded.assistant_response_message_id,
        message_count = excluded.message_count,
        tool_execution_count = excluded.tool_execution_count,
        thinking_tokens = excluded.thinking_tokens,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        duration_ms = excluded.duration_ms
    `);

    const insertMany = db.transaction((items: Turn[]) => {
      for (const t of items) {
        stmt.run({
          id: t.id,
          sessionId: t.sessionId,
          sequence: t.sequence,
          userInput: t.userInput ?? null,
          userInputMessageId: t.userInputMessageId ?? null,
          assistantResponse: t.assistantResponse ?? null,
          assistantResponseMessageId: t.assistantResponseMessageId ?? null,
          messageCount: t.messageCount ?? 0,
          toolExecutionCount: t.toolExecutionCount ?? 0,
          thinkingTokens: t.thinkingTokens ?? 0,
          inputTokens: t.inputTokens ?? 0,
          outputTokens: t.outputTokens ?? 0,
          startedAt: t.startedAt,
          endedAt: t.endedAt ?? null,
          durationMs: t.durationMs ?? 0,
        });
      }
    });

    insertMany(turns);
  }

  getTurns(sessionId: string): Turn[] {
    return (this.getDb().prepare(
      'SELECT * FROM turns WHERE session_id = ? ORDER BY sequence'
    ).all(sessionId) as any[]).map(r => ({
      id: r.id,
      sessionId: r.session_id,
      sequence: r.sequence,
      userInput: r.user_input,
      userInputMessageId: r.user_input_message_id,
      assistantResponse: r.assistant_response,
      assistantResponseMessageId: r.assistant_response_message_id,
      messageCount: r.message_count,
      toolExecutionCount: r.tool_execution_count,
      thinkingTokens: r.thinking_tokens,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      durationMs: r.duration_ms,
    }));
  }

  // ==================== Messages CRUD ====================

  insertSessionMessages(messages: SessionMessage[]): void {
    if (messages.length === 0) return;
    const db = this.getDb();

    const stmt = db.prepare(`
      INSERT INTO messages (
        id, session_id, turn_id, source, sequence, role,
        content_text, content_thinking, content_tool_name, content_tool_input,
        content_tool_output, content_tool_error,
        cwd, git_branch,
        token_input, token_output, token_cache_creation, token_cache_read, token_reasoning,
        model, stop_reason, parent_id, depth, is_sidechain, agent_id,
        timestamp, created_at
      ) VALUES (
        @id, @sessionId, @turnId, @source, @sequence, @role,
        @contentText, @contentThinking, @contentToolName, @contentToolInput,
        @contentToolOutput, @contentToolError,
        @cwd, @gitBranch,
        @tokenInput, @tokenOutput, @tokenCacheCreation, @tokenCacheRead, @tokenReasoning,
        @model, @stopReason, @parentId, @depth, @isSidechain, @agentId,
        @timestamp, @createdAt
      )
      ON CONFLICT(id) DO UPDATE SET
        turn_id = excluded.turn_id,
        source = excluded.source,
        sequence = excluded.sequence,
        role = excluded.role,
        content_text = excluded.content_text,
        content_thinking = excluded.content_thinking,
        content_tool_name = excluded.content_tool_name,
        content_tool_input = excluded.content_tool_input,
        content_tool_output = excluded.content_tool_output,
        content_tool_error = excluded.content_tool_error,
        cwd = excluded.cwd,
        git_branch = excluded.git_branch,
        token_input = excluded.token_input,
        token_output = excluded.token_output,
        token_cache_creation = excluded.token_cache_creation,
        token_cache_read = excluded.token_cache_read,
        token_reasoning = excluded.token_reasoning,
        model = excluded.model,
        stop_reason = excluded.stop_reason,
        parent_id = excluded.parent_id,
        depth = excluded.depth,
        is_sidechain = excluded.is_sidechain,
        agent_id = excluded.agent_id,
        timestamp = excluded.timestamp
    `);

    const insertMany = db.transaction((msgs: SessionMessage[]) => {
      for (const m of msgs) {
        stmt.run({
          id: m.id,
          sessionId: m.sessionId,
          turnId: m.turnId ?? null,
          source: m.source,
          sequence: m.sequence ?? 0,
          role: m.role,
          contentText: m.contentText ?? null,
          contentThinking: m.contentThinking ?? null,
          contentToolName: m.contentToolName ?? null,
          contentToolInput: m.contentToolInput ?? null,
          contentToolOutput: m.contentToolOutput ?? null,
          contentToolError: m.contentToolError ?? null,
          cwd: m.cwd ?? null,
          gitBranch: m.gitBranch ?? null,
          tokenInput: m.tokenInput ?? null,
          tokenOutput: m.tokenOutput ?? null,
          tokenCacheCreation: m.tokenCacheCreation ?? null,
          tokenCacheRead: m.tokenCacheRead ?? null,
          tokenReasoning: m.tokenReasoning ?? null,
          model: m.model ?? null,
          stopReason: m.stopReason ?? null,
          parentId: m.parentId ?? null,
          depth: m.depth ?? 0,
          isSidechain: m.isSidechain ? 1 : 0,
          agentId: m.agentId ?? null,
          timestamp: m.timestamp,
          createdAt: m.createdAt,
        });
      }
    });

    insertMany(messages);
  }

  getSessionMessages(sessionId: string, opts?: { source?: string }): SessionMessage[] {
    let sql = 'SELECT * FROM messages WHERE session_id = ?';
    const params: any[] = [sessionId];
    if (opts?.source) {
      sql += ' AND source = ?';
      params.push(opts.source);
    }
    sql += ' ORDER BY sequence, timestamp';
    return (this.getDb().prepare(sql).all(...params) as any[]).map(r => this.rowToSessionMessage(r));
  }

  /**
   * Batch variant of getSessionMessages: one query per 500-id chunk instead
   * of one round trip per session. Full-snapshot export over a few thousand
   * sessions otherwise issues that many individual SELECTs (N+1). Returns
   * messages grouped by session id; each group's ordering matches
   * getSessionMessages (sequence, timestamp).
   */
  getSessionMessagesBatch(sessionIds: string[]): Map<string, SessionMessage[]> {
    const grouped = new Map<string, SessionMessage[]>();
    if (sessionIds.length === 0) return grouped;
    const db = this.getDb();
    const CHUNK_SIZE = 500; // SQLite's default host-variable limit is 999
    for (let offset = 0; offset < sessionIds.length; offset += CHUNK_SIZE) {
      const chunk = sessionIds.slice(offset, offset + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT * FROM messages WHERE session_id IN (${placeholders}) ORDER BY session_id, sequence, timestamp`
      ).all(...chunk) as any[];
      for (const row of rows) {
        const message = this.rowToSessionMessage(row);
        const list = grouped.get(message.sessionId);
        if (list) {
          list.push(message);
        } else {
          grouped.set(message.sessionId, [message]);
        }
      }
    }
    return grouped;
  }

  getSessionMessageCount(sessionId: string): number {
    const row = this.getDb().prepare(
      'SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?'
    ).get(sessionId) as any;
    return row?.cnt ?? 0;
  }

  // ==================== Tool Executions ====================

  insertUnifiedToolExecutions(executions: UnifiedToolExecution[]): void {
    if (executions.length === 0) return;
    const db = this.getDb();

    const stmt = db.prepare(`
      INSERT INTO tool_executions (
        id, session_id, turn_id, sequence,
        tool_use_message_id, tool_result_message_id,
        tool_use_id, tool_name, tool_category, outcome,
        input_summary, output_summary,
        is_error, exit_code, duration_ms, timestamp
      ) VALUES (
        @id, @sessionId, @turnId, @sequence,
        @toolUseMessageId, @toolResultMessageId,
        @toolUseId, @toolName, @toolCategory, @outcome,
        @inputSummary, @outputSummary,
        @isError, @exitCode, @durationMs, @timestamp
      )
      ON CONFLICT(id) DO UPDATE SET
        turn_id = excluded.turn_id,
        sequence = excluded.sequence,
        tool_result_message_id = excluded.tool_result_message_id,
        tool_name = excluded.tool_name,
        tool_category = excluded.tool_category,
        outcome = excluded.outcome,
        input_summary = excluded.input_summary,
        output_summary = excluded.output_summary,
        is_error = excluded.is_error,
        exit_code = excluded.exit_code,
        duration_ms = excluded.duration_ms,
        timestamp = excluded.timestamp
    `);

    const insertMany = db.transaction((execs: UnifiedToolExecution[]) => {
      for (const e of execs) {
        stmt.run({
          id: e.id,
          sessionId: e.sessionId,
          turnId: e.turnId ?? null,
          sequence: e.sequence ?? 0,
          toolUseMessageId: e.toolUseMessageId,
          toolResultMessageId: e.toolResultMessageId ?? null,
          toolUseId: e.toolUseId,
          toolName: e.toolName,
          toolCategory: e.toolCategory ?? 'other',
          outcome: e.outcome ?? 'pending',
          inputSummary: e.inputSummary ?? null,
          outputSummary: e.outputSummary ?? null,
          isError: e.isError ? 1 : 0,
          exitCode: e.exitCode ?? null,
          durationMs: e.durationMs ?? null,
          timestamp: e.timestamp,
        });
      }
    });

    insertMany(executions);
  }

  getUnifiedToolExecutions(sessionId: string): UnifiedToolExecution[] {
    return (this.getDb().prepare(
      'SELECT * FROM tool_executions WHERE session_id = ? ORDER BY sequence, timestamp'
    ).all(sessionId) as any[]).map(r => ({
      id: r.id,
      sessionId: r.session_id,
      turnId: r.turn_id,
      sequence: r.sequence,
      toolUseMessageId: r.tool_use_message_id,
      toolResultMessageId: r.tool_result_message_id,
      toolUseId: r.tool_use_id,
      toolName: r.tool_name,
      toolCategory: r.tool_category,
      outcome: r.outcome,
      inputSummary: r.input_summary,
      outputSummary: r.output_summary,
      isError: r.is_error === 1,
      exitCode: r.exit_code,
      durationMs: r.duration_ms,
      timestamp: r.timestamp,
    }));
  }

  /**
   * P4a relay quality: raw file-tool touch rows (read/write/edit) across a set
   * of sessions, oldest first. The deterministic key-file extraction aggregates
   * these into anchored file lists — the handoff pack's file section is
   * grounded on captured tool executions, not on model recollection.
   */
  listFileToolTouches(sessionIds: string[], maxRows = 5_000): Array<{
    sessionId: string;
    toolName: string;
    toolCategory: string;
    inputSummary: string | null;
    timestamp: number;
  }> {
    const unique = [...new Set(sessionIds)].filter(id => typeof id === 'string' && id.length > 0);
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(', ');
    return (this.getDb().prepare(
      `SELECT session_id, tool_name, tool_category, input_summary, timestamp
       FROM tool_executions
       WHERE tool_category IN ('file_read', 'file_write', 'file_edit')
         AND session_id IN (${placeholders})
       ORDER BY timestamp
       LIMIT ?`
    ).all(...unique, maxRows) as any[]).map(r => ({
      sessionId: r.session_id,
      toolName: r.tool_name,
      toolCategory: r.tool_category,
      inputSummary: r.input_summary,
      timestamp: r.timestamp,
    }));
  }

  // ==================== Subagent Links ====================

  insertSubagentLink(link: SubagentLink): void {
    this.getDb().prepare(`
      INSERT INTO subagent_links (
        id, parent_session_id, child_session_id, agent_id, agent_role, slug, file_path, message_count, spawned_at
      ) VALUES (
        @id, @parentSessionId, @childSessionId, @agentId, @agentRole, @slug, @filePath, @messageCount, @spawnedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        child_session_id = COALESCE(excluded.child_session_id, child_session_id)
    `).run({
      id: link.id,
      parentSessionId: link.parentSessionId,
      childSessionId: link.childSessionId ?? null,
      agentId: link.agentId,
      agentRole: link.agentRole ?? null,
      slug: link.slug ?? null,
      filePath: link.filePath,
      messageCount: link.messageCount ?? 0,
      spawnedAt: link.spawnedAt ?? null,
    });
    // A child has exactly one parent: once a link names the child session,
    // drop rows that mount the same child elsewhere (e.g. stale rows from
    // before nested parentAgentId lineage was honored).
    if (link.childSessionId) {
      this.getDb().prepare(
        'DELETE FROM subagent_links WHERE child_session_id = ? AND id != ?'
      ).run(link.childSessionId, link.id);
    }
  }

  getSubagentLinks(sessionId: string): SubagentLink[] {
    return (this.getDb().prepare(
      'SELECT * FROM subagent_links WHERE parent_session_id = ?'
    ).all(sessionId) as any[]).map(r => ({
      id: r.id,
      parentSessionId: r.parent_session_id,
      childSessionId: r.child_session_id,
      agentId: r.agent_id,
      agentRole: r.agent_role,
      slug: r.slug,
      filePath: r.file_path,
      messageCount: r.message_count,
      spawnedAt: r.spawned_at,
    }));
  }

  /**
   * Work-session ids that are linked as subagent children (A1). Downstream
   * surfaces (stats, recent lists, exports) treat these as folded into their
   * parent conversation rather than standalone entries.
   */
  getSubagentChildIds(): Set<string> {
    const rows = this.getDb().prepare(
      'SELECT DISTINCT child_session_id AS id FROM subagent_links WHERE child_session_id IS NOT NULL'
    ).all() as Array<{ id: string }>;
    return new Set(rows.map(r => r.id));
  }

  /**
   * child work-session id → { parentSessionId, agentRole } for every resolved
   * link. Single query; used to stamp lineage on conversation exports.
   */
  getSubagentLineageByChild(): Map<string, { parentSessionId: string; agentRole: string | null }> {
    const rows = this.getDb().prepare(
      'SELECT child_session_id AS child, parent_session_id AS parent, agent_role AS role FROM subagent_links WHERE child_session_id IS NOT NULL'
    ).all() as Array<{ child: string; parent: string; role: string | null }>;
    const map = new Map<string, { parentSessionId: string; agentRole: string | null }>();
    for (const row of rows) {
      if (!map.has(row.child)) map.set(row.child, { parentSessionId: row.parent, agentRole: row.role });
    }
    return map;
  }

  /**
   * Compact per-child brief for one parent session: role, title, size and
   * the child's digest one-liner when the digest pipeline has produced one.
   * Feeds progressive disclosure downstream (agent transcripts, relay packs)
   * so folded subagent work stays visible without loading child transcripts.
   */
  getSubagentBriefs(parentSessionId: string): Array<{
    childSessionId: string;
    agentRole: string | null;
    title: string;
    messageCount: number;
    oneLiner: string | null;
  }> {
    try {
      const rows = this.getDb().prepare(`
        SELECT sl.child_session_id AS child, COALESCE(sl.agent_role, sl.slug) AS role,
               ws.title AS title, ws.message_count AS mc, sd.one_liner AS ol
        FROM subagent_links sl
        JOIN work_sessions ws ON ws.id = sl.child_session_id
        LEFT JOIN session_digests sd ON sd.session_id = sl.child_session_id
        WHERE sl.parent_session_id = ? AND sl.child_session_id IS NOT NULL
        ORDER BY ws.started_at
      `).all(parentSessionId) as Array<{ child: string; role: string | null; title: string; mc: number | null; ol: string | null }>;
      return rows.map(r => ({
        childSessionId: r.child,
        agentRole: r.role,
        title: r.title,
        messageCount: r.mc ?? 0,
        oneLiner: r.ol,
      }));
    } catch {
      return []; // pre-A1 schema — degrade silently
    }
  }

  getUnresolvedSubagentLinks(): Array<SubagentLink & { id: string }> {
    return (this.getDb().prepare(
      'SELECT * FROM subagent_links WHERE child_session_id IS NULL'
    ).all() as any[]).map(r => ({
      id: r.id,
      parentSessionId: r.parent_session_id,
      childSessionId: r.child_session_id,
      agentId: r.agent_id,
      agentRole: r.agent_role,
      slug: r.slug,
      filePath: r.file_path,
      messageCount: r.message_count,
      spawnedAt: r.spawned_at,
    }));
  }

  updateSubagentLinkChild(linkId: string, childSessionId: string): void {
    const db = this.getDb();
    db.prepare(
      'UPDATE subagent_links SET child_session_id = ? WHERE id = ?'
    ).run(childSessionId, linkId);
    // Same single-parent invariant as insertSubagentLink.
    db.prepare(
      'DELETE FROM subagent_links WHERE child_session_id = ? AND id != ?'
    ).run(childSessionId, linkId);
  }

  // ==================== Context Compactions ====================

  insertContextCompactions(compactions: ContextCompaction[]): void {
    if (compactions.length === 0) return;
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO context_compactions (
        id, session_id, sequence, compacted_at, messages_before, messages_after, summary
      ) VALUES (@id, @sessionId, @sequence, @compactedAt, @messagesBefore, @messagesAfter, @summary)
    `);
    const insertMany = db.transaction((items: ContextCompaction[]) => {
      for (const c of items) {
        stmt.run({
          id: c.id,
          sessionId: c.sessionId,
          sequence: c.sequence,
          compactedAt: c.compactedAt,
          messagesBefore: c.messagesBefore ?? null,
          messagesAfter: c.messagesAfter ?? null,
          summary: c.summary ?? null,
        });
      }
    });
    insertMany(compactions);
  }

  getContextCompactions(sessionId: string): ContextCompaction[] {
    return (this.getDb().prepare(
      'SELECT * FROM context_compactions WHERE session_id = ? ORDER BY sequence'
    ).all(sessionId) as any[]).map(r => ({
      id: r.id,
      sessionId: r.session_id,
      sequence: r.sequence,
      compactedAt: r.compacted_at,
      messagesBefore: r.messages_before,
      messagesAfter: r.messages_after,
      summary: r.summary,
    }));
  }

  // ==================== System Events ====================

  insertSystemEvents(events: SystemEvent[]): void {
    if (events.length === 0) return;
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO system_events (
        id, session_id, turn_id, event_type, message, metadata, timestamp
      ) VALUES (@id, @sessionId, @turnId, @eventType, @message, @metadata, @timestamp)
    `);
    const insertMany = db.transaction((items: SystemEvent[]) => {
      for (const e of items) {
        stmt.run({
          id: e.id,
          sessionId: e.sessionId,
          turnId: e.turnId ?? null,
          eventType: e.eventType,
          message: e.message ?? null,
          metadata: e.metadata ?? null,
          timestamp: e.timestamp,
        });
      }
    });
    insertMany(events);
  }

  getSystemEvents(sessionId: string): SystemEvent[] {
    return (this.getDb().prepare(
      'SELECT * FROM system_events WHERE session_id = ? ORDER BY timestamp'
    ).all(sessionId) as any[]).map(r => ({
      id: r.id,
      sessionId: r.session_id,
      turnId: r.turn_id,
      eventType: r.event_type,
      message: r.message,
      metadata: r.metadata,
      timestamp: r.timestamp,
    }));
  }

  // ==================== Sync State ====================

  getSyncState(filePath: string): { lastPosition: number; lastModified: number; conversationId?: string; parserVersion: number } | null {
    const row = this.getDb().prepare('SELECT * FROM sync_state WHERE file_path = ?').get(filePath) as any;
    if (!row) return null;
    return { lastPosition: row.last_position, lastModified: row.last_modified, conversationId: row.conversation_id, parserVersion: row.parser_version ?? 0 };
  }

  setSyncState(filePath: string, platform: string, position: number, modified: number, sessionId?: string, conversationId?: string, parserVersion = 0): void {
    this.getDb().prepare(`
      INSERT INTO sync_state (file_path, platform, last_position, last_modified, session_id, conversation_id, parser_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        last_position = excluded.last_position,
        last_modified = excluded.last_modified,
        conversation_id = COALESCE(excluded.conversation_id, conversation_id),
        parser_version = excluded.parser_version
    `).run(filePath, platform, position, modified, sessionId ?? null, conversationId ?? null, parserVersion);
  }

  // ==================== Session Digests (P1.5) ====================

  upsertSessionDigest(digest: SessionDigest): void {
    this.getDb().prepare(`
      INSERT INTO session_digests (
        session_id, host, platform, project_key, one_liner,
        key_topics, key_files, decisions, open_questions,
        embedding, embedding_provider, embedding_model, embedding_dimensions,
        embedding_version, embedding_status, digest_version, message_count, updated_at
      ) VALUES (
        @sessionId, @host, @platform, @projectKey, @oneLiner,
        @keyTopics, @keyFiles, @decisions, @openQuestions,
        @embedding, @embeddingProvider, @embeddingModel, @embeddingDimensions,
        @embeddingVersion, @embeddingStatus, @digestVersion, @messageCount, @updatedAt
      )
      ON CONFLICT(session_id) DO UPDATE SET
        host = excluded.host,
        platform = excluded.platform,
        project_key = excluded.project_key,
        one_liner = excluded.one_liner,
        key_topics = excluded.key_topics,
        key_files = excluded.key_files,
        decisions = excluded.decisions,
        open_questions = excluded.open_questions,
        embedding = excluded.embedding,
        embedding_provider = excluded.embedding_provider,
        embedding_model = excluded.embedding_model,
        embedding_dimensions = excluded.embedding_dimensions,
        embedding_version = excluded.embedding_version,
        embedding_status = excluded.embedding_status,
        digest_version = excluded.digest_version,
        message_count = excluded.message_count,
        updated_at = excluded.updated_at
    `).run({
      sessionId: digest.sessionId,
      host: digest.host,
      platform: digest.platform,
      projectKey: digest.projectKey,
      oneLiner: digest.oneLiner,
      keyTopics: JSON.stringify(digest.keyTopics ?? []),
      keyFiles: JSON.stringify(digest.keyFiles ?? []),
      decisions: JSON.stringify(digest.decisions ?? []),
      openQuestions: JSON.stringify(digest.openQuestions ?? []),
      embedding: digest.embedding ?? null,
      embeddingProvider: digest.embeddingProvider ?? null,
      embeddingModel: digest.embeddingModel ?? null,
      embeddingDimensions: digest.embeddingDimensions ?? null,
      embeddingVersion: digest.embeddingVersion ?? null,
      embeddingStatus: digest.embeddingStatus,
      digestVersion: digest.digestVersion,
      messageCount: digest.messageCount,
      updatedAt: digest.updatedAt,
    });

    if (digest.embedding && digest.embeddingVersion) {
      this.getDb().prepare(`
        INSERT INTO session_digest_embeddings (
          session_id, provider, model, dimensions, index_version, embedding, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, index_version) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          dimensions = excluded.dimensions,
          embedding = excluded.embedding,
          created_at = excluded.created_at
      `).run(
        digest.sessionId,
        digest.embeddingProvider ?? 'unknown',
        digest.embeddingModel ?? 'unknown',
        digest.embeddingDimensions ?? Math.floor(digest.embedding.byteLength / 4),
        digest.embeddingVersion,
        digest.embedding,
        digest.updatedAt,
      );
      this.getDb().prepare(
        'UPDATE embedding_index_state SET revision = revision + 1 WHERE singleton = 1',
      ).run();
    }
  }

  getSessionDigest(sessionId: string): SessionDigest | null {
    const row = this.getDb().prepare('SELECT * FROM session_digests WHERE session_id = ?').get(sessionId) as any;
    return row ? this.rowToSessionDigest(row) : null;
  }

  /**
   * Healthy digest representations that may be embedded without another LLM
   * summary pass. Structural fallback rows remain for DigestService recovery
   * and are deliberately excluded from vector-only backfill.
   */
  listEmbeddableSessionDigests(): SessionDigest[] {
    return (this.getDb().prepare(`
      SELECT sd.*
      FROM session_digests sd
      JOIN work_sessions ws ON ws.id = sd.session_id
      WHERE ws.session_type = 'conversation'
        AND COALESCE(TRIM(sd.one_liner), '') != ''
        AND sd.embedding_status NOT IN ('failed', 'degraded')
        AND NOT (
          sd.embedding_status = 'skipped'
          AND COALESCE(TRIM(sd.key_topics), '[]') IN ('', '[]')
          AND COALESCE(TRIM(sd.key_files), '[]') IN ('', '[]')
          AND COALESCE(TRIM(sd.decisions), '[]') IN ('', '[]')
          AND COALESCE(TRIM(sd.open_questions), '[]') IN ('', '[]')
        )
      ORDER BY sd.updated_at ASC, sd.session_id ASC
    `).all() as any[]).map(row => this.rowToSessionDigest(row));
  }

  getEmbeddingIndexState(): {
    activeVersion: string | null;
    revision: number;
    promotedAt: string | null;
  } {
    const row = this.getDb().prepare(`
      SELECT active_index_version, revision, promoted_at
      FROM embedding_index_state WHERE singleton = 1
    `).get() as {
      active_index_version: string | null;
      revision: number;
      promoted_at: string | null;
    } | undefined;
    return {
      activeVersion: row?.active_index_version ?? null,
      revision: row?.revision ?? 0,
      promotedAt: row?.promoted_at ?? null,
    };
  }

  listDigestEmbeddingSessionIds(indexVersion: string): string[] {
    return (this.getDb().prepare(`
      SELECT sde.session_id
      FROM session_digest_embeddings sde
      JOIN session_digests sd ON sd.session_id = sde.session_id
      WHERE sde.index_version = ?
        AND julianday(sde.created_at) >= julianday(sd.updated_at)
      ORDER BY sde.session_id ASC
    `).all(indexVersion) as Array<{ session_id: string }>).map(row => row.session_id);
  }

  listThinkingMapEmbeddings(
    indexVersion: string,
    sessionIds: string[],
  ): Array<{ sessionId: string; dimensions: number; embedding: Buffer }> {
    const wanted = new Set(sessionIds);
    if (wanted.size === 0) return [];
    return (this.getDb().prepare(`
      SELECT sde.session_id, sde.dimensions, sde.embedding
      FROM session_digest_embeddings sde
      JOIN session_digests sd ON sd.session_id = sde.session_id
      WHERE sde.index_version = ?
        AND julianday(sde.created_at) >= julianday(sd.updated_at)
      ORDER BY sde.session_id ASC
    `).all(indexVersion) as Array<{
      session_id: string;
      dimensions: number;
      embedding: Buffer;
    }>).flatMap(row => wanted.has(row.session_id)
      ? [{
          sessionId: row.session_id,
          dimensions: row.dimensions,
          embedding: row.embedding,
        }]
      : []);
  }

  upsertDigestEmbedding(input: {
    sessionId: string;
    provider: string;
    model: string;
    dimensions: number;
    indexVersion: string;
    embedding: Buffer;
    createdAt: string;
  }): void {
    const db = this.getDb();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO session_digest_embeddings (
          session_id, provider, model, dimensions, index_version, embedding, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, index_version) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          dimensions = excluded.dimensions,
          embedding = excluded.embedding,
          created_at = excluded.created_at
      `).run(
        input.sessionId,
        input.provider,
        input.model,
        input.dimensions,
        input.indexVersion,
        input.embedding,
        input.createdAt,
      );
      db.prepare(`
        UPDATE session_digests
        SET embedding = ?,
            embedding_provider = ?,
            embedding_model = ?,
            embedding_dimensions = ?,
            embedding_version = ?,
            embedding_status = 'ok'
        WHERE session_id = ?
      `).run(
        input.embedding,
        input.provider,
        input.model,
        input.dimensions,
        input.indexVersion,
        input.sessionId,
      );
      db.prepare(
        'UPDATE embedding_index_state SET revision = revision + 1 WHERE singleton = 1',
      ).run();
    })();
  }

  promoteEmbeddingIndex(indexVersion: string, promotedAt = new Date().toISOString()): void {
    this.getDb().prepare(`
      UPDATE embedding_index_state
      SET active_index_version = ?, promoted_at = ?, revision = revision + 1
      WHERE singleton = 1
    `).run(indexVersion, promotedAt);
  }

  /** All digests of one project, newest first (L2 brief input). */
  listSessionDigestsForProject(projectKey: string): SessionDigest[] {
    return (this.getDb().prepare(
      'SELECT * FROM session_digests WHERE project_key = ? ORDER BY updated_at DESC',
    ).all(projectKey) as any[]).map(row => this.rowToSessionDigest(row));
  }

  /** Registry label for a project key ('' when unknown). */
  getProjectLabel(projectKey: string): string {
    const row = this.getDb().prepare('SELECT label FROM project_registry WHERE project_key = ?').get(projectKey) as any;
    return row?.label ?? '';
  }

  /**
   * Conversation sessions whose digest is missing, stale (fewer messages
   * digested than captured) or built by an older prompt version.
   */
  listSessionsNeedingDigest(digestVersion: number): Array<{ id: string; messageCount: number }> {
    return (this.getDb().prepare(`
      SELECT ws.id, ws.message_count
      FROM work_sessions ws
      LEFT JOIN session_digests sd ON sd.session_id = ws.id
      WHERE ws.session_type = 'conversation'
        AND ws.message_count > 0
        AND (
          sd.session_id IS NULL
          OR sd.message_count IS NULL
          OR sd.message_count < ws.message_count
          OR sd.digest_version < ?
        )
      ORDER BY ws.last_activity_at DESC
    `).all(digestVersion) as any[]).map(row => ({ id: row.id, messageCount: row.message_count }));
  }

  /**
   * SQL pre-filter for degraded digests (bench C 2026-07-19): LLM-failure
   * fallback rows have all four structured fields empty and the raw first
   * user message as one_liner. Exact echo judgment needs the session's first
   * user message, so callers re-check at runtime; 'degraded' rows already
   * used their retry and are excluded here.
   */
  listDegradedDigestCandidates(): SessionDigest[] {
    return (this.getDb().prepare(`
      SELECT * FROM session_digests
      WHERE embedding_status = 'skipped'
        AND COALESCE(TRIM(key_topics), '[]') IN ('', '[]')
        AND COALESCE(TRIM(key_files), '[]') IN ('', '[]')
        AND COALESCE(TRIM(decisions), '[]') IN ('', '[]')
        AND COALESCE(TRIM(open_questions), '[]') IN ('', '[]')
        AND COALESCE(TRIM(one_liner), '') != ''
      ORDER BY updated_at DESC
    `).all() as any[]).map(row => this.rowToSessionDigest(row));
  }

  /** Store-wide digest health counts (DigestService.getDigestStats). */
  getSessionDigestStats(): SessionDigestStats {
    const row = this.getDb().prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN COALESCE(TRIM(key_topics), '[]') IN ('', '[]')
                  AND COALESCE(TRIM(key_files), '[]') IN ('', '[]')
                  AND COALESCE(TRIM(decisions), '[]') IN ('', '[]')
                  AND COALESCE(TRIM(open_questions), '[]') IN ('', '[]')
                  AND COALESCE(TRIM(one_liner), '') != ''
                 THEN 1 ELSE 0 END) AS empty_structured,
        SUM(CASE WHEN embedding_status = 'degraded' THEN 1 ELSE 0 END) AS gave_up,
        SUM(CASE WHEN embedding_status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM session_digests
    `).get() as any;
    return {
      total: row?.total ?? 0,
      emptyStructured: row?.empty_structured ?? 0,
      gaveUp: row?.gave_up ?? 0,
      failed: row?.failed ?? 0,
    };
  }

  private rowToSessionDigest(row: any): SessionDigest {
    const parseArray = (value: unknown): string[] => {
      if (typeof value !== 'string' || !value) return [];
      try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
      } catch {
        return [];
      }
    };
    return {
      sessionId: row.session_id,
      host: row.host ?? 'native',
      platform: row.platform ?? '',
      projectKey: row.project_key ?? '',
      oneLiner: row.one_liner ?? '',
      keyTopics: parseArray(row.key_topics),
      keyFiles: parseArray(row.key_files),
      decisions: parseArray(row.decisions),
      openQuestions: parseArray(row.open_questions),
      embedding: row.embedding ?? null,
      embeddingProvider: row.embedding_provider ?? null,
      embeddingModel: row.embedding_model ?? null,
      embeddingDimensions: row.embedding_dimensions ?? null,
      embeddingVersion: row.embedding_version ?? null,
      embeddingStatus: row.embedding_status ?? 'none',
      digestVersion: row.digest_version ?? 1,
      messageCount: row.message_count ?? 0,
      updatedAt: row.updated_at ?? '',
      validFrom: row.valid_from ?? null,
      validTo: row.valid_to ?? null,
      supersededBy: row.superseded_by ?? null,
      accessCount: row.access_count ?? 0,
    };
  }

  // ==================== Recall (P1.5) ====================

  recallSessions(query: string, options: SessionRecallOptions = {}): SessionRecallHit[] {
    return recallSessions(this.getDb(), query, options);
  }

  // ==================== Memory v2: fork lineage + L0/L2 project layers ====================

  /**
   * Detect codex forks (rollout copies the parent's history, so two sessions
   * share most message ids) and persist `forked_from` for sessions that have
   * no lineage yet. Explicit lineage (kimi state.json forkedFrom, set at
   * parse time) is never overwritten. Returns the number of edges written.
   */
  refreshForkLineage(): number {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT id, session_id, platform, started_at
      FROM work_sessions
      WHERE platform = 'codex' AND forked_from IS NULL AND session_type = 'conversation'
      ORDER BY started_at ASC
    `).all() as Array<{ id: string; session_id: string; platform: string; started_at: number }>;
    if (rows.length < 2) return 0;

    const msgStmt = db.prepare('SELECT id FROM messages WHERE session_id = ?');
    const candidates = rows.map(row => ({
      id: row.id,
      rawSessionId: row.session_id,
      platform: row.platform,
      startedAt: row.started_at,
      messageIds: (msgStmt.all(row.id) as Array<{ id: string }>).map(message => message.id),
    }));

    const edges = detectForksByMessageOverlap(candidates);
    if (edges.size === 0) return 0;
    const update = db.prepare('UPDATE work_sessions SET forked_from = ? WHERE id = ? AND forked_from IS NULL');
    let written = 0;
    const apply = db.transaction(() => {
      for (const [child, parent] of edges) {
        written += update.run(parent, child).changes;
      }
    });
    apply();
    return written;
  }

  // ---- L0: project_state ----

  upsertProjectState(state: ProjectState): void {
    this.getDb().prepare(`
      INSERT INTO project_state (
        project_key, one_liner, active_files, open_questions, session_count, last_active, updated_at
      ) VALUES (
        @projectKey, @oneLiner, @activeFiles, @openQuestions, @sessionCount, @lastActive, @updatedAt
      )
      ON CONFLICT(project_key) DO UPDATE SET
        one_liner = excluded.one_liner,
        active_files = excluded.active_files,
        open_questions = excluded.open_questions,
        session_count = excluded.session_count,
        last_active = excluded.last_active,
        updated_at = excluded.updated_at
    `).run({
      projectKey: state.projectKey,
      oneLiner: state.oneLiner,
      activeFiles: JSON.stringify(state.activeFiles ?? []),
      openQuestions: JSON.stringify(state.openQuestions ?? []),
      sessionCount: state.sessionCount,
      lastActive: state.lastActive,
      updatedAt: state.updatedAt,
    });
  }

  /** Rebuild every project's L0 card deterministically. Returns the count. */
  rebuildProjectStates(now: Date = new Date()): number {
    const db = this.getDb();
    const keys = listProjectKeys(db);
    const rebuild = db.transaction(() => {
      for (const key of keys) this.upsertProjectState(buildProjectState(db, key, now));
    });
    rebuild();
    return keys.length;
  }

  getProjectState(projectKey: string): ProjectState | null {
    const row = this.getDb().prepare('SELECT * FROM project_state WHERE project_key = ?').get(projectKey) as any;
    return row ? this.rowToProjectState(row) : null;
  }

  listProjectStates(): ProjectState[] {
    return (this.getDb().prepare('SELECT * FROM project_state ORDER BY project_key').all() as any[])
      .map(row => this.rowToProjectState(row));
  }

  private rowToProjectState(row: any): ProjectState {
    const parse = (value: unknown): any[] => {
      if (typeof value !== 'string' || !value) return [];
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    return {
      projectKey: row.project_key,
      oneLiner: row.one_liner ?? '',
      activeFiles: parse(row.active_files),
      openQuestions: parse(row.open_questions).filter((item): item is string => typeof item === 'string'),
      sessionCount: row.session_count ?? 0,
      lastActive: row.last_active ?? '',
      updatedAt: row.updated_at ?? '',
    };
  }

  // ---- L2: project_briefs ----

  getProjectBrief(projectKey: string): ProjectBrief | null {
    const row = this.getDb().prepare('SELECT * FROM project_briefs WHERE project_key = ?').get(projectKey) as any;
    if (!row) return null;
    return {
      projectKey: row.project_key,
      contentMarkdown: row.content_markdown ?? '',
      version: row.version ?? 0,
      lastOps: row.last_ops ?? '[]',
      updatedAt: row.updated_at ?? '',
    };
  }

  upsertProjectBrief(brief: ProjectBrief): void {
    this.getDb().prepare(`
      INSERT INTO project_briefs (project_key, content_markdown, version, last_ops, updated_at)
      VALUES (@projectKey, @contentMarkdown, @version, @lastOps, @updatedAt)
      ON CONFLICT(project_key) DO UPDATE SET
        content_markdown = excluded.content_markdown,
        version = excluded.version,
        last_ops = excluded.last_ops,
        updated_at = excluded.updated_at
    `).run({
      projectKey: brief.projectKey,
      contentMarkdown: brief.contentMarkdown,
      version: brief.version,
      lastOps: brief.lastOps,
      updatedAt: brief.updatedAt,
    });
  }

  // ---- L2 support: deterministic per-file timeline ----

  getFileTimeline(query: FileTimelineQuery): FileTimelineEvent[] {
    return getFileTimeline(this.getDb(), query);
  }

  /** L1 access tracking: MCP search bumps the digests it surfaced. */
  bumpDigestAccessCount(sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    const stmt = this.getDb().prepare(
      'UPDATE session_digests SET access_count = access_count + 1 WHERE session_id = ?',
    );
    const bump = this.getDb().transaction(() => {
      for (const id of sessionIds) stmt.run(id);
    });
    bump();
  }

  // ==================== Memory Entries (记忆空间, v14) ====================

  upsertMemoryEntry(e: MemoryEntry): void {
    this.getDb().prepare(`
      INSERT INTO memory_entries (
        id, kind, title, content_markdown, summary, scope, template,
        source_session_ids, tags, version, prev_id, last_ops, status, entry_date,
        created_at, updated_at
      ) VALUES (
        @id, @kind, @title, @contentMarkdown, @summary, @scope, @template,
        @sourceSessionIds, @tags, @version, @prevId, @lastOps, @status, @entryDate,
        @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        content_markdown = excluded.content_markdown,
        summary = excluded.summary,
        scope = excluded.scope,
        template = excluded.template,
        source_session_ids = excluded.source_session_ids,
        tags = excluded.tags,
        version = excluded.version,
        prev_id = excluded.prev_id,
        last_ops = excluded.last_ops,
        status = excluded.status,
        entry_date = excluded.entry_date,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run({
      id: e.id,
      kind: e.kind,
      title: e.title,
      contentMarkdown: e.contentMarkdown,
      summary: e.summary ?? null,
      scope: e.scope ?? null,
      template: e.template ?? null,
      sourceSessionIds: JSON.stringify(e.sourceSessionIds ?? []),
      tags: JSON.stringify(e.tags ?? []),
      version: e.version,
      prevId: e.prevId ?? null,
      lastOps: e.lastOps ?? null,
      status: e.status,
      entryDate: e.entryDate ?? null,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    });
  }

  getMemoryEntry(id: string): MemoryEntry | null {
    const row = this.getDb().prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as any;
    return row ? this.rowToMemoryEntry(row) : null;
  }

  listMemoryEntries(opts?: { kind?: string; status?: string; limit?: number; offset?: number }): MemoryEntry[] {
    let sql = 'SELECT * FROM memory_entries WHERE 1=1';
    const params: any[] = [];

    if (opts?.kind) {
      sql += ' AND kind = ?';
      params.push(opts.kind);
    }
    if (opts?.status) {
      sql += ' AND status = ?';
      params.push(opts.status);
    }
    sql += ' ORDER BY updated_at DESC';
    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }
    if (opts?.offset) {
      sql += ' OFFSET ?';
      params.push(opts.offset);
    }

    return (this.getDb().prepare(sql).all(...params) as any[]).map(r => this.rowToMemoryEntry(r));
  }

  /**
   * FTS5 over title/content_markdown/tags. The query is escaped through
   * toFtsQuery (each word token quoted, OR-combined) so user text can never
   * break MATCH syntax; on builds where the FTS table is unusable the LIKE
   * fallback keeps search working.
   */
  searchMemoryEntries(query: string, limit = 20): MemoryEntry[] {
    const db = this.getDb();
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    try {
      const rows = db.prepare(`
        SELECT e.*, rank
        FROM memory_entries_fts fts
        JOIN memory_entries e ON e.rowid = fts.rowid
        WHERE memory_entries_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit) as any[];
      return rows.map(r => this.rowToMemoryEntry(r));
    } catch {
      // Fallback to LIKE
      const pattern = `%${query}%`;
      const rows = db.prepare(`
        SELECT * FROM memory_entries
        WHERE title LIKE ? OR content_markdown LIKE ? OR tags LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(pattern, pattern, pattern, limit) as any[];
      return rows.map(r => this.rowToMemoryEntry(r));
    }
  }

  /** Hard delete — archiving is an UPDATE of status, not a delete. */
  deleteMemoryEntry(id: string): void {
    this.getDb().prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
  }

  countMemoryEntries(kind?: string): number {
    const row = (kind
      ? this.getDb().prepare('SELECT COUNT(*) AS c FROM memory_entries WHERE kind = ?').get(kind)
      : this.getDb().prepare('SELECT COUNT(*) AS c FROM memory_entries').get()) as any;
    return row?.c ?? 0;
  }

  getMemoryMeta(key: string): string | null {
    const row = this.getDb().prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as any;
    return row?.value ?? null;
  }

  setMemoryMeta(key: string, value: string): void {
    this.getDb().prepare(`
      INSERT INTO memory_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private rowToMemoryEntry(row: any): MemoryEntry {
    const parseArray = (value: unknown): string[] => {
      if (typeof value !== 'string' || !value) return [];
      try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
      } catch {
        return [];
      }
    };
    return {
      id: row.id,
      kind: row.kind,
      title: row.title ?? '',
      contentMarkdown: row.content_markdown ?? '',
      summary: row.summary ?? null,
      scope: row.scope ?? null,
      template: row.template ?? null,
      sourceSessionIds: parseArray(row.source_session_ids),
      tags: parseArray(row.tags),
      version: row.version ?? 1,
      prevId: row.prev_id ?? null,
      lastOps: row.last_ops ?? null,
      status: row.status ?? 'active',
      entryDate: row.entry_date ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ==================== Helpers ====================

  private rowToWorkSession(r: any): WorkSession {
    return {
      id: r.id,
      sessionId: r.session_id,
      platform: r.platform,
      host: r.host ?? 'native',
      platformVersion: r.platform_version,
      projectPath: r.project_path,
      gitBranch: r.git_branch,
      gitRemote: r.git_remote,
      model: r.model,
      models: r.models,
      title: r.title,
      summary: r.summary,
      tags: JSON.parse(r.tags || '[]'),
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      lastActivityAt: r.last_activity_at,
      durationMs: r.duration_ms,
      messageCount: r.message_count,
      userInputCount: r.user_input_count,
      assistantMessageCount: r.assistant_message_count,
      thinkingCount: r.thinking_count,
      toolCallCount: r.tool_call_count,
      codeBlockCount: r.code_block_count,
      turnCount: r.turn_count,
      totalInputTokens: r.total_input_tokens,
      totalOutputTokens: r.total_output_tokens,
      totalCacheCreationTokens: r.total_cache_creation_tokens,
      totalCacheReadTokens: r.total_cache_read_tokens,
      hasSubagents: r.has_subagents === 1,
      hasContextCompaction: r.has_context_compaction === 1,
      agentMeta: r.agent_meta,
      claudeCodeVersion: r.claude_code_version,
      sessionType: r.session_type || 'conversation',
      forkedFrom: r.forked_from ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private rowToSessionMessage(r: any): SessionMessage {
    return {
      id: r.id,
      sessionId: r.session_id,
      turnId: r.turn_id,
      source: r.source,
      sequence: r.sequence,
      role: r.role,
      contentText: r.content_text,
      contentThinking: r.content_thinking,
      contentToolName: r.content_tool_name,
      contentToolInput: r.content_tool_input,
      contentToolOutput: r.content_tool_output,
      contentToolError: r.content_tool_error,
      cwd: r.cwd,
      gitBranch: r.git_branch,
      tokenInput: r.token_input,
      tokenOutput: r.token_output,
      tokenCacheCreation: r.token_cache_creation,
      tokenCacheRead: r.token_cache_read,
      tokenReasoning: r.token_reasoning,
      model: r.model,
      stopReason: r.stop_reason,
      parentId: r.parent_id,
      depth: r.depth,
      isSidechain: r.is_sidechain === 1,
      agentId: r.agent_id,
      timestamp: r.timestamp,
      createdAt: r.created_at,
    };
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}
