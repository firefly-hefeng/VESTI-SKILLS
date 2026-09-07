/**
 * WorkBuddy (Tencent) parser. Sessions are JSONL files under
 * <home>/.workbuddy/projects/<project>/<sessionId>.jsonl, with subagent
 * transcripts nested at <sessionId>/subagents/<agentId>.jsonl.
 *
 * Wire format (one JSON object per line):
 *   { type: 'message', role: 'user'|'assistant', content: string |
 *     [{ text|input_text|output_text }], timestamp, cwd?,
 *     providerData?: { model?, usage?|rawUsage? } }
 *   { type: 'function_call', name, callId, arguments: string|object, ... }
 *   { type: 'function_call_result', callId, output, ... }
 * Timestamps are epoch ms (ISO strings tolerated). Usage keys accept both
 * camelCase and snake_case; prompt_tokens/completion_tokens include cached
 * and reasoning splits respectively.
 * Malformed lines are skipped, never fatal.
 */

import fs from 'fs-extra';
import path from 'path';
import type { ParsedMessage, ParsedSession, SessionTokenUsage, SubagentRef } from '../../types/agent.js';
import type { ToolExecution, TokenUsage } from '../../types/index.js';

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function toTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
    return value < 100_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      const obj = record(part);
      for (const key of ['text', 'input_text', 'output_text'] as const) {
        if (typeof obj[key] === 'string' && obj[key]) {
          parts.push(obj[key] as string);
          break;
        }
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

function textValue(value: unknown, max = 1_000_000): string {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (value !== null && value !== undefined) {
    const obj = record(value);
    if (typeof obj.text === 'string') text = obj.text;
    else try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  return text.length > max ? `${text.slice(0, max)}\n[truncated by Vesti]` : text;
}

function numberField(source: JsonObject, ...keys: string[]): { value: number; found: boolean } {
  for (const key of keys) {
    const segments = key.split('.');
    let current: unknown = source;
    for (const segment of segments) current = record(current)[segment];
    if (typeof current === 'number' && Number.isFinite(current)) {
      return { value: Math.max(0, Math.round(current)), found: true };
    }
  }
  return { value: 0, found: false };
}

function extractUsage(line: JsonObject): TokenUsage | undefined {
  const provider = record(line.providerData);
  const model = typeof provider.model === 'string' ? provider.model : '';
  const usage = record(provider.usage ?? provider.rawUsage);
  if (Object.keys(usage).length === 0) return undefined;

  const input = numberField(usage, 'inputTokens', 'input_tokens', 'prompt_tokens');
  const output = numberField(usage, 'outputTokens', 'output_tokens', 'completion_tokens');
  const cacheRead = numberField(usage, 'cacheReadInputTokens', 'cache_read_input_tokens', 'prompt_tokens_details.cached_tokens');
  const cacheCreate = numberField(usage, 'cacheCreationInputTokens', 'cache_creation_input_tokens');
  if (!input.found && !output.found && !cacheRead.found && !cacheCreate.found) return undefined;

  // prompt_tokens-style totals already include the cached share.
  const inputTokens = usage.prompt_tokens !== undefined
    ? Math.max(input.value - cacheRead.value, 0)
    : input.value;
  return {
    inputTokens,
    outputTokens: output.value,
    cacheCreationTokens: cacheCreate.value,
    cacheReadTokens: cacheRead.value,
    model,
  };
}

function emptyTokenUsage(): SessionTokenUsage {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    models: new Set<string>(),
  };
}

export class WorkBuddyParser {
  /**
   * One JSONL file holds one session. Returns null for files with no
   * conversational content (empty sessions, metadata-only files).
   */
  async parseFile(filePath: string): Promise<ParsedSession | null> {
    const content = await fs.readFile(filePath, 'utf8');
    return this.parseContent(content, filePath);
  }

  parseContent(content: string, filePath: string): ParsedSession | null {
    const sessionId = path.basename(filePath, '.jsonl');
    const messages: ParsedMessage[] = [];
    const tokenUsage = emptyTokenUsage();
    let cwd = '';
    let firstPrompt = '';
    let malformed = 0;

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let row: JsonObject;
      try {
        row = JSON.parse(line) as JsonObject;
      } catch {
        malformed++;
        continue;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        malformed++;
        continue;
      }

      if (!cwd && typeof row.cwd === 'string' && row.cwd) cwd = row.cwd;
      const timestamp = toTimestamp(row.timestamp);
      const type = typeof row.type === 'string' ? row.type : '';

      if (type === 'message') {
        const role = row.role === 'user' ? 'user' : row.role === 'assistant' ? 'assistant' : null;
        if (!role) continue;
        const text = contentText(row.content);
        if (!text) continue;
        if (!firstPrompt && role === 'user') firstPrompt = text;
        const usage = role === 'assistant' ? extractUsage(row) : undefined;
        if (usage) this.accumulate(tokenUsage, usage);
        messages.push({
          uuid: `workbuddy-${sessionId}-${messages.length}`,
          type: role,
          role,
          timestamp,
          contentText: text,
          usage,
          isToolResult: false,
          depth: 0,
        });
        continue;
      }

      if (type === 'function_call') {
        const name = typeof row.name === 'string' ? row.name : '';
        const callId = typeof row.callId === 'string' ? row.callId : '';
        if (!name || !callId) continue;
        const args = row.arguments;
        const input = typeof args === 'string'
          ? (() => { try { return JSON.parse(args) as unknown; } catch { return args; } })()
          : args ?? {};
        const usage = extractUsage(row);
        if (usage) this.accumulate(tokenUsage, usage);
        messages.push({
          uuid: `workbuddy-${sessionId}-${messages.length}`,
          type: 'assistant',
          role: 'assistant',
          timestamp,
          toolCalls: [{ id: callId, name, input }],
          usage,
          isToolResult: false,
          depth: 0,
        });
        continue;
      }

      if (type === 'function_call_result') {
        const callId = typeof row.callId === 'string' ? row.callId : '';
        if (!callId) continue;
        messages.push({
          uuid: `workbuddy-${sessionId}-${messages.length}`,
          type: 'user',
          role: 'user',
          timestamp,
          toolResults: [{ toolUseId: callId, content: textValue(row.output) }],
          isToolResult: true,
          depth: 0,
        });
        continue;
      }
      // Unknown line types are ignored so format additions do not break capture.
    }

    if (messages.length === 0) return null;

    const toolExecutions = this.buildToolExecutions(messages);
    const timestamps = messages.map(message => message.timestamp).filter(value => value > 0);
    const startTime = timestamps.length ? Math.min(...timestamps) : Date.now();
    const endTime = timestamps.length ? Math.max(...timestamps) : undefined;

    return {
      sessionId,
      platform: 'workbuddy',
      projectPath: cwd || path.basename(path.dirname(filePath)),
      messages,
      toolExecutions,
      subagents: [],
      tokenUsage,
      startTime,
      endTime,
      meta: {
        first_prompt: firstPrompt || undefined,
        malformed_lines: malformed || undefined,
      },
      warnings: malformed > 0 ? [`skipped ${malformed} malformed line(s)`] : undefined,
    };
  }

  /** Subagent transcripts nested next to a main session file. */
  discoverSubagents(filePath: string): SubagentRef[] {
    const refs: SubagentRef[] = [];
    const subagentsDir = path.join(path.dirname(filePath), path.basename(filePath, '.jsonl'), 'subagents');
    try {
      if (!fs.existsSync(subagentsDir)) return refs;
      for (const entry of fs.readdirSync(subagentsDir, { withFileTypes: true })) {
        if (entry.isDirectory() || !entry.name.endsWith('.jsonl')) continue;
        refs.push({
          agentId: entry.name.slice(0, -'.jsonl'.length),
          filePath: path.join(subagentsDir, entry.name),
        });
      }
    } catch { /* directory may be unreadable */ }
    return refs;
  }

  private accumulate(total: SessionTokenUsage, usage: TokenUsage): void {
    total.totalInputTokens += usage.inputTokens;
    total.totalOutputTokens += usage.outputTokens;
    total.totalCacheCreationTokens += usage.cacheCreationTokens;
    total.totalCacheReadTokens += usage.cacheReadTokens;
    if (usage.model) total.models.add(usage.model);
  }

  private buildToolExecutions(messages: ParsedMessage[]): ToolExecution[] {
    const uses = new Map<string, { messageId: string; name: string; input: unknown; timestamp: number }>();
    const results = new Map<string, { messageId: string; content: string; timestamp: number }>();
    for (const message of messages) {
      for (const call of message.toolCalls ?? []) {
        uses.set(call.id, { messageId: message.uuid, name: call.name, input: call.input, timestamp: message.timestamp });
      }
      for (const result of message.toolResults ?? []) {
        results.set(result.toolUseId, { messageId: message.uuid, content: result.content, timestamp: message.timestamp });
      }
    }
    const executions: ToolExecution[] = [];
    for (const [toolUseId, use] of uses) {
      const result = results.get(toolUseId);
      const inputStr = typeof use.input === 'string' ? use.input : JSON.stringify(use.input);
      executions.push({
        id: `workbuddy-tool-${toolUseId}`,
        conversationId: '',
        toolUseMessageId: use.messageId,
        toolResultMessageId: result?.messageId,
        toolUseId,
        toolName: use.name,
        inputSummary: inputStr.slice(0, 500),
        outputSummary: result?.content.slice(0, 500),
        isError: false,
        durationMs: result && result.timestamp >= use.timestamp ? result.timestamp - use.timestamp : undefined,
        timestamp: use.timestamp,
      });
    }
    return executions.sort((a, b) => a.timestamp - b.timestamp);
  }
}
