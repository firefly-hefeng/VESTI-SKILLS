import { extractFilePaths, parseKeyFiles, queryTokens } from './extract.js';
import type {
  FileHit,
  FileMatchSource,
  FileSearchDataSource,
  FileSearchReadOptions,
  FileSearchTrace,
  ProjectRecord,
  RecallCandidate,
  SearchFilesArgs,
  SearchFilesResult,
} from './types.js';

export const DEFAULT_TOP_K = 10;
export const MAX_TOP_K = 25;
export const SESSION_RECALL_LIMIT = 12;
export const MAX_SESSION_RECALL_LIMIT = 30;

interface SessionEvidence {
  title: string;
  lastMs: number;
  recallScore: number;
}

interface Accumulator {
  key: string;
  path: string;
  projects: Set<string>;
  sessions: Map<string, SessionEvidence>;
  touches: number;
  lastMs: number;
  via: Set<FileMatchSource>;
  recallScore: number;
}

interface ProjectPlan {
  semanticQuery: string;
  projectHint: string | null;
  projectPaths: string[];
}

interface ScoredCandidate {
  hit: FileHit;
  project: string;
  exactBasename: boolean;
  coverage: number;
  weightedCoverage: number;
  semanticScore: number;
  nameScore: number;
  groupBoost: number;
  baseScore: number;
  recallScore: number;
  evidenceGroups: Map<string, number>;
  finalScore: number;
}

function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

function cleanProjectPath(value: string): string {
  const slashed = value.trim().replace(/\\/g, '/');
  const isUnc = slashed.startsWith('//');
  let normalized = isUnc
    ? `//${slashed.slice(2).replace(/\/{2,}/g, '/')}`
    : slashed.replace(/\/{2,}/g, '/');
  if (normalized.length > (isUnc ? 2 : 1)) normalized = normalized.replace(/\/$/, '');
  if (/^[A-Za-z]:\//.test(normalized)) {
    normalized = `${normalized[0].toLowerCase()}${normalized.slice(1)}`;
  }
  return normalized;
}

function isWindowsProjectPath(value: string): boolean {
  return /^[A-Za-z]:\//.test(cleanProjectPath(value)) || cleanProjectPath(value).startsWith('//');
}

/** Windows paths are case-insensitive; POSIX paths retain their case. */
function projectPathKey(value: string): string {
  const cleaned = cleanProjectPath(value);
  return isWindowsProjectPath(cleaned) ? cleaned.toLowerCase() : cleaned;
}

function projectPathEquals(left: string, right: string): boolean {
  const leftClean = cleanProjectPath(left);
  const rightClean = cleanProjectPath(right);
  if (isWindowsProjectPath(leftClean) || isWindowsProjectPath(rightClean)) {
    return isWindowsProjectPath(leftClean)
      && isWindowsProjectPath(rightClean)
      && leftClean.toLowerCase() === rightClean.toLowerCase();
  }
  return leftClean === rightClean;
}

function normalizeFilePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
}

function projectAliases(project: ProjectRecord): string[] {
  const projectPath = cleanProjectPath(project.projectPath);
  const basename = projectPath.split('/').filter(Boolean).at(-1) ?? projectPath;
  const aliases = new Set([basename.toLowerCase()]);
  if (project.label?.trim()) aliases.add(project.label.trim().toLowerCase());
  for (const value of [...aliases]) {
    for (const part of value.split(/[-_.\s]+/)) {
      if (part.length >= 3 && part !== 'vesti') aliases.add(part);
    }
  }
  return [...aliases];
}

