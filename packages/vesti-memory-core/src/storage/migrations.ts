/**
 * Schema Migrations
 * Ordered, transactional migrations tracked in the schema_migrations table.
 * Add new entries at the end with the next version number — never edit
 * shipped migrations. Each `up` must be idempotent-safe: it runs exactly
 * once per database, but should still re-check state (e.g. PRAGMA
 * table_info) so databases created by newer code stay compatible.
 */

type Database = import('better-sqlite3').Database;

export interface Migration {
  version: number;
  name: string;
  /**
   * Returns an optional note recorded in schema_migrations.note — used when a
   * migration detects at runtime that it cannot apply (e.g. the SQLite build
   * lacks a feature) and skips itself instead of failing the whole startup.
   */
  up(db: Database): string | void;
}

export function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === column);
}

/**
 * Probe whether this SQLite build actually supports an FTS5 tokenizer.
 * sqlite_version() / compile options don't prove a tokenizer is linked in —
 * trigram is built into SQLite ≥ 3.34, but the only trustworthy check is to
 * create a throwaway table with it.
 */
export function probeFtsTokenizer(db: Database, tokenizer: string): boolean {
  try {
    db.exec(`CREATE VIRTUAL TABLE _fts_tokenizer_probe USING fts5(x, tokenize='${tokenizer}')`);
    db.exec('DROP TABLE _fts_tokenizer_probe');
    return true;
  } catch {
    try { db.exec('DROP TABLE IF EXISTS _fts_tokenizer_probe'); } catch { /* probe best-effort */ }
    return false;
  }
}

/**
 * Rebuild messages_fts / sessions_fts with the trigram tokenizer (migration
 * 5). unicode61 treats a whole unspaced CJK run as ONE token, so Chinese
 * facts written without spaces were invisible to FTS; trigram indexes
 * 3-character sliding windows, making CJK substrings of length ≥ 3 matchable
 * (and Latin matching substring-lenient as a side effect). Column layout is
 * unchanged; the content tables are re-indexed via the FTS5 'rebuild'
 * command. Runs inside the caller's migration transaction.
 */
