/**
 * Fork lineage & duplicate counting (memory v2).
 *
 * Two lineage sources exist:
 * - explicit: kimi-code state.json `forkedFrom` (mapped at parse time),
 * - detected: codex `fork`/`resume` copies the parent's whole history into the
 *   child rollout, so two rollouts share most response-item ids. Codex
 *   session_meta carries no lineage field (verified on cli 0.144.5), so forks
 *   are detected by message-id overlap.
 *
 * Message dedup key: codex message ids are namespaced per session
 * (`codex-<sessionId>-message-<itemId>`), so the key strips that prefix;
 * other platforms use raw wire uuids which survive a fork copy verbatim.
 * Everything here is pure — SQL lives with the callers.
 */

/** Strip the per-session namespace so fork copies share a key. */
export function messageDedupKey(platform: string, rawSessionId: string, messageId: string): string {
  if (platform === 'codex') {
    const prefix = `codex-${rawSessionId}-`;
    if (messageId.startsWith(prefix)) return messageId.slice(prefix.length);
  }
  return messageId;
}

export interface ForkCandidateSession {
  /** work_sessions.id */
  id: string;
  /** raw platform session id (work_sessions.session_id) */
  rawSessionId: string;
  platform: string;
  /** ms epoch; the earlier session in an overlap pair is the parent. */
  startedAt: number;
  messageIds: string[];
}

export interface ForkDetectionOptions {
  /** Minimum shared dedup keys to consider a pair fork-related. */
  minShared?: number;
  /** Minimum share of the child's keys found in the parent. */
  minRatio?: number;
}

const DEFAULT_MIN_SHARED = 5;
const DEFAULT_MIN_RATIO = 0.5;

/**
 * Detect fork edges child → parent from message-id overlap. For each session
 * (oldest first) the parent candidate is the earlier session sharing the most
 * dedup keys, provided the share clears both thresholds. A session keeps an
 * explicitly-set lineage (callers filter those out beforehand). Sessions
 * without message overlap stay lineage-free. Cycles are impossible by
 * construction: parents are always strictly earlier.
 */
export function detectForksByMessageOverlap(
  sessions: ForkCandidateSession[],
  options: ForkDetectionOptions = {},
): Map<string, string> {
  const minShared = options.minShared ?? DEFAULT_MIN_SHARED;
  const minRatio = options.minRatio ?? DEFAULT_MIN_RATIO;
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1));

  const keySets = new Map<string, Set<string>>();
  for (const session of sorted) {
    keySets.set(
      session.id,
      new Set(session.messageIds.map(id => messageDedupKey(session.platform, session.rawSessionId, id))),
    );
  }

  const edges = new Map<string, string>();
  const earlier: ForkCandidateSession[] = [];
  for (const session of sorted) {
    const childKeys = keySets.get(session.id)!;
    let bestParent: string | null = null;
    let bestShared = 0;
    if (childKeys.size > 0) {
      for (const candidate of earlier) {
        const parentKeys = keySets.get(candidate.id)!;
        let shared = 0;
        for (const key of childKeys) {
          if (parentKeys.has(key)) shared += 1;
        }
        if (shared > bestShared) {
          bestShared = shared;
          bestParent = candidate.id;
        }
      }
    }
    if (bestParent && bestShared >= minShared && bestShared / childKeys.size >= minRatio) {
      edges.set(session.id, bestParent);
    }
    earlier.push(session);
  }
  return edges;
}

/**
 * Ancestor chain for each session, nearest parent first, root last. Cycles
 * (corrupt data) are cut at the repeat. Only sessions with a lineage edge get
 * an entry.
 */
export function buildForkAncestorMap(
  rows: Array<{ id: string; forkedFrom?: string | null }>,
): Map<string, string[]> {
  const parentById = new Map<string, string>();
  for (const row of rows) {
    if (row.forkedFrom) parentById.set(row.id, row.forkedFrom);
  }
  const chains = new Map<string, string[]>();
  for (const id of parentById.keys()) {
    const chain: string[] = [];
    const seen = new Set<string>([id]);
    let cursor = parentById.get(id);
    while (cursor && !seen.has(cursor)) {
      chain.push(cursor);
      seen.add(cursor);
      cursor = parentById.get(cursor);
    }
    chains.set(id, chain);
  }
  return chains;
}

export interface ForkCountSession {
  id: string;
  rawSessionId: string;
  platform: string;
  messageIds: string[];
  forkedFrom?: string | null;
}

/**
 * Unique-message counts per session: messages whose dedup key also appears in
 * an ancestor of the fork chain are pre-fork copies and counted once, on the
 * ancestor (the earliest copy wins). Non-fork sessions keep their full count.
 */
export function computeUniqueMessageCounts(
  sessions: ForkCountSession[],
): Map<string, { unique: number; duplicated: number }> {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const keySetById = new Map<string, Set<string>>();
  for (const session of sessions) {
    keySetById.set(
      session.id,
      new Set(session.messageIds.map(id => messageDedupKey(session.platform, session.rawSessionId, id))),
    );
  }
  const chains = buildForkAncestorMap(sessions);

  const result = new Map<string, { unique: number; duplicated: number }>();
  for (const session of sessions) {
    const ownKeys = keySetById.get(session.id)!;
    const chain = chains.get(session.id) ?? [];
    let duplicated = 0;
    if (chain.length > 0) {
      const ancestorKeys = new Set<string>();
      for (const ancestorId of chain) {
        const ancestor = byId.get(ancestorId);
        if (!ancestor) continue;
        for (const key of keySetById.get(ancestorId) ?? []) ancestorKeys.add(key);
      }
      for (const key of ownKeys) {
        if (ancestorKeys.has(key)) duplicated += 1;
      }
    }
    result.set(session.id, { unique: ownKeys.size - duplicated, duplicated });
  }
  return result;
}
