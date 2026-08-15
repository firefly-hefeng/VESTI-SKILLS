export type FileMatchSource = 'name' | 'session-content';

export interface SearchFilesArgs {
  query: string;
  topK?: number;
  /** Optional project path or unambiguous project name/alias. */
  project?: string;
  /** Internal recall breadth. Defaults to 12 and is capped at 30. */
  sessionRecallLimit?: number;
  /** Include deterministic query, recall and ranking diagnostics. */
  includeTrace?: boolean;
}

export interface FileHit {
  path: string;
  projects: string[];
  touches: number;
  last_touched: string | null;
  sessions: Array<{ session_id: string; title: string }>;
  matched_via: FileMatchSource[];
  score: number;
}

export interface SearchFilesResult {
  query: string;
  count: number;
  results: FileHit[];
  trace?: FileSearchTrace;
}

export interface RecallCandidate {
  sessionId: string;
  score: number;
}

export interface ProjectRecord {
  projectPath: string;
  label?: string;
}

export interface FileSearchReadOptions {
  /** Database-native project paths resolved by the core. */
  projectPaths?: string[];
  includeTrace?: boolean;
}

export interface FileSearchRecallResult {
  candidates: RecallCandidate[];
  /** Adapter-owned diagnostics, for example FTS/LIKE candidate lists. */
  trace?: unknown;
}

export interface FileSearchTrace {
  query: {
    original: string;
    semantic: string;
    filenameTokens: string[];
    projectHint: string | null;
    projectPaths: string[];
    projectResolution: 'none' | 'resolved';
  };
  sessionRecallLimit: number;
  recalledSessions: Array<{ sessionId: string; score: number; rank: number }>;
  recall: unknown | null;
  candidateCount: number;
  strategy: 'score' | 'group-aware' | 'project-aware';
  ranking: Array<{
    path: string;
    project: string;
    /** Rank by raw relevance before any coverage reranking. */
    preRank: number;
    /** Rank after the selected reranking strategy. */
    postRank: number;
    /** Position in the returned top-k, or null when not selected. */
    selectedRank: number | null;
    baseScore: number;
    finalScore: number;
    exactBasename: boolean;
    coverage: number;
    weightedCoverage: number;
    semanticScore: number;
    nameScore: number;
    groupBoost: number;
  }>;
}

export interface SessionRecord {
  id: string;
  title: string;
  projectPath: string;
  startedAt: number;
}

export interface ToolInputRecord {
  inputSummary: string | null;
  timestamp: number | null;
}

export interface NamedToolInputRecord extends ToolInputRecord {
  sessionId: string;
  title: string;
  projectPath: string;
}

export interface NamedDigestRecord {
  sessionId: string;
  keyFiles: string | null;
  title: string;
  projectPath: string;
  startedAt: number;
}

/**
 * Storage adapter implemented by the capture owner. The search core knows
 * nothing about SQLite, FTS, Electron or the VESTI database schema.
 */
export interface FileSearchDataSource {
  listProjects?(): ProjectRecord[];
  recall(
    query: string,
    limit: number,
    options?: FileSearchReadOptions,
  ): RecallCandidate[] | FileSearchRecallResult;
  getSession(sessionId: string): SessionRecord | undefined;
  getDigestKeyFiles(sessionId: string): string | null | undefined;
  getToolInputs(sessionId: string): ToolInputRecord[];
  findToolInputsContaining(
    tokens: string[],
    options?: FileSearchReadOptions,
  ): NamedToolInputRecord[];
  findDigestFilesContaining(
    tokens: string[],
    options?: FileSearchReadOptions,
  ): NamedDigestRecord[];
}
