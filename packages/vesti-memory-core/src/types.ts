/**
 * VESTI memory-core unified types.
 *
 * Ported from VESTI-APP packages/capture-core/src/types/unified.ts (+ the
 * AgentPlatform union from types/index.ts), trimmed to the memory domain:
 * capture-pipeline-only shapes (v1 compat records, token usage events,
 * converter output) are intentionally not part of this package.
 */

// ==================== Platform ====================

export type AgentPlatform =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'kimi-code'
  | 'aider'
  | 'unknown';

// ==================== Message Source ====================

export type MessageSource =
  | 'user_input'       // Real user input (~1.7%)
  | 'tool_result'      // Tool execution result (~97.7%)
  | 'assistant_text'   // Agent text response
  | 'assistant_think'  // Agent thinking process
  | 'tool_request'     // Agent requesting tool call
  | 'progress'         // Tool execution intermediate output
  | 'system_event'     // API errors, retries, queue-operation
  | 'file_snapshot';   // File state snapshot

// ==================== Tool Category ====================

export type ToolCategory =
  | 'shell'       // Bash, terminal
  | 'file_read'   // Read, Cat
  | 'file_write'  // Write
  | 'file_edit'   // Edit, NotebookEdit
  | 'search'      // Glob, Grep, WebSearch, WebFetch
  | 'agent'       // Task (subagent)
  | 'git'         // Git operations
  | 'interaction' // AskUserQuestion, user interaction
  | 'planning'    // Plan mode, todo lists, scheduling
  | 'other';

// ==================== Tool Outcome ====================

export type ToolOutcome = 'success' | 'error' | 'pending';

// ==================== WorkSession ====================

export interface WorkSession {
  id: string;                    // {platform}:{sessionId} — WSL sources: {platform}:wsl-<distro>-{sessionId}
  sessionId: string;
  platform: AgentPlatform;
  host?: string;                 // 'native' | 'wsl:<distro>'
  platformVersion?: string;
  projectPath: string;
  gitBranch?: string;
  gitRemote?: string;
  model?: string;
  models?: string;               // JSON array of all models used

  title: string;
  summary?: string;
  tags: string[];
  status: 'active' | 'archived';
  sessionType: 'conversation' | 'file_snapshot' | 'empty';

  startedAt: number;
  endedAt?: number;
  lastActivityAt: number;
  durationMs: number;

  // Counts
  messageCount: number;
  userInputCount: number;        // Real user inputs (not tool_result)
  assistantMessageCount: number;
  thinkingCount: number;
  toolCallCount: number;
  codeBlockCount: number;
  turnCount: number;

  // Tokens
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;

  // Flags
  hasSubagents: boolean;
  hasContextCompaction: boolean;

  // Agent-specific metadata (JSON)
  agentMeta?: string;
  claudeCodeVersion?: string;

  /**
   * Fork lineage (memory v2): work_sessions.id of the session this one was
   * forked from, when known. Forked sessions are independent work — the
   * lineage exists so duplicated pre-fork history is counted once.
   */
  forkedFrom?: string | null;

  createdAt: number;
  updatedAt: number;
}

// ==================== Turn ====================

export interface Turn {
  id: string;                    // {sessionId}:turn:{sequence}
  sessionId: string;             // WorkSession.id
  sequence: number;              // 1-based turn number

  userInput?: string;            // The user's actual input text
  userInputMessageId?: string;   // Message ID of the user_input message
  assistantResponse?: string;    // Final assistant text response (truncated)
  assistantResponseMessageId?: string;

  // Aggregated stats for this turn
  messageCount: number;
  toolExecutionCount: number;
  thinkingTokens: number;
  inputTokens: number;
  outputTokens: number;

  startedAt: number;
  endedAt?: number;
  durationMs: number;
}

// ==================== SessionMessage ====================

export interface SessionMessage {
  id: string;                    // uuid from raw data
  sessionId: string;             // WorkSession.id
  turnId?: string;               // Turn.id (null for orphan messages)
  source: MessageSource;
  sequence: number;              // Order within session

  role: 'user' | 'assistant' | 'system';

  contentText?: string;
  contentThinking?: string;
  contentToolName?: string;
  contentToolInput?: string;
  contentToolOutput?: string;
  contentToolError?: string;

  // Context
  cwd?: string;
  gitBranch?: string;

  // Tokens
  tokenInput?: number;
  tokenOutput?: number;
  tokenCacheCreation?: number;
  tokenCacheRead?: number;
  tokenReasoning?: number;
  model?: string;
  stopReason?: string;

