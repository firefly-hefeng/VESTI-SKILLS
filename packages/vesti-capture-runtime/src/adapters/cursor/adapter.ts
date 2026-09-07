/** Cursor desktop adapter (read-only access to Cursor's local state database). */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { glob } from 'glob';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';
import { CursorParser } from './parser.js';
import { CursorTranscriptParser } from './transcript.js';

function cursorUserDir(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Cursor', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User');
}

export class CursorAdapter implements AgentAdapter {
  readonly platform = 'cursor' as const;
  readonly name = 'Cursor';
  readonly shouldBackupSource = false;
  /**
   * v2 (2026-07-22): subagent lineage + tokenCount extraction from
   * state.vscdb, char-estimated usage, and the agent-transcripts JSONL
   * source. v3: child-side lineage for background agents (top-level
   * transcript whose parent is only named in the chat meta). v4: chat title
   * as session_title + injected-tag stripping in title extraction. Bump
   * forces re-parse of files synced by older parsers.
   */
  readonly parserVersion = 4;

  private readonly userDir = cursorUserDir();
  private readonly cursorHome = path.join(os.homedir(), '.cursor');
  private readonly parser = new CursorParser();
  private readonly transcripts = new CursorTranscriptParser(this.cursorHome);
  // sessionIds present in state.vscdb, keyed by db mtime — used to skip
  // transcript twins of composer sessions (both stores can hold the same
  // conversation around the storage-format transition).
  private vscdbIdsCache: { mtimeMs: number; ids: Set<string> } | null = null;

  async detect(): Promise<AgentDetectResult> {
    const files = await this.getSessionFiles();
    if (files.length === 0) return { installed: false };

    let sessionCount = 0;
    const dbFile = files.find(file => file.endsWith('.vscdb'));
    if (dbFile) {
      try { sessionCount = await this.parser.countSessions(dbFile); } catch { /* Cursor may hold a short write lock */ }
    }
    sessionCount += files.filter(file => file.endsWith('.jsonl')).length;
    return {
      installed: true,
      installPath: this.userDir,
      sessionCount,
    };
  }

  async parseSession(filePath: string): Promise<ParsedSession> {
    const sessions = await this.parseSessions(filePath);
    if (sessions.length === 0) throw new Error(`No Cursor conversations found in ${filePath}`);
    return sessions[0];
  }

  async parseSessions(filePath: string): Promise<ParsedSession[]> {
    if (filePath.endsWith('.jsonl')) {
      const sessions = await this.transcripts.parseFile(filePath);
      // A transcript twin of a state.vscdb composer would double-store the
      // conversation (different message uuid schemes); the vscdb copy wins —
      // it carries real per-bubble timestamps, thinking and model info.
      const vscdbIds = await this.getVscdbSessionIds();
      return sessions.filter(session => !vscdbIds.has(session.sessionId));
    }
    return this.parser.parseDatabase(filePath);
  }

  async getSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    const globalDb = path.join(this.userDir, 'globalStorage', 'state.vscdb');
    if (await fs.pathExists(globalDb)) {
      files.push(globalDb);
    } else {
      const workspaceStorage = path.join(this.userDir, 'workspaceStorage');
      if (await fs.pathExists(workspaceStorage)) {
        files.push(...await glob('*/state.vscdb', { cwd: workspaceStorage, absolute: true }));
      }
    }
    // Cursor 2.x agent sessions no longer land in state.vscdb; their JSONL
    // sidecars under ~/.cursor/projects are the only local source.
    files.push(...await this.transcripts.listMainTranscripts());
    return files;
  }

  getWatchPatterns(): string[] {
    return [
      path.join(this.userDir, 'globalStorage', 'state.vscdb'),
      path.join(this.userDir, 'workspaceStorage', '*', 'state.vscdb'),
      path.join(this.cursorHome, 'projects', '*', 'agent-transcripts', '*', '*.jsonl'),
      path.join(this.cursorHome, 'projects', '*', 'agent-transcripts', '*', 'subagents', '*.jsonl'),
    ];
  }

  private async getVscdbSessionIds(): Promise<Set<string>> {
    const globalDb = path.join(this.userDir, 'globalStorage', 'state.vscdb');
    let stat: { mtimeMs: number } | null = null;
    try { stat = await fs.stat(globalDb); } catch { return new Set(); }
    if (this.vscdbIdsCache && this.vscdbIdsCache.mtimeMs === stat.mtimeMs) {
      return this.vscdbIdsCache.ids;
    }
    const ids = new Set<string>();
    try {
      const BetterSqlite3 = (await import('better-sqlite3')).default;
      const db = new BetterSqlite3(globalDb, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare(
          "SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value IS NOT NULL"
        ).all() as Array<{ key: string }>;
        for (const row of rows) ids.add(row.key.slice('composerData:'.length));
      } finally {
        db.close();
      }
    } catch { /* locked or schema-less db — treat as empty */ }
    this.vscdbIdsCache = { mtimeMs: stat.mtimeMs, ids };
    return ids;
  }
}
