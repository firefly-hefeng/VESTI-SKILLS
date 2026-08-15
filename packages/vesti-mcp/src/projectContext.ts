/**
 * Project-level context tools — the "automatic context" primitives:
 *
 *   vesti_get_project_context — one call returns everything a fresh session
 *     needs to continue work in a project: the L0 state card, the L2 brief,
 *     recent sessions, open questions and the deterministic active-file
 *     timeline. Accepts several paths at once (merge/branch scenarios) and
 *     then also reports cross-project links: shared files, shared topics and
 *     overlapping work windows.
 *   vesti_get_handoff_context — light handoff material aligned with the
 *     app's relay v2 schema: the project block plus the newest user
 *     messages, file anchors and deterministic verify-first hints. Heavy
 *     transcript compression stays in the desktop app's relay pipeline;
 *     this tool only ships raw, checkable anchors.
 *
 * Project key derivation is a port of capture-core's projectRegistry
 * (sha256 of platform|host|normalized basis). The same directory worked on
 * by several agents yields several keys, so the per-key memory layers
 * (project_state / project_briefs) are merged deterministically into one
 * project view. Tables or columns from newer schemas are probed, not
 * assumed — older databases degrade to digest-based answers instead of
 * errors.
 */

import { createHash } from 'node:crypto';

import type { VestiDatabase } from './db.js';
import { resolveSession } from './tools.js';

// ==================== project key derivation (port of capture-core) ====================

/** Must match capture-core storage/projectRegistry.normalizeProjectPath. */
export function normalizeProjectPath(projectPath: string): string {
  let value = projectPath.trim().replace(/\\/g, '/');
  value = value.replace(/\/{2,}/g, '/');
  if (value.length > 1) value = value.replace(/\/+$/, '');
  if (/^[A-Z]:\//.test(value)) value = value[0].toLowerCase() + value.slice(1);
  return value === '/' ? '' : value;
}

function normalizeGitRemote(gitRemote: string): string {
  return gitRemote.trim().replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '');
}

function projectBasis(projectPath: string, gitRemote?: string | null): string {
  const path = normalizeProjectPath(projectPath);
  if (path) return path;
  const remote = normalizeGitRemote(gitRemote ?? '');
  return remote || 'unknown';
}

/** Must match capture-core storage/projectRegistry.deriveProjectKey. */
export function deriveProjectKey(input: {
  platform: string;
  host: string;
  projectPath?: string;
  gitRemote?: string;
}): string {
  const hash = createHash('sha256')
    .update(`${input.platform}|${input.host}|${projectBasis(input.projectPath ?? '', input.gitRemote)}`)
    .digest('hex')
    .slice(0, 16);
  return `cli_${hash}`;
}

function pathLabel(basis: string): string {
  const segments = basis.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? basis;
}

// ==================== shared helpers ====================

function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