  // Claude Code specific
  parentId?: string;
  depth: number;
  isSidechain?: boolean;
  agentId?: string;

  timestamp: number;
  createdAt: number;
}

// ==================== ToolExecution (enhanced) ====================

export interface UnifiedToolExecution {
  id: string;
  sessionId: string;             // WorkSession.id
  turnId?: string;               // Turn.id
  sequence: number;              // Order within turn

  toolUseMessageId: string;
  toolResultMessageId?: string;
  toolUseId: string;
  toolName: string;
  toolCategory: ToolCategory;
  outcome: ToolOutcome;

  inputSummary?: string;
  outputSummary?: string;
  displayData?: string;          // JSON: Kimi Code display array (diffs, briefs, todos)
  isError: boolean;
  exitCode?: number;
  durationMs?: number;
  timestamp: number;
}

// ==================== SubagentLink ====================

export interface SubagentLink {
  id: string;
  parentSessionId: string;       // Parent WorkSession.id
  childSessionId?: string;       // Child WorkSession.id (if synced)
  agentId: string;
  agentRole?: string;            // e.g. "Explore", "Plan"
  slug?: string;
  filePath: string;
  messageCount: number;
  spawnedAt?: number;
}

// ==================== ContextCompaction ====================

export interface ContextCompaction {
  id: string;
  sessionId: string;
  sequence: number;              // Which compaction (1st, 2nd, etc.)
  compactedAt: number;
  messagesBefore?: number;
  messagesAfter?: number;
  summary?: string;
}

// ==================== SystemEvent ====================

export interface SystemEvent {
  id: string;
  sessionId: string;
  turnId?: string;
  eventType: string;             // 'api_error', 'retry', 'rate_limit', 'queue_operation', etc.
  message?: string;
  metadata?: string;             // JSON
  timestamp: number;
}

// ==================== Session Digest (P1.5) ====================

/** 'degraded' doubles as the degraded-digest mark: the row is a structural
 * fallback that already used its one LLM retry — do not auto-retry until the
 * session grows or DIGEST_VERSION bumps (no new column; TEXT field). */
export type DigestEmbeddingStatus = 'none' | 'ok' | 'skipped' | 'failed' | 'degraded';

/** Store-wide digest health snapshot (DigestService.getDigestStats). */
export interface SessionDigestStats {
  total: number;
  /** Four structured fields all empty with a non-empty one_liner — degraded
   * suspects; the exact echo check happens at runtime in the digest service. */
  emptyStructured: number;
  /** embedding_status='degraded': degraded rows that used up their retry. */
  gaveUp: number;
  failed: number;
}

export interface SessionDigest {
  sessionId: string;             // work_sessions.id
  host: string;
  platform: string;
  projectKey: string;
  oneLiner: string;
  keyTopics: string[];           // stored as JSON arrays
  keyFiles: string[];
  decisions: string[];
  openQuestions: string[];
  embedding?: Buffer | null;     // serialized Float32Array (little-endian)
  embeddingProvider?: string | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
  embeddingVersion?: string | null;
  embeddingStatus: DigestEmbeddingStatus;
  digestVersion: number;
  messageCount: number;
  updatedAt: string;             // ISO 8601

  // ---- L1 validity semantics (memory v2; all optional, additive) ----
  /** Start of the interval this digest describes (ISO 8601). */
  validFrom?: string | null;
  /** Set when the digest stopped being current (superseded); NULL = current. */
  validTo?: string | null;
  /** session_id of the digest row that replaced this one. */
  supersededBy?: string | null;
  /** How often recall/search surfaced this digest (MCP bumps it on hits). */
  accessCount?: number;
}

// ==================== Project State / Brief (memory v2, L0 & L2) ====================

/** A file surfaced in the project's L0 state card. */
export interface ProjectActiveFile {
  path: string;
  /** tool_executions touching this file in the lookback window. */
  touches: number;
  /** ISO 8601 of the most recent touch. */
  lastTouched: string;
}

/**
 * L0 project_state: one deterministic "current state card" per project.
 * Rewritten wholesale on every rebuild (never invalidated, never compressed).
 */
export interface ProjectState {
  projectKey: string;
  oneLiner: string;              // newest session digest one-liner ('' when none)
  activeFiles: ProjectActiveFile[];
  openQuestions: string[];       // merged from the 5 newest digests, deduped
  sessionCount: number;
  lastActive: string;            // ISO 8601 ('' when the project has no sessions)
  updatedAt: string;             // ISO 8601 of this rebuild
}

