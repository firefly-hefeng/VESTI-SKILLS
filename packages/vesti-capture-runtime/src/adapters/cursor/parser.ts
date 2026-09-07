/**
 * Cursor stores modern Composer conversations in global state.vscdb:
 *   composerHeaders -> composerData:<id> -> bubbleId:<composerId>:<bubbleId>
 * Values are read as JSON. Unknown fields are deliberately ignored so schema
 * additions do not break capture.
 */

import type { ParsedMessage, ParsedSession, SessionTokenUsage } from '../../types/agent.js';
import type { ToolExecution } from '../../types/index.js';
import { estimateTokensFromText } from './estimate.js';

type SqliteDatabase = import('better-sqlite3').Database;
type JsonObject = Record<string, unknown>;

interface ComposerHeader extends JsonObject {
  composerId?: string;
  name?: string;
  createdAt?: unknown;
  lastUpdatedAt?: unknown;
  isArchived?: boolean;
  isSubagent?: boolean;
  workspaceIdentifier?: unknown;
}

/**
 * Subagent lineage carried by subagent composers (verified on Cursor 2026
 * databases): subagentInfo.parentComposerId names the spawning composer,
 * subagentTypeName the agent role, toolCallId the Task-tool call that
 * spawned it. Parents additionally list children in subagentComposerIds.
 */
interface SubagentLineage {
  parentComposerId: string;
  typeName?: string;
  toolCallId?: string;
}

function extractLineage(source: JsonObject): SubagentLineage | null {
  const info = record(source.subagentInfo);
  const parent = info.parentComposerId ?? info.rootParentConversationId;
  if (typeof parent !== 'string' || !parent) return null;
  return {
    parentComposerId: parent,
    typeName: typeof info.subagentTypeName === 'string' ? info.subagentTypeName : undefined,
    toolCallId: typeof info.toolCallId === 'string' ? info.toolCallId : undefined,
  };
}

function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function parseJson(value: unknown): JsonObject | null {
  if (value === null || value === undefined) return null;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function toTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim()) return toTimestamp(numeric, fallback);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function textValue(value: unknown, max = 1_000_000): string {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (value !== null && value !== undefined) {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  return text.length > max ? `${text.slice(0, max)}\n[truncated by Vesti]` : text;
}

function jsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function uriPath(value: unknown): string {
  const obj = record(value);
  const uri = record(obj.uri ?? value);
  for (const candidate of [uri.fsPath, uri.path, uri.external, obj.fsPath, obj.path]) {
    if (typeof candidate === 'string' && candidate) {
      if (candidate.startsWith('file://')) {
        try { return decodeURIComponent(new URL(candidate).pathname).replace(/^\/([A-Za-z]:)/, '$1'); } catch { /* fall through */ }
      }
      return candidate;
    }
  }
  return '';
}

function extractThinking(bubble: JsonObject): string {
  if (typeof bubble.thinking === 'string') return bubble.thinking;
  const thinking = record(bubble.thinking);
  return typeof thinking.text === 'string' ? thinking.text : '';
}

function extractModel(data: JsonObject, bubbles: JsonObject[]): string | undefined {
  const configured = record(data.modelConfig).modelName;
  if (typeof configured === 'string' && configured) return configured;
  for (const bubble of bubbles) {
    const name = record(bubble.modelInfo).modelName;
    if (typeof name === 'string' && name) return name;
  }
  return undefined;
}

function tokenNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }
  }
  return 0;
}

function extractBubbleUsage(
  bubble: JsonObject,
  fallbackModel?: string,
): ParsedMessage['usage'] | undefined {
  const tokenCount = record(bubble.tokenCount);
  if (Object.keys(tokenCount).length === 0) return undefined;

  const inputTokens = tokenNumber(
    tokenCount.inputTokens,
    tokenCount.input_tokens,
    tokenCount.promptTokens,
  );
  const outputTokens = tokenNumber(
    tokenCount.outputTokens,
    tokenCount.output_tokens,
    tokenCount.completionTokens,
  );
  const cacheCreationTokens = tokenNumber(
    tokenCount.cacheCreationTokens,
    tokenCount.cache_creation_input_tokens,
  );
  const cacheReadTokens = tokenNumber(
    tokenCount.cacheReadTokens,
    tokenCount.cachedInputTokens,
    tokenCount.cached_input_tokens,
  );
  if (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0) {
    return undefined;
  }

  const bubbleModel = record(bubble.modelInfo).modelName;
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    model: typeof bubbleModel === 'string' && bubbleModel
      ? bubbleModel
      : fallbackModel || 'cursor-unknown',
  };
}

