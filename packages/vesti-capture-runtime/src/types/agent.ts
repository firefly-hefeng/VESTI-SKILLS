/**
 * Agent Adapter Types
 * Interfaces for platform-specific adapters
 */

import type { AgentPlatform, VestiMessage, VestiConversation, ToolExecution, Subagent, TokenUsage } from './index.js';
import type { HomeRoot } from '../platform/PathResolver.js';

// ==================== Adapter Interface ====================

export interface AgentAdapter {
  readonly platform: AgentPlatform;
  readonly name: string;

  /**
   * Bump when the parser learns to extract materially new data from old
   * files (lineage, usage, …). SyncEngine re-parses files whose stored
   * sync_state.parser_version is lower — size/mtime alone would skip them
   * forever, freezing already-synced files on the old parse.
   */
  readonly parserVersion?: number;

  /** Check if this agent is installed on the system */
  detect(): Promise<AgentDetectResult>;

  /** Parse a session file into normalized messages */
  parseSession(filePath: string): Promise<ParsedSession>;

  /** Parse a physical source that contains multiple sessions. */
  parseSessions?(filePath: string): Promise<ParsedSession[]>;

  /** Get all session file paths for this agent */
  getSessionFiles(): Promise<string[]>;

  /** Get watch glob patterns */
  getWatchPatterns(): string[];

  /** Whether SyncEngine should keep a compressed raw copy. */
  readonly shouldBackupSource?: boolean;

  /**
   * Multi-root support: replace the adapter's home roots (native first,
   * then any WSL homes). Adapters that omit this stay native-only.
   */
  setHomeRoots?(homes: HomeRoot[]): void;
}

export interface AgentDetectResult {
  installed: boolean;
  version?: string;
  installPath?: string;
  sessionCount?: number;
}

// ==================== Parsed Session ====================

export interface ParsedSession {
  sessionId: string;
  platform: AgentPlatform;
  projectPath: string;
  gitBranch?: string;
  claudeCodeVersion?: string;
  model?: string;

  /** Source host tag: 'native' or canonical 'wsl:<distro>:<user>'. Set by SyncEngine from the file path. */
  host?: string;

  /**
   * Stable key for the physical sync candidate that produced this parsed
   * session. SyncEngine owns this value; adapters should not derive it from a
   * logical session id because one file may contain several sessions.
   */
  sourceFileKey?: string;

  messages: ParsedMessage[];
  toolExecutions: ToolExecution[];
  subagents: SubagentRef[];
  /**
   * Child-side lineage: set when only the child knows its parent (e.g.
   * Cursor 2.x background agents own a top-level transcript, with lineage
   * solely in their chat meta). Converts to the same subagent_links row a
   * parent-side SubagentRef would produce.
   * `parentSessionId` is the fully-qualified parent WorkSession.id
   * (`<platform>:<rawId>`). `agentId` (optional) replaces the child session
   * id in the link id/agent fields — kimi-code sets it to the agent dir name
   * (`agent-3`) so the child-side row reuses the parent-side link id and the
   * two insert paths dedup instead of double-linking.
   */
  subagentOf?: { parentSessionId: string; agentId?: string; agentRole?: string; toolCallId?: string };
  tokenUsage: SessionTokenUsage;
  /** Timestamped, non-cumulative usage samples used for calendar-day
   * analytics. Adapters that only expose usage on messages may omit this;
   * MessageConverter derives equivalent events from message usage. */
  tokenUsageEvents?: ParsedTokenUsageEvent[];

  startTime: number;
  endTime?: number;

  meta?: Record<string, unknown>;
  contextCompactions?: Array<{ sequence: number; compactedAt: number; summary?: string }>;
  peakContextUsage?: number;

  /**
   * Non-fatal parse warnings, e.g. a high share of unrecognized wire events.
   * Surfaced so "parsed OK but extracted nothing" never fails silently.
   */
  warnings?: string[];
}

/** One model invocation (or a cumulative counter delta) at its source time. */
export interface ParsedTokenUsageEvent {
  /** Stable within the physical source so rescans remain idempotent. */
  id: string;
  /** Logical identity used to deduplicate replayed Codex fork history. */
  dedupeKey?: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens?: number;
  model?: string;
  source: string;

  /**
   * Physical replacement scope assigned by SyncEngine. Adapter parsers may
   * leave it unset; it is intentionally unrelated to the logical session id.
   */
  sourceScope?: string;
}

export interface ParsedMessage {
  uuid: string;
  parentUuid?: string;
  type: 'user' | 'assistant' | 'progress' | 'file-history-snapshot' | 'system' | 'queue-operation';
  role: 'user' | 'assistant' | 'system';
  timestamp: number;

  /** Native task/turn identifier emitted by the source agent, when present. */
  sourceTurnId?: string;
  /** Assistant delivery phase used to distinguish progress from the final answer. */
  assistantPhase?: 'commentary' | 'final_answer';

  // Content
  contentText?: string;
  contentThinking?: string;
  toolCalls?: ToolCallBlock[];
  toolResults?: ToolResultBlock[];

  // Context
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;

  // Token usage (assistant only)
  usage?: TokenUsage;
  stopReason?: string;

  // Source classification
  isToolResult: boolean;         // true if this user message is a tool_result (not real user input)

  // Enhanced metadata
  isApiError?: boolean;
  isCompactSummary?: boolean;
  permissionMode?: string;
  systemSubtype?: string;
  errorDetails?: string;         // JSON string of error metadata

  // Claude Code specific
  isSidechain?: boolean;
  agentId?: string;
  slug?: string;
  sourceToolAssistantUUID?: string;
  toolUseResult?: unknown;

  // Calculated
  depth: number;
}

// ==================== Content Blocks ====================

export interface ToolCallBlock {
  id: string;        // toolu_01...
  name: string;      // Bash, Read, Write, etc.
  input: unknown;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

// ==================== Subagent ====================

export interface SubagentRef {
  agentId: string;
  slug?: string;
  filePath: string;
  /**
   * Fully-qualified child WorkSession.id when the parser already knows it
   * (e.g. Cursor: parent and child composers live in the same database, so
   * subagentInfo.parentComposerId links them at parse time). When set, the
   * link needs no sync_state file-path resolution.
   */
  childSessionId?: string;
  /** Display role, e.g. Cursor subagentTypeName ("generalPurpose"). */
  agentRole?: string;
}

// ==================== Token Aggregation ====================

export interface SessionTokenUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  models: Set<string>;
}

// ==================== Progress Data ====================

export interface ProgressData {
  type: string;       // e.g. "bash_progress"
  output?: string;
  fullOutput?: string;
  toolUseID?: string;
  parentToolUseID?: string;
}
