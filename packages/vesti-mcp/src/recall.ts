/**
 * Cross-session recall — a port of capture-core's SessionRecall (FTS5 over
 * messages_fts and sessions_fts fused with Reciprocal Rank Fusion, k=60),
 * re-implemented here against `node:sqlite` so the MCP server has zero
 * dependency on the desktop app's better-sqlite3 native binary.
 *
 * The vector signal from SessionRecall is intentionally omitted: digest
 * embeddings require an embedding service that is only available inside the
 * running app. Without a query vector SessionRecall degrades to pure FTS as
 * well, so behavior matches its documented fallback path.
 *
 * Schema compatibility: the desktop app owns all migrations. This consumer
 * detects at query time which shape it is reading —
 *   - messages_fts tokenizer: trigram (schema v5+) or the unicode61 default
 *     (older DBs). The same quoted-token OR query parses under both; only
 *     the confidence coverage accounting differs (trigram cannot match
 *     tokens shorter than 3 characters).
 *   - recency decay + confidence mirror SessionRecall on both shapes.
 */

import type { VestiDatabase } from './db.js';

const RRF_K = 60;
const DEFAULT_CANDIDATE_LIMIT = 30;

/** Recency decay time constant: fused score × (FLOOR + (1−FLOOR)·exp(−ageDays/τ)). */
export const RECENCY_TAU_DAYS = 90;
/**
 * Recency decay floor, deliberately shallow: RRF k=60 compresses top ranks
 * to within ~2% of each other, so a deep floor lets fresh noise outrank
 * clearly better old hits. 0.9 bounds the swing to ≤10% — enough to order
 * same-fact update pairs, not enough to bury strong old hits.
 */
export const RECENCY_FLOOR = 0.9;
/** Trigram indexes 3-character windows; shorter query tokens can never match. */
export const TRIGRAM_MIN_TOKEN_CHARS = 3;
/**
 * Merged short-token spans count as coverage evidence only when the
 * short-token part has at least this many characters: a single-character
 * token is almost always a function word ("的"), and its merge ("的 ma") is
 * weak evidence that would inflate decoy coverage. Two-character shorts
 * ("CI", "M3") are content — their spans count.
 */
export const COVERAGE_MERGE_MIN_SHORT_CHARS = 2;
/**
 * Confidence calibration (bench A, docs/bench/after-trigram-2026-07-19.md):
 * a hit is 'low' when its best matching message literally covers less than
 * this fraction of the matchable query tokens. RRF scores are flat by design
 * and cannot tell a decoy from a real hit; coverage is the usable signal.
 */
export const CONFIDENCE_COVERAGE_FLOOR = 0.5;

export type RecallConfidence = 'high' | 'low';

export interface RecallHit {
  sessionId: string;
  /** Fused RRF score scaled by recency decay; higher is better. */
  score: number;
  snippet: string;
  /**
   * Abstention signal: 'low' when the query has no matchable tokens or the
   * best message covers less than CONFIDENCE_COVERAGE_FLOOR of them. A 'low'
   * top-1 means the answer is probably not in the archive.
   */
  confidence: RecallConfidence;
}