function parseJsonArray(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function oneLine(text: string | null | undefined, max = 160): string {
  const cleaned = (text ?? '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

/** Mirror of capture-core utils/injectedBlocks: machine-injected wrappers are
 * not the user's own words, so recent-message excerpts look past them. */
const INJECTED_BLOCK_PATTERNS: RegExp[] = [
  /<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/g,
  /<user_instructions\b[^>]*>[\s\S]*?<\/user_instructions>/g,
  /<git-context\b[^>]*\/>/g,
  /<git-context\b[^>]*>[\s\S]*?<\/git-context>/g,
  /<timestamp>[\s\S]*?<\/timestamp>/g,
  /<user_info>[\s\S]*?<\/user_info>/g,
  /<system_notification>[\s\S]*?<\/system_notification>/g,
  /<system_reminder>[\s\S]*?<\/system_reminder>/g,
];

function stripInjected(text: string): string {
  let result = text;
  for (const pattern of INJECTED_BLOCK_PATTERNS) result = result.replace(pattern, ' ');
  return result.replace(/<\/?user_query>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Column names of a table, for schema-version tolerance (fixture and
 * pre-v5 databases lack git_remote / session_type). */
function tableColumns(db: VestiDatabase, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    return new Set(rows.map(row => row.name));
  } catch {
    return new Set();
  }
}

function tableExists(db: VestiDatabase, table: string): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { name?: string } | undefined;
    return row?.name === table;
  } catch {
    return false;
  }
}

// ==================== session scan ====================

interface ProjectSessionRow {
  id: string;
  platform: string;
  host: string | null;
  project_path: string;
  git_remote: string | null;
  title: string;
  started_at: number;
  ended_at: number | null;
  last_activity_at: number;
}

/** Conversation sessions, oldest schema tolerated. */
function listConversationSessions(db: VestiDatabase): ProjectSessionRow[] {
  const cols = tableColumns(db, 'work_sessions');
  const optional = `${cols.has('git_remote') ? ', git_remote' : ''}${cols.has('session_type') ? ', session_type' : ''}`;
  const rows = db
    .prepare(
      `SELECT id, platform, host, project_path, title, started_at, ended_at, last_activity_at${optional}
       FROM work_sessions`,
    )
    .all() as unknown as Array<ProjectSessionRow & { session_type?: string | null }>;
  return rows
    .filter(row => !('session_type' in row) || (row.session_type ?? 'conversation') === 'conversation')
    .map(row => ({
      id: row.id,
      platform: row.platform,
      host: row.host,
      project_path: row.project_path ?? '',
      git_remote: row.git_remote ?? null,
      title: row.title,
      started_at: row.started_at,
      ended_at: row.ended_at,
      last_activity_at: row.last_activity_at,
    }));
}

function sessionKey(row: ProjectSessionRow): string {
  return deriveProjectKey({
    platform: row.platform,
    host: row.host || 'native',
    projectPath: row.project_path,
    gitRemote: row.git_remote ?? undefined,
  });
}

/** Group conversation sessions by their normalized path-like basis. */
export function groupSessionsByProject(db: VestiDatabase): Map<string, ProjectSessionRow[]> {
  const groups = new Map<string, ProjectSessionRow[]>();
  for (const row of listConversationSessions(db)) {
    const basis = projectBasis(row.project_path, row.git_remote);
    if (basis === 'unknown') continue; // not matchable by path — skip
    const list = groups.get(basis) ?? [];
    list.push(row);
    groups.set(basis, list);
  }
  return groups;
}

// ==================== memory layers ====================

interface DigestRow {
  session_id: string;
  one_liner: string | null;
  key_topics: string | null;
  key_files: string | null;
  open_questions: string | null;
  updated_at: string | null;
}

function digestsForSessions(db: VestiDatabase, sessionIds: string[]): DigestRow[] {
  if (sessionIds.length === 0 || !tableExists(db, 'session_digests')) return [];
  const cols = tableColumns(db, 'session_digests');
  const select = [
    'session_id',
    'one_liner',
    cols.has('key_topics') ? 'key_topics' : "NULL AS key_topics",
    cols.has('key_files') ? 'key_files' : "NULL AS key_files",
    cols.has('open_questions') ? 'open_questions' : "NULL AS open_questions",
    'updated_at',
  ].join(', ');
  try {
    return db
      .prepare(
        `SELECT ${select} FROM session_digests
         WHERE session_id IN (${sessionIds.map(() => '?').join(',')})
         ORDER BY updated_at DESC`,
      )
      .all(...sessionIds) as unknown as DigestRow[];
  } catch {
    return [];
  }
}

interface ProjectStateRow {
  project_key: string;
  one_liner: string | null;
  active_files: string | null;
  open_questions: string | null;
  session_count: number | null;
  last_active: string | null;
  updated_at: string | null;
}

function statesForKeys(db: VestiDatabase, keys: string[]): ProjectStateRow[] {
  if (keys.length === 0 || !tableExists(db, 'project_state')) return [];
  try {
    return db
      .prepare(
        `SELECT project_key, one_liner, active_files, open_questions, session_count, last_active, updated_at
         FROM project_state WHERE project_key IN (${keys.map(() => '?').join(',')})`,
      )
      .all(...keys) as unknown as ProjectStateRow[];
  } catch {
    return [];
  }
}

interface ProjectBriefRow {
  project_key: string;
  content_markdown: string | null;
  version: number | null;
  updated_at: string | null;
}

function briefsForKeys(db: VestiDatabase, keys: string[]): ProjectBriefRow[] {
  if (keys.length === 0 || !tableExists(db, 'project_briefs')) return [];
  try {
    return db
      .prepare(
        `SELECT project_key, content_markdown, version, updated_at
         FROM project_briefs WHERE project_key IN (${keys.map(() => '?').join(',')})`,
      )
      .all(...keys) as unknown as ProjectBriefRow[];
  } catch {
    return [];
  }
}

function registryLabels(db: VestiDatabase, keys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (keys.length === 0 || !tableExists(db, 'project_registry')) return out;
  try {
    const rows = db
      .prepare(
        `SELECT project_key, label FROM project_registry
         WHERE project_key IN (${keys.map(() => '?').join(',')})`,
      )
      .all(...keys) as unknown as Array<{ project_key: string; label: string | null }>;
    for (const row of rows) if (row.label) out.set(row.project_key, row.label);
  } catch { /* degrade to path basename */ }
  return out;
}

// ==================== per-project block ====================

export interface ProjectActiveFile {
  path: string;
  touches: number;
  last_touched: string;
}

export interface ProjectContextSession {
  session_id: string;
  title: string;
  platform: string;
  host: string | null;
  started_at: string | null;
  one_liner: string | null;
  key_topics: string[];
}

export interface ProjectContextBlock {
  /** Normalized path the project is keyed on. */
  path: string;
  label: string;
  /** Derived keys (one per platform+host that worked here). */
  project_keys: string[];
  platforms: string[];
  session_count: number;
  last_active: string | null;
  /** Merged L0 card (null when the desktop app has not built one AND no
   * digest fallback exists). */
  state: {
    one_liner: string;
    active_files: ProjectActiveFile[];
    open_questions: string[];
    updated_at: string;
  } | null;
  /** Newest L2 brief across the project's keys (null until generated). */
  brief: {
    content_markdown: string;
    version: number;
    updated_at: string;
    truncated: boolean;
  } | null;
  recent_sessions: ProjectContextSession[];
  open_questions: string[];
  /** Deterministic key-file timeline (touches + last touch). */
  active_files: ProjectActiveFile[];
}

const OPEN_QUESTIONS_LIMIT = 8;
const ACTIVE_FILES_LIMIT = 10;
const DIGEST_FALLBACK_LIMIT = 5;

function mergeActiveFiles(lists: ProjectActiveFile[][]): ProjectActiveFile[] {
  const byPath = new Map<string, { touches: number; lastTouched: string }>();
  for (const list of lists) {
    for (const file of list) {
      const entry = byPath.get(file.path) ?? { touches: 0, lastTouched: '' };
      entry.touches += file.touches;
      if (file.last_touched > entry.lastTouched) entry.lastTouched = file.last_touched;
      byPath.set(file.path, entry);
    }
  }
  return [...byPath.entries()]
    .sort((a, b) =>
      b[1].touches - a[1].touches
      || b[1].lastTouched.localeCompare(a[1].lastTouched)
      || a[0].localeCompare(b[0]))
    .slice(0, ACTIVE_FILES_LIMIT)
    .map(([path, entry]) => ({ path, touches: entry.touches, last_touched: entry.lastTouched }));
}

function mergeQuestions(lists: string[][], limit = OPEN_QUESTIONS_LIMIT): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const question of list) {
      const cleaned = question.trim();
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function parseStateFiles(text: string | null): ProjectActiveFile[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(file => ({
      path: String(file?.path ?? ''),
      touches: Number(file?.touches ?? 0),
      last_touched: String(file?.lastTouched ?? file?.last_touched ?? ''),
    })).filter(file => file.path);
  } catch {
    return [];
  }
}

export interface ProjectContextOptions {
  session_limit?: number;
  brief_chars?: number;
}

function buildProjectBlock(
  db: VestiDatabase,
  basis: string,
  rows: ProjectSessionRow[],
  digests: DigestRow[],
  options: ProjectContextOptions,
): ProjectContextBlock {
  const sessionLimit = Math.max(1, Math.min(options.session_limit ?? 8, 25));
  const briefChars = Math.max(500, options.brief_chars ?? 4000);
  const keys = [...new Set(rows.map(sessionKey))];
  const states = statesForKeys(db, keys);
  const briefs = briefsForKeys(db, keys);
  const labels = registryLabels(db, keys);
  const digestBySession = new Map(digests.map(digest => [digest.session_id, digest]));

  // L0 merge: official state cards win; digests are the pre-v4 fallback.
  const stateFiles = states.map(state => parseStateFiles(state.active_files));
  const digestFiles = digests.slice(0, DIGEST_FALLBACK_LIMIT).map((digest, index) =>
    parseJsonArray(digest.key_files).map(path => ({
      path,
      touches: DIGEST_FALLBACK_LIMIT - index, // newest digest weighs most
      last_touched: digest.updated_at ?? '',
    })),
  );
  const activeFiles = states.length > 0 ? mergeActiveFiles(stateFiles) : mergeActiveFiles(digestFiles);

  const stateQuestions = states.map(state => parseJsonArray(state.open_questions));
  const digestQuestions = digests.slice(0, DIGEST_FALLBACK_LIMIT).map(digest => parseJsonArray(digest.open_questions));
  const openQuestions = mergeQuestions(
    states.length > 0 ? [...stateQuestions, ...digestQuestions] : digestQuestions,
  );

  const newestState = states
    .filter(state => state.one_liner)
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0];
  const oneLiner = newestState?.one_liner ?? digests.find(digest => digest.one_liner)?.one_liner ?? '';
  const stateUpdatedAt = states.reduce((max, state) => (state.updated_at ?? '') > max ? state.updated_at ?? '' : max, '');
  const state = oneLiner || activeFiles.length > 0 || openQuestions.length > 0
    ? {
        one_liner: oneLiner,
        active_files: activeFiles,
        open_questions: openQuestions,
        updated_at: stateUpdatedAt || digests[0]?.updated_at || '',
      }
    : null;

  const newestBrief = briefs
    .filter(brief => brief.content_markdown)
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))[0];
  const brief = newestBrief?.content_markdown
    ? {
        content_markdown: newestBrief.content_markdown.slice(0, briefChars),
        version: newestBrief.version ?? 0,
        updated_at: newestBrief.updated_at ?? '',
        truncated: newestBrief.content_markdown.length > briefChars,
      }
    : null;

  const recent = [...rows]
    .sort((a, b) => b.last_activity_at - a.last_activity_at)
    .slice(0, sessionLimit)
    .map(row => {
      const digest = digestBySession.get(row.id);
      return {
        session_id: row.id,
        title: row.title || 'Untitled',
        platform: row.platform,
        host: row.host,
        started_at: iso(row.started_at),
        one_liner: digest?.one_liner ? oneLine(digest.one_liner) : null,
        key_topics: digest ? parseJsonArray(digest.key_topics) : [],
      };
    });

  const lastActiveMs = rows.reduce((max, row) => Math.max(max, row.last_activity_at || 0), 0);
  const label = keys.map(key => labels.get(key)).find(Boolean) ?? pathLabel(basis);

  return {
    path: basis,
    label,
    project_keys: keys,
    platforms: [...new Set(rows.map(row => row.platform))].sort(),
    session_count: rows.length,
    last_active: lastActiveMs > 0 ? iso(lastActiveMs) : null,
    state,
    brief,
    recent_sessions: recent,
    open_questions: openQuestions,
    active_files: activeFiles,
  };
}

