/**
 * Trae (ByteDance) stores chat sessions in state.vscdb (a VS Code-style
 * SQLite state database) under one ItemTable key:
 *   key   = 'memento/icube-ai-agent-storage'
 *   value = JSON { list: [ { sessionId, createdAt, updatedAt, model,
 *          messages: [{ role, content, agentTaskContent, timestamp, model,
 *          turnIndex }] } ] }
 * Both User/globalStorage/state.vscdb and per-workspace
 * User/workspaceStorage/<hash>/state.vscdb may carry the key.
 * Timestamps accept epoch seconds, epoch ms or RFC3339 strings.
 * This legacy store holds plain user/assistant text only — no tool calls or
 * token usage. Newer Trae builds moved agent data into an encrypted
 * ModularData/ai-agent/database.db, which this parser deliberately ignores.
 * Unknown fields are ignored so schema additions do not break capture.
 */

import path from 'path';
import fs from 'fs-extra';
import type { ParsedMessage, ParsedSession, SessionTokenUsage } from '../../types/agent.js';

type SqliteDatabase = import('better-sqlite3').Database;
type JsonObject = Record<string, unknown>;

const STORAGE_KEY = 'memento/icube-ai-agent-storage';

function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function toTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
    return value < 100_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric !== 0) return toTimestamp(numeric, fallback);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Assistant fallbacks when content is empty: agentTaskContent carries a
 * string, a {content|text|proposal} object, or a guideline plan item list. */
function agentTaskFallback(value: unknown): string {
  if (typeof value === 'string') return value;
  const obj = record(value);
  for (const key of ['content', 'text', 'proposal']) {
    if (typeof obj[key] === 'string' && (obj[key] as string).trim()) {
      return (obj[key] as string).trim();
    }
  }
  const guideline = record(obj.guideline);
  if (Array.isArray(guideline.planItems)) {
    const parts = guideline.planItems
      .map(item => record(item).content)
      .filter((text): text is string => typeof text === 'string' && !!text.trim());
    if (parts.length > 0) return parts.join('\n');
  }
  return '';
}

/** Project path of a workspace state.vscdb, from its workspace.json folder URI. */
export function readTraeWorkspaceProject(dbPath: string): string {
  try {
    const manifest = path.join(path.dirname(dbPath), 'workspace.json');
    if (!fs.existsSync(manifest)) return '';
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8')) as JsonObject;
    const folder = typeof data.folder === 'string' ? data.folder : '';
    if (!folder) return '';
    if (folder.startsWith('file://')) {
      return decodeURIComponent(new URL(folder).pathname).replace(/^\/([A-Za-z]:)/, '$1');
    }
    return folder;
  } catch {
    return '';
  }
}

function emptyTokenUsage(models: Set<string>): SessionTokenUsage {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    models,
  };
}

export class TraeParser {
  private async open(filePath: string): Promise<SqliteDatabase> {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const db = new BetterSqlite3(filePath, { readonly: true, fileMustExist: true }) as SqliteDatabase;
    db.pragma('busy_timeout = 2000');
    return db;
  }

  private readStorageValue(db: SqliteDatabase): string | null {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ItemTable'").get();
    if (!table) return null;
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(STORAGE_KEY) as { value?: unknown } | undefined;
    if (row?.value === null || row?.value === undefined) return null;
    return Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
  }

  async countSessions(filePath: string): Promise<number> {
    const db = await this.open(filePath);
    try {
      const value = this.readStorageValue(db);
      if (!value) return 0;
      const store = JSON.parse(value) as JsonObject;
      return Array.isArray(store.list) ? store.list.length : 0;
    } finally {
      db.close();
    }
  }

  async parseDatabase(filePath: string): Promise<ParsedSession[]> {
    const db = await this.open(filePath);
    let value: string | null;
    try {
      value = this.readStorageValue(db);
    } finally {
      db.close();
    }
    if (!value) return [];

    let store: JsonObject;
    try {
      store = JSON.parse(value) as JsonObject;
    } catch {
      return [];
    }
    const list = Array.isArray(store.list) ? store.list : [];
    // A workspace db knows its project via workspace.json; the global db does not.
    const projectPath = path.basename(path.dirname(filePath)) === 'globalStorage'
      ? ''
      : readTraeWorkspaceProject(filePath);

    const sessions: ParsedSession[] = [];
    for (const raw of list) {
      const session = record(raw);
      const sessionId = typeof session.sessionId === 'string' ? session.sessionId.trim() : '';
      if (!sessionId) continue;
      const parsed = this.parseSessionRecord(sessionId, session, projectPath, filePath);
      if (parsed) sessions.push(parsed);
    }
    return sessions.sort((a, b) => b.startTime - a.startTime);
  }

  private parseSessionRecord(
    sessionId: string,
    session: JsonObject,
    projectPath: string,
    filePath: string,
  ): ParsedSession | null {
    const now = Date.now();
    const sessionModel = typeof session.model === 'string' && session.model ? session.model : undefined;
    const startFallback = toTimestamp(session.createdAt ?? session.updatedAt, now);
    const rawMessages = Array.isArray(session.messages) ? session.messages : [];

    const messages: ParsedMessage[] = [];
    let firstPrompt = '';
    let sequence = 0;
    for (const raw of rawMessages) {
      const message = record(raw);
      const role = String(message.role ?? '').trim().toLowerCase();
      if (role !== 'user' && role !== 'assistant') continue;
      let content = typeof message.content === 'string' ? message.content.trim() : '';
      if (!content && role === 'assistant') content = agentTaskFallback(message.agentTaskContent);
      if (!content) continue;
      if (!firstPrompt && role === 'user') firstPrompt = content;
      const model = typeof message.model === 'string' && message.model ? message.model : sessionModel;
      messages.push({
        uuid: `trae-${sessionId}-${sequence}`,
        type: role,
        role,
        timestamp: toTimestamp(message.timestamp, startFallback + sequence),
        contentText: content,
        isToolResult: false,
        depth: 0,
      });
      sequence++;
    }
    if (messages.length === 0) return null;

    const timestamps = messages.map(message => message.timestamp).filter(value => value > 0);
    const startTime = timestamps.length ? Math.min(...timestamps) : startFallback;
    const endTime = timestamps.length ? Math.max(...timestamps) : undefined;
    const models = new Set<string>();
    if (sessionModel) models.add(sessionModel);
    for (const raw of rawMessages) {
      const model = record(raw).model;
      if (typeof model === 'string' && model) models.add(model);
    }

    return {
      sessionId,
      platform: 'trae',
      projectPath,
      model: sessionModel,
      messages,
      toolExecutions: [],
      subagents: [],
      tokenUsage: emptyTokenUsage(models),
      startTime,
      endTime,
      meta: {
        first_prompt: firstPrompt || undefined,
        source_database: filePath,
      },
    };
  }
}
