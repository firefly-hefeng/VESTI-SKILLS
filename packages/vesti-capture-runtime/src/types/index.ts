/**
 * VESTI-CLI Core Types
 * Complete type definitions covering all fields from Claude Code JSONL format
 */

// ==================== Conversation ====================

export interface VestiConversation {
  id: string;
  sessionId: string;
  platform: AgentPlatform;
  platformVersion?: string;
  projectPath: string;
  gitBranch?: string;
  gitRemote?: string;
  model?: string;

  title: string;
  summary?: string;
  tags: string[];
  status: 'active' | 'archived';

  startedAt: number;
  endedAt?: number;
  lastActivityAt: number;
  durationMs: number;

  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  thinkingCount: number;
  toolCallCount: number;
  codeBlockCount: number;

  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;

  hasSubagents: boolean;
  claudeCodeVersion?: string;

  createdAt: number;
  updatedAt: number;
}

// ==================== Message ====================

export interface VestiMessage {
  id: string;           // uuid from JSONL
  conversationId: string;
  parentId?: string;    // parentUuid from JSONL
  depth: number;        // calculated from parent chain

  role: 'user' | 'assistant' | 'system';
  type: MessageType;

  // Content fields
  contentText?: string;
  contentThinking?: string;
  contentToolName?: string;
  contentToolInput?: string;   // JSON string
  contentToolOutput?: string;  // JSON string
  contentToolError?: string;

  // Context snapshot
  cwd?: string;
  gitBranch?: string;

  // Token usage (assistant messages only)
  tokenInput?: number;
  tokenOutput?: number;
  tokenCacheCreation?: number;
  tokenCacheRead?: number;
  model?: string;
  stopReason?: string;

  // Claude Code specific
  isSidechain?: boolean;
  agentId?: string;
  sourceToolAssistantUUID?: string;
  toolUseResult?: string;  // JSON string

  timestamp: number;
  createdAt: number;
}

export type MessageType = 'message' | 'thinking' | 'tool_use' | 'tool_result' | 'progress';

// ==================== Tool Execution Chain ====================

export interface ToolExecution {
  id: string;
  conversationId: string;
  toolUseMessageId: string;     // assistant message containing tool_use block
  toolResultMessageId?: string; // user message containing tool_result
  toolUseId: string;            // tool_use block id (toolu_01...)
  toolName: string;             // Bash, Read, Write, Edit, Glob, Grep, etc.
  inputSummary?: string;        // truncated input for display
  outputSummary?: string;       // truncated output for display
  displayData?: any[];          // Kimi Code display array (diffs, briefs, todos)
  isError: boolean;
  durationMs?: number;
  timestamp: number;
}

// ==================== Subagent ====================

export interface Subagent {
  id: string;
  parentConversationId: string;
  agentId: string;
  slug?: string;
  filePath: string;
  messageCount: number;
}

// ==================== Token Usage ====================

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  model: string;
}

// ==================== Search ====================

export interface SearchQuery {
  text: string;
  filters?: {
    platforms?: AgentPlatform[];
    dateRange?: { start: number; end: number };
    hasCode?: boolean;
  };
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  type: 'conversation' | 'message';
  id: string;
  conversationId?: string;
  score: number;
  title: string;
  preview: string;
  platform?: AgentPlatform;
  timestamp?: number;
}

// ==================== Platform ====================

export type AgentPlatform =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'kimi-code'
  | 'aider'
  | 'trae'
  | 'coder'
  | 'workbuddy'
  | 'unknown';

// ==================== Config ====================

export interface VestiConfigData {
  storage: {
    basePath: string;
  };
  api: {
    host: string;
    port: number;
  };
  watch: {
    enabled: boolean;
    stabilityThreshold: number;
  };
}

// ==================== Stats ====================

export interface VestiStats {
  totalConversations: number;
  totalMessages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  platformBreakdown: Record<string, number>;
  platformTokenBreakdown: Record<string, {
    conversations: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  modelBreakdown: Record<string, number>;
  modelTokenBreakdown: Record<string, {
    conversations: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  dailyActivity: Array<{ date: string; conversations: number; messages: number }>;
  dailyTokenUsage: Array<{ date: string; inputTokens: number; outputTokens: number }>;
  topProjects: Array<{ path: string; conversations: number }>;
  toolCategoryBreakdown?: Record<string, number>;
  storageSize: number;
}

// ==================== Export ====================

export interface ExportOptions {
  format: 'json' | 'markdown';
  includeThinking?: boolean;
  includeToolCalls?: boolean;
  outputPath?: string;
}
