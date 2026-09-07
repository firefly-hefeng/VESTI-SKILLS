/**
 * VESTI Mainline Compatibility Layer
 * Converts VESTI-CLI data models to VESTI mainline format
 *
 * VESTI mainline uses:
 *   - Conversation { id: number, uuid, platform: "ChatGPT"|"Claude"|..., title, snippet, url, ... }
 *   - Message { id: number, conversation_id, role: "user"|"ai", content_text, ... }
 *
 * VESTI-CLI uses:
 *   - WorkSession { id: string, sessionId, platform: "claude-code"|"kimi-code"|..., title, ... }
 *   - SessionMessage { id: string, sessionId, source, role: "user"|"assistant"|"system", ... }
 */

import type { WorkSession, SessionMessage } from '../types/unified.js';
import {
  looksLikeInjectedContextPrefix,
  stripInjectedContextBlocks,
} from '../utils/injectedBlocks.js';
import {
  looksLikeCodexInjectedPrefix,
  sanitizeCodexUserText,
} from '../utils/codexUserText.js';

type CapturePlatform = WorkSession['platform'];

function sanitizePlatformUserText(text: string, platform?: CapturePlatform): string {
  return platform === 'codex'
    ? sanitizeCodexUserText(text)
    : stripInjectedContextBlocks(text);
}

// ==================== ID Conversion ====================

/**
 * Convert a CLI string ID to a stable numeric ID.
 * Uses FNV-1a hash with offset to avoid collision with Dexie auto-increment IDs.
 */
const CLI_ID_OFFSET = 10_000_000;
// Hash space: (10M, 2^53-1). The previous 90M range hit ~50% collision
// probability at ~10k hashed IDs (birthday bound); 2^53 pushes that
// out past any realistic local session/message count.
const ID_SPACE = BigInt(Number.MAX_SAFE_INTEGER - CLI_ID_OFFSET);

