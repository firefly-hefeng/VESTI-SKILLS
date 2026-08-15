import { extractFilePaths, parseKeyFiles, queryTokens } from './extract.js';
import type {
  FileHit,
  FileMatchSource,
  FileSearchDataSource,
  SearchFilesArgs,
  SearchFilesResult,
} from './types.js';

export const DEFAULT_TOP_K = 10;
export const MAX_TOP_K = 25;
export const SESSION_RECALL_LIMIT = 12;

interface Accumulator {
  path: string;
  projects: Set<string>;
  sessions: Map<string, { title: string; lastMs: number }>;
  touches: number;
  lastMs: number;
  via: Set<FileMatchSource>;
  recallScore: number;
}

function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * Search historical file evidence. This function is synchronous and pure
 * apart from reading through the injected data source.
 */
export function searchFiles(
  dataSource: FileSearchDataSource,
  args: SearchFilesArgs,
): SearchFilesResult {
  const query = (args.query ?? '').trim();
  if (!query) throw new Error('query is required');
  const topK = Math.max(1, Math.min(args.topK ?? DEFAULT_TOP_K, MAX_TOP_K));

  const files = new Map<string, Accumulator>();
  const acc = (rawPath: string): Accumulator => {
    const normalized = rawPath.replace(/\\/g, '/');
    let entry = files.get(normalized);
    if (!entry) {
      entry = {
        path: normalized,
        projects: new Set(),
        sessions: new Map(),
        touches: 0,
        lastMs: 0,
        via: new Set(),
        recallScore: 0,
      };
      files.set(normalized, entry);
    }
    return entry;
  };
  const note = (
    rawPath: string,
    via: FileMatchSource,
    meta: {
      sessionId?: string;
      title?: string;
      projectPath?: string;
      timeMs?: number;
      recallScore?: number;
    },
  ) => {
    const entry = acc(rawPath);
    entry.via.add(via);
    entry.touches += 1;
    if (meta.projectPath) entry.projects.add(meta.projectPath);
    if (meta.timeMs && meta.timeMs > entry.lastMs) entry.lastMs = meta.timeMs;
    if (meta.sessionId) {
      const previous = entry.sessions.get(meta.sessionId);
      const at = meta.timeMs ?? 0;
      if (!previous || at > previous.lastMs) {
        entry.sessions.set(meta.sessionId, { title: meta.title ?? '', lastMs: at });
      }
    }
    if (meta.recallScore) entry.recallScore = Math.max(entry.recallScore, meta.recallScore);
  };

  const recallResult = dataSource.recall(query, SESSION_RECALL_LIMIT);
  const recalledSessions = Array.isArray(recallResult)
    ? recallResult
    : recallResult.candidates;

  for (const hit of recalledSessions) {
    const session = dataSource.getSession(hit.sessionId);
    if (!session) continue;
    const meta = {
      sessionId: session.id,
      title: session.title,
      projectPath: session.projectPath,
      recallScore: hit.score,
    };
    try {
      for (const file of parseKeyFiles(dataSource.getDigestKeyFiles(session.id))) {
        note(file, 'session-content', { ...meta, timeMs: session.startedAt });
      }
    } catch {
      // Older capture schemas may not expose digest key files.
    }
    try {
      for (const row of dataSource.getToolInputs(session.id)) {
        for (const file of extractFilePaths(row.inputSummary ?? '')) {
          note(file, 'session-content', {
            ...meta,
            timeMs: row.timestamp ?? session.startedAt,
          });
        }
      }
    } catch {
      // Very old capture schemas may not expose tool executions.
    }
  }

  const tokens = queryTokens(query);
  const hitToken = (file: string): boolean => {
    const normalized = file.toLowerCase();
    return tokens.some(token => normalized.includes(token.toLowerCase()));
  };

  try {
    for (const row of dataSource.findToolInputsContaining(tokens)) {
      for (const file of extractFilePaths(row.inputSummary ?? '')) {
        if (!hitToken(file)) continue;
        note(file, 'name', {
          sessionId: row.sessionId,
          title: row.title,
          projectPath: row.projectPath,
          timeMs: row.timestamp ?? undefined,
        });
      }
    }
  } catch {
    // Missing tool-execution channel degrades to the other evidence sources.
  }

  try {
    for (const row of dataSource.findDigestFilesContaining(tokens)) {
      for (const file of parseKeyFiles(row.keyFiles)) {
        if (!hitToken(file)) continue;
        note(file, 'name', {
          sessionId: row.sessionId,
          title: row.title,
          projectPath: row.projectPath,
          timeMs: row.startedAt,
        });
      }
    }
  } catch {
    // Missing digest channel degrades to tool-input evidence.
  }

  const results: FileHit[] = [...files.values()]
    .map(entry => {
      const score =
        (entry.via.has('name') ? 3 : 0)
        + entry.recallScore * 2
        + Math.min(entry.sessions.size, 3) * 0.5;
      const sessions = [...entry.sessions.entries()]
        .sort((a, b) => b[1].lastMs - a[1].lastMs)
        .slice(0, 5)
        .map(([session_id, session]) => ({ session_id, title: session.title }));
      return {
        path: entry.path,
        projects: [...entry.projects],
        touches: entry.touches,
        last_touched: iso(entry.lastMs || null),
        sessions,
        matched_via: [...entry.via],
        score: Number(score.toFixed(6)),
      };
    })
    .sort((a, b) => b.score - a.score || b.touches - a.touches)
    .slice(0, topK);

  return { query, count: results.length, results };
}
