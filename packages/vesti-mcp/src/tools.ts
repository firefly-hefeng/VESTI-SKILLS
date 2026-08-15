/**
 * The progressive-disclosure tools exposed over MCP:
 *
 *   1. vesti_search        — session-level index entries (~100 tokens each)
 *   2. vesti_timeline      — per-session turn outline to locate a passage
 *   3. vesti_get_turns     — full message content for a handful of turns
 *   4. vesti_project_brief — L0 state card + L2 brief of a whole project
 *
 * Pure SQL + string logic over the database handle; every function is
 * unit-testable against a temporary database file. The single write in this
 * package is the session_digests.access_count bump in vesti_search (memory
 * v2 L1 access tracking); everything else is read-only.
 */

import type { VestiDatabase } from './db.js';
import { recallSessions } from './recall.js';

// ==================== shared helpers ====================

interface SessionRow {
  id: string;
  session_id: string;
  title: string;
  platform: string;
  host: string | null;
  project_path: string;
  started_at: number;
  ended_at: number | null;
  turn_count: number | null;
  message_count: number | null;
}

function getSession(db: VestiDatabase, id: string): SessionRow | undefined {
  return db
    .prepare(
      `SELECT id, session_id, title, platform, host, project_path,
              started_at, ended_at, turn_count, message_count
       FROM work_sessions WHERE id = ?`,
    )
    .get(id) as unknown as SessionRow | undefined;
}