export function cliIdToNumeric(cliId: string): number {
  // 64-bit FNV-1a folded into the safe-integer range above the offset.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < cliId.length; i++) {
    hash ^= BigInt(cliId.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return CLI_ID_OFFSET + Number(hash % ID_SPACE);
}

// Reverse lookup: numeric → CLI ID
const numericToCliIdMap = new Map<number, string>();

export function registerCliId(cliId: string): number {
  const numeric = cliIdToNumeric(cliId);
  numericToCliIdMap.set(numeric, cliId);
  return numeric;
}

export function resolveCliId(numericId: number | string): string | null {
  if (typeof numericId === 'string') {
    // Could be the CLI ID itself or a numeric string
    const asNum = parseInt(numericId);
    if (!isNaN(asNum) && numericToCliIdMap.has(asNum)) {
      return numericToCliIdMap.get(asNum)!;
    }
    return numericId; // Return as-is, might be CLI ID directly
  }
  return numericToCliIdMap.get(numericId) ?? null;
}

// ==================== Platform Mapping ====================

const CLI_TO_VESTI_PLATFORM: Record<string, string> = {
  'claude-code': 'Claude Code',
  'kimi-code': 'Kimi Code',
  'codex': 'Codex',
  'cursor': 'Cursor',
  'aider': 'Aider',
  'trae': 'Trae',
  'coder': 'Qoder',
  'workbuddy': 'WorkBuddy',
};

const VESTI_TO_CLI_PLATFORM: Record<string, string> = {
  'Claude Code': 'claude-code',
  'Kimi Code': 'kimi-code',
  'Codex': 'codex',
  'Cursor': 'cursor',
  'Aider': 'aider',
  'Trae': 'trae',
  'Qoder': 'coder',
  'WorkBuddy': 'workbuddy',
  'Claude': 'claude-code',
  'Kimi': 'kimi-code',
  'ChatGPT': 'codex',
};

export function mapPlatform(cliPlatform: string): string {
  return CLI_TO_VESTI_PLATFORM[cliPlatform] || cliPlatform;
}

/**
 * Reverse map: VESTI mainline platform → CLI platform name
 * Used when the frontend sends a platform filter in VESTI format
 */
export function reverseMapPlatform(vestiPlatform: string): string | undefined {
  return VESTI_TO_CLI_PLATFORM[vestiPlatform];
}

// ==================== Data Conversion ====================

export interface VestiConversationCompat {
  id: number;
  uuid: string;
  platform: string;
  title: string;
  snippet: string;
  url: string;
  source_created_at: number | null;
  first_captured_at: number;
  last_captured_at: number;
  created_at: number;
  updated_at: number;
  message_count: number;
  turn_count: number;
  is_archived: boolean;
  is_trash: boolean;
  tags: string[];
  topic_id: number | null;
  is_starred: boolean;
  // Extension fields
  _source: 'local_terminal';
  _cli_id: string;
  _cli_platform: string;
  _project_path?: string;
  _model?: string;
  _tool_call_count?: number;
  /** A1: parent work-session id when this session is a folded subagent run. */
  _subagent_of?: string;
  /** A1: subagent role/type (e.g. "bugbot", "Task"), when known. */
  _agent_role?: string;
}

export interface VestiMessageCompat {
  id: number;
  conversation_id: number;
  role: 'user' | 'ai';
  content_text: string;
  content_ast: null;
  content_ast_version: null;
  degraded_nodes_count: number;
  citations: never[];
  attachments: never[];
  artifacts: never[];
  normalized_html_snapshot: null;
  created_at: number;
  // Extension fields
  _source: 'local_terminal';
  _thinking?: string;
  _tool_name?: string;
  _tool_input?: string;
  _tool_output?: string;
  _message_source?: string;
  _turn_id?: string;
  _turn_sequence?: number;
  _message_kind?: 'turn_prompt' | 'turn_response';
  _followups?: VestiTurnSegmentCompat[];
  _progress_segments?: VestiTurnSegmentCompat[];
  _thinking_segments?: VestiTurnSegmentCompat[];
  _member_message_ids?: number[];
}

export interface VestiTurnSegmentCompat {
  id: number;
  content_text: string;
  created_at: number;
}

export interface VestiTurnProjection {
  messages: VestiMessageCompat[];
  turnCount: number;
}

/**
 * Convert a WorkSession to VESTI mainline Conversation format
 */
export function workSessionToVestiConversation(
  ws: WorkSession,
  snippet?: string,
  visibleCounts?: { messageCount: number; turnCount: number },
): VestiConversationCompat {
  const numericId = registerCliId(ws.id);
  const sanitizedTitle = sanitizePlatformUserText(ws.title, ws.platform);
  const visibleSnippet = sanitizePlatformUserText(snippet ?? '', ws.platform);
  const hasInjectedTitle = looksLikeInjectedContextPrefix(sanitizedTitle)
    || (ws.platform === 'codex' && looksLikeCodexInjectedPrefix(sanitizedTitle));
  const title = hasInjectedTitle
    ? ''
    : sanitizedTitle;
  const snippetTitle = visibleSnippet.split(/\r?\n/, 1)[0].slice(0, 80);

  return {
    id: numericId,
    uuid: ws.sessionId,
    platform: mapPlatform(ws.platform),
    title: title || snippetTitle || 'Untitled',
    snippet: visibleSnippet,
    url: ws.projectPath ? `file://${ws.projectPath}` : '',
    source_created_at: ws.startedAt,
    first_captured_at: ws.startedAt,
    last_captured_at: ws.endedAt || ws.startedAt,
    created_at: ws.startedAt,
    updated_at: ws.endedAt || ws.startedAt,
    message_count: visibleCounts?.messageCount ?? ws.messageCount,
    turn_count: visibleCounts?.turnCount ?? ws.turnCount,
    is_archived: ws.status === 'archived',
    is_trash: false,
    tags: ws.tags || [],
    topic_id: null,
    is_starred: false,
    _source: 'local_terminal',
    _cli_id: ws.id,
    _cli_platform: ws.platform,
    _project_path: ws.projectPath || undefined,
    _model: ws.model || undefined,
    _tool_call_count: ws.toolCallCount || undefined,
  };
}

function baseVestiMessage(
  source: SessionMessage,
  conversationNumericId: number,
  role: 'user' | 'ai',
  contentText: string,
): VestiMessageCompat {
  return {
    id: cliIdToNumeric(source.id),
    conversation_id: conversationNumericId,
    role,
    content_text: contentText,
    content_ast: null,
    content_ast_version: null,
    degraded_nodes_count: 0,
    citations: [],
    attachments: [],
    artifacts: [],
    normalized_html_snapshot: null,
    created_at: source.timestamp,
    _source: 'local_terminal',
    _thinking: source.contentThinking || undefined,
    _tool_name: source.contentToolName || undefined,
    _tool_input: source.contentToolInput || undefined,
    _tool_output: source.contentToolOutput || undefined,
    _message_source: source.source,
  };
}

function segment(message: SessionMessage, contentText: string): VestiTurnSegmentCompat {
  return {
    id: cliIdToNumeric(message.id),
    content_text: contentText,
    created_at: message.timestamp,
  };
}

function uniqueSegments(
  messages: SessionMessage[],
  content: (message: SessionMessage) => string,
  excludedContent?: string,
): VestiTurnSegmentCompat[] {
  const seen = new Set<string>();
  const result: VestiTurnSegmentCompat[] = [];
  for (const message of messages) {
    const value = content(message).trim();
    if (!value || value === excludedContent || seen.has(value)) continue;
    seen.add(value);
    result.push(segment(message, value));
  }
  return result;
}

/**
 * Build the canonical user-facing task projection. Raw SessionMessages remain
 * untouched in SQLite; consumers receive at most a prompt and a response per
 * task, with follow-ups and process segments attached as metadata.
 */
export function projectSessionTurnsToVesti(
  messages: SessionMessage[],
  conversationNumericId: number,
  platform?: CapturePlatform,
): VestiTurnProjection {
  const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
  const visibleUserTurnIds = new Set(sorted.flatMap(message => {
    if (message.source !== 'user_input' || !message.turnId) return [];
    return sanitizePlatformUserText(message.contentText ?? '', platform)
      ? [message.turnId]
      : [];
  }));
  const groups = new Map<string, SessionMessage[]>();
  let activeFallbackTurnId: string | undefined;
  for (const message of sorted) {
    let key: string | undefined;
    if (message.source === 'user_input') {
      const contentText = sanitizePlatformUserText(message.contentText ?? '', platform);
      if (!contentText) {
        activeFallbackTurnId = undefined;
        continue;
      }
      key = message.turnId ?? `${message.sessionId}:projected:${message.id}`;
      activeFallbackTurnId = key;
    } else if (message.turnId && visibleUserTurnIds.has(message.turnId)) {
      key = message.turnId;
    } else if (!message.turnId) {
      // Legacy/non-native adapters can lack stored turn ids. Preserve their
      // user-input boundary fallback without guessing for an explicit but
      // unmatched native child id.
      key = activeFallbackTurnId;
    }
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(message);
    else groups.set(key, [message]);
  }

  const projected: VestiMessageCompat[] = [];
  let turnCount = 0;
  const orderedGroups = [...groups.entries()].sort(([, left], [, right]) => {
    const leftUserAt = left.find(message => message.source === 'user_input')?.timestamp ?? Number.MAX_SAFE_INTEGER;
    const rightUserAt = right.find(message => message.source === 'user_input')?.timestamp ?? Number.MAX_SAFE_INTEGER;
    return leftUserAt - rightUserAt;
  });
  for (const [turnId, members] of orderedGroups) {
    const visibleUsers = members.flatMap(message => {
      if (message.source !== 'user_input') return [];
      const contentText = sanitizePlatformUserText(message.contentText ?? '', platform);
      return contentText ? [{ message, contentText }] : [];
    });
    const assistantTexts = members.filter(message => message.source === 'assistant_text' && message.contentText?.trim());
    const commentaryTexts = members.filter(message => message.source === 'assistant_commentary' && message.contentText?.trim());
    const finalMessage = assistantTexts.at(-1) ?? commentaryTexts.at(-1);
    const finalText = finalMessage?.contentText?.trim() ?? '';
    const progressMessages = members.filter(message =>
      message.source === 'assistant_commentary'
      || message.source === 'progress'
      || (message.source === 'assistant_text' && message.id !== finalMessage?.id)
    ).filter(message => message.id !== finalMessage?.id);
    const thinkingMessages = members.filter(message => message.source === 'assistant_think');
    const progressSegments = uniqueSegments(
      progressMessages,
      message => message.contentText ?? '',
      finalText,
    );
    const thinkingSegments = uniqueSegments(
      thinkingMessages,
      message => message.contentThinking ?? message.contentText ?? '',
    );
    const hasAssistantProjection = Boolean(finalMessage || progressSegments.length || thinkingSegments.length);
    if (!visibleUsers.length) continue;

    turnCount++;
    const projectionTurnId = turnId;
    const userMemberIds = members
      .filter(message => message.source === 'user_input')
      .map(message => cliIdToNumeric(message.id));
    const assistantMemberIds = members
      .filter(message => message.source !== 'user_input')
      .map(message => cliIdToNumeric(message.id));

    if (visibleUsers.length) {
      const [primary, ...followups] = visibleUsers;
      projected.push({
        ...baseVestiMessage(primary.message, conversationNumericId, 'user', primary.contentText),
        _turn_id: projectionTurnId,
        _turn_sequence: turnCount,
        _message_kind: 'turn_prompt',
        _followups: followups.map(item => segment(item.message, item.contentText)),
        _member_message_ids: userMemberIds,
      });
    }

    if (hasAssistantProjection) {
      const host = finalMessage
        ?? progressMessages.at(-1)
        ?? thinkingMessages.at(-1)!;
      projected.push({
        ...baseVestiMessage(host, conversationNumericId, 'ai', finalText),
        _turn_id: projectionTurnId,
        _turn_sequence: turnCount,
        _message_kind: 'turn_response',
        _progress_segments: progressSegments,
        _thinking_segments: thinkingSegments,
        _member_message_ids: assistantMemberIds,
        _thinking: thinkingSegments.map(item => item.content_text).join('\n\n') || undefined,
      });
    }
  }

  return { messages: projected, turnCount };
}

/** Convert raw stored messages into the canonical task-turn view. */
export function sessionMessagesToVestiMessages(
  messages: SessionMessage[],
  conversationNumericId: number,
  platform?: CapturePlatform,
): VestiMessageCompat[] {
  return projectSessionTurnsToVesti(messages, conversationNumericId, platform).messages;
}

/** Return the first displayable user message, skipping legacy system rows. */
export function firstVisibleUserSnippet(
  messages: SessionMessage[],
  maxLength = 200,
  platform?: CapturePlatform,
): string {
  for (const message of messages) {
    if (message.source !== 'user_input' || !message.contentText) continue;
    const visibleText = sanitizePlatformUserText(message.contentText, platform);
    if (visibleText) return visibleText.slice(0, maxLength);
  }
  return '';
}