function resolveProject(projects: ProjectRecord[], hint: string): string[] {
  const rawNeedle = cleanProjectPath(hint.replace(/^(?:project|repo(?:sitory)?)\s*[:=]\s*/i, ''));
  const aliasNeedle = rawNeedle.toLowerCase();
  const pathLike = rawNeedle.includes('/');
  const ranked = projects.map(project => {
    const aliases = projectAliases(project);
    let score = 0;
    if (projectPathEquals(project.projectPath, rawNeedle)) score = 100;
    else if (!pathLike && aliases.includes(aliasNeedle)) score = 90;
    else if (!pathLike && aliases.some(alias => alias.endsWith(`-${aliasNeedle}`) || alias.endsWith(`_${aliasNeedle}`))) score = 80;
    else if (!pathLike && aliasNeedle.length >= 3 && aliases.some(alias => alias.includes(aliasNeedle))) score = 60;
    return { project, score };
  }).filter(entry => entry.score > 0);
  if (ranked.length === 0) return [];
  const best = Math.max(...ranked.map(entry => entry.score));
  const matches = ranked.filter(entry => entry.score === best);
  if (matches.length > 1) {
    throw new Error(`Ambiguous project: ${hint}. Matches: ${matches.map(entry => entry.project.projectPath).join(', ')}`);
  }
  return [matches[0].project.projectPath];
}

function inlineProjectCandidate(query: string): { hint: string; start: number; end: number } | null {
  const patterns = [
    /\b(?:project|repo(?:sitory)?)\s*[:=]\s*([^\s,，;；]+)/iu,
    /\b(?:in|within|under)\s+([^\s,，;；]+)(?:\s+(?:project|repo(?:sitory)?))?\s*$/iu,
    /(?:在|位于)\s*([^\s,，;；]+)\s*(?:项目|仓库)(?:中|里|内)?/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(query);
    if (match?.[1]) return { hint: match[1], start: match.index, end: match.index + match[0].length };
  }
  return null;
}

function planProjectScope(query: string, explicitProject: string | undefined, projects: ProjectRecord[]): ProjectPlan {
  if (explicitProject?.trim()) {
    if (projects.length === 0) {
      throw new Error('Project filtering is unavailable because the data source exposes no projects');
    }
    const projectPaths = resolveProject(projects, explicitProject.trim());
    if (projectPaths.length === 0) throw new Error(`Project not found: ${explicitProject.trim()}`);
    const inline = inlineProjectCandidate(query);
    const semanticQuery = inline
      ? `${query.slice(0, inline.start)} ${query.slice(inline.end)}`.replace(/\s+/g, ' ').trim()
      : query;
    return { semanticQuery, projectHint: explicitProject.trim(), projectPaths };
  }

  const inline = inlineProjectCandidate(query);
  if (!inline || projects.length === 0) return { semanticQuery: query, projectHint: null, projectPaths: [] };
  const projectPaths = resolveProject(projects, inline.hint);
  if (projectPaths.length === 0) {
    // A normal phrase ending in "in memory" must not become a bogus project
    // filter. Inline syntax is consumed only after it resolves to known data.
    return { semanticQuery: query, projectHint: null, projectPaths: [] };
  }
  const semanticQuery = `${query.slice(0, inline.start)} ${query.slice(inline.end)}`
    .replace(/\s+/g, ' ')
    .trim();
  return { semanticQuery, projectHint: inline.hint, projectPaths };
}

function fileBasename(file: string): string {
  return normalizeFilePath(file).split('/').at(-1)?.toLowerCase() ?? '';
}

function fileStem(file: string): string {
  const base = fileBasename(file);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function tokenMatchQuality(file: string, token: string): number {
  const normalized = normalizeFilePath(file).toLowerCase();
  const base = fileBasename(file);
  if (token === base) return 1;
  if (token === fileStem(file)) return 0.85;
  if (normalized.split('/').includes(token)) return 0.65;
  const length = [...token].length;
  const isCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token);
  if ((length >= 4 || (isCjk && length >= 2)) && normalized.includes(token)) return 0.3;
  return 0;
}

function isCrossProjectIntent(query: string): boolean {
  return /跨项目|不同项目|各项目|cross[- ]project|across projects|multiple projects/iu.test(query);
}

function isMultiFileIntent(query: string): boolean {
  return /哪些(?:文件|组件|模块)|(?:多个|多個|多份|一组|一組|多)(?:文件|组件|組件|模块|模組)|(?:文件|组件|組件|模块|模組).{0,8}(?:协同|一起|共同|成套)|\b(?:files|components|modules)\b/iu.test(query);
}

function rankedByBase(a: ScoredCandidate, b: ScoredCandidate): number {
  return b.baseScore - a.baseScore
    || Number(b.exactBasename) - Number(a.exactBasename)
    || b.weightedCoverage - a.weightedCoverage
    || b.recallScore - a.recallScore
    || (b.hit.last_touched ?? '').localeCompare(a.hit.last_touched ?? '')
    || a.hit.path.localeCompare(b.hit.path);
}

