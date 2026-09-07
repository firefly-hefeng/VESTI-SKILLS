/**
 * The memory space (schema v14): unified long-term memory entries — deposit
 * documents migrated out of the renderer, dream-extracted durable facts about
 * the user, dream run logs and free notes. Two more progressive-disclosure
 * layers beside the session tools in tools.ts:
 *
 *   1. vesti_memory_search — index entries (~150 tokens each) or a newest-
 *      first browse list when no query is given
 *   2. vesti_memory_get    — full documents for a handful of ids
 *
 * FTS strategy mirrors recall.ts: the memory_entries_fts tokenizer (trigram
 * when the app's SQLite build supports it, unicode61 otherwise) is detected
 * from sqlite_master and the query plan adapts to it; when the FTS table is
 * unusable the query path degrades to an empty result instead of throwing.
 * Read-only, like every MCP tool in this package.
 */

import type { VestiDatabase } from './db.js';
import { buildQueryPlan, buildSnippet, detectFtsTokenizer, recallTokens } from './recall.js';

// ==================== shared helpers ====================

/** The memory space exists only on schema v14+ databases. */
export function hasMemorySpace(db: VestiDatabase): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'")
      .get();
    return row != null;
  } catch {
    return false;
  }
}

/**
 * Friendly failure instead of a SQL stack: older databases simply predate the
 * memory space. The server turns thrown errors into isError text results.
 */
function requireMemorySpace(db: VestiDatabase): void {
  if (!hasMemorySpace(db)) {
    throw new Error(
      'The memory space is not set up in this database yet (no memory_entries table — it arrives with schema v14). ' +
        'Run `vesti setup` from a global @vesti/memory installation, or start the standalone capture runtime so migrations run, then try again.',
    );
  }
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

interface MemoryRow {
  id: string;
  kind: string;
  title: string;
  content_markdown: string;
  summary: string | null;
  scope: string | null;
  template: string | null;
  source_session_ids: string;
  tags: string;
  version: number;
  prev_id: string | null;
  last_ops: string | null;
  status: string;
  entry_date: string | null;
  created_at: number;
  updated_at: number;
}

const MEMORY_COLUMNS = `id, kind, title, content_markdown, summary, scope, template,
  source_session_ids, tags, version, prev_id, last_ops, status, entry_date, created_at, updated_at`;

/** Same columns, qualified for the FTS join query. */
const MEMORY_COLUMNS_E = MEMORY_COLUMNS.split(',').map(col => `e.${col.trim()}`).join(', ');

function buildFilters(
  args: { kind?: string; entry_date?: string; include_archived?: boolean },
): { where: string[]; params: Array<string | number> } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (!args.include_archived) where.push(`e.status = 'active'`);
  if (args.kind) {
    where.push('e.kind = ?');
    params.push(args.kind);
  }
  if (args.entry_date) {
    where.push('e.entry_date = ?');
    params.push(args.entry_date);
  }
  return { where, params };
}

// ==================== layer 1: vesti_memory_search ====================

export interface MemorySearchEntry {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  entry_date: string | null;
  tags: string[];
  updated_at: string | null;
  /** ~160-char extract of content_markdown, centered on the first query hit. */
  snippet: string;
}

export function vestiMemorySearch(
  db: VestiDatabase,
  args: {
    query?: string;
    kind?: string;
    entry_date?: string;
    limit?: number;
    include_archived?: boolean;
  } = {},
): { query: string | null; kind: string | null; count: number; results: MemorySearchEntry[] } {
  requireMemorySpace(db);
  const query = args.query?.trim() || null;
  const limit = Math.max(1, Math.min(args.limit ?? 10, 20));
  const { where, params } = buildFilters(args);
  const statusAndFilters = where.length > 0 ? `AND ${where.join(' AND ')}` : '';

  let rows: MemoryRow[];
  if (query) {
    // Tokenizer-aware FTS over title/content_markdown/tags, same query-plan
    // strategy as session recall (trigram merges short CJK/Latin tokens into
    // verbatim spans; unicode61 matches plain OR-ed tokens).
    const tokenizer = detectFtsTokenizer(db, 'memory_entries_fts');
    const { ftsQuery } = buildQueryPlan(query, tokenizer);
    if (!ftsQuery) {
      // Every token is unmatchable (e.g. all <3 chars under trigram) — mirror
      // recall's abstention instead of silently ignoring the query.
      return { query, kind: args.kind ?? null, count: 0, results: [] };
    }
    try {
      rows = db
        .prepare(
          `SELECT ${MEMORY_COLUMNS_E}
           FROM memory_entries_fts fts
           JOIN memory_entries e ON e.rowid = fts.rowid
           WHERE memory_entries_fts MATCH ? ${statusAndFilters}
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, ...params, limit) as unknown as MemoryRow[];
    } catch {
      rows = []; // FTS table unusable in this SQLite build — degrade like recall
    }
  } else {
    // Browse mode: newest first, same filters.
    rows = db
      .prepare(
        `SELECT ${MEMORY_COLUMNS_E}
         FROM memory_entries e
         WHERE 1 = 1 ${statusAndFilters}
         ORDER BY e.updated_at DESC
         LIMIT ?`,
      )
      .all(...params, limit) as unknown as MemoryRow[];
  }

  const tokens = query ? recallTokens(query) : [];
  const results: MemorySearchEntry[] = rows.map(row => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    entry_date: row.entry_date,
    tags: parseJsonArray(row.tags),
    updated_at: iso(row.updated_at),
    snippet: buildSnippet(row.content_markdown ?? '', tokens),
  }));
  return { query, kind: args.kind ?? null, count: results.length, results };
}

// ==================== layer 2: vesti_memory_get ====================

export const MEMORY_GET_MAX_IDS = 10;

export interface MemoryEntryFull {
  id: string;
  kind: string;
  title: string;
  content_markdown: string;
  summary: string | null;
  scope: string | null;
  template: string | null;
  source_session_ids: string[];
  tags: string[];
  version: number;
  prev_id: string | null;
  last_ops: string | null;
  status: string;
  entry_date: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function vestiMemoryGet(
  db: VestiDatabase,
  args: { ids: string[]; include_archived?: boolean },
): { requested: number; count: number; missing: string[]; entries: MemoryEntryFull[] } {
  requireMemorySpace(db);
  const ids = (args.ids ?? []).filter(id => typeof id === 'string' && id.trim().length > 0);
  if (ids.length === 0) throw new Error('ids is required — a non-empty array of memory entry ids');
  if (ids.length > MEMORY_GET_MAX_IDS) {
    throw new Error(`vesti_memory_get accepts at most ${MEMORY_GET_MAX_IDS} ids per call (got ${ids.length})`);
  }

  const stmt = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memory_entries WHERE id = ?`);
  const entries: MemoryEntryFull[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const row = stmt.get(id) as unknown as MemoryRow | undefined;
    if (!row || (row.status !== 'active' && !args.include_archived)) {
      missing.push(id);
      continue;
    }
    entries.push({
      id: row.id,
      kind: row.kind,
      title: row.title,
      content_markdown: row.content_markdown,
      summary: row.summary,
      scope: row.scope,
      template: row.template,
      source_session_ids: parseJsonArray(row.source_session_ids),
      tags: parseJsonArray(row.tags),
      version: row.version,
      prev_id: row.prev_id,
      last_ops: row.last_ops,
      status: row.status,
      entry_date: row.entry_date,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    });
  }
  return { requested: ids.length, count: entries.length, missing, entries };
}