/**
 * L2 project_briefs: LLM-maintained cross-session project brief. `version`
 * increments on every successful maintain pass; `lastOps` holds the ops the
 * last deposit-maintain merge applied (JSON array, for the UI badge).
 */
export interface ProjectBrief {
  projectKey: string;
  contentMarkdown: string;
  version: number;
  lastOps: string;               // JSON array of DepositMaintainOp ('[]' for fallbacks)
  updatedAt: string;             // ISO 8601
}

/** One touch event in a file's deterministic timeline (L2 support query). */
export interface FileTimelineEvent {
  sessionId: string;             // work_sessions.id
  sessionTitle: string;
  platform: string;
  toolName: string;
  toolCategory: string;
  isError: boolean;
  timestamp: number;             // ms epoch
}

// ==================== Memory Entries (记忆空间, migration v14) ====================

/**
 * 记忆空间条目：沉淀（deposit）、梦境记忆（dream）、梦境运行日志（dream-log）
 * 与自由笔记（note）的统一存储。渲染侧的沉淀区原先存在 IndexedDB，主进程与
 * MCP 都看不到；migration v14 起统一落 SQLite。kind/status 在 TS 侧收窄，
 * SQLite 侧存字符串。
 *
 * `version` 每次维护（dream-maintain 合并等）递增；`prevId` 指向被取代的
 * 前一条目；`lastOps` 保存最近一次维护操作的 JSON ops 日志。
 */
export interface MemoryEntry {
  id: string;
  kind: 'deposit' | 'dream' | 'dream-log' | 'note';
  title: string;
  contentMarkdown: string;
  summary?: string | null;
  scope?: string | null;
  template?: string | null;
  sourceSessionIds: string[];    // stored as a JSON array
  tags: string[];                // stored as a JSON array
  version: number;
  prevId?: string | null;
  lastOps?: string | null;
  status: 'active' | 'archived';
  entryDate?: string | null;     // YYYY-MM-DD
  createdAt: number;             // ms epoch
  updatedAt: number;             // ms epoch
}

// ==================== Project Registry (P1.5) ====================

export interface ProjectRegistryEntry {
  projectKey: string;
  kind: 'cli_path';
  label: string;
  pathOrDomain: string;
  firstSeen: string;             // ISO 8601
  lastSeen: string;              // ISO 8601
}

// ==================== Tool Category Mapping ====================

const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  // Shell (Claude Code + Kimi Code + Codex)
  Bash: 'shell',
  Shell: 'shell',
  shell_command: 'shell',
  // File read
  Read: 'file_read',
  ReadFile: 'file_read',
  Cat: 'file_read',
  readFile: 'file_read',
  readCode: 'file_read',
  ReadMediaFile: 'file_read',
  // File write
  Write: 'file_write',
  WriteFile: 'file_write',
  writeFile: 'file_write',
  // File edit
  Edit: 'file_edit',
  NotebookEdit: 'file_edit',
  MultiEdit: 'file_edit',
  StrReplaceFile: 'file_edit',
  // Search
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  WebFetch: 'search',
  SearchWeb: 'search',
  FetchURL: 'search',
  // Agent (Claude Code + Kimi Code)
  Task: 'agent',
  Agent: 'agent',
  TaskCreate: 'agent',
  TaskUpdate: 'agent',
  TaskList: 'agent',
  TaskOutput: 'agent',
  TaskStop: 'agent',
  TaskGet: 'agent',
  // Git operations
  GitCommit: 'git',
  GitPush: 'git',
  GitPull: 'git',
  GitStatus: 'git',
  GitDiff: 'git',
  GitLog: 'git',
  GitBranch: 'git',
  GitCheckout: 'git',
  // User interaction
  AskUserQuestion: 'interaction',
  PromptUser: 'interaction',
  RequestApproval: 'interaction',
  // Planning & scheduling
  EnterPlanMode: 'planning',
  ExitPlanMode: 'planning',
  SetTodoList: 'planning',
  TodoWrite: 'planning',
  TodoRead: 'planning',
  CronCreate: 'planning',
  CronDelete: 'planning',
  CronList: 'planning',
  Skill: 'planning',
  EnterWorktree: 'planning',
  ExitWorktree: 'planning',
};

export function classifyTool(toolName: string): ToolCategory {
  return TOOL_CATEGORY_MAP[toolName] || 'other';
}