export class CursorParser {
  private async open(filePath: string): Promise<SqliteDatabase> {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const db = new BetterSqlite3(filePath, { readonly: true, fileMustExist: true }) as SqliteDatabase;
    db.pragma('busy_timeout = 2000');
    return db;
  }

  async countSessions(filePath: string): Promise<number> {
    const db = await this.open(filePath);
    try {
      if (tableExists(db, 'composerHeaders')) {
        const row = db.prepare('SELECT COUNT(*) AS count FROM composerHeaders').get() as { count?: number } | undefined;
        if (row?.count) return row.count;
      }
      if (!tableExists(db, 'cursorDiskKV')) return 0;
      const row = db.prepare("SELECT COUNT(*) AS count FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value IS NOT NULL").get() as { count?: number } | undefined;
      return row?.count ?? 0;
    } finally {
      db.close();
    }
  }

  async parseDatabase(filePath: string): Promise<ParsedSession[]> {
    const db = await this.open(filePath);
    try {
      if (!tableExists(db, 'cursorDiskKV')) return [];
      const headers = this.readHeaders(db);
      const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value IS NOT NULL").all() as Array<{ key: string; value: unknown }>;
      const sessions: ParsedSession[] = [];
      // child composerId → lineage; assembled from both sides (the child's
      // subagentInfo and the parent's subagentComposerIds array).
      const lineageByChild = new Map<string, SubagentLineage>();

      for (const row of rows) {
        const data = parseJson(row.value);
        if (!data) continue;
        const composerId = typeof data.composerId === 'string'
          ? data.composerId
          : row.key.slice('composerData:'.length);
        if (!composerId || composerId.length < 8) continue;
        const header = headers.get(composerId) ?? {};

        // readHeaders merges the header row's JSON value into the header
        // object, so subagentInfo is visible on either source.
        const lineage = extractLineage(data) ?? extractLineage(header);
        if (lineage && lineage.parentComposerId !== composerId) {
          lineageByChild.set(composerId, lineage);
        }
        const childIds = Array.isArray(data.subagentComposerIds) ? data.subagentComposerIds : [];
        for (const childId of childIds) {
          if (typeof childId === 'string' && childId && childId !== composerId && !lineageByChild.has(childId)) {
            lineageByChild.set(childId, { parentComposerId: composerId });
          }
        }

        const parsed = this.parseComposer(db, filePath, composerId, data, header);
        if (parsed && parsed.messages.length > 0) sessions.push(parsed);
      }

      this.attachLineage(sessions, lineageByChild, filePath);
      return sessions.sort((a, b) => b.startTime - a.startTime);
    } finally {
      db.close();
    }
  }

  /**
   * Second pass over the parsed batch: mount subagent refs on parents (the
   * child work-session id is known at parse time — no file-path resolution
   * needed) and let headless subagents (workspace "empty-window") inherit
   * the parent's project path so the tree mounts them in the same project.
   */
  private attachLineage(
    sessions: ParsedSession[],
    lineageByChild: Map<string, SubagentLineage>,
    filePath: string,
  ): void {
    if (lineageByChild.size === 0) return;
    const byId = new Map(sessions.map(session => [session.sessionId, session]));
    for (const [childId, lineage] of lineageByChild) {
      const child = byId.get(childId);
      const parent = byId.get(lineage.parentComposerId);
      if (!child || !parent) continue;
      parent.subagents.push({
        agentId: childId,
        slug: lineage.typeName,
        agentRole: lineage.typeName,
        filePath,
        childSessionId: `cursor:${childId}`,
      });
      if (child.meta) {
        child.meta.parent_composer_id = lineage.parentComposerId;
        if (lineage.typeName) child.meta.subagent_type = lineage.typeName;
        if (lineage.toolCallId) child.meta.spawned_by_tool_call = lineage.toolCallId;
      }
      if (!child.projectPath && parent.projectPath) {
        child.projectPath = parent.projectPath;
      }
    }
  }

  private readHeaders(db: SqliteDatabase): Map<string, ComposerHeader> {
    const result = new Map<string, ComposerHeader>();
    if (tableExists(db, 'composerHeaders')) {
      const rows = db.prepare('SELECT composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, value FROM composerHeaders').all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const value = parseJson(row.value) ?? {};
        const composerId = String(row.composerId ?? value.composerId ?? '');
        if (!composerId) continue;
        result.set(composerId, { ...value, ...row, composerId });
      }
    }

