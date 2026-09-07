/**
 * L0 project_state generator (memory v2).
 *
 * One deterministic "current state card" per project — pure SQL + JS, no LLM.
 * The card is rewritten wholesale on every rebuild: it never expires and the
 * compression pipeline never touches it.
 *
 *   one_liner      newest session digest one-liner
 *   active_files   top-10 files from the last 30 days of tool_executions,
 *                  ranked by touch count then recency (ties: path asc)
 *   open_questions merged + deduped from the 5 newest digests (cap 8)
 *   session_count / last_active   plain aggregates
 */

import { deriveProjectKey } from '../storage/projectRegistry.js';
import { stripInjectedContextBlocks } from '../utils/injectedBlocks.js';
import type { ProjectActiveFile, ProjectState } from '../types/unified.js';

type Database = import('better-sqlite3').Database;

export const ACTIVE_FILES_WINDOW_DAYS = 30;
export const ACTIVE_FILES_LIMIT = 10;
export const OPEN_QUESTIONS_DIGEST_LIMIT = 5;
export const OPEN_QUESTIONS_LIMIT = 8;

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** JSON keys whose values are file paths across the captured platforms
 * (Read/Edit/Write/Grep… store their input as a JSON object). */
const PATH_JSON_KEYS = new Set([
  'path', 'file_path', 'filepath', 'file', 'target_file', 'target_notebook',
  'notebook_path', 'abs_path', 'absolute_path',
]);

function looksLikeFilePath(candidate: string): boolean {
  // Real files carry a directory separator AND a final extension segment;
  // this rejects code-fragment junk like `t.text` / `EXPERTS.map` that the
  // old regex promoted into "active files".
  if (candidate.length < 3 || !candidate.includes('/')) return false;
  const base = candidate.slice(candidate.lastIndexOf('/') + 1);
  if (!/^[\p{L}\p{N}_.@+-]+\.[\p{L}\p{N}]{1,10}$/u.test(base)) return false;
  // Ignore version strings and URLs.
  if (/^\d+\.\d+/.test(base)) return false;
  if (/^https?:/i.test(candidate)) return false;
  return true;
}

/**
 * Pull plausible file paths out of a tool input summary. Deterministic.
 * Tool inputs are JSON objects on every captured platform, so path-named
 * keys are read directly; free text falls back to a path regex. Either way
 * a candidate must look like a real file (separator + extension) — the old
 * bare-word regex filled active_files with member-access fragments.
 */
export function extractFilePaths(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const add = (value: string) => {
    const candidate = value.replace(/\\/g, '/').replace(/[.,;:)\]]+$/, '');
    if (looksLikeFilePath(candidate)) out.add(candidate);
  };
  const pattern = /(?:[A-Za-z]:[\\/]|~?[\\/]|\.{1,2}[\\/])?(?:[\p{L}\p{N}_.@+-]+[\\/])+[\p{L}\p{N}_.@+-]+\.[\p{L}\p{N}]{1,10}/gu;
  if (text.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') continue;
        if (PATH_JSON_KEYS.has(key.toLowerCase())) {
          add(value);
        } else if (key.toLowerCase() === 'command') {
          // Shell commands legitimately reference files; content-ish values
          // (contents/new_string/…) are skipped — code text is where the
          // member-access junk came from.
          for (const match of value.matchAll(pattern)) add(match[0]);
        }
      }
      return [...out];
    } catch { /* not valid JSON — fall through to the regex */ }
  }
  for (const match of text.matchAll(pattern)) add(match[0]);
  return [...out];
}

interface SessionRow {
  id: string;
  platform: string;
  host: string | null;
  project_path: string;
  git_remote: string | null;
  last_activity_at: number;
}

/** work_sessions ids belonging to a derived project key. */
function sessionRowsForProject(db: Database, projectKey: string): SessionRow[] {
  const rows = db.prepare(`
    SELECT id, platform, host, project_path, git_remote, last_activity_at
    FROM work_sessions
    WHERE session_type = 'conversation'
  `).all() as SessionRow[];
  return rows.filter(row => deriveProjectKey({
    platform: row.platform,
    host: row.host || 'native',
    projectPath: row.project_path,
    gitRemote: row.git_remote ?? undefined,
  }) === projectKey);
}

interface ActiveFileAccumulator {
  touches: number;
  lastTouchedMs: number;
}

/**
 * Rank files touched by the project's tool executions inside the lookback
 * window. Deterministic ordering: touches desc, last-touched desc, path asc.
 */