/** Accept either the internal work_sessions.id or the platform session_id. */
export function resolveSession(db: VestiDatabase, sessionIdOrPlatformId: string): SessionRow | undefined {
  const byId = getSession(db, sessionIdOrPlatformId);
  if (byId) return byId;
  return db
    .prepare(
      `SELECT id, session_id, title, platform, host, project_path,
              started_at, ended_at, turn_count, message_count
       FROM work_sessions WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(sessionIdOrPlatformId) as unknown as SessionRow | undefined;
}

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

// ==================== layer 1: vesti_search ====================

export interface SearchEntry {
  session_id: string;
  title: string;
  platform: string;
  host: string | null;
  project_path: string;
  started_at: string | null;
  one_liner: string | null;
  key_topics: string[];
  snippet: string;
  score: number;
  /**
   * Abstention signal from recall: 'low' when the hit is weakly supported
   * (best message covers < half of the matchable query tokens). Callers
   * should treat a 'low' top entry as "probably not in the archive".
   */
  confidence: 'high' | 'low';
}

export function vestiSearch(
  db: VestiDatabase,
  args: { query: string; topK?: number },
): { query: string; count: number; results: SearchEntry[] } {
  const topK = Math.max(1, Math.min(args.topK ?? 8, 50));
  const hits = recallSessions(db, args.query, { topK });

  const metaStmt = db.prepare(
    `SELECT ws.id, ws.title, ws.platform, ws.host, ws.project_path, ws.started_at,
            sd.one_liner, sd.key_topics
     FROM work_sessions ws
     LEFT JOIN session_digests sd ON sd.session_id = ws.id
     WHERE ws.id = ?`,
  );

  const results = hits.map(hit => {
    const meta = metaStmt.get(hit.sessionId) as unknown as
      | {
          id: string;
          title: string;
          platform: string;
          host: string | null;
          project_path: string;
          started_at: number;
          one_liner: string | null;
          key_topics: string | null;
        }
      | undefined;
    // FTS may hit a thinking/tool column whose content_text is empty; a blank
    // snippet is worse than no snippet — fall back to the digest one-liner,
    // then to the session title.
    const snippet = hit.snippet.trim() || meta?.one_liner?.trim() || meta?.title || '';
    return {
      session_id: hit.sessionId,
      title: meta?.title ?? 'Untitled',
      platform: meta?.platform ?? '',
      host: meta?.host ?? null,
      project_path: meta?.project_path ?? '',
      started_at: iso(meta?.started_at),
      one_liner: meta?.one_liner ?? null,
      key_topics: parseJsonArray(meta?.key_topics),
      snippet: oneLine(snippet, 200),
      score: Number(hit.score.toFixed(6)),
      confidence: hit.confidence,
    };
  });

  bumpDigestAccess(db, results.map(entry => entry.session_id));

  return { query: args.query, count: results.length, results };
}

/**
 * Memory v2 L1 access tracking: every digest a search surfaces gets its
 * access_count bumped. This is the package's only write; a pre-v4 database
 * (no access_count column) silently skips it.
 */
export function bumpDigestAccess(db: VestiDatabase, sessionIds: string[]): void {
  if (sessionIds.length === 0) return;
  try {
    const stmt = db.prepare(
      'UPDATE session_digests SET access_count = access_count + 1 WHERE session_id = ?',
    );
    for (const id of new Set(sessionIds)) stmt.run(id);
  } catch { /* older schema or locked db — access tracking is best-effort */ }
}

// ==================== layer 2: vesti_timeline ====================

export interface TimelineTurn {
  seq: number;
  started_at: string | null;
  duration_ms: number | null;
  user_intent: string;
  tool_count: number;
  input_tokens: number;
  output_tokens: number;
}

/** Subagent line spawned by this session — one more disclosure level down:
 * call vesti_timeline / vesti_get_turns with its session_id to drill in. */
export interface TimelineSubagent {
  session_id: string;
  role: string | null;
  title: string;
  message_count: number;
  one_liner: string | null;
}

function listSubagents(db: VestiDatabase, sessionId: string): TimelineSubagent[] {
  try {
    const rows = db
      .prepare(
        `SELECT sl.child_session_id, sl.agent_role, sl.slug, ws.title, ws.message_count, sd.one_liner
         FROM subagent_links sl
         JOIN work_sessions ws ON ws.id = sl.child_session_id
         LEFT JOIN session_digests sd ON sd.session_id = sl.child_session_id
         WHERE sl.parent_session_id = ? AND sl.child_session_id IS NOT NULL
         ORDER BY ws.started_at`,
      )
      .all(sessionId) as unknown as Array<{
        child_session_id: string;
        agent_role: string | null;
        slug: string | null;
        title: string;
        message_count: number | null;
        one_liner: string | null;
      }>;
    return rows.map(row => ({
      session_id: row.child_session_id,
      role: row.agent_role ?? row.slug,
      title: oneLine(row.title, 120),
      message_count: row.message_count ?? 0,
      one_liner: row.one_liner ? oneLine(row.one_liner, 160) : null,
    }));
  } catch {
    return []; // older schema without subagent_links — degrade silently
  }
}

export function vestiTimeline(
  db: VestiDatabase,
  args: { session_id: string; around_turn?: number; window?: number },
): {
  session: {
    session_id: string;
    title: string;
    platform: string;
    host: string | null;
    project_path: string;
    started_at: string | null;
    ended_at: string | null;
    turn_count: number;
    message_count: number;
  };
  total_turns: number;
  showing: { from_seq: number; to_seq: number };
  turns: TimelineTurn[];
  /** Subagent lines spawned by this session (absent when there are none). */
  subagents?: TimelineSubagent[];
} {
  const session = resolveSession(db, args.session_id);
  if (!session) {
    throw new Error(`Session not found: ${args.session_id}`);
  }

  interface TurnRow {
    sequence: number;
    started_at: number;
    duration_ms: number | null;
    user_input: string | null;
    tool_execution_count: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
  }

  const allTurns = db
    .prepare(
      `SELECT sequence, started_at, duration_ms, user_input,
              tool_execution_count, input_tokens, output_tokens
       FROM turns WHERE session_id = ? ORDER BY sequence`,
    )
    .all(session.id) as unknown as TurnRow[];

  let rows = allTurns;
  const window = Math.max(1, args.window ?? 10);
  if (args.around_turn != null && allTurns.length > window * 2 + 1) {
    const center = allTurns.findIndex(t => t.sequence === args.around_turn);
    const at = center === -1 ? 0 : center;
    const start = Math.max(0, Math.min(at - window, allTurns.length - (window * 2 + 1)));
    rows = allTurns.slice(start, start + window * 2 + 1);
  }

  const subagents = listSubagents(db, session.id);

  return {
    session: {
      session_id: session.id,
      title: session.title,
      platform: session.platform,
      host: session.host,
      project_path: session.project_path,
      started_at: iso(session.started_at),
      ended_at: iso(session.ended_at),
      turn_count: session.turn_count ?? allTurns.length,
      message_count: session.message_count ?? 0,
    },
    ...(subagents.length > 0 ? { subagents } : {}),
    total_turns: allTurns.length,
    showing: {
      from_seq: rows[0]?.sequence ?? 0,
      to_seq: rows[rows.length - 1]?.sequence ?? 0,
    },
    turns: rows.map(t => ({
      seq: t.sequence,
      started_at: iso(t.started_at),
      duration_ms: t.duration_ms,
      user_intent: oneLine(t.user_input) || '(no user input recorded)',
      tool_count: t.tool_execution_count ?? 0,
      input_tokens: t.input_tokens ?? 0,
      output_tokens: t.output_tokens ?? 0,
    })),
  };
}

// ==================== layer 3: vesti_get_turns ====================

export interface TurnToolExecution {
  tool: string;
  outcome: string;
  input_summary: string | null;
  output_summary: string | null;
  is_error: boolean;
}

export interface TurnContent {
  seq: number;
  started_at: string | null;
  user: string;
  assistant: string;
  thinking: string;
  tools: TurnToolExecution[];
}

export function vestiGetTurns(
  db: VestiDatabase,
  args: {
    session_id: string;
    turn_ids?: number[];
    range?: { from: number; to: number };
    max_chars?: number;
  },
): {
  session_id: string;
  requested: number;
  returned: number;
  truncated: boolean;
  char_count: number;
  max_chars: number;
  turns: TurnContent[];
} {
  const session = resolveSession(db, args.session_id);
  if (!session) {
    throw new Error(`Session not found: ${args.session_id}`);
  }
  const maxChars = Math.max(500, args.max_chars ?? 8000);

  interface TurnRow {
    id: string;
    sequence: number;
    started_at: number;
    user_input: string | null;
  }

  let turnRows: TurnRow[];
  if (args.turn_ids && args.turn_ids.length > 0) {
    const placeholders = args.turn_ids.map(() => '?').join(',');
    turnRows = db
      .prepare(
        `SELECT id, sequence, started_at, user_input FROM turns
         WHERE session_id = ? AND sequence IN (${placeholders}) ORDER BY sequence`,
      )
      .all(session.id, ...args.turn_ids) as unknown as TurnRow[];
  } else if (args.range) {
    turnRows = db
      .prepare(
        `SELECT id, sequence, started_at, user_input FROM turns
         WHERE session_id = ? AND sequence BETWEEN ? AND ? ORDER BY sequence`,
      )
      .all(session.id, args.range.from, args.range.to) as unknown as TurnRow[];
  } else {
    turnRows = db
      .prepare(
        `SELECT id, sequence, started_at, user_input FROM turns
         WHERE session_id = ? ORDER BY sequence`,
      )
      .all(session.id) as unknown as TurnRow[];
  }

  const messageStmt = db.prepare(
    `SELECT source, content_text, content_thinking FROM messages
     WHERE turn_id = ? AND is_sidechain = 0 ORDER BY sequence`,
  );
  const toolStmt = db.prepare(
    `SELECT tool_name, outcome, input_summary, output_summary, is_error
     FROM tool_executions WHERE turn_id = ? ORDER BY sequence`,
  );

  let charCount = 0;
  let truncated = false;
  const turns: TurnContent[] = [];

  const cut = (text: string, budget: number): string => {
    if (text.length <= budget) return text;
    truncated = true;
    return `${text.slice(0, Math.max(0, budget - 40))}\n… [truncated: ${text.length - budget} more chars]`;
  };

  for (const turn of turnRows) {
    if (truncated) break;

    const messages = messageStmt.all(turn.id) as unknown as Array<{
      source: string;
      content_text: string | null;
      content_thinking: string | null;
    }>;
    const tools = toolStmt.all(turn.id) as unknown as Array<{
      tool_name: string;
      outcome: string | null;
      input_summary: string | null;
      output_summary: string | null;
      is_error: number | null;
    }>;

    const joinParts = (parts: Array<string | null>): string =>
      parts.filter((p): p is string => !!p && p.trim().length > 0).join('\n\n');

    const user =
      turn.user_input?.trim() ||
      joinParts(messages.filter(m => m.source === 'user_input').map(m => m.content_text));
    const assistant = joinParts(
      messages.filter(m => m.source === 'assistant_text').map(m => m.content_text),
    );
    const thinking = joinParts(
      messages.filter(m => m.source === 'assistant_think').map(m => m.content_thinking),
    );
    const toolList: TurnToolExecution[] = tools.map(t => ({
      tool: t.tool_name,
      outcome: t.outcome ?? 'unknown',
      input_summary: t.input_summary,
      output_summary: t.output_summary ? oneLine(t.output_summary, 400) : null,
      is_error: t.is_error === 1,
    }));

    const turnChars =
      user.length +
      assistant.length +
      thinking.length +
      toolList.reduce(
        (sum, t) => sum + t.tool.length + (t.input_summary?.length ?? 0) + (t.output_summary?.length ?? 0),
        0,
      );

    if (turns.length > 0 && charCount + turnChars > maxChars) {
      truncated = true;
      break;
    }

    const budget = maxChars - charCount;
    const content: TurnContent = {
      seq: turn.sequence,
      started_at: iso(turn.started_at),
      user: cut(user, budget),
      assistant: cut(assistant, Math.max(0, budget - user.length)),
      thinking: cut(
        thinking,
        Math.max(0, budget - user.length - assistant.length),
      ),
      tools: toolList,
    };
    charCount += Math.min(turnChars, budget);
    turns.push(content);
  }

  return {
    session_id: session.id,
    requested: turnRows.length,
    returned: turns.length,
    truncated,
    char_count: charCount,
    max_chars: maxChars,
    turns,
  };
}

// ==================== layer 4: vesti_project_brief ====================

export interface ProjectBriefResult {
  project_key: string;
  label: string;
  matched: string;
  /** L0 deterministic state card (null before the first desktop rebuild). */
  state: {
    one_liner: string;
    active_files: Array<{ path: string; touches: number; last_touched: string }>;
    open_questions: string[];
    session_count: number;
    last_active: string;
    updated_at: string;
  } | null;
  /** L2 LLM-maintained brief (null until the desktop app generates one). */
  brief: {
    content_markdown: string;
    version: number;
    updated_at: string;
  } | null;
}

interface ProjectCandidate {
  project_key: string;
  label: string | null;
}

/**
 * Fuzzy-match a project name against project_registry (exact key > exact
 * label > substring, case-insensitive) and return its L0 state card plus the
 * L2 brief. Tables from schema v4 may be absent on older databases — those
 * degrade to null fields instead of errors.
 */
export function vestiProjectBrief(
  db: VestiDatabase,
  args: { project: string },
): ProjectBriefResult {
  const needle = (args.project ?? '').trim();
  if (!needle) throw new Error('project is required');

  const candidates = db
    .prepare('SELECT project_key, label FROM project_registry')
    .all() as unknown as ProjectCandidate[];
  if (candidates.length === 0) throw new Error('No projects in the database yet');

  const lower = needle.toLowerCase();
  const scored = candidates
    .map(candidate => {
      const key = candidate.project_key.toLowerCase();
      const label = (candidate.label ?? '').toLowerCase();
      let score = 0;
      if (key === lower || label === lower) score = 3;
      else if (label.includes(lower) || key.includes(lower)) score = 2;
      else if (lower.includes(label) && label.length > 0) score = 1;
      return { candidate, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.project_key.localeCompare(b.candidate.project_key));
  if (scored.length === 0) {
    throw new Error(
      `Project not found: ${needle}. Known projects: ${candidates
        .map(candidate => candidate.label ?? candidate.project_key)
        .slice(0, 10)
        .join(', ')}`,
    );
  }
  const match = scored[0].candidate;

  let state: ProjectBriefResult['state'] = null;
  try {
    const row = db
      .prepare(
        `SELECT one_liner, active_files, open_questions, session_count, last_active, updated_at
         FROM project_state WHERE project_key = ?`,
      )
      .get(match.project_key) as unknown as
      | {
          one_liner: string | null;
          active_files: string | null;
          open_questions: string | null;
          session_count: number | null;
          last_active: string | null;
          updated_at: string | null;
        }
      | undefined;
    if (row) {
      // active_files is a JSON array of objects, unlike the string arrays
      // parseJsonArray handles — parse it directly.
      let files: Array<{ path?: unknown; touches?: unknown; lastTouched?: unknown }> = [];
      try {
        const parsed = JSON.parse(row.active_files ?? '[]');
        if (Array.isArray(parsed)) files = parsed;
      } catch { /* tolerate a corrupt row */ }
      state = {
        one_liner: row.one_liner ?? '',
        active_files: files.map(file => ({
          path: String(file?.path ?? ''),
          touches: Number(file?.touches ?? 0),
          last_touched: String(file?.lastTouched ?? ''),
        })),
        open_questions: parseJsonArray(row.open_questions),
        session_count: row.session_count ?? 0,
        last_active: row.last_active ?? '',
        updated_at: row.updated_at ?? '',
      };
    }
  } catch { /* pre-v4 database without project_state */ }

  let brief: ProjectBriefResult['brief'] = null;
  try {
    const row = db
      .prepare(
        `SELECT content_markdown, version, updated_at
         FROM project_briefs WHERE project_key = ?`,
      )
      .get(match.project_key) as unknown as
      | { content_markdown: string | null; version: number | null; updated_at: string | null }
      | undefined;
    if (row?.content_markdown) {
      brief = {
        content_markdown: row.content_markdown,
        version: row.version ?? 0,
        updated_at: row.updated_at ?? '',
      };
    }
  } catch { /* pre-v4 database without project_briefs */ }

  if (!state && !brief) {
    throw new Error(
      `Project "${match.label ?? match.project_key}" has no memory layers yet — ` +
        'open the VESTI desktop app and let a sync + digest pass finish first.',
    );
  }

  return {
    project_key: match.project_key,
    label: match.label ?? match.project_key,
    matched: needle,
    state,
    brief,
  };
}
