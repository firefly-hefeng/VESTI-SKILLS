/**
 * Cross-session recall — a port of capture-core's SessionRecall (FTS5 over
 * messages_fts and sessions_fts fused with Reciprocal Rank Fusion, k=60),
 * implemented against the MCP package's VestiDatabase abstraction, with no
 * dependency on the desktop application process.
 *
 * The vector signal from SessionRecall is intentionally omitted: digest
 * embeddings require an embedding service that is only available inside the
 * running app. Without a query vector SessionRecall degrades to pure FTS as
 * well, so behavior matches its documented fallback path.
 *
 * Schema compatibility: the capture/runtime owner applies migrations. This consumer
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

const charLen = (s: string): number => [...s].length;
const SHORT_FALLBACK_STOP_WORDS = new Set([
  'a', 'an', 'as', 'at', 'be', 'by', 'if', 'in', 'is', 'it', 'of', 'on',
  'or', 'to', '项目', '文件', '目录', '位置', '代码', '哪里', '哪个',
  '哪些', '什么', '怎么', '如何', '是否', '请问', '帮我', '一下',
  '相关', '内容', '信息', '记录', '对话', '会话', '历史', '最近',
  '目前', '现在', '最终', '找到', '查找', '定位', '查看', '看看',
]);
const CJK_WORD = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const MAX_SHORT_FALLBACK_TOKENS = 8;

interface SegmentLike {
  segment: string;
  isWordLike?: boolean;
}

/**
 * Split a natural, unspaced CJK run into conservative semantic words.
 * `Intl.Segmenter` is shipped by supported Node/Electron runtimes and turns
 * e.g. "采集增量防护在哪个文件" into 采集/增量/防护/在/哪个/文件.
 * Structural question words and one-character particles are discarded, so
 * every emitted two-character unit is safe to use in a parameterized LIKE.
 */
function cjkSemanticUnits(token: string): string[] {
  if (!CJK_WORD.test(token) || charLen(token) < TRIGRAM_MIN_TOKEN_CHARS) return [token];
  let segments: SegmentLike[] = [];
  try {
    const Segmenter = Intl.Segmenter;
    segments = [...new Segmenter('zh', { granularity: 'word' }).segment(token)] as SegmentLike[];
  } catch {
    // Minimal-ICU runtimes are uncommon, but preserving the original token
    // keeps the normal trigram path working instead of failing the request.
    return [token];
  }
  const meaningful = segments
    .filter(segment => segment.isWordLike !== false)
    .map(segment => segment.segment.toLowerCase())
    .filter(segment => charLen(segment) >= 2)
    .filter(segment => !SHORT_FALLBACK_STOP_WORDS.has(segment));

  // ICU's dictionary deliberately favours precision and can split an
  // otherwise ordinary domain term into single Han characters (for example
  // "重试" -> "重"/"试" and "轮询" -> "轮"/"询").  Trigram FTS cannot
  // search either character, so conservatively reconstruct adjacent bigrams
  // inside each consecutive run of one-character CJK word segments.  Do not
  // bridge a recognised multi-character word or punctuation boundary.
  const reconstructedBigrams: string[] = [];
  let singleRun: string[] = [];
  const flushSingleRun = (): void => {
    for (let i = 0; i + 1 < singleRun.length; i += 1) {
      const bigram = `${singleRun[i]}${singleRun[i + 1]}`.toLowerCase();
      if (!SHORT_FALLBACK_STOP_WORDS.has(bigram)) reconstructedBigrams.push(bigram);
    }
    singleRun = [];
  };
  for (const segment of segments) {
    const value = segment.segment.toLowerCase();
    if (segment.isWordLike !== false && CJK_WORD.test(value) && charLen(value) === 1) {
      singleRun.push(value);
    } else {
      flushSingleRun();
    }
  }
  flushSingleRun();

  const units = [...new Set([...meaningful, ...reconstructedBigrams])];
  return units.length > 0 ? units : [token];
}

export interface QueryPlan {
  /**
   * FTS5 MATCH expression (quoted OR branches). Under trigram this contains
   * only independently matchable tokens (three or more Unicode code points).
   */
  ftsQuery: string;
  /**
   * Units that can literally appear in the matched text. Confidence coverage
   * includes independently queried two-character LIKE fallback terms.
   */
  matchUnits: string[];
  /** Meaningful two-character terms queried independently through LIKE. */
  shortFallbackTokens: string[];
}