/** Word tokens usable for FTS MATCH and snippet locating. */
export function recallTokens(query: string): string[] {
  return query.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/** Build a safe FTS5 MATCH expression: each token quoted, OR-combined. */
export function toFtsQuery(query: string): string {
  return recallTokens(query)
    .map(token => `"${token.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/**
 * Recency multiplier in (RECENCY_FLOOR, 1]: 1.0 for activity right now,
 * decaying exponentially toward the floor for very old sessions.
 */
export function recencyFactor(lastActivityAt: number, now: number, tauDays: number = RECENCY_TAU_DAYS): number {
  const ageDays = Math.max(0, (now - lastActivityAt) / 86_400_000);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.exp(-ageDays / tauDays);
}

/**
 * Detect the tokenizer of an FTS table ('trigram' on schema v5+ messages_fts,
 * the unicode61 default on older DBs). One cheap sqlite_master lookup per call.
 */
export function detectFtsTokenizer(db: VestiDatabase, ftsTable: string = 'messages_fts'): string {
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(ftsTable) as { sql?: string } | undefined;
    return row?.sql?.toLowerCase().includes('trigram') ? 'trigram' : 'unicode61';
  } catch {
    return 'unicode61';
  }
}

/**
 * Query tokens that can match on their own under the given tokenizer: with
 * trigram, tokens shorter than TRIGRAM_MIN_TOKEN_CHARS (Unicode code points)
 * are dropped; unicode61 can match any token.
 */
export function effectiveTokens(query: string, tokenizer: string): string[] {
  const tokens = recallTokens(query);
  if (tokenizer !== 'trigram') return tokens;
  return tokens.filter(token => [...token].length >= TRIGRAM_MIN_TOKEN_CHARS);
}

interface QueryTokenSpan { text: string; start: number; end: number }

/** recallTokens with source offsets, so original separators stay recoverable. */
function queryTokenSpans(query: string): QueryTokenSpan[] {
  const spans: QueryTokenSpan[] = [];
  const re = /[\p{L}\p{N}_]+/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(query)) !== null) {
    spans.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

const charLen = (s: string): number => [...s].length;

export interface QueryPlan {
  /**
   * FTS5 MATCH expression (quoted OR branches). Under trigram, runs of
   * short (<3-char) tokens are additionally merged into verbatim spans using
   * the original separators ("CI 平台 选型" → `"CI 平台"`): a quoted trigram
   * phrase is a substring match, so a ≥3-char span matches even though its
   * 2-char parts cannot.
   */
  ftsQuery: string;
  /**
   * Units that can literally appear in the matched text (long tokens plus
   * merged spans of COVERAGE_MERGED_MIN_CHARS+). Confidence coverage basis.
   */
  matchUnits: string[];
}

/** Tokenizer-aware query construction; the unicode61 path is unchanged. */
export function buildQueryPlan(query: string, tokenizer: string): QueryPlan {
  const spans = queryTokenSpans(query);
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  if (tokenizer !== 'trigram') {
    return { ftsQuery: spans.map(s => quote(s.text)).join(' OR '), matchUnits: spans.map(s => s.text) };
  }
  const isShort = (text: string) => charLen(text) < TRIGRAM_MIN_TOKEN_CHARS;
  const branches: string[] = [];
  const matchUnits: string[] = [];
  let i = 0;
  while (i < spans.length) {
    const span = spans[i];
    if (!isShort(span.text)) {
      branches.push(quote(span.text));
      matchUnits.push(span.text);
      i += 1;
      continue;
    }
    // A run of consecutive short tokens merges into one verbatim span.
    let j = i;
    while (j + 1 < spans.length && isShort(spans[j + 1].text)) j += 1;
    const shortChars = spans.slice(i, j + 1).reduce((n, s) => n + charLen(s.text), 0);
    let merged = query.slice(span.start, spans[j].end);
    if (charLen(merged) < TRIGRAM_MIN_TOKEN_CHARS) {
      // Still too short ("M3 里程碑…" → "M3"): absorb a prefix of the next
      // long token (or a suffix of the previous one at query end). The
      // neighbour keeps its own branch — the merge only adds a span branch.
      const need = TRIGRAM_MIN_TOKEN_CHARS - charLen(merged);
      if (j + 1 < spans.length) {
        merged += query.slice(spans[j].end, spans[j + 1].start)
          + [...spans[j + 1].text].slice(0, need).join('');
      } else if (i > 0) {
        merged = [...spans[i - 1].text].slice(-need).join('')
          + query.slice(spans[i - 1].end, spans[j].end);
      }
    }
    if (charLen(merged) >= TRIGRAM_MIN_TOKEN_CHARS) {
      branches.push(quote(merged));
      if (shortChars >= COVERAGE_MERGE_MIN_SHORT_CHARS) matchUnits.push(merged);
    }
    i = j + 1;
  }
  return { ftsQuery: branches.join(' OR '), matchUnits };
}

/** Confidence from token coverage; exported for tests. */
export function confidenceForCoverage(coverage: number, effectiveTokenCount: number): RecallConfidence {
  if (effectiveTokenCount === 0) return 'low';
  return coverage >= CONFIDENCE_COVERAGE_FLOOR ? 'high' : 'low';
}

/** Snippet centered on the first token hit; falls back to the text head. */
export function buildSnippet(text: string, tokens: string[], radius = 80): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const lower = cleaned.toLowerCase();
  let at = -1;
  for (const token of tokens) {
    const index = lower.indexOf(token.toLowerCase());
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  if (at === -1) return cleaned.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(cleaned.length, at + radius);
  return `${start > 0 ? '…' : ''}${cleaned.slice(start, end)}${end < cleaned.length ? '…' : ''}`;
}

interface MessageHitRow {
  session_id: string;
  content_text: string | null;
}

function rankMessageHits(db: VestiDatabase, ftsQuery: string, limit: number): MessageHitRow[] {
  try {
    return db
      .prepare(
        `SELECT m.session_id, m.content_text
         FROM messages_fts fts
         JOIN messages m ON m.rowid = fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as unknown as MessageHitRow[];
  } catch {
    return [];
  }
}

function rankSessionHits(db: VestiDatabase, ftsQuery: string, limit: number): Array<{ id: string }> {
  try {
    return db
      .prepare(
        `SELECT ws.id
         FROM sessions_fts fts
         JOIN work_sessions ws ON ws.rowid = fts.rowid
         WHERE sessions_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as unknown as Array<{ id: string }>;
  } catch {
    return [];
  }
}

/**
 * Recall the top-K sessions for a query (pure FTS, RRF-fused across the
 * message and session-title indexes). Returns session ids with a snippet
 * from their best-ranked message hit. Fused scores are scaled by recency
 * decay (τ = RECENCY_TAU_DAYS) and each hit carries a coverage-based
 * confidence flag; both mirror capture-core's SessionRecall.
 */
export function recallSessions(
  db: VestiDatabase,
  query: string,
  options: { topK?: number; candidateLimit?: number; now?: number } = {},
): RecallHit[] {
  const topK = options.topK ?? 8;
  if (topK <= 0) return [];
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const tokens = recallTokens(query);
  const tokenizer = detectFtsTokenizer(db);
  const { ftsQuery, matchUnits } = buildQueryPlan(query, tokenizer);
  if (!ftsQuery) return [];

  const lists: string[][] = [];
  const snippetBySession = new Map<string, string>();
  const coverageBySession = new Map<string, number>();

  const messageSessionIds: string[] = [];
  const loweredUnits = matchUnits.map(unit => unit.toLowerCase());
  for (const row of rankMessageHits(db, ftsQuery, candidateLimit * 4)) {
    if (!snippetBySession.has(row.session_id)) {
      snippetBySession.set(row.session_id, buildSnippet(row.content_text ?? '', tokens));
    }
    if (loweredUnits.length > 0 && row.content_text) {
      const text = row.content_text.toLowerCase();
      const covered = loweredUnits.reduce((n, unit) => n + (text.includes(unit) ? 1 : 0), 0);
      const ratio = covered / loweredUnits.length;
      if (ratio > (coverageBySession.get(row.session_id) ?? 0)) {
        coverageBySession.set(row.session_id, ratio);
      }
    }
    if (!messageSessionIds.includes(row.session_id)) {
      messageSessionIds.push(row.session_id);
    }
  }
  lists.push(messageSessionIds.slice(0, candidateLimit));
  lists.push(rankSessionHits(db, ftsQuery, candidateLimit).map(row => row.id));

  if (lists.every(list => list.length === 0)) return [];

  // RRF fusion; ties break by session id for deterministic output.
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((sessionId, index) => {
      scores.set(sessionId, (scores.get(sessionId) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }

  // Recency re-rank (same formula as SessionRecall): near-equal matches —
  // the update-pair case — order newest first; strong old hits keep their
  // lead (bounded RECENCY_FLOOR swing).
  const now = options.now ?? Date.now();
  const activityStmt = db.prepare('SELECT last_activity_at FROM work_sessions WHERE id = ?');
  for (const [sessionId, score] of scores) {
    const row = activityStmt.get(sessionId) as { last_activity_at: number } | undefined;
    scores.set(sessionId, score * recencyFactor(row?.last_activity_at ?? 0, now));
  }

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, topK);

  return ranked.map(([sessionId, score]) => ({
    sessionId,
    score,
    snippet: snippetBySession.get(sessionId) ?? '',
    confidence: confidenceForCoverage(coverageBySession.get(sessionId) ?? 0, matchUnits.length),
  }));
}
