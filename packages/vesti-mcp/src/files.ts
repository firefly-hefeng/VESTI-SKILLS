/**
 * vesti_search_files — the file-level index layer.
 *
 * The aggregation algorithm lives in @vesti/search-files-core (pure,
 * storage-agnostic). This module is the SQLite data-source adapter that
 * feeds it from the VESTI capture database. Read-only; degrades gracefully
 * on older schemas (the core wraps the optional channels in try/catch).
 */

import { searchFiles, extractFilePaths } from '@vesti/search-files-core';
import type {
  FileSearchDataSource,
  NamedDigestRecord,
  NamedToolInputRecord,
  RecallCandidate,
  SearchFilesArgs,
  SearchFilesResult,
  SessionRecord,
  ToolInputRecord,
} from '@vesti/search-files-core';

import type { VestiDatabase } from './db.js';
import { recallSessions } from './recall.js';

export { extractFilePaths };
export type { FileHit, SearchFilesResult } from '@vesti/search-files-core';

export function createFileSearchDataSource(db: VestiDatabase): FileSearchDataSource {
  return {
    recall(query: string, limit: number): RecallCandidate[] {
      return recallSessions(db, query, { topK: limit }).map(hit => ({
        sessionId: hit.sessionId,
        score: hit.score,
      }));
    },

    getSession(sessionId: string): SessionRecord | undefined {
      const row = db
        .prepare(`SELECT id, title, project_path, started_at FROM work_sessions WHERE id = ?`)
        .get(sessionId) as unknown as
        | { id: string; title: string; project_path: string; started_at: number }
        | undefined;
      if (!row) return undefined;
      return {
        id: row.id,
        title: row.title,
        projectPath: row.project_path,
        startedAt: row.started_at,
      };
    },

    getDigestKeyFiles(sessionId: string): string | null | undefined {
      const row = db
        .prepare(`SELECT key_files FROM session_digests WHERE session_id = ?`)
        .get(sessionId) as unknown as { key_files: string | null } | undefined;
      return row?.key_files;
    },

    getToolInputs(sessionId: string): ToolInputRecord[] {
      const rows = db
        .prepare(`SELECT input_summary, timestamp FROM tool_executions WHERE session_id = ?`)
        .all(sessionId) as unknown as Array<{ input_summary: string | null; timestamp: number | null }>;
      return rows.map(row => ({ inputSummary: row.input_summary, timestamp: row.timestamp }));
    },

    findToolInputsContaining(tokens: string[]): NamedToolInputRecord[] {
      if (tokens.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT te.input_summary, te.timestamp, ws.id AS session_id, ws.title, ws.project_path
           FROM tool_executions te JOIN work_sessions ws ON ws.id = te.session_id
           WHERE ${tokens.map(() => 'te.input_summary LIKE ?').join(' OR ')}`,
        )
        .all(...tokens.map(token => `%${token}%`)) as unknown as Array<{
        input_summary: string | null;
        timestamp: number | null;
        session_id: string;
        title: string;
        project_path: string;
      }>;
      return rows.map(row => ({
        inputSummary: row.input_summary,
        timestamp: row.timestamp,
        sessionId: row.session_id,
        title: row.title,
        projectPath: row.project_path,
      }));
    },

    findDigestFilesContaining(tokens: string[]): NamedDigestRecord[] {
      if (tokens.length === 0) return [];
      const rows = db
        .prepare(
          `SELECT sd.session_id, sd.key_files, ws.title, ws.project_path, ws.started_at
           FROM session_digests sd JOIN work_sessions ws ON ws.id = sd.session_id
           WHERE ${tokens.map(() => 'sd.key_files LIKE ?').join(' OR ')}`,
        )
        .all(...tokens.map(token => `%${token}%`)) as unknown as Array<{
        session_id: string;
        key_files: string | null;
        title: string;
        project_path: string;
        started_at: number;
      }>;
      return rows.map(row => ({
        sessionId: row.session_id,
        keyFiles: row.key_files,
        title: row.title,
        projectPath: row.project_path,
        startedAt: row.started_at,
      }));
    },
  };
}

/**
 * Find local files related to a topic. Read-only; never throws on a missing
 * column (older schemas degrade to fewer evidence channels).
 */
export function vestiSearchFiles(db: VestiDatabase, args: SearchFilesArgs): SearchFilesResult {
  return searchFiles(createFileSearchDataSource(db), args);
}