export function rebuildFtsWithTrigram(db: Database): void {
  // Triggers reference the FTS tables — drop them first.
  for (const trigger of [
    'msg_fts_insert', 'msg_fts_delete', 'msg_fts_update',
    'ws_fts_insert', 'ws_fts_delete', 'ws_fts_update',
  ]) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  db.exec('DROP TABLE IF EXISTS messages_fts');
  db.exec('DROP TABLE IF EXISTS sessions_fts');

  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output,
      content='messages',
      content_rowid='rowid',
      tokenize='trigram'
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE sessions_fts USING fts5(
      title, summary,
      content='work_sessions',
      content_rowid='rowid',
      tokenize='trigram'
    )
  `);

  // Same trigger bodies as DatabaseManager.createFTS (kept IF NOT EXISTS
  // there so both paths coexist: migration creates them on trigram builds,
  // createFTS is the fallback on builds without trigram).
  db.exec(`
    CREATE TRIGGER msg_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
      VALUES (new.rowid, new.content_text, new.content_thinking, new.content_tool_name, new.content_tool_input, new.content_tool_output);
    END
  `);
  db.exec(`
    CREATE TRIGGER msg_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
      VALUES ('delete', old.rowid, old.content_text, old.content_thinking, old.content_tool_name, old.content_tool_input, old.content_tool_output);
    END
  `);
  db.exec(`
    CREATE TRIGGER msg_fts_update AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
      VALUES ('delete', old.rowid, old.content_text, old.content_thinking, old.content_tool_name, old.content_tool_input, old.content_tool_output);
      INSERT INTO messages_fts(rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
      VALUES (new.rowid, new.content_text, new.content_thinking, new.content_tool_name, new.content_tool_input, new.content_tool_output);
    END
  `);
  db.exec(`
    CREATE TRIGGER ws_fts_insert AFTER INSERT ON work_sessions BEGIN
      INSERT INTO sessions_fts(rowid, title, summary)
      VALUES (new.rowid, new.title, new.summary);
    END
  `);
  db.exec(`
    CREATE TRIGGER ws_fts_delete AFTER DELETE ON work_sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, title, summary)
      VALUES ('delete', old.rowid, old.title, old.summary);
    END
  `);
  db.exec(`
    CREATE TRIGGER ws_fts_update AFTER UPDATE ON work_sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, title, summary)
      VALUES ('delete', old.rowid, old.title, old.summary);
      INSERT INTO sessions_fts(rowid, title, summary)
      VALUES (new.rowid, new.title, new.summary);
    END
  `);

  // Full backfill from the external content tables. 'rebuild' drops and
  // re-reads the whole index; thousands of messages rebuild in seconds.
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild')`);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'add_work_sessions_session_type',
    up(db) {
      // Absorbs the old "ALTER TABLE ... catch" fallback: databases created
      // before session_type existed get the column, fresh databases already
      // have it from CREATE TABLE and skip.
      if (hasColumn(db, 'work_sessions', 'session_type')) return;
      db.exec(`ALTER TABLE work_sessions ADD COLUMN session_type TEXT DEFAULT 'conversation'`);
    },
  },
  {
    version: 2,
    name: 'add_work_sessions_host',
    up(db) {
      // WSL capture (P1.2): tags each session with its source host —
      // 'native' or 'wsl:<distro>'. Existing rows are native by definition.
      if (hasColumn(db, 'work_sessions', 'host')) return;
      db.exec(`ALTER TABLE work_sessions ADD COLUMN host TEXT NOT NULL DEFAULT 'native'`);
    },
  },
  {
    version: 3,
    name: 'add_session_digests_and_project_registry',
    up(db) {
      // P1.5 conversation-tree index: per-session LLM digests (with optional
      // embedding) and the deterministic project registry the sync pipeline
      // maintains from work_sessions rows.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_digests (
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
          updated_at TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_registry (
          project_key TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          label TEXT,
          path_or_domain TEXT,
          first_seen TEXT,
          last_seen TEXT
        )
      `);
    },
  },
  {
    version: 4,
    name: 'add_memory_v2_fork_lineage_and_project_layers',
    up(db) {
      // Memory v2 (fork lineage + L0-L3 layered project memory):
      // - work_sessions.forked_from: explicit fork lineage (kimi state.json
      //   forkedFrom, codex rollout overlap detection). NULL = not a fork.
      // - session_digests validity semantics (L1): valid_from/valid_to mark
      //   the interval a digest describes; superseded_by points at the digest
      //   that replaced it; access_count feeds recency ranking (MCP bumps it
      //   on search hits).
      // - project_state (L0): one deterministic "current state card" per
      //   project, rewritten wholesale on every rebuild — never invalidated.
      // - project_briefs (L2): LLM-maintained cross-session brief with a
      //   version counter and the ops log of the last deposit-maintain merge.
      if (!hasColumn(db, 'work_sessions', 'forked_from')) {
        db.exec(`ALTER TABLE work_sessions ADD COLUMN forked_from TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'valid_from')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN valid_from TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'valid_to')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN valid_to TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'superseded_by')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN superseded_by TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'access_count')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_state (
          project_key TEXT PRIMARY KEY,
          one_liner TEXT,
          active_files TEXT,
          open_questions TEXT,
          session_count INTEGER,
          last_active TEXT,
          updated_at TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_briefs (
          project_key TEXT PRIMARY KEY,
          content_markdown TEXT,
          version INTEGER NOT NULL DEFAULT 0,
          last_ops TEXT,
          updated_at TEXT
        )
      `);
    },
  },
  {
    version: 5,
    name: 'fts5_trigram_tokenizer',
    // Optional probe override exists only for tests (simulate a SQLite build
    // without trigram); runMigrations calls up(db) with the real probe.
    up(db, probe: () => boolean = () => probeFtsTokenizer(db, 'trigram')) {
      if (!probe()) {
        const { v } = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
        return `skipped: SQLite ${v} has no usable FTS5 trigram tokenizer; messages_fts/sessions_fts kept the default unicode61 tokenizer`;
      }
      rebuildFtsWithTrigram(db);
    },
  },
  {
    version: 6,
    name: 'reclassify_degraded_digests_as_skipped',
    up(db) {
      // Digest semantics fix: 'degraded' used to be written whenever the
      // degraded-retry LLM call failed for ANY reason — including the LLM
      // being unreachable — which permanently locked those rows out of
      // recovery (the retry scan only looks at 'skipped'). Under the new
      // semantics 'degraded' means "the LLM parsed fine but still produced
      // an echo of the user prompt"; transport/parse failures stay
      // 'skipped' (recoverable). Reclassify shipped rows so a healthy LLM
      // can regenerate them.
      const changed = db
        .prepare("UPDATE session_digests SET embedding_status = 'skipped' WHERE embedding_status = 'degraded'")
        .run().changes;
      return changed > 0 ? `reclassified ${changed} degraded digest rows as skipped` : undefined;
    },
  },
  {
    version: 7,
    name: 'rescan_cursor_reported_token_usage',
    up(db) {
      // Cursor usage was previously hard-coded to zero and the legacy inline
      // conversation layout was skipped. Invalidate only Cursor's source
      // checkpoint once so existing installations are backfilled immediately
      // even when state.vscdb itself has not changed since the app upgrade.
      db.prepare("DELETE FROM sync_state WHERE platform = 'cursor'").run();
    },
  },
  {
    version: 8,
    name: 'sync_state_parser_version',
    up(db) {
      // Adapter parser upgrades (e.g. Cursor subagent lineage) must be able
      // to re-parse already-synced files; the size/mtime short-circuit alone
      // would skip them forever. Default 0 marks every existing row as
      // parsed by a pre-versioning parser, so any adapter that declares a
      // parserVersion > 0 re-parses on the next sync.
      const columns = db.prepare("PRAGMA table_info(sync_state)").all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'parser_version')) {
        db.exec('ALTER TABLE sync_state ADD COLUMN parser_version INTEGER DEFAULT 0');
        return 'added sync_state.parser_version';
      }
    },
  },
  {
    version: 9,
    name: 'version_session_digest_embeddings',
    up(db) {
      if (!hasColumn(db, 'session_digests', 'embedding_provider')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN embedding_provider TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'embedding_model')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN embedding_model TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'embedding_dimensions')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN embedding_dimensions INTEGER`);
      }
      if (!hasColumn(db, 'session_digests', 'embedding_version')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN embedding_version TEXT`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_digest_embeddings (
          session_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL,
          index_version TEXT NOT NULL,
          embedding BLOB NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, index_version),
          FOREIGN KEY (session_id) REFERENCES session_digests(session_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_session_digest_embeddings_version
          ON session_digest_embeddings(index_version);
      `);
      // Preserve pre-upgrade vectors as an explicitly isolated legacy index.
      db.exec(`
        UPDATE session_digests
        SET embedding_provider = COALESCE(embedding_provider, 'legacy'),
            embedding_model = COALESCE(embedding_model, 'unknown'),
            embedding_dimensions = COALESCE(embedding_dimensions, length(embedding) / 4),
            embedding_version = COALESCE(
              embedding_version,
              'legacy:unknown:' || CAST(length(embedding) / 4 AS TEXT)
            )
        WHERE embedding IS NOT NULL;

        INSERT OR IGNORE INTO session_digest_embeddings (
          session_id, provider, model, dimensions, index_version, embedding, created_at
        )
        SELECT session_id, embedding_provider, embedding_model,
               embedding_dimensions, embedding_version, embedding,
               COALESCE(updated_at, datetime('now'))
        FROM session_digests
        WHERE embedding IS NOT NULL AND embedding_version IS NOT NULL;

        -- Force the digest pipeline to regenerate embeddings with the new
        -- gateway on its next sync. The versioned table above keeps the old
        -- vectors available for rollback while active recall refuses to mix
        -- them with the new index.
        UPDATE session_digests
        SET digest_version = 0
        WHERE embedding IS NOT NULL;
      `);
    },
  },
  {
    version: 10,
    name: 'repair_memory_v2_schema_after_legacy_v4_collision',
    up(db) {
      // Some beta databases shipped with version 4 already occupied by the
      // old Cursor token-rescan migration. Migration tracking is keyed by
      // version, so those databases skipped the later Memory v2 migration
      // that reused version 4 and were left without the columns/tables below.
      // Keep the published v4 entry untouched and repair the schema under a
      // new version. Every operation is deliberately idempotent so this is
      // also harmless for databases where Memory v2 was applied correctly.
      if (!hasColumn(db, 'work_sessions', 'forked_from')) {
        db.exec(`ALTER TABLE work_sessions ADD COLUMN forked_from TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'valid_from')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN valid_from TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'valid_to')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN valid_to TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'superseded_by')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN superseded_by TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'access_count')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_state (
          project_key TEXT PRIMARY KEY,
          one_liner TEXT,
          active_files TEXT,
          open_questions TEXT,
          session_count INTEGER,
          last_active TEXT,
          updated_at TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_briefs (
          project_key TEXT PRIMARY KEY,
          content_markdown TEXT,
          version INTEGER NOT NULL DEFAULT 0,
          last_ops TEXT,
          updated_at TEXT
        )
      `);
    },
  },
  {
    version: 11,
    name: 'add_token_usage_events_and_rescan_sources',
    up(db) {
      // Session totals remain the authoritative all-time counters, but they
      // cannot describe *when* usage happened for conversations spanning
      // multiple days. Keep each adapter's stable usage records separately so
      // the dashboard can group them by their real timestamp. The primary key
      // makes a full or incremental rescan idempotent.
      db.exec(`
        CREATE TABLE IF NOT EXISTS token_usage_events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          source_scope TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          model TEXT,
          source TEXT NOT NULL,
          FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_token_usage_events_timestamp
          ON token_usage_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_token_usage_events_session
          ON token_usage_events(session_id);
        CREATE INDEX IF NOT EXISTS idx_token_usage_events_dedupe
          ON token_usage_events(session_id, dedupe_key, timestamp);
        CREATE INDEX IF NOT EXISTS idx_token_usage_events_source_scope
          ON token_usage_events(source_scope);
      `);

      // Existing installations only have per-session cumulative totals.
      // Invalidate source checkpoints once so adapters replay the original
      // files and backfill timestamped usage events without touching sessions.
      db.exec('DELETE FROM sync_state');
    },
  },
  {
    version: 12,
    name: 'repair_token_usage_event_dedupe_key',
    up(db) {
      // A development build briefly shipped migration 11 without dedupe_key.
      // Migration tracking prevents v11 from running twice, so repair those
      // databases under a new version before any event INSERT or stats query.
      if (!hasColumn(db, 'token_usage_events', 'dedupe_key')) {
        db.exec(`
          ALTER TABLE token_usage_events
          ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT ''
        `);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_token_usage_events_dedupe
          ON token_usage_events(session_id, dedupe_key, timestamp);

        -- Old rows lack semantic transition keys. Rebuild them from source
        -- instead of displaying a transient, inflated fork total.
        DELETE FROM token_usage_events;
        DELETE FROM sync_state;
      `);
    },
  },
  {
    version: 13,
    name: 'rebuild_codex_spawned_thread_token_usage',
    up(db) {
      // Existing event rows do not retain the Codex session_meta source kind,
      // so they cannot be classified as root, guardian, or thread_spawn using
      // SQL alone. Mark them inactive (without deleting history) and rewind
      // Codex checkpoints. Each successfully reparsed physical source replaces
      // its inactive snapshot atomically with corrected active events.
      if (!hasColumn(db, 'token_usage_events', 'is_valid')) {
        db.exec(
          'ALTER TABLE token_usage_events ADD COLUMN is_valid INTEGER NOT NULL DEFAULT 1',
        );
      }
      db.prepare(
        "UPDATE token_usage_events SET is_valid = 0 WHERE session_id LIKE 'codex:%' OR source LIKE 'codex:%'",
      ).run();
      db.prepare(
        "UPDATE sync_state SET last_position = -1, last_modified = 0 WHERE platform = 'codex'",
      ).run();
    },
  },
  {
    version: 14,
    name: 'memory_entries',
    up(db) {
      // 记忆空间 (memory space): unified long-term memory entries — deposits
      // migrated out of the renderer's IndexedDB, dream memories, dream run
      // logs and free notes — so the main process (and later MCP) can read
      // them. memory_meta is a small kv table (migration watermarks etc.).
      // FTS follows migration 5's tokenizer decision: unicode61 indexes a
      // whole unspaced CJK run as ONE token, making Chinese facts
      // unsearchable; use trigram when the build supports it.
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
      const tokenizer = probeFtsTokenizer(db, 'trigram') ? `,\n          tokenize='trigram'` : '';
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
          title, content_markdown, tags,
          content='memory_entries', content_rowid='rowid'${tokenizer}
        )
      `);
      // Same trigger pattern as DatabaseManager.createFTS (messages_fts).
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS mem_fts_insert AFTER INSERT ON memory_entries BEGIN
          INSERT INTO memory_entries_fts(rowid, title, content_markdown, tags)
          VALUES (new.rowid, new.title, new.content_markdown, new.tags);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS mem_fts_delete AFTER DELETE ON memory_entries BEGIN
          INSERT INTO memory_entries_fts(memory_entries_fts, rowid, title, content_markdown, tags)
          VALUES ('delete', old.rowid, old.title, old.content_markdown, old.tags);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS mem_fts_update AFTER UPDATE ON memory_entries BEGIN
          INSERT INTO memory_entries_fts(memory_entries_fts, rowid, title, content_markdown, tags)
          VALUES ('delete', old.rowid, old.title, old.content_markdown, old.tags);
          INSERT INTO memory_entries_fts(rowid, title, content_markdown, tags)
          VALUES (new.rowid, new.title, new.content_markdown, new.tags);
        END
      `);
    },
  },
  {
    version: 15,
    name: 'active_embedding_index_state',
    up(db) {
      // One completed embedding space is active at a time. Candidate vectors
      // remain in session_digest_embeddings but stay invisible to graph
      // readers until this singleton is promoted.
      db.exec(`
        CREATE TABLE IF NOT EXISTS embedding_index_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          active_index_version TEXT,
          revision INTEGER NOT NULL DEFAULT 0,
          promoted_at TEXT
        );
        INSERT OR IGNORE INTO embedding_index_state (
          singleton, active_index_version, revision, promoted_at
        ) VALUES (1, NULL, 0, NULL);
      `);
    },
  },
];
