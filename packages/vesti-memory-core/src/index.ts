// @vesti/memory-core — VESTI memory storage, digest pipeline and recall
export * from './types.js';
export { DatabaseManager } from './storage/DatabaseManager.js';
export { MIGRATIONS, hasColumn, probeFtsTokenizer, rebuildFtsWithTrigram } from './storage/migrations.js';
export type { Migration } from './storage/migrations.js';
export {
  deriveProjectKey,
  projectBasis,
  projectLabel,
  normalizeProjectPath,
  normalizeGitRemote,
} from './storage/projectRegistry.js';
export type { ProjectKeyInput } from './storage/projectRegistry.js';
export { serializeVector, deserializeVector, cosineSimilarity, searchByVector } from './search/VectorSearch.js';
export type { VectorCandidate, VectorMatch } from './search/VectorSearch.js';
export { buildSemanticEdges } from './search/SemanticEdges.js';
export type {
  SemanticEdgeVector,
  SemanticEdge,
  SemanticEdgePolicy,
  SemanticEdgeBuildResult,
} from './search/SemanticEdges.js';
export {
  recallSessions,
  recallTokens,
  toFtsQuery,
  buildSnippet,
  recencyFactor,
  detectFtsTokenizer,
  effectiveTokens,
  buildQueryPlan,
  confidenceForCoverage,
  RECENCY_TAU_DAYS,
  RECENCY_FLOOR,
  TRIGRAM_MIN_TOKEN_CHARS,
  COVERAGE_MERGE_MIN_SHORT_CHARS,
  CONFIDENCE_COVERAGE_FLOOR,
} from './search/SessionRecall.js';
export type { SessionRecallHit, SessionRecallOptions, RecallConfidence, QueryPlan } from './search/SessionRecall.js';
export {
  messageDedupKey,
  detectForksByMessageOverlap,
  buildForkAncestorMap,
  computeUniqueMessageCounts,
} from './tree/forks.js';
export type {
  ForkCandidateSession,
  ForkDetectionOptions,
  ForkCountSession,
} from './tree/forks.js';
export {
  buildProjectState,
  listProjectKeys,
  renderProjectStateMarkdown,
  extractFilePaths,
  rankActiveFiles,
  mergeOpenQuestions,
  ACTIVE_FILES_WINDOW_DAYS,
  ACTIVE_FILES_LIMIT,
  OPEN_QUESTIONS_LIMIT,
} from './state/projectState.js';
export { getFileTimeline, pathMatches } from './state/fileTimeline.js';
export type { FileTimelineQuery } from './state/fileTimeline.js';
export { stripInjectedContextBlocks } from './utils/injectedBlocks.js';
export {
  DigestService,
  DIGEST_VERSION,
  buildDigestTranscript,
  isDegradedDigest,
} from './digest/DigestService.js';
export type {
  DigestAgentRequest,
  DigestAgentResult,
  DigestAgentRunner,
  DigestEmbedder,
  DigestSessionStore,
  DegradedDigestShape,
  SessionDetail,
} from './digest/DigestService.js';
export {
  RECENT_MESSAGE_LIMIT,
  TRANSCRIPT_BUDGET_CHARS,
  FIRST_USER_MESSAGE_CHARS,
  OVERSIZED_MESSAGE_CAP_CHARS,
  FILE_WRITE_EXTRA_LIMIT,
  OVERSIZED_MESSAGE_CHARS,
  TOOL_OUTPUT_CHARS,
  isFileWriteTool,
  formatDigestMessage,
  truncateForDigest,
  extractNumericFacts,
  formatNumericFactsBlock,
  scoreFactDensity,
} from './digest/transcript.js';
export type { DigestTranscriptOptions, NumericFact } from './digest/transcript.js';
export {
  buildDigestPrompt,
  parseDigestPayload,
  DIGEST_LANGUAGE_AFFIXES,
} from './digest/payload.js';
export type { DigestPayload, DigestChatMessage } from './digest/payload.js';
