import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { sessions as defaultSessions } from './large-corpus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = path.join(HERE, 'fixture-schema.sql');

function resolveOptions(options) {
  if (typeof options === 'string') return { dbPath: options };
  return options ?? {};
}

function assertSession(session, index) {
  const label = `sessions[${index}]`;
  if (!session || typeof session !== 'object') {
    throw new TypeError(`${label} must be an object`);
  }
  for (const field of [
    'id',
    'platformSessionId',
    'platform',
    'projectPath',
    'title',
    'summary',
    'searchText',
  ]) {
    if (typeof session[field] !== 'string') {
      throw new TypeError(`${label}.${field} must be a string`);
    }
  }
  for (const field of ['startedAt', 'lastActivityAt']) {
    if (!Number.isFinite(session[field])) {
      throw new TypeError(`${label}.${field} must be a finite timestamp`);
    }
  }
  if (!Array.isArray(session.keyFiles) || !session.keyFiles.every(file => typeof file === 'string')) {
    throw new TypeError(`${label}.keyFiles must be an array of strings`);
  }
  if (!Array.isArray(session.toolInputs)) {
    throw new TypeError(`${label}.toolInputs must be an array`);
  }
  session.toolInputs.forEach((toolInput, toolIndex) => {
    if (
      !toolInput
      || typeof toolInput.inputSummary !== 'string'
      || !Number.isFinite(toolInput.timestamp)
    ) {
      throw new TypeError(
        `${label}.toolInputs[${toolIndex}] must contain inputSummary and timestamp`,
      );
    }
  });
}

function removeDatabaseFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/**
 * Build a privacy-safe, temporary vesti.db fixture from the large synthetic
 * corpus. The SQL schema is a benchmark input contract; all retrieval,
 * ranking and MCP behavior remains owned by the APP artifact under test.
 *
 * @param {{
 *   dbPath?: string,
 *   sessions?: Array<object>,
 *   schemaPath?: string,
 * } | string} [options]
 * @returns {{
 *   dbPath: string,
 *   cleanup: () => void,
 *   counts: {sessions: number, turns: number, messages: number, tools: number, digests: number},
 * }}
 */
export function buildFixtureDb(options = {}) {
  const resolved = resolveOptions(options);
  const fixtureSessions = resolved.sessions ?? defaultSessions;
  const schemaPath = path.resolve(resolved.schemaPath ?? DEFAULT_SCHEMA_PATH);
  if (!Array.isArray(fixtureSessions)) {
    throw new TypeError('sessions must be an array');
  }

  const seenIds = new Set();
  fixtureSessions.forEach((session, index) => {
    assertSession(session, index);
    if (seenIds.has(session.id)) throw new Error(`Duplicate session id: ${session.id}`);
    seenIds.add(session.id);
  });

  let ownedTempDir = null;
  let dbPath;
  if (resolved.dbPath) {
    dbPath = path.resolve(resolved.dbPath);
    if (fs.existsSync(dbPath)) {
      throw new Error(`Refusing to overwrite existing fixture database: ${dbPath}`);
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } else {
    ownedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesti-file-search-bench-'));
    dbPath = path.join(ownedTempDir, 'vesti.db');
  }

  const cleanup = () => {
    if (ownedTempDir) {
      fs.rmSync(ownedTempDir, { recursive: true, force: true });
      return;
    }
    // A caller-provided parent directory is never removed.
    removeDatabaseFiles(dbPath);
  };

  let db;
  try {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec(schema);

    const insertSession = db.prepare(`
      INSERT INTO work_sessions (
        id, session_id, platform, project_path, title, summary, host,
        started_at, ended_at, last_activity_at, message_count, turn_count,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'native', ?, ?, ?, 2, 1, ?, ?)
    `);
    const insertTurn = db.prepare(`
      INSERT INTO turns (
        id, session_id, sequence, user_input, assistant_response,
        message_count, tool_execution_count, input_tokens, output_tokens,
        started_at, ended_at, duration_ms
      ) VALUES (?, ?, 1, ?, ?, 2, ?, 0, 0, ?, ?, ?)
    `);
    const insertMessage = db.prepare(`
      INSERT INTO messages (
        id, session_id, turn_id, source, sequence, role, content_text,
        content_thinking, content_tool_name, content_tool_input,
        content_tool_output, is_sidechain, timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, ?, ?)
    `);
    const insertTool = db.prepare(`
      INSERT INTO tool_executions (
        id, session_id, turn_id, sequence, tool_use_message_id, tool_name,
        outcome, input_summary, output_summary, is_error, timestamp
      ) VALUES (?, ?, ?, ?, ?, 'Edit', 'success', ?, ?, 0, ?)
    `);
    const insertDigest = db.prepare(`
      INSERT INTO session_digests (
        session_id, host, platform, one_liner, key_topics, key_files,
        decisions, open_questions, embedding, embedding_status,
        access_count, updated_at
      ) VALUES (?, 'native', ?, ?, ?, ?, '[]', '[]', NULL, 'none', 0, ?)
    `);

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const session of fixtureSessions) {
        const turnId = `${session.id}:turn-1`;
        const userMessageId = `${session.id}:message-user`;
        const assistantMessageId = `${session.id}:message-assistant`;
        const durationMs = Math.max(0, session.lastActivityAt - session.startedAt);

        insertSession.run(
          session.id,
          session.platformSessionId,
          session.platform,
          session.projectPath,
          session.title,
          session.summary,
          session.startedAt,
          session.lastActivityAt,
          session.lastActivityAt,
          session.startedAt,
          session.lastActivityAt,
        );
        insertTurn.run(
          turnId,
          session.id,
          session.searchText,
          session.summary,
          session.toolInputs.length,
          session.startedAt,
          session.lastActivityAt,
          durationMs,
        );
        insertMessage.run(
          userMessageId,
          session.id,
          turnId,
          'user_input',
          1,
          'user',
          session.searchText,
          session.startedAt,
          session.startedAt,
        );
        insertMessage.run(
          assistantMessageId,
          session.id,
          turnId,
          'assistant_text',
          2,
          'assistant',
          session.summary,
          session.lastActivityAt,
          session.lastActivityAt,
        );

        session.toolInputs.forEach((toolInput, index) => {
          insertTool.run(
            `${session.id}:tool-${index + 1}`,
            session.id,
            turnId,
            index + 1,
            assistantMessageId,
            toolInput.inputSummary,
            'Synthetic benchmark fixture operation completed.',
            toolInput.timestamp,
          );
        });

        insertDigest.run(
          session.id,
          session.platform,
          session.summary,
          JSON.stringify(session.conceptId ? [session.conceptId] : []),
          JSON.stringify(session.keyFiles),
          new Date(session.lastActivityAt).toISOString(),
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the original insertion failure.
      }
      throw error;
    }

    const count = table => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    const counts = {
      sessions: count('work_sessions'),
      turns: count('turns'),
      messages: count('messages'),
      tools: count('tool_executions'),
      digests: count('session_digests'),
    };
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (integrity.integrity_check !== 'ok') {
      throw new Error(`SQLite integrity check failed: ${integrity.integrity_check}`);
    }
    db.close();
    db = undefined;

    return { dbPath, cleanup, counts };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the original build failure.
    }
    cleanup();
    throw error;
  }
}
