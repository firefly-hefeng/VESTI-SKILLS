/**
 * File timeline (memory v2, L2 support query).
 *
 * Every touch of one file across the project's sessions: which session, when,
 * with which tool. Deterministic — tool_executions.input_summary is scanned
 * for the queried path (basename or full-path substring match), no LLM.
 */

import { deriveProjectKey } from '../storage/projectRegistry.js';
import type { FileTimelineEvent } from '../types.js';
import { extractFilePaths } from './projectState.js';

type Database = import('better-sqlite3').Database;

export interface FileTimelineQuery {
  /** Restrict to one derived project key; omit for a global timeline. */
  projectKey?: string;
  filePath: string;
  limit?: number;
}

const DEFAULT_LIMIT = 200;

/**
 * True when an extracted path refers to the queried file. A full-path hit
 * wins; otherwise the basename must match (digest key_files are often bare
 * paths or basenames).
 */
export function pathMatches(query: string, candidate: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return false;
  if (q === c || c.endsWith(`/${q}`) || q.endsWith(`/${c}`)) return true;
  const base = (value: string) => value.slice(value.lastIndexOf('/') + 1);
  return base(q) === base(c);
}

export function getFileTimeline(db: Database, query: FileTimelineQuery): FileTimelineEvent[] {
  const filePath = query.filePath.trim();
  if (!filePath) return [];
  const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, 1000));

  // Narrow with a cheap LIKE on both separator variants, then confirm with
  // the extractor so look-alike substrings ("app.ts" vs "app.tsx") stay out.
  const likeNeedles = [filePath, filePath.replace(/\//g, '\\')]
    .map(needle => `%${needle.replace(/[%_]/g, '')}%`);
  const baseName = (filePath.replace(/\\/g, '/').split('/').pop() ?? filePath).replace(/[%_]/g, '');

  let sessionFilter = '';
  const params: unknown[] = [];
  if (query.projectKey) {
    const sessionIds = (db.prepare(`
      SELECT id, platform, host, project_path, git_remote FROM work_sessions
      WHERE session_type = 'conversation'
    `).all() as Array<{
      id: string; platform: string; host: string | null; project_path: string; git_remote: string | null;
    }>)
      .filter(row => deriveProjectKey({
        platform: row.platform,
        host: row.host || 'native',
        projectPath: row.project_path,
        gitRemote: row.git_remote ?? undefined,
      }) === query.projectKey)
      .map(row => row.id);
    if (sessionIds.length === 0) return [];
    sessionFilter = ` AND te.session_id IN (${sessionIds.map(() => '?').join(',')})`;
    params.push(...sessionIds);
  }

  const rows = db.prepare(`
    SELECT te.session_id, te.tool_name, te.tool_category, te.is_error, te.timestamp,
           te.input_summary, ws.title AS session_title, ws.platform
    FROM tool_executions te
    JOIN work_sessions ws ON ws.id = te.session_id
    WHERE te.input_summary IS NOT NULL
      AND (te.input_summary LIKE ? OR te.input_summary LIKE ? OR te.input_summary LIKE ?)
      ${sessionFilter}
    ORDER BY te.timestamp ASC
    LIMIT ?
  `).all(`%${baseName}%`, ...likeNeedles, ...params, limit * 3) as Array<{
    session_id: string;
    tool_name: string;
    tool_category: string | null;
    is_error: number;
    timestamp: number;
    input_summary: string | null;
    session_title: string;
    platform: string;
  }>;

  const events: FileTimelineEvent[] = [];
  for (const row of rows) {
    const paths = extractFilePaths(row.input_summary ?? '');
    if (!paths.some(candidate => pathMatches(filePath, candidate))) continue;
    events.push({
      sessionId: row.session_id,
      sessionTitle: row.session_title || 'Untitled',
      platform: row.platform,
      toolName: row.tool_name,
      toolCategory: row.tool_category ?? 'other',
      isError: row.is_error === 1,
      timestamp: row.timestamp,
    });
    if (events.length >= limit) break;
  }
  return events;
}