/** Tokenizer-aware query construction; the unicode61 path is unchanged. */
export function buildQueryPlan(query: string, tokenizer: string): QueryPlan {
  const tokens = recallTokens(query);
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  if (tokenizer !== 'trigram') {
    return {
      ftsQuery: tokens.map(quote).join(' OR '),
      matchUnits: tokens,
      shortFallbackTokens: [],
    };
  }
  const plannedUnits = tokens.flatMap(cjkSemanticUnits);
  // Keep the original long token as an exact trigram branch for consumers
  // such as memory_search; semantic fragments are additional recall paths.
  const longTokens = [...new Set([...tokens, ...plannedUnits]
    .map(token => token.toLowerCase())
    .filter(token => charLen(token) >= TRIGRAM_MIN_TOKEN_CHARS))];
  const shortFallbackTokens = [...new Set(plannedUnits
    .map(token => token.toLowerCase())
    .filter(token => charLen(token) === 2 && !SHORT_FALLBACK_STOP_WORDS.has(token)))]
    .slice(0, MAX_SHORT_FALLBACK_TOKENS);
  return {
    ftsQuery: longTokens.map(quote).join(' OR '),
    matchUnits: [...longTokens, ...shortFallbackTokens],
    shortFallbackTokens,
  };
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

function projectFilter(column: string, projectPaths: string[]): { sql: string; params: string[] } {
  if (projectPaths.length === 0) return { sql: '', params: [] };
  return {
    sql: ` AND ${column} IN (${projectPaths.map(() => '?').join(', ')})`,
    params: projectPaths,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function rankMessageHits(
  db: VestiDatabase,
  ftsQuery: string,
  limit: number,
  projectPaths: string[],
): MessageHitRow[] {
  try {
    const scope = projectFilter('ws.project_path', projectPaths);
    return db
      .prepare(
        `WITH ranked_messages AS (
           SELECT m.session_id, m.content_text, m.timestamp, fts.rank AS fts_rank,
                  ROW_NUMBER() OVER (
                    PARTITION BY m.session_id
                    ORDER BY fts.rank ASC, m.timestamp DESC, m.rowid DESC
                  ) AS session_row
           FROM messages_fts fts
           JOIN messages m ON m.rowid = fts.rowid
           JOIN work_sessions ws ON ws.id = m.session_id
           WHERE messages_fts MATCH ?
           ${scope.sql}
         )
         SELECT session_id, content_text
         FROM ranked_messages
         WHERE session_row = 1
         ORDER BY fts_rank ASC, timestamp DESC, session_id
         LIMIT ?`,
      )
      .all(ftsQuery, ...scope.params, limit) as unknown as MessageHitRow[];
  } catch {
    return [];
  }
}

function rankSessionHits(
  db: VestiDatabase,
  ftsQuery: string,
  limit: number,
  projectPaths: string[],
): Array<{ id: string }> {
  try {
    const scope = projectFilter('ws.project_path', projectPaths);
    return db
      .prepare(
        `SELECT ws.id
         FROM sessions_fts fts
         JOIN work_sessions ws ON ws.rowid = fts.rowid
         WHERE sessions_fts MATCH ?
         ${scope.sql}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, ...scope.params, limit) as unknown as Array<{ id: string }>;
  } catch {
    return [];
  }
}

function rankMessageLikeHits(
  db: VestiDatabase,
  token: string,
  limit: number,
  projectPaths: string[],
): MessageHitRow[] {
  try {
    const scope = projectFilter('ws.project_path', projectPaths);
    return db.prepare(
      `WITH ranked_messages AS (
         SELECT m.session_id, m.content_text, m.timestamp,
                ROW_NUMBER() OVER (
                  PARTITION BY m.session_id
                  ORDER BY m.timestamp DESC, m.rowid DESC
                ) AS session_row
         FROM messages m
         JOIN work_sessions ws ON ws.id = m.session_id
         WHERE m.content_text LIKE ? ESCAPE '\\'
         ${scope.sql}
       )
       SELECT session_id, content_text
       FROM ranked_messages
       WHERE session_row = 1
       ORDER BY timestamp DESC, session_id
       LIMIT ?`,
    ).all(`%${escapeLike(token)}%`, ...scope.params, limit) as unknown as MessageHitRow[];
  } catch {
    return [];
  }
}

function rankSessionLikeHits(
  db: VestiDatabase,
  token: string,
  limit: number,
  projectPaths: string[],
): Array<{ id: string }> {
  try {
    const scope = projectFilter('ws.project_path', projectPaths);
    const pattern = `%${escapeLike(token)}%`;
    return db.prepare(
      `SELECT ws.id
       FROM work_sessions ws
       WHERE (ws.title LIKE ? ESCAPE '\\' OR COALESCE(ws.summary, '') LIKE ? ESCAPE '\\')
       ${scope.sql}
       ORDER BY ws.last_activity_at DESC, ws.id
       LIMIT ?`,
    ).all(pattern, pattern, ...scope.params, limit) as unknown as Array<{ id: string }>;
  } catch {
    return [];
  }
}

export interface RecallTrace {
  tokenizer: string;
  ftsQuery: string;
  matchUnits: string[];
  shortFallbackTokens: string[];
  projectPaths: string[];
  candidateLimit: number;
  lists: Array<{ source: string; sessionIds: string[] }>;
  ranked: Array<{ sessionId: string; score: number }>;
}

export interface RecallOptions {
  topK?: number;
  candidateLimit?: number;
  now?: number;
  projectPaths?: string[];
  onTrace?: (trace: RecallTrace) => void;
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
  options: RecallOptions = {},
): RecallHit[] {
  const topK = options.topK ?? 8;
  if (topK <= 0) return [];
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const projectPaths = [...new Set(options.projectPaths ?? [])];
  const tokens = recallTokens(query);
  const tokenizer = detectFtsTokenizer(db);
  const { ftsQuery, matchUnits, shortFallbackTokens } = buildQueryPlan(query, tokenizer);

  const lists: string[][] = [];
  const listTrace: RecallTrace['lists'] = [];
  const snippetBySession = new Map<string, string>();
  const coverageBySession = new Map<string, number>();
  const loweredUnits = matchUnits.map(unit => unit.toLowerCase());
  const observeMessage = (row: MessageHitRow) => {
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
  };
  const pushList = (source: string, sessionIds: string[]) => {
    const unique = [...new Set(sessionIds)].slice(0, candidateLimit);
    lists.push(unique);
    listTrace.push({ source, sessionIds: unique });
  };

  if (ftsQuery) {
    const messageRows = rankMessageHits(db, ftsQuery, candidateLimit, projectPaths);
    for (const row of messageRows) observeMessage(row);
    pushList('fts-messages', messageRows.map(row => row.session_id));
    pushList(
      'fts-sessions',
      rankSessionHits(db, ftsQuery, candidateLimit, projectPaths).map(row => row.id),
    );
  }

  for (const token of shortFallbackTokens) {
    const messageRows = rankMessageLikeHits(db, token, candidateLimit, projectPaths);
    for (const row of messageRows) observeMessage(row);
    pushList(`like-messages:${token}`, messageRows.map(row => row.session_id));
    pushList(
      `like-sessions:${token}`,
      rankSessionLikeHits(db, token, candidateLimit, projectPaths).map(row => row.id),
    );
  }

  if (lists.every(list => list.length === 0)) {
    options.onTrace?.({
      tokenizer,
      ftsQuery,
      matchUnits,
      shortFallbackTokens,
      projectPaths,
      candidateLimit,
      lists: listTrace,
      ranked: [],
    });
    return [];
  }

  // RRF fusion; independently matched two-character terms contribute their
  // own lists, so a session containing both outranks a one-term distractor.
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
    const coverage = coverageBySession.get(sessionId) ?? 0;
    const coverageFactor = matchUnits.length > 1 ? 0.45 + 0.55 * coverage : 1;
    scores.set(
      sessionId,
      score * recencyFactor(row?.last_activity_at ?? 0, now) * coverageFactor,
    );
  }

  const rankedAll = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  options.onTrace?.({
    tokenizer,
    ftsQuery,
    matchUnits,
    shortFallbackTokens,
    projectPaths,
    candidateLimit,
    lists: listTrace,
    ranked: rankedAll.slice(0, Math.max(topK, 30)).map(([sessionId, score]) => ({ sessionId, score })),
  });
  const ranked = rankedAll.slice(0, topK);

  return ranked.map(([sessionId, score]) => ({
    sessionId,
    score,
    snippet: snippetBySession.get(sessionId) ?? '',
    confidence: confidenceForCoverage(coverageBySession.get(sessionId) ?? 0, matchUnits.length),
  }));
}