export function rankActiveFiles(
  touches: Array<{ timestampMs: number; paths: string[] }>,
  limit = ACTIVE_FILES_LIMIT,
): ProjectActiveFile[] {
  const byPath = new Map<string, ActiveFileAccumulator>();
  for (const touch of touches) {
    for (const path of touch.paths) {
      const entry = byPath.get(path) ?? { touches: 0, lastTouchedMs: 0 };
      entry.touches += 1;
      if (touch.timestampMs > entry.lastTouchedMs) entry.lastTouchedMs = touch.timestampMs;
      byPath.set(path, entry);
    }
  }
  return [...byPath.entries()]
    .sort((a, b) =>
      b[1].touches - a[1].touches
      || b[1].lastTouchedMs - a[1].lastTouchedMs
      || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([path, entry]) => ({
      path,
      touches: entry.touches,
      lastTouched: new Date(entry.lastTouchedMs).toISOString(),
    }));
}

/** Merge open_questions from newest-first digests: deduped, first-seen order. */
export function mergeOpenQuestions(digests: Array<{ openQuestions: string[] }>, limit = OPEN_QUESTIONS_LIMIT): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const digest of digests) {
    for (const question of digest.openQuestions) {
      const cleaned = question.trim();
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Rebuild the L0 card for one project. Pure read; the caller persists. */
export function buildProjectState(db: Database, projectKey: string, now: Date = new Date()): ProjectState {
  const sessions = sessionRowsForProject(db, projectKey);
  const sessionIds = sessions.map(row => row.id);

  const digests = sessionIds.length === 0 ? [] : (db.prepare(`
    SELECT one_liner, key_topics, key_files, decisions, open_questions, updated_at
    FROM session_digests
    WHERE session_id IN (${sessionIds.map(() => '?').join(',')})
    ORDER BY updated_at DESC
  `).all(...sessionIds) as Array<{
    one_liner: string | null;
    key_topics: string | null;
    key_files: string | null;
    decisions: string | null;
    open_questions: string | null;
    updated_at: string | null;
  }>);

  // Prefer the newest REAL digest for the card headline: fallback rows (LLM
  // outage) copy the raw first user prompt — often a pasted agent brief or
  // injected <environment_context>, useless as a project one-liner. A digest
  // with any structured field filled came from a parsed LLM answer.
  const isRealDigest = (row: (typeof digests)[number]) =>
    parseJsonArray(row.key_topics).length > 0 ||
    parseJsonArray(row.key_files).length > 0 ||
    parseJsonArray(row.decisions).length > 0 ||
    parseJsonArray(row.open_questions).length > 0;
  const headline = digests.find(isRealDigest) ?? digests[0];

  const sinceMs = now.getTime() - ACTIVE_FILES_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const touchRows = sessionIds.length === 0 ? [] : (db.prepare(`
    SELECT input_summary, timestamp
    FROM tool_executions
    WHERE session_id IN (${sessionIds.map(() => '?').join(',')})
      AND timestamp >= ?
      AND input_summary IS NOT NULL
  `).all(...sessionIds, sinceMs) as Array<{ input_summary: string | null; timestamp: number }>);

  const lastActiveMs = sessions.reduce((max, row) => Math.max(max, row.last_activity_at || 0), 0);

  return {
    projectKey,
    oneLiner: stripInjectedContextBlocks(headline?.one_liner ?? '').slice(0, 200),
    activeFiles: rankActiveFiles(
      touchRows.map(row => ({ timestampMs: row.timestamp, paths: extractFilePaths(row.input_summary ?? '') })),
    ),
    openQuestions: mergeOpenQuestions(
      digests.slice(0, OPEN_QUESTIONS_DIGEST_LIMIT).map(row => ({ openQuestions: parseJsonArray(row.open_questions) })),
    ),
    sessionCount: sessions.length,
    lastActive: lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : '',
    updatedAt: now.toISOString(),
  };
}

/** Every project key known to the registry, in stable order. */
export function listProjectKeys(db: Database): string[] {
  return (db.prepare('SELECT project_key FROM project_registry ORDER BY project_key').all() as Array<{ project_key: string }>)
    .map(row => row.project_key);
}

/**
 * Render the L0 card as Markdown — the no-LLM fallback content for the L2
 * project brief, so the brief stays useful when the agent is unconfigured.
 */
export function renderProjectStateMarkdown(state: ProjectState, projectLabel?: string): string {
  const lines: string[] = [`# ${projectLabel ?? state.projectKey} — 当前状态`, ''];
  lines.push(`- 一句话：${state.oneLiner || '（暂无）'}`);
  lines.push(`- 会话数：${state.sessionCount}`);
  lines.push(`- 最近活跃：${state.lastActive || '（暂无）'}`);
  lines.push('', '## 活跃文件（近 30 天）');
  if (state.activeFiles.length === 0) {
    lines.push('- （暂无）');
  } else {
    for (const file of state.activeFiles) {
      lines.push(`- \`${file.path}\`（${file.touches} 次，最近 ${file.lastTouched.slice(0, 10)}）`);
    }
  }
  lines.push('', '## 未决问题');
  if (state.openQuestions.length === 0) {
    lines.push('- （暂无）');
  } else {
    for (const question of state.openQuestions) lines.push(`- ${question}`);
  }
  return lines.join('\n');
}