function projectAwareOrder(candidates: ScoredCandidate[]): ScoredCandidate[] {
  const remaining = [...candidates];
  const selected: ScoredCandidate[] = [];
  const projectCounts = new Map<string, number>();
  const maxBase = Math.max(...remaining.map(candidate => candidate.baseScore), 1);
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestUtility = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const count = projectCounts.get(candidate.project) ?? 0;
      const utility = candidate.baseScore / maxBase
        + (count === 0 ? 0.18 : 0)
        - 0.04 * Math.log1p(count);
      if (utility > bestUtility || (utility === bestUtility && rankedByBase(candidate, remaining[bestIndex]) < 0)) {
        bestIndex = index;
        bestUtility = utility;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    chosen.finalScore = bestUtility;
    selected.push(chosen);
    projectCounts.set(chosen.project, (projectCounts.get(chosen.project) ?? 0) + 1);
  }
  return selected;
}

/**
 * Cover independent evidence groups without imposing a per-session quota.
 *
 * The novelty term depends only on recall relevance and how often a group has
 * already been represented. It deliberately does not depend on the number of
 * files mentioned by a session: a long noisy session therefore cannot make
 * every one of its files look more relevant merely by mentioning more files.
 */
function groupAwareOrder(candidates: ScoredCandidate[]): ScoredCandidate[] {
  const remaining = [...candidates];
  const selected: ScoredCandidate[] = [];
  const groupCounts = new Map<string, number>();
  const maxBase = Math.max(...remaining.map(candidate => candidate.baseScore), 1);
  const maxEvidence = Math.max(
    ...remaining.flatMap(candidate => [...candidate.evidenceGroups.values()]),
    0,
  );
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestUtility = Number.NEGATIVE_INFINITY;
    let bestBoost = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      let coverageBoost = 0;
      if (maxEvidence > 0) {
        for (const [group, strength] of candidate.evidenceGroups) {
          const represented = groupCounts.get(group) ?? 0;
          coverageBoost = Math.max(
            coverageBoost,
            0.06 * (strength / maxEvidence) / Math.sqrt(1 + represented),
          );
        }
      }
      const utility = candidate.baseScore / maxBase + coverageBoost;
      if (utility > bestUtility || (utility === bestUtility && rankedByBase(candidate, remaining[bestIndex]) < 0)) {
        bestIndex = index;
        bestUtility = utility;
        bestBoost = coverageBoost;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    chosen.groupBoost = bestBoost;
    chosen.finalScore = bestUtility;
    selected.push(chosen);
    for (const group of chosen.evidenceGroups.keys()) {
      groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
    }
  }
  return selected;
}