// ==================== cross-project links ====================

export interface CrossProjectLinks {
  /** Files (by trailing two path segments) touched in ≥2 of the projects. */
  shared_files: Array<{ file: string; projects: string[] }>;
  /** Digest key_topics shared by ≥2 of the projects. */
  shared_topics: Array<{ topic: string; projects: string[] }>;
  /** Session-window overlap between project pairs. */
  time_overlaps: Array<{
    projects: [string, string];
    overlapping_session_pairs: number;
    latest_overlap: { start: string; end: string } | null;
  }>;
}

/** Stable signature for "the same file" across checkouts: last two segments. */
function fileSignature(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.slice(-2).join('/').toLowerCase();
}

function buildCrossProjectLinks(
  blocks: ProjectContextBlock[],
  rowsByBasis: Map<string, ProjectSessionRow[]>,
  digestsByBasis: Map<string, DigestRow[]>,
): CrossProjectLinks {
  const fileOwners = new Map<string, Set<string>>();
  for (const block of blocks) {
    const files = new Set<string>([
      ...block.active_files.map(file => fileSignature(file.path)),
      ...(digestsByBasis.get(block.path) ?? [])
        .flatMap(digest => parseJsonArray(digest.key_files))
        .map(fileSignature),
    ]);
    for (const signature of files) {
      if (!signature) continue;
      const owners = fileOwners.get(signature) ?? new Set<string>();
      owners.add(block.label);
      fileOwners.set(signature, owners);
    }
  }

  const topicOwners = new Map<string, Set<string>>();
  for (const block of blocks) {
    const topics = new Set<string>(
      (digestsByBasis.get(block.path) ?? [])
        .flatMap(digest => parseJsonArray(digest.key_topics))
        .map(topic => topic.trim().toLowerCase())
        .filter(Boolean),
    );
    for (const topic of topics) {
      const owners = topicOwners.get(topic) ?? new Set<string>();
      owners.add(block.label);
      topicOwners.set(topic, owners);
    }
  }

  const overlaps: CrossProjectLinks['time_overlaps'] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = (rowsByBasis.get(blocks[i].path) ?? []).slice(0, 50);
      const b = (rowsByBasis.get(blocks[j].path) ?? []).slice(0, 50);
      let pairs = 0;
      let latestStart = 0;
      let latestEnd = 0;
      for (const rowA of a) {
        const endA = rowA.ended_at ?? rowA.last_activity_at;
        for (const rowB of b) {
          const endB = rowB.ended_at ?? rowB.last_activity_at;
          const start = Math.max(rowA.started_at, rowB.started_at);
          const end = Math.min(endA, endB);
          if (start > end) continue;
          pairs += 1;
          if (start > latestStart || (start === latestStart && end > latestEnd)) {
            latestStart = start;
            latestEnd = end;
          }
        }
      }
      if (pairs > 0) {
        overlaps.push({
          projects: [blocks[i].label, blocks[j].label],
          overlapping_session_pairs: pairs,
          latest_overlap: latestStart > 0 ? { start: iso(latestStart)!, end: iso(latestEnd)! } : null,
        });
      }
    }
  }

  const shared = (owners: Map<string, Set<string>>) =>
    [...owners.entries()]
      .filter(([, projects]) => projects.size >= 2)
      .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([name, projects]) => ({ name, projects: [...projects].sort() }));

  return {
    shared_files: shared(fileOwners).map(entry => ({ file: entry.name, projects: entry.projects })),
    shared_topics: shared(topicOwners).map(entry => ({ topic: entry.name, projects: entry.projects })),
    time_overlaps: overlaps.sort((a, b) => b.overlapping_session_pairs - a.overlapping_session_pairs).slice(0, 10),
  };
}

