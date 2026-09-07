/**
 * Kimi Code wire.jsonl Event Types
 *
 * Two on-disk protocols exist:
 * - Legacy (fixture-era): {timestamp: float_seconds, message: {type, payload}}
 * - Protocol 1.4 (current, first line {"type":"metadata","protocol_version":"1.4"}):
 *   flat events {type: string, time: ms_epoch, ...payload}
 *
 * Layout (https://www.kimi.com/code/docs/kimi-code-cli/guides/sessions.html):
 *   ~/.kimi-code/sessions/<workDirKey>/<sessionId>/state.json
 *   ~/.kimi-code/sessions/<workDirKey>/<sessionId>/agents/<agentId>/wire.jsonl
 */

// ==================== Wire Line Format ====================

export interface KimiWireLine {
  timestamp?: number;  // Legacy: Unix seconds (float)
  message?: { type: string; payload: any };  // Legacy envelope
  type?: string;       // metadata line (legacy) / any event type (protocol 1.4)
  protocol_version?: string;
  time?: number;       // Protocol 1.4: ms epoch
  [key: string]: unknown;  // Protocol 1.4 payloads are flat
}

// ==================== Protocol 1.4 Events ====================

/** {"type":"turn.prompt"|"turn.steer", input, origin, time} — duplicated by the
 * following context.append_message, so the parser treats these as structural. */
export interface Kimi14TurnPrompt {
  input?: Array<{ type: string; text?: string }>;
  origin?: { kind?: string; name?: string; [key: string]: unknown };
  time?: number;
}

/** {"type":"context.append_message", message, time} — user-side message as
 * appended to the model context. This is the authoritative user-message event. */
export interface Kimi14AppendMessage {
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    toolCalls?: unknown[];
    origin?: { kind?: string; name?: string; [key: string]: unknown };
  };
  time?: number;
}

/** context.append_loop_event payloads (event.type):
 * step.begin | step.end | content.part | tool.call | tool.result */
export interface Kimi14LoopEvent {
  type?: string;
  uuid?: string;
  turnId?: string;
  step?: number;
  stepUuid?: string;
  // content.part
  part?: { type?: string; text?: string; think?: string };
  // tool.call
  toolCallId?: string;
  name?: string;
  args?: unknown;
  description?: string;
  // tool.result
  parentUuid?: string;
  result?: { output?: unknown; isError?: boolean; note?: string; truncated?: boolean };
  // step.end
  usage?: Kimi14Usage;
  finishReason?: string;
}

export interface Kimi14Usage {
  inputOther?: number;
  output?: number;
  inputCacheRead?: number;
  inputCacheCreation?: number;
}

/** {"type":"usage.record", model, usage, usageScope:"turn", time} */
export interface Kimi14UsageRecord {
  model?: string;
  usage?: Kimi14Usage;
  usageScope?: string;
  time?: number;
}

/** {"type":"llm.request", model, modelAlias, ...} */
export interface Kimi14LlmRequest {
  model?: string;
  modelAlias?: string;
}

/** state.json sitting next to agents/ in the session directory. */
export interface KimiSessionState {
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  isCustomTitle?: boolean;
  agents?: Record<string, {
    homedir?: string;
    type?: string;           // 'main' | 'sub'
    parentAgentId?: string | null;
    swarmItem?: string;
  }>;
  workDir?: string;
  lastPrompt?: string;
  /**
   * Fork lineage: session id (session directory name) this session was
   * forked from. Absent on non-forked sessions.
   */
  forkedFrom?: string | { sessionId?: string } | null;
  custom?: Record<string, unknown>;
}

/** session_index.jsonl row at ~/.kimi-code/session_index.jsonl */
export interface KimiSessionIndexRow {
  sessionId?: string;
  sessionDir?: string;
  workDir?: string;
}

/** workspaces.json at ~/.kimi-code/workspaces.json */
export interface KimiWorkspacesFile {
  workspaces?: Record<string, { root?: string; name?: string }>;
}

// ==================== Payload Types ====================

export interface KimiTurnBeginPayload {
  user_input: string | Array<{ type: string; text: string }>;
}

export interface KimiStepBeginPayload {
  n: number;
}

export interface KimiContentPartPayload {
  type: 'think' | 'text';
  think?: string;
  text?: string;
  encrypted?: unknown;
}

export interface KimiToolCallPayload {
  type: 'function';
  id: string;
  function: { name: string; arguments: string };
  extras?: unknown;
}

export interface KimiToolCallPartPayload {
  arguments_part: string;
}

export interface KimiToolResultPayload {
  tool_call_id: string;
  return_value: {
    is_error: boolean;
    output: string | unknown[];
    message?: string;
    display?: unknown[];
    extras?: unknown;
  };
}

export interface KimiStatusUpdatePayload {
  context_usage?: number;
  token_usage?: {
    input_other?: number;
    output?: number;
    input_cache_read?: number;
    input_cache_creation?: number;
  };
  message_id?: string;
}

export interface KimiSubagentEventPayload {
  task_tool_call_id: string;
  event: { type: string; payload: any };
}

export interface KimiApprovalRequestPayload {
  id: string;
  tool_call_id: string;
  sender: string;
  action: string;
  description: string;
  display?: unknown[];
}

export interface KimiApprovalResponsePayload {
  request_id: string;
  response: string;  // 'approve_for_session', 'deny', etc.
}

export interface KimiErrorPayload {
  error_type?: string;
  message?: string;
}

// ==================== Metadata ====================

export interface KimiSessionMetadata {
  session_id?: string;
  title?: string;
  title_generated?: boolean;
  wire_mtime?: number;
  archived?: boolean;
  archived_at?: number | null;
}

// ==================== Config ====================

export interface KimiConfig {
  work_dirs?: Array<{
    path: string;
    kaos?: string;
    last_session_id?: string | null;
  }>;
}
