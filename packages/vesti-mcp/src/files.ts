/**
 * SQLite/FTS adapter for the repository-independent file-search core.
 *
 * The retrieval algorithm, path extraction, aggregation and ranking live in
 * VESTI-SKILLS (@vesti/search-files-core). This module only translates the
 * VESTI capture schema into that package's FileSearchDataSource contract.
 */

import {
  searchFiles,
  type FileSearchDataSource,
  type SearchFilesArgs,
  type SearchFilesResult,
} from '@vesti/search-files-core';

import type { VestiDatabase } from './db.js';
import { recallSessions, type RecallTrace } from './recall.js';

export { extractFilePaths } from '@vesti/search-files-core';
export type { FileHit, SearchFilesResult } from '@vesti/search-files-core';

/** Direct filename evidence is deliberately bounded independently of core. */
export const FILE_EVIDENCE_QUERY_TOKEN_LIMIT = 8;
export const FILE_EVIDENCE_ROWS_PER_TOKEN = 128;
export const FILE_EVIDENCE_RESULT_LIMIT = 512;

function projectClause(column: string, projectPaths: string[] | undefined): string {
  return projectPaths?.length
    ? ` AND ${column} IN (${projectPaths.map(() => '?').join(', ')})`
    : '';
}

function likePattern(token: string): string {
  return `%${token.replace(/[\\%_]/g, match => `\\${match}`)}%`;
}

/**
 * Prefer explicit filename/path-like tokens, then longer (usually rarer)
 * terms. This keeps an exact basename query even when callers provide more
 * tokens than the database adapter is willing to scan.
 */
function boundedEvidenceTokens(tokens: string[]): string[] {
  const unique = [...new Map(tokens
    .map(token => token.trim())
    .filter(Boolean)
    .map((token, index) => [token.toLowerCase(), { token, index }])).values()];
  return unique
    .sort((a, b) => {
      const pathLikeA = /[./\\]/.test(a.token) ? 1 : 0;
      const pathLikeB = /[./\\]/.test(b.token) ? 1 : 0;
      return pathLikeB - pathLikeA
        || [...b.token].length - [...a.token].length
        || a.index - b.index;
    })
    .slice(0, FILE_EVIDENCE_QUERY_TOKEN_LIMIT)
    .map(entry => entry.token);
}

/** Build the capture-schema adapter consumed by the standalone search core. */
export function createFileSearchDataSource(db: VestiDatabase): FileSearchDataSource {
  return {
    listProjects() {
      const rows = db.prepare(
        `SELECT project_path, MAX(last_activity_at) AS last_activity_at
         FROM work_sessions
         WHERE project_path <> ''
         GROUP BY project_path
         ORDER BY last_activity_at DESC`,
      ).all() as unknown as Array<{ project_path: string }>;
      return rows.map(row => ({ projectPath: row.project_path }));
    },

    recall(query, limit, options) {
      let trace: RecallTrace | undefined;
      const candidates = recallSessions(db, query, {
        topK: limit,
        candidateLimit: limit,
        projectPaths: options?.projectPaths,
        ...(options?.includeTrace ? { onTrace: value => { trace = value; } } : {}),
      }).map(hit => ({
        sessionId: hit.sessionId,
        score: hit.score,
      }));
      return options?.includeTrace ? { candidates, trace } : candidates;
    },

    getSession(sessionId) {
      const row = db
        .prepare('SELECT id, title, project_path, started_at FROM work_sessions WHERE id = ?')
        .get(sessionId) as unknown as
        | { id: string; title: string; project_path: string; started_at: number }
        | undefined;
      return row
        ? {
            id: row.id,
            title: row.title,
            projectPath: row.project_path,
            startedAt: row.started_at,
          }
        : undefined;
    },

    getDigestKeyFiles(sessionId) {
      const row = db
        .prepare('SELECT key_files FROM session_digests WHERE session_id = ?')
        .get(sessionId) as unknown as { key_files: string | null } | undefined;
      return row?.key_files;
    },

    getToolInputs(sessionId) {
      const rows = db
        .prepare('SELECT input_summary, timestamp FROM tool_executions WHERE session_id = ?')
        .all(sessionId) as unknown as Array<{
          input_summary: string | null;
          timestamp: number | null;
        }>;
      return rows.map(row => ({
        inputSummary: row.input_summary,
        timestamp: row.timestamp,
      }));
    },

    findToolInputsContaining(tokens, options) {
      const queryTokens = boundedEvidenceTokens(tokens);
      if (queryTokens.length === 0) return [];
      const scope = projectClause('ws.project_path', options?.projectPaths);
      const statement = db.prepare(
        `SELECT te.input_summary, te.timestamp, ws.id AS session_id, ws.title, ws.project_path
         FROM tool_executions te JOIN work_sessions ws ON ws.id = te.session_id
         WHERE te.input_summary LIKE ? ESCAPE '\\'${scope}
         ORDER BY te.timestamp DESC, te.rowid DESC
         LIMIT ?`,
      );
      const rows: Array<{
          input_summary: string | null;
          timestamp: number | null;
          session_id: string;
          title: string;
          project_path: string;
      }> = [];
      const seen = new Set<string>();
      for (const token of queryTokens) {
        const batch = statement.all(
          likePattern(token),
          ...(options?.projectPaths ?? []),
          FILE_EVIDENCE_ROWS_PER_TOKEN,
        ) as unknown as typeof rows;
        for (const row of batch) {
          const key = `${row.session_id}\0${row.timestamp ?? ''}\0${row.input_summary ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push(row);
          if (rows.length >= FILE_EVIDENCE_RESULT_LIMIT) break;
        }
        if (rows.length >= FILE_EVIDENCE_RESULT_LIMIT) break;
      }
      return rows.map(row => ({
        inputSummary: row.input_summary,
        timestamp: row.timestamp,
        sessionId: row.session_id,
        title: row.title,
        projectPath: row.project_path,
      }));
    },

    findDigestFilesContaining(tokens, options) {
      const queryTokens = boundedEvidenceTokens(tokens);
      if (queryTokens.length === 0) return [];
      const scope = projectClause('ws.project_path', options?.projectPaths);
      const statement = db.prepare(
        `SELECT sd.session_id, sd.key_files, ws.title, ws.project_path, ws.started_at
         FROM session_digests sd JOIN work_sessions ws ON ws.id = sd.session_id
         WHERE sd.key_files LIKE ? ESCAPE '\\'${scope}
         ORDER BY ws.last_activity_at DESC, sd.session_id
         LIMIT ?`,
      );
      const rows: Array<{
          session_id: string;
          key_files: string | null;
          title: string;
          project_path: string;
          started_at: number;
      }> = [];
      const seen = new Set<string>();
      for (const token of queryTokens) {
        const batch = statement.all(
          likePattern(token),
          ...(options?.projectPaths ?? []),
          FILE_EVIDENCE_ROWS_PER_TOKEN,
        ) as unknown as typeof rows;
        for (const row of batch) {
          if (seen.has(row.session_id)) continue;
          seen.add(row.session_id);
          rows.push(row);
          if (rows.length >= FILE_EVIDENCE_RESULT_LIMIT) break;
        }
        if (rows.length >= FILE_EVIDENCE_RESULT_LIMIT) break;
      }
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

/** Preserve the original MCP-facing API while delegating behavior to SKILLS. */
export function vestiSearchFiles(
  db: VestiDatabase,
  args: SearchFilesArgs,
): SearchFilesResult {
  return searchFiles(createFileSearchDataSource(db), args);
}