// ==================== vesti_get_project_context ====================

export interface ProjectContextResult {
  generated_at: string;
  projects: ProjectContextBlock[];
  /** Input paths with no captured sessions (not tracked by VESTI). */
  unmatched_paths: string[];
  /** Present only when ≥2 projects matched. */
  cross_project: CrossProjectLinks | null;
  /** Actionable notes (empty state, degradation). */
  hints: string[];
}

function mostRecentBasis(groups: Map<string, ProjectSessionRow[]>): string | null {
  let best: string | null = null;
  let bestActivity = 0;
  for (const [basis, rows] of groups) {
    const activity = rows.reduce((max, row) => Math.max(max, row.last_activity_at || 0), 0);
    if (activity > bestActivity) {
      bestActivity = activity;
      best = basis;
    }
  }
  return best;
}

export function vestiGetProjectContext(
  db: VestiDatabase,
  args: { paths?: string[] } & ProjectContextOptions = {},
): ProjectContextResult {
  const groups = groupSessionsByProject(db);
  const hints: string[] = [];

  if (groups.size === 0) {
    return {
      generated_at: new Date().toISOString(),
      projects: [],
      unmatched_paths: (args.paths ?? []).map(normalizeProjectPath).filter(Boolean),
      cross_project: null,
      hints: [
        'VESTI has no captured sessions yet — run the VESTI desktop app (or CLI capture) and let a sync finish first.',
      ],
    };
  }

  let bases: string[];
  const unmatched: string[] = [];
  const inputs = (args.paths ?? []).map(normalizeProjectPath).filter(Boolean);
  if (inputs.length === 0) {
    const recent = mostRecentBasis(groups);
    if (!recent) {
      return {
        generated_at: new Date().toISOString(),
        projects: [],
        unmatched_paths: [],
        cross_project: null,
        hints: ['No trackable project paths found in the captured sessions.'],
      };
    }
    bases = [recent];
    hints.push('No paths given — defaulted to the most recently active project. Pass your cwd as paths[0] to target a specific project.');
  } else {
    bases = [];
    for (const input of inputs) {
      if (groups.has(input)) bases.push(input);
      else unmatched.push(input);
    }
    if (unmatched.length > 0) {
      hints.push(
        `Unmatched paths: ${unmatched.join(', ')}. Known project paths: ${[...groups.keys()].slice(0, 10).join(', ')}`,
      );
    }
  }

  const uniqueBases = [...new Set(bases)];
  const digestsByBasis = new Map<string, DigestRow[]>();
  const projects = uniqueBases.map(basis => {
    const rows = groups.get(basis) ?? [];
    const digests = digestsForSessions(db, rows.map(row => row.id));
    digestsByBasis.set(basis, digests);
    return buildProjectBlock(db, basis, rows, digests, args);
  });

  if (projects.every(project => !project.state && !project.brief)) {
    hints.push(
      'No L0/L2 memory layers yet (recent sessions are still listed) — open the VESTI desktop app and let a sync + digest pass finish to build them.',
    );
  }

  return {
    generated_at: new Date().toISOString(),
    projects,
    unmatched_paths: unmatched,
    cross_project: projects.length >= 2 ? buildCrossProjectLinks(projects, groups, digestsByBasis) : null,
    hints,
  };
}

