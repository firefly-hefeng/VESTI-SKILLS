export type FileMatchSource = 'name' | 'session-content';

export interface SearchFilesArgs {
  query: string;
  topK?: number;
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
}

export interface RecallCandidate {
  sessionId: string;
  score: number;
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
  recall(query: string, limit: number): RecallCandidate[];
  getSession(sessionId: string): SessionRecord | undefined;
  getDigestKeyFiles(sessionId: string): string | null | undefined;
  getToolInputs(sessionId: string): ToolInputRecord[];
  findToolInputsContaining(tokens: string[]): NamedToolInputRecord[];
  findDigestFilesContaining(tokens: string[]): NamedDigestRecord[];
}