/** Search historical file evidence through an injected, synchronous store. */
export function searchFiles(dataSource: FileSearchDataSource, args: SearchFilesArgs): SearchFilesResult {
  const query = (args.query ?? '').trim();
  if (!query) throw new Error('query is required');
  const topK = Math.max(1, Math.min(args.topK ?? DEFAULT_TOP_K, MAX_TOP_K));
  const sessionRecallLimit = Math.max(1, Math.min(
    args.sessionRecallLimit ?? SESSION_RECALL_LIMIT,
    MAX_SESSION_RECALL_LIMIT,
  ));

  let projects: ProjectRecord[] = [];
  try {
    projects = dataSource.listProjects?.() ?? [];
  } catch {
    projects = [];
  }
  const projectPlan = planProjectScope(query, args.project, projects);
  const tokens = queryTokens(projectPlan.semanticQuery);
  const allowedProjects = new Set(projectPlan.projectPaths.map(projectPathKey));
  const readOptions: FileSearchReadOptions = {
    ...(projectPlan.projectPaths.length > 0 ? { projectPaths: projectPlan.projectPaths } : {}),
    ...(args.includeTrace ? { includeTrace: true } : {}),
  };
  const projectAllowed = (projectPath?: string): boolean =>
    allowedProjects.size === 0 || (projectPath != null && allowedProjects.has(projectPathKey(projectPath)));

  const files = new Map<string, Accumulator>();
  const acc = (rawPath: string, projectPath = ''): Accumulator => {
    const normalized = normalizeFilePath(rawPath);
    const projectKey = projectPathKey(projectPath);
    const pathKey = isWindowsProjectPath(projectPath) ? normalized.toLowerCase() : normalized;
    const key = `${projectKey}\0${pathKey}`;
    let entry = files.get(key);
    if (!entry) {
      entry = {
        key,
        path: normalized,
        projects: new Set(),
        sessions: new Map(),
        touches: 0,
        lastMs: 0,
        via: new Set(),
        recallScore: 0,
      };
      files.set(key, entry);
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
    if (!projectAllowed(meta.projectPath)) return;
    const entry = acc(rawPath, meta.projectPath);
    entry.via.add(via);
    entry.touches += 1;
    if (meta.projectPath) entry.projects.add(meta.projectPath);
    if (meta.timeMs && meta.timeMs > entry.lastMs) entry.lastMs = meta.timeMs;
    if (meta.sessionId) {
      const previous = entry.sessions.get(meta.sessionId);
      const at = meta.timeMs ?? 0;
      const recallScore = Math.max(previous?.recallScore ?? 0, meta.recallScore ?? 0);
      if (!previous || at > previous.lastMs || recallScore > previous.recallScore) {
        entry.sessions.set(meta.sessionId, {
          title: meta.title ?? previous?.title ?? '',
          lastMs: Math.max(at, previous?.lastMs ?? 0),
          recallScore,
        });
      }
    }
    if (meta.recallScore) entry.recallScore = Math.max(entry.recallScore, meta.recallScore);
  };

  const rawRecall = dataSource.recall(projectPlan.semanticQuery, sessionRecallLimit, readOptions);
  const recalled: RecallCandidate[] = Array.isArray(rawRecall) ? rawRecall : rawRecall.candidates;
  const adapterRecallTrace = Array.isArray(rawRecall) ? null : (rawRecall.trace ?? null);
  for (const hit of recalled) {
    const session = dataSource.getSession(hit.sessionId);
    if (!session || !projectAllowed(session.projectPath)) continue;
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
          note(file, 'session-content', { ...meta, timeMs: row.timestamp ?? session.startedAt });
        }
      }
    } catch {
      // Very old capture schemas may not expose tool executions.
    }
  }

  const hasPathToken = (file: string): boolean => tokens.some(token => tokenMatchQuality(file, token) > 0);
  if (tokens.length > 0) {
    try {
      for (const row of dataSource.findToolInputsContaining(tokens, readOptions)) {
        if (!projectAllowed(row.projectPath)) continue;
        for (const file of extractFilePaths(row.inputSummary ?? '')) {
          if (!hasPathToken(file)) continue;
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
      for (const row of dataSource.findDigestFilesContaining(tokens, readOptions)) {
        if (!projectAllowed(row.projectPath)) continue;
        for (const file of parseKeyFiles(row.keyFiles)) {
          if (!hasPathToken(file)) continue;
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
  }

  const entries = [...files.values()];
  const documentFrequency = new Map<string, number>();
  for (const token of tokens) {
    documentFrequency.set(token, entries.filter(entry => tokenMatchQuality(entry.path, token) > 0).length);
  }
  const idf = (token: string): number =>
    1 + Math.log((entries.length + 1) / ((documentFrequency.get(token) ?? 0) + 1));
  const idfTotal = tokens.reduce((sum, token) => sum + idf(token), 0);

  const multiIntent = isMultiFileIntent(projectPlan.semanticQuery);
  const crossIntent = allowedProjects.size === 0 && isCrossProjectIntent(projectPlan.semanticQuery);

  const scored: ScoredCandidate[] = entries.flatMap(entry => {
    const qualities = tokens.map(token => tokenMatchQuality(entry.path, token));
    const matchedCount = qualities.filter(quality => quality > 0).length;
    const coverage = tokens.length === 0 ? 0 : matchedCount / tokens.length;
    const weightedCoverage = idfTotal === 0
      ? 0
      : qualities.reduce((sum, quality, index) => sum + quality * idf(tokens[index]), 0) / idfTotal;
    const exactBasename = tokens.some(token => token === fileBasename(entry.path));
    const nameEligible = exactBasename
      || (tokens.length === 1 && matchedCount === 1)
      || matchedCount >= 2
      || weightedCoverage >= 0.6;
    const nameScore = (exactBasename ? 5 : 0)
      + (nameEligible ? 0.75 * coverage + 1.25 * weightedCoverage : 0);
    const recalledSessions = [...entry.sessions.values()].filter(session => session.recallScore > 0);
    const semanticScore = 16 * entry.recallScore + 0.08 * Math.log1p(recalledSessions.length);
    const evidenceGroups = new Map(
      [...entry.sessions.entries()]
        .filter(([, evidence]) => evidence.recallScore > 0)
        .map(([sessionId, evidence]) => [sessionId, evidence.recallScore]),
    );
    const groupBoost = 0;
    const hasSemantic = entry.via.has('session-content') && entry.recallScore > 0;
    const hasName = entry.via.has('name') && nameScore > 0;
    if (!hasSemantic && !hasName) return [];
    const corroborationBonus = hasSemantic && hasName ? 0.15 : 0;
    const baseScore = semanticScore + nameScore + groupBoost + corroborationBonus;
    const sessions = [...entry.sessions.entries()]
      .sort((a, b) => b[1].lastMs - a[1].lastMs)
      .slice(0, 5)
      .map(([session_id, session]) => ({ session_id, title: session.title }));
    const via: FileMatchSource[] = [];
    if (hasSemantic) via.push('session-content');
    if (hasName) via.push('name');
    const hit: FileHit = {
      path: entry.path,
      projects: [...entry.projects].sort(),
      touches: entry.touches,
      last_touched: iso(entry.lastMs || null),
      sessions,
      matched_via: via,
      score: Number(baseScore.toFixed(6)),
    };
    return [{
      hit,
      project: hit.projects[0] ?? '',
      exactBasename,
      coverage,
      weightedCoverage,
      semanticScore,
      nameScore,
      groupBoost,
      baseScore,
      recallScore: entry.recallScore,
      evidenceGroups,
      finalScore: baseScore,
    }];
  });

  scored.sort(rankedByBase);
  const strategy: FileSearchTrace['strategy'] = crossIntent
    ? 'project-aware'
    : multiIntent ? 'group-aware' : 'score';
  const reranked = crossIntent
    ? projectAwareOrder(scored)
    : multiIntent ? groupAwareOrder(scored) : scored;
  const ordered = reranked.slice(0, topK);
  const results = ordered.map(candidate => candidate.hit);
  const result: SearchFilesResult = { query, count: results.length, results };

  if (args.includeTrace) {
    result.trace = {
      query: {
        original: query,
        semantic: projectPlan.semanticQuery,
        filenameTokens: tokens,
        projectHint: projectPlan.projectHint,
        projectPaths: projectPlan.projectPaths,
        projectResolution: projectPlan.projectPaths.length > 0 ? 'resolved' : 'none',
      },
      sessionRecallLimit,
      recalledSessions: recalled.map((hit, index) => ({
        sessionId: hit.sessionId,
        score: hit.score,
        rank: index + 1,
      })),
      recall: adapterRecallTrace,
      candidateCount: scored.length,
      strategy,
      ranking: reranked.slice(0, Math.max(topK, 15)).map((candidate, index) => ({
        path: candidate.hit.path,
        project: candidate.project,
        preRank: scored.indexOf(candidate) + 1,
        postRank: index + 1,
        selectedRank: index < topK ? index + 1 : null,
        baseScore: Number(candidate.baseScore.toFixed(6)),
        finalScore: Number(candidate.finalScore.toFixed(6)),
        exactBasename: candidate.exactBasename,
        coverage: Number(candidate.coverage.toFixed(6)),
        weightedCoverage: Number(candidate.weightedCoverage.toFixed(6)),
        semanticScore: Number(candidate.semanticScore.toFixed(6)),
        nameScore: Number(candidate.nameScore.toFixed(6)),
        groupBoost: Number(candidate.groupBoost.toFixed(6)),
      })),
    };
  }
  return result;
}
