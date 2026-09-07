export { defaultDbPath, resolveDbPath, openVestiDb, VestiDbNotFoundError } from './db.js';
export type { VestiDatabase } from './db.js';
export { recallSessions, recallTokens, toFtsQuery, buildSnippet } from './recall.js';
export type { RecallHit, RecallOptions, RecallTrace } from './recall.js';
export { vestiSearch, vestiTimeline, vestiGetTurns, resolveSession } from './tools.js';
export type {
  SearchEntry,
  TimelineTurn,
  TurnContent,
  TurnToolExecution,
} from './tools.js';
export { hasMemorySpace, vestiMemoryGet, vestiMemorySearch } from './memory.js';
export type { MemoryEntryFull, MemorySearchEntry } from './memory.js';
export {
  normalizeProjectPath,
  deriveProjectKey,
  groupSessionsByProject,
  vestiGetProjectContext,
  vestiGetHandoffContext,
} from './projectContext.js';
export type {
  ProjectActiveFile,
  ProjectContextBlock,
  ProjectContextResult,
  ProjectContextSession,
  CrossProjectLinks,
  HandoffContextResult,
} from './projectContext.js';
export { createVestiMcpServer, serveStdio } from './server.js';
export type { VestiMcpServerOptions } from './server.js';
export {
  looksLikeInjectedContextPrefix,
  sanitizeCapturedText,
  stripInjectedContextBlocks,
} from './injectedBlocks.js';
export { looksLikeCodexInjectedPrefix, sanitizeCodexUserText } from './codexUserText.js';
export { sanitizePlatformUserText } from './userText.js';
