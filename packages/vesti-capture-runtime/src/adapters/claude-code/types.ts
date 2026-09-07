/**
 * Claude Code JSONL Types
 * Exact representation of the raw JSONL format written by Claude Code
 */

// ==================== Raw JSONL Line ====================

export interface ClaudeRawLine {
  uuid: string;
  parentUuid?: string;
  type: ClaudeMessageType;
  timestamp: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;

  // For user/assistant messages
  message?: ClaudeRawMessageBody;

  // For progress messages
  data?: ClaudeProgressData;
  toolUseID?: string;
  parentToolUseID?: string;

  // Claude Code specific
  isSidechain?: boolean;
  agentId?: string;
  slug?: string;

  // User message specific
  sourceToolAssistantUUID?: string;
  toolUseResult?: unknown;

  // file-history-snapshot uses messageId instead of uuid
  messageId?: string;

  // queue-operation fields
  content?: unknown;
  operation?: string;

  // System message subtypes (api_error, turn_duration, compact_boundary)
  subtype?: string;
  durationMs?: number;
  error?: string;
  level?: string;
  retryInMs?: number;
  retryAttempt?: number;
  maxRetries?: number;
  cause?: string;

  // Context compaction
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
  logicalParentUuid?: string;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;

  // Error / permission markers
  isApiErrorMessage?: boolean;
  permissionMode?: string;
}

export type ClaudeMessageType = 'user' | 'assistant' | 'progress' | 'file-history-snapshot' | 'system' | 'queue-operation';

// ==================== Message Body ====================

export interface ClaudeRawMessageBody {
  role: 'user' | 'assistant';
  model?: string;
  content: string | ClaudeContentBlock[];
  usage?: ClaudeUsage;
  stop_reason?: string;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// ==================== Content Blocks ====================

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock;

export interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

export interface ClaudeThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;       // toolu_01...
  name: string;     // Bash, Read, Write, Edit, Glob, Grep, Task, etc.
  input: unknown;
}

export interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ClaudeToolResultContent[];
  is_error?: boolean;
}

export interface ClaudeToolResultContent {
  type: 'text';
  text: string;
}

// ==================== Session Meta ====================

export interface ClaudeSessionMeta {
  session_id?: string;
  project_path?: string;
  start_time?: string;
  duration_minutes?: number;
  user_message_count?: number;
  assistant_message_count?: number;
  tool_counts?: Record<string, number>;
  languages?: Record<string, number>;
  git_commits?: number;
  git_pushes?: number;
  input_tokens?: number;
  output_tokens?: number;
  first_prompt?: string;
  user_interruptions?: number;
  user_response_times?: number[];
  tool_errors?: number;
  tool_error_categories?: Record<string, number>;
  uses_task_agent?: boolean;
  uses_mcp?: boolean;
  uses_web_search?: boolean;
  uses_web_fetch?: boolean;
  lines_added?: number;
  lines_removed?: number;
  files_modified?: number;
  message_hours?: number[];
  user_message_timestamps?: string[];
}

// ==================== Progress Data ====================

export interface ClaudeProgressData {
  type: string;       // "bash_progress", etc.
  output?: string;
  fullOutput?: string;
  elapsedTimeSeconds?: number;
  totalLines?: number;
  totalBytes?: number;
  taskId?: string;
  timeoutMs?: number;
  hookEvent?: string;
  hookName?: string;
  command?: string;
}