    if (tableExists(db, 'ItemTable')) {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key='composer.composerHeaders'").get() as { value?: unknown } | undefined;
      const value = parseJson(row?.value);
      const all = Array.isArray(value?.allComposers) ? value.allComposers : [];
      for (const item of all) {
        const header = record(item) as ComposerHeader;
        if (typeof header.composerId !== 'string') continue;
        result.set(header.composerId, { ...(result.get(header.composerId) ?? {}), ...header });
      }
    }
    return result;
  }

  private parseComposer(
    db: SqliteDatabase,
    filePath: string,
    composerId: string,
    data: JsonObject,
    header: ComposerHeader,
  ): ParsedSession | null {
    const fallbackStart = toTimestamp(data.createdAt ?? header.createdAt, Date.now());
    const headerList = Array.isArray(data.fullConversationHeadersOnly)
      ? data.fullConversationHeadersOnly.map(record)
      : [];
    const bubbleEntries: Array<{ bubble: JsonObject; header: JsonObject }> = [];
    const bubbleStatement = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');

    for (const bubbleHeader of headerList) {
      const bubbleId = typeof bubbleHeader.bubbleId === 'string' ? bubbleHeader.bubbleId : '';
      if (!bubbleId) continue;
      const row = bubbleStatement.get(`bubbleId:${composerId}:${bubbleId}`) as { value?: unknown } | undefined;
      const bubble = parseJson(row?.value);
      if (bubble) bubbleEntries.push({ bubble, header: bubbleHeader });
    }

    if (bubbleEntries.length === 0) {
      const conversationMap = record(data.conversationMap);
      for (const value of Object.values(conversationMap)) {
        const bubble = record(value);
        if (Object.keys(bubble).length) bubbleEntries.push({ bubble, header: bubble });
      }
    }

    // Cursor's older Composer layout stores the complete bubble list inline
    // as `conversation[]`. Newer databases keep only headers here and place
    // each bubble in cursorDiskKV. Support both without combining them, which
    // would double-count messages and reported usage during migrations.
    if (bubbleEntries.length === 0 && Array.isArray(data.conversation)) {
      for (const value of data.conversation) {
        const bubble = record(value);
        if (Object.keys(bubble).length) bubbleEntries.push({ bubble, header: bubble });
      }
    }

    const messages: ParsedMessage[] = [];
    const toolExecutions: ToolExecution[] = [];
    const bubbles = bubbleEntries.map(entry => entry.bubble);
    const model = extractModel(data, bubbles);
    const tokenUsage: SessionTokenUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      models: new Set(model ? [model] : []),
    };
    let firstPrompt = '';
    let sequence = 0;

    for (const { bubble, header: bubbleHeader } of bubbleEntries) {
      const bubbleId = typeof bubble.bubbleId === 'string'
        ? bubble.bubbleId
        : typeof bubbleHeader.bubbleId === 'string' ? bubbleHeader.bubbleId : `bubble-${sequence}`;
      const ts = toTimestamp(bubble.createdAt ?? bubbleHeader.createdAt, fallbackStart + sequence);
      const type = Number(bubble.type ?? bubbleHeader.type);
      const role = type === 1 ? 'user' : 'assistant';
      const text = typeof bubble.text === 'string' ? bubble.text.trim() : '';
      const thinking = extractThinking(bubble).trim();
      const tool = record(bubble.toolFormerData);
      const usage = extractBubbleUsage(bubble, model);
      if (usage) {
        tokenUsage.totalInputTokens += usage.inputTokens;
        tokenUsage.totalOutputTokens += usage.outputTokens;
        tokenUsage.totalCacheCreationTokens += usage.cacheCreationTokens;
        tokenUsage.totalCacheReadTokens += usage.cacheReadTokens;
        tokenUsage.models.add(usage.model);
      }

      if (role === 'user') {
        if (text) {
          if (!firstPrompt) firstPrompt = text;
          messages.push({
            uuid: `cursor-${composerId}-${bubbleId}`,
            type: 'user',
            role: 'user',
            timestamp: ts,
            contentText: text,
            isToolResult: false,
            depth: 0,
          });
        }
        sequence++;
        continue;
      }

      if (Object.keys(tool).length > 0) {
        const callId = String(tool.toolCallId ?? bubbleId);
        const name = String(tool.name ?? `cursor_tool_${String(tool.tool ?? 'unknown')}`);
        const input = jsonish(tool.params ?? tool.rawArgs ?? {});
        const callMessageId = `cursor-${composerId}-${bubbleId}-tool-call`;
        messages.push({
          uuid: callMessageId,
          type: 'assistant',
          role: 'assistant',
          timestamp: ts,
          contentText: text || undefined,
          contentThinking: thinking || undefined,
          toolCalls: [{ id: callId, name, input }],
          usage,
          isToolResult: false,
          depth: 0,
        });

        const hasResult = tool.result !== undefined || tool.error !== undefined || String(tool.status ?? '').toLowerCase() !== 'running';
        let resultMessageId: string | undefined;
        let resultText = '';
        const isError = Boolean(tool.error) || /error|failed/i.test(String(tool.status ?? ''));
        if (hasResult) {
          resultText = textValue(tool.error ?? tool.result ?? tool.status ?? '');
          resultMessageId = `cursor-${composerId}-${bubbleId}-tool-result`;
          messages.push({
            uuid: resultMessageId,
            type: 'user',
            role: 'user',
            timestamp: ts + 1,
            toolResults: [{ toolUseId: callId, content: resultText, isError }],
            isToolResult: true,
            depth: 0,
          });
        }

        toolExecutions.push({
          id: `cursor-${composerId}-tool-${callId}`,
          conversationId: '',
          toolUseMessageId: callMessageId,
          toolResultMessageId: resultMessageId,
          toolUseId: callId,
          toolName: name,
          inputSummary: textValue(input, 500),
          outputSummary: resultText.slice(0, 500),
          isError,
          timestamp: ts,
        });
      } else if (text || thinking) {
        messages.push({
          uuid: `cursor-${composerId}-${bubbleId}`,
          type: 'assistant',
          role: 'assistant',
          timestamp: ts,
          contentText: text || undefined,
          contentThinking: thinking || undefined,
          usage,
          isToolResult: false,
          depth: 0,
        });
      }
      sequence++;
    }

    if (messages.length === 0) return null;
    const timestamps = messages.map(message => message.timestamp).filter(value => value > 0);
    const startTime = timestamps.length ? Math.min(...timestamps) : fallbackStart;
    const endTime = timestamps.length ? Math.max(...timestamps) : toTimestamp(data.lastUpdatedAt ?? header.lastUpdatedAt, startTime);

    // Recent Cursor builds write bubble.tokenCount as zeros; fall back to a
    // character-based estimate (flagged via meta.token_estimated) so cursor
    // sessions register real activity instead of a misleading 0.
    let tokenEstimated = false;
    if (tokenUsage.totalInputTokens === 0 && tokenUsage.totalOutputTokens === 0) {
      for (const message of messages) {
        const inputText = (message.role === 'user' ? message.contentText ?? '' : '')
          + (message.toolResults ?? []).map(result => result.content).join('\n');
        const outputText = message.role === 'assistant'
          ? `${message.contentText ?? ''}\n${message.contentThinking ?? ''}`
          : '';
        tokenUsage.totalInputTokens += estimateTokensFromText(inputText);
        tokenUsage.totalOutputTokens += estimateTokensFromText(outputText);
      }
      tokenEstimated = tokenUsage.totalInputTokens > 0 || tokenUsage.totalOutputTokens > 0;
    }

    const title = typeof data.name === 'string' && data.name.trim()
      ? data.name.trim()
      : typeof header.name === 'string' ? header.name.trim() : '';

    // Empty-window composers genuinely have no workspace on disk; tag them so
    // consumers can distinguish "no folder was open" from "path not captured".
    const headerWs = record(header.workspaceIdentifier);
    const wsIdentifier = headerWs.id !== undefined ? headerWs : record(data.workspaceIdentifier);
    const isEmptyWindow = wsIdentifier.id === 'empty-window';

    return {
      sessionId: composerId,
      platform: 'cursor',
      projectPath: uriPath(header.workspaceIdentifier) || uriPath(data.workspaceIdentifier),
      model,
      messages,
      toolExecutions,
      subagents: [],
      tokenUsage,
      startTime,
      endTime,
      meta: {
        first_prompt: title || firstPrompt || undefined,
        composer_name: title || undefined,
        // composerHeaders stores these as SQLite integers (0/1), the JSON
        // value as booleans — accept both.
        archived: header.isArchived === true || (header.isArchived as unknown) === 1 || data.isArchived === true,
        is_subagent: header.isSubagent === true || (header.isSubagent as unknown) === 1 || data.isSubagent === true,
        empty_window: isEmptyWindow || undefined,
        token_estimated: tokenEstimated || undefined,
        source_database: filePath,
        unified_mode: data.unifiedMode,
        force_mode: data.forceMode,
      },
    };
  }
}
