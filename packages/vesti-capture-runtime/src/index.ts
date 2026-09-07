// @vesti/capture-runtime - capture engine and headless daemon entry point
export * from './types/index.js';
export * from './types/agent.js';
export * from './types/unified.js';
export { VestiConfig } from './config/VestiConfig.js';
export { DatabaseManager } from './storage/DatabaseManager.js';
export { MessageConverter } from './storage/MessageConverter.js';
export { ClaudeCodeParser } from './adapters/claude-code/parser.js';
export { ClaudeCodeAdapter } from './adapters/claude-code/adapter.js';
export type { ClaudeSessionMeta } from './adapters/claude-code/types.js';
export { CodexAdapter } from './adapters/codex/adapter.js';
export { CodexParser } from './adapters/codex/parser.js';
export { CursorAdapter } from './adapters/cursor/adapter.js';
export { CursorParser } from './adapters/cursor/parser.js';
export { AiderAdapter } from './adapters/aider/adapter.js';
export { AiderParser } from './adapters/aider/parser.js';
export { KimiCodeAdapter } from './adapters/kimi-code/adapter.js';
export { KimiCodeParser } from './adapters/kimi-code/parser.js';
export { TraeAdapter } from './adapters/trae/adapter.js';
export { TraeParser } from './adapters/trae/parser.js';
export { CoderAdapter } from './adapters/coder/adapter.js';
export { CoderParser } from './adapters/coder/parser.js';
export { WorkBuddyAdapter } from './adapters/workbuddy/adapter.js';
export { WorkBuddyParser } from './adapters/workbuddy/parser.js';
export { AdapterManager, normalizeAdapterWatchEvent } from './adapters/AdapterManager.js';
export type { AdapterWatchEvent } from './adapters/AdapterManager.js';
export { WslDetector, decodeWslOutput, parseWslDistroList, wslDistroRoot } from './platform/WslDetector.js';
export type { WslDetection, WslDetectorOptions, WslUserHome } from './platform/WslDetector.js';
export {
  hostFromPath,
  nativeHomeRoot,
  normalizeWslIdentitySegment,
  rewriteSessionIdForHost,
  wslHostTag,
} from './platform/PathResolver.js';
export type { HomeRoot } from './platform/PathResolver.js';
export { SyncEngine, mergeCodexLogicalSession } from './sync/SyncEngine.js';
export type { SyncResult, SyncFileResult, SyncFileOptions } from './sync/SyncEngine.js';
export { SearchEngine } from './search/SearchEngine.js';
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
export { buildConversationTree } from './tree/TreeIndex.js';
export type {
  ConversationTree,
  ConversationTreeSource,
  ConversationTreeProject,
  ConversationTreeSession,
} from './tree/TreeIndex.js';
export {
  deriveProjectKey,
  projectBasis,
  projectLabel,
  normalizeProjectPath,
  normalizeGitRemote,
} from './storage/projectRegistry.js';
export type { ProjectKeyInput } from './storage/projectRegistry.js';
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
export { stripInjectedContextBlocks } from './utils/injectedBlocks.js';
export type { FileTimelineQuery } from './state/fileTimeline.js';
export { ExportEngine } from './export/ExportEngine.js';
export { VaultManager } from './storage/VaultManager.js';
export {
  workSessionToVestiConversation,
  projectSessionTurnsToVesti,
  sessionMessagesToVestiMessages,
  firstVisibleUserSnippet,
  cliIdToNumeric,
  resolveCliId,
  mapPlatform,
  reverseMapPlatform,
} from './api/vestiCompat.js';
export type {
  VestiConversationCompat,
  VestiMessageCompat,
  VestiTurnProjection,
  VestiTurnSegmentCompat,
} from './api/vestiCompat.js';
export { CaptureRuntime } from './runtime/CaptureRuntime.js';
export type { CaptureRuntimeFactories, CaptureRuntimeOptions } from './runtime/CaptureRuntime.js';
export { CaptureDaemon } from './runtime/daemon.js';
export type {
  CaptureDaemonOptions,
  CaptureRuntimeController,
} from './runtime/daemon.js';
export { dispatchCaptureDaemonRequest } from './runtime/dispatch.js';
export type { CaptureDaemonCommandController } from './runtime/dispatch.js';
export {
  acquireDaemonLock,
  CaptureDaemonAlreadyRunningError,
  CaptureDaemonLock,
  defaultDaemonLockDependencies,
  nodeDaemonLockFileSystem,
} from './runtime/lock.js';
export type {
  AcquireDaemonLockOptions,
  DaemonLockDependencies,
  DaemonLockFileSystem,
  DaemonLockMetadata,
} from './runtime/lock.js';
export {
  createNdjsonDecoder,
  encodeNdjson,
  parseCaptureDaemonRequest,
  parseCaptureDaemonResponse,
  CaptureProtocolError,
} from './runtime/protocol.js';
export { FileRuntimeLogger, silentRuntimeLogger } from './runtime/logger.js';
export type { FileRuntimeLoggerOptions, RuntimeLogger } from './runtime/logger.js';
export { resolveRuntimePaths } from './runtime/paths.js';
export type { ResolveRuntimePathsOptions, RuntimePaths } from './runtime/paths.js';
export {
  CAPTURE_DAEMON_PROTOCOL_VERSION,
  DEFAULT_CAPTURE_PLATFORMS,
} from './runtime/types.js';
export type {
  CaptureDaemonErrorResponse,
  CaptureDaemonPingResult,
  CaptureDaemonRequest,
  CaptureDaemonRequestInput,
  CaptureDaemonResponse,
  CaptureDaemonStatus,
  CaptureDaemonSuccessResponse,
  CaptureRuntimePlatform,
  CaptureRuntimeState,
  CaptureRuntimeStatus,
  CaptureSourceStatus,
  CaptureSyncSummary,
} from './runtime/types.js';