// ==================== vesti_get_handoff_context ====================

export interface HandoffContextResult {
  project: ProjectContextBlock;
  /** Newest user messages across the project's sessions (stripped of
   * machine-injected context blocks). */
  recent_user_messages: Array<{
    session_id: string;
    session_title: string;
    timestamp: string | null;
    text: string;
  }>;
  /** Relay-v2 file anchors: the deterministic active-file timeline. */
  file_anchors: ProjectActiveFile[];
  /** Relay-v2 verifyFirst seeds — every entry is grounded in stored data. */
  verify_first: Array<{ check: string; source: string }>;
  hints: string[];
}

const HANDOFF_USER_MESSAGES_DEFAULT = 8;
const HANDOFF_USER_MESSAGES_MAX = 20;
const VERIFY_FIRST_LIMIT = 6;

export function vestiGetHandoffContext(
  db: VestiDatabase,
  args: { path?: string; session_id?: string; user_messages?: number } & ProjectContextOptions = {},
): HandoffContextResult {
  const groups = groupSessionsByProject(db);

  let basis: string | null = null;
  if (args.session_id) {
    const session = resolveSession(db, args.session_id);
    if (!session) throw new Error(`Session not found: ${args.session_id}`);
    const sessionBasis = projectBasis(session.project_path, null);
    if (sessionBasis === 'unknown' || !groups.has(sessionBasis)) {
      throw new Error(`Session ${args.session_id} has no tracked project path`);
    }
    basis = sessionBasis;
  } else if (args.path) {
    const normalized = normalizeProjectPath(args.path);
    if (!groups.has(normalized)) {
      throw new Error(
        `Project not found: ${normalized}. Known project paths: ${[...groups.keys()].slice(0, 10).join(', ')}`,
      );
    }
    basis = normalized;
  } else {
    basis = mostRecentBasis(groups);
    if (!basis) throw new Error('No tracked projects in the database yet');
  }

  const rows = groups.get(basis) ?? [];
  const project = buildProjectBlock(db, basis, rows, digestsForSessions(db, rows.map(row => row.id)), args);
  const sessionIds = rows.map(row => row.id);
  const hints: string[] = [
    'Assemble the actual handoff with the relay v2 schema (goal / state / files / decisions / verification / verifyFirst / handoffPrompt): fill goal, state and decisions from the sessions below — only the anchors here are machine-extracted. Heavy transcript compression lives in the VESTI app relay pipeline, not in this tool.',
  ];

  const messageLimit = Math.max(1, Math.min(args.user_messages ?? HANDOFF_USER_MESSAGES_DEFAULT, HANDOFF_USER_MESSAGES_MAX));
  let recentUserMessages: HandoffContextResult['recent_user_messages'] = [];
  if (sessionIds.length > 0 && tableExists(db, 'messages')) {
    try {
      const messageRows = db
        .prepare(
          `SELECT m.session_id, m.content_text, m.timestamp, ws.title AS session_title
           FROM messages m JOIN work_sessions ws ON ws.id = m.session_id
           WHERE m.session_id IN (${sessionIds.map(() => '?').join(',')})
             AND m.source = 'user_input' AND m.content_text IS NOT NULL
           ORDER BY m.timestamp DESC LIMIT ?`,
        )
        .all(...sessionIds, messageLimit * 3) as unknown as Array<{
          session_id: string;
          content_text: string | null;
          timestamp: number;
          session_title: string;
        }>;
      recentUserMessages = messageRows
        .map(row => ({
          session_id: row.session_id,
          session_title: row.session_title || 'Untitled',
          timestamp: iso(row.timestamp),
          text: oneLine(stripInjected(row.content_text ?? ''), 300),
        }))
        .filter(row => row.text)
        .slice(0, messageLimit);
    } catch { /* messages table shape differs — degrade */ }
  }

  const verifyFirst: Array<{ check: string; source: string }> = [];
  for (const question of project.open_questions.slice(0, 3)) {
    verifyFirst.push({
      check: `Confirm whether this is still unresolved: "${oneLine(question, 120)}"`,
      source: 'project open questions',
    });
  }
  if (sessionIds.length > 0 && tableExists(db, 'tool_executions')) {
    try {
      const failing = db
        .prepare(
          `SELECT te.tool_name, te.input_summary, te.timestamp, ws.title AS session_title
           FROM tool_executions te JOIN work_sessions ws ON ws.id = te.session_id
           WHERE te.session_id IN (${sessionIds.map(() => '?').join(',')}) AND te.is_error = 1
           ORDER BY te.timestamp DESC LIMIT 3`,
        )
        .all(...sessionIds) as unknown as Array<{
          tool_name: string;
          input_summary: string | null;
          timestamp: number;
          session_title: string;
        }>;
      for (const row of failing) {
        verifyFirst.push({
          check: `Re-check the last failing step: ${row.tool_name} — ${oneLine(row.input_summary, 120)}`,
          source: `${row.session_title || 'Untitled'} (${(iso(row.timestamp) ?? '').slice(0, 10)})`,
        });
      }
    } catch { /* degrade */ }
  }

  return {
    project,
    recent_user_messages: recentUserMessages,
    file_anchors: project.active_files,
    verify_first: verifyFirst.slice(0, VERIFY_FIRST_LIMIT),
    hints,
  };
}
