/**
 * Claude Code Parser (Rewritten)
 * Fixes all 10 known issues from echo's parser:
 * 1. progress messages preserved
 * 2. file-history-snapshot handled
 * 3. subagent files discovered
 * 4. content field polymorphism (string | tool_result[])
 * 5. tool_use ↔ tool_result paired via toolUseId
 * 6. token usage extracted from message.usage
 * 7. depth calculated from parent chain
 * 8. project path from cwd field (not directory name)
 * 9. single parser (no duplicate logic)
 * 10. all optional fields preserved
 */

import fs from 'fs-extra';
import path from 'path';
import readline from 'readline';
import type { ParsedSession, ParsedMessage, ToolCallBlock, ToolResultBlock, SubagentRef, SessionTokenUsage } from '../../types/agent.js';
import type { ToolExecution, TokenUsage } from '../../types/index.js';
import type {
  ClaudeRawLine,
  ClaudeContentBlock,
  ClaudeToolResultBlock,
  ClaudeToolUseBlock,
} from './types.js';

export class ClaudeCodeParser {

  /**
   * Parse a complete JSONL session file
   */
  async parseFile(filePath: string): Promise<ParsedSession> {
    const content = await fs.readFile(filePath, 'utf-8');
    return this.parseContent(content, filePath);
  }

  /**
   * Parse from a byte offset (for incremental sync)
   */
  async parseIncremental(filePath: string, byteOffset: number): Promise<{ session: ParsedSession; newOffset: number }> {
    const buf = await fs.readFile(filePath);
    const slice = buf.slice(byteOffset);
    const content = slice.toString('utf-8');
    const session = this.parseContent(content, filePath);
    return { session, newOffset: byteOffset + slice.length };
  }

  /**
   * Stream parse (low memory for large files)
   */
  async parseFileStream(filePath: string): Promise<ParsedSession> {
    const rawLines: ClaudeRawLine[] = [];
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        rawLines.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    const sessionId = path.basename(filePath, '.jsonl');
    return this.parseLines(rawLines, sessionId, filePath);
  }

  /**
   * Core parsing logic
   */
  parseContent(content: string, filePath: string): ParsedSession {
    const sessionId = path.basename(filePath, '.jsonl');
    const lines = content.split('\n').filter(l => l.trim());

    const rawLines: ClaudeRawLine[] = [];
    for (const line of lines) {
      try {
        rawLines.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    return this.parseLines(rawLines, sessionId, filePath);
  }

  /**
   * Parse raw lines into ParsedSession
   */
  private parseLines(rawLines: ClaudeRawLine[], sessionId: string, filePath: string): ParsedSession {

    // Parse all messages (including progress and file-history-snapshot)
    const messages: ParsedMessage[] = [];
    const progressMap = new Map<string, string[]>(); // toolUseId → progress outputs
    let projectPath = '';
    let gitBranch: string | undefined;
    let claudeCodeVersion: string | undefined;
    let model: string | undefined;

    // Track compaction boundaries for pairing
    const compactionBoundaries: Array<{
      sequence: number;
      timestamp: number;
      trigger?: string;
      preTokens?: number;
      logicalParentUuid?: string;
    }> = [];

    for (const raw of rawLines) {
      // Extract metadata from first messages
      if (!projectPath && raw.cwd) projectPath = raw.cwd;
      if (!gitBranch && raw.gitBranch) gitBranch = raw.gitBranch;
      if (!claudeCodeVersion && raw.version) claudeCodeVersion = raw.version;
      if (!model && raw.message?.model) model = raw.message.model;

      if (raw.type === 'progress') {
        // Fix #1: Preserve progress messages
        const toolUseId = raw.toolUseID || raw.parentToolUseID || '';
        if (toolUseId) {
          if (!progressMap.has(toolUseId)) progressMap.set(toolUseId, []);
          const output = raw.data?.output || raw.data?.fullOutput || '';
          if (output) progressMap.get(toolUseId)!.push(output);
        }
        // Also store as a message for completeness
        messages.push({
          uuid: raw.uuid,
          parentUuid: raw.parentUuid,
          type: 'progress',
          role: 'system',
          timestamp: raw.timestamp ? new Date(raw.timestamp).getTime() || 0 : 0,
          contentText: raw.data?.output || raw.data?.fullOutput,
          cwd: raw.cwd,
          gitBranch: raw.gitBranch,
          sessionId: raw.sessionId,
          isToolResult: false,
          depth: 0,
        });
        continue;
      }

      if (raw.type === 'file-history-snapshot') {
        // Fix #2: Record file-history-snapshot
        // Note: these have messageId (not uuid), no timestamp, and messageId can be shared across sessions
        // Prefix with sessionId to ensure uniqueness
        const snapshotId = raw.messageId
          ? `fhs-${sessionId}-${raw.messageId}-${messages.length}`
          : `fhs-${sessionId}-${messages.length}`;
        messages.push({
          uuid: snapshotId,
          parentUuid: raw.parentUuid,
          type: 'file-history-snapshot',
          role: 'system',
          timestamp: raw.timestamp ? new Date(raw.timestamp).getTime() || 0 : 0,
          cwd: raw.cwd,
          sessionId: raw.sessionId,
          isToolResult: false,
          depth: 0,
        });
        continue;
      }

      if (raw.type === 'system' || raw.type === 'queue-operation') {
        // v2: Preserve system and queue-operation messages with subtype details
        const msg: ParsedMessage = {
          uuid: raw.uuid || raw.messageId || `${raw.type}-${messages.length}`,
          parentUuid: raw.parentUuid,
          type: raw.type,
          role: 'system',
          timestamp: raw.timestamp ? new Date(raw.timestamp).getTime() || 0 : 0,
          contentText: typeof raw.message?.content === 'string'
            ? raw.message.content
            : raw.content ? String(raw.content) : undefined,
          cwd: raw.cwd,
          sessionId: raw.sessionId,
          isToolResult: false,
          depth: 0,
          systemSubtype: raw.subtype,
        };

        // Subtype-specific processing
        if (raw.subtype === 'api_error') {
          msg.isApiError = true;
          msg.errorDetails = JSON.stringify({
            error: raw.error,
            level: raw.level,
            retryInMs: raw.retryInMs,
            retryAttempt: raw.retryAttempt,
            maxRetries: raw.maxRetries,
            cause: raw.cause,
          });
        } else if (raw.subtype === 'compact_boundary') {
          compactionBoundaries.push({
            sequence: compactionBoundaries.length + 1,
            timestamp: msg.timestamp,
            trigger: raw.compactMetadata?.trigger,
            preTokens: raw.compactMetadata?.preTokens,
            logicalParentUuid: raw.logicalParentUuid,
          });
        }

        messages.push(msg);
        continue;
      }

      if (raw.type === 'user' || raw.type === 'assistant') {
        const msg = this.parseUserOrAssistant(raw);
        if (msg) messages.push(msg);
      }
    }

    // Fix #7: Calculate depths from parent chain
    this.calculateDepths(messages);

    // Fix #5: Build tool execution chains
    const toolExecutions = this.buildToolExecutionChains(messages, progressMap);

    // Discover subagent references
    const subagents = this.discoverSubagents(filePath, rawLines);

    // Aggregate token usage
    const tokenUsage = this.aggregateTokenUsage(messages);

    // Build context compactions from boundaries + compact summary messages
    const compactSummaries = messages.filter(m => m.isCompactSummary);
    const contextCompactions: Array<{ sequence: number; compactedAt: number; summary?: string }> = [];
    for (let i = 0; i < compactionBoundaries.length; i++) {
      const boundary = compactionBoundaries[i];
      const summary = compactSummaries[i];
      contextCompactions.push({
        sequence: boundary.sequence,
        compactedAt: boundary.timestamp,
        summary: summary?.contentText?.slice(0, 2000),
      });
    }
    // If we found compact summaries but no boundaries, still record them
    if (contextCompactions.length === 0 && compactSummaries.length > 0) {
      for (let i = 0; i < compactSummaries.length; i++) {
        contextCompactions.push({
          sequence: i + 1,
          compactedAt: compactSummaries[i].timestamp,
          summary: compactSummaries[i].contentText?.slice(0, 2000),
        });
      }
    }

    // Timestamps
    const timestamps = messages.filter(m => m.timestamp > 0).map(m => m.timestamp);
    const startTime = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
    const endTime = timestamps.length > 0 ? Math.max(...timestamps) : undefined;

    return {
      sessionId,
      platform: 'claude-code',
      projectPath, // Fix #8: from cwd, not directory name
      gitBranch,
      claudeCodeVersion,
      model,
      messages,
      toolExecutions,
      subagents,
      tokenUsage,
      startTime,
      endTime,
      contextCompactions: contextCompactions.length > 0 ? contextCompactions : undefined,
    };
  }

  /**
   * Parse user or assistant message
   */
  private parseUserOrAssistant(raw: ClaudeRawLine): ParsedMessage | null {
    if (!raw.message) return null;

    const timestamp = new Date(raw.timestamp).getTime();
    if (isNaN(timestamp)) return null;

    const role = raw.type === 'user' ? 'user' : 'assistant';

    // Fix #4: Handle content polymorphism
    const content = raw.message.content;
    let contentText: string | undefined;
    let contentThinking: string | undefined;
    let toolCalls: ToolCallBlock[] | undefined;
    let toolResults: ToolResultBlock[] | undefined;

    if (typeof content === 'string') {
      // User messages can be plain strings
      contentText = content;
    } else if (Array.isArray(content)) {
      const texts: string[] = [];
      const thinkings: string[] = [];
      const calls: ToolCallBlock[] = [];
      const results: ToolResultBlock[] = [];

      for (const block of content as ClaudeContentBlock[]) {
        switch (block.type) {
          case 'text':
            if (block.text) texts.push(block.text);
            break;
          case 'thinking':
            if (block.thinking) thinkings.push(block.thinking);
            break;
          case 'tool_use': {
            const tu = block as ClaudeToolUseBlock;
            calls.push({ id: tu.id, name: tu.name, input: tu.input });
            break;
          }
          case 'tool_result': {
            const tr = block as ClaudeToolResultBlock;
            const resultText = typeof tr.content === 'string'
              ? tr.content
              : Array.isArray(tr.content)
                ? tr.content.map(c => c.text).join('\n')
                : '';
            results.push({
              toolUseId: tr.tool_use_id,
              content: resultText,
              isError: tr.is_error,
            });
            break;
          }
        }
      }

      if (texts.length > 0) contentText = texts.join('\n\n');
      if (thinkings.length > 0) contentThinking = thinkings.join('\n\n');
      if (calls.length > 0) toolCalls = calls;
      if (results.length > 0) toolResults = results;
    }

    // Fix #6: Extract token usage
    let usage: TokenUsage | undefined;
    if (raw.message.usage) {
      const u = raw.message.usage;
      usage = {
        inputTokens: u.input_tokens || 0,
        outputTokens: u.output_tokens || 0,
        cacheCreationTokens: u.cache_creation_input_tokens || 0,
        cacheReadTokens: u.cache_read_input_tokens || 0,
        model: raw.message.model || '',
      };
    }

    // Fix #10: Preserve all optional fields
    // v2: Detect if this is a tool_result message (not real user input)
    const isToolResult = role === 'user' && (
      !!raw.toolUseResult || !!raw.sourceToolAssistantUUID || (toolResults !== undefined && toolResults.length > 0)
    );

    // v2: Detect compact summary and API error markers
    const isCompactSummary = raw.isCompactSummary === true;
    const isApiError = raw.isApiErrorMessage === true;

    return {
      uuid: raw.uuid,
      parentUuid: raw.parentUuid,
      type: raw.type as 'user' | 'assistant',
      role,
      timestamp,
      contentText,
      contentThinking,
      toolCalls,
      toolResults,
      cwd: raw.cwd,
      gitBranch: raw.gitBranch,
      sessionId: raw.sessionId,
      usage,
      stopReason: raw.message.stop_reason,
      isToolResult,
      isCompactSummary: isCompactSummary || undefined,
      isApiError: isApiError || undefined,
      permissionMode: raw.permissionMode,
      isSidechain: raw.isSidechain,
      agentId: raw.agentId,
      slug: raw.slug,
      sourceToolAssistantUUID: raw.sourceToolAssistantUUID,
      toolUseResult: raw.toolUseResult,
      depth: 0, // calculated later
    };
  }

  /**
   * Fix #7: Calculate message tree depths
   */
  private calculateDepths(messages: ParsedMessage[]): void {
    const depthCache = new Map<string, number>();
    const parentMap = new Map<string, string>();

    for (const m of messages) {
      if (m.parentUuid) parentMap.set(m.uuid, m.parentUuid);
    }

    const getDepth = (uuid: string): number => {
      if (depthCache.has(uuid)) return depthCache.get(uuid)!;
      const parent = parentMap.get(uuid);
      const depth = parent ? getDepth(parent) + 1 : 0;
      depthCache.set(uuid, depth);
      return depth;
    };

    for (const m of messages) {
      m.depth = getDepth(m.uuid);
    }
  }

  /**
   * Fix #5: Build tool execution chains
   * Links tool_use blocks (in assistant messages) → progress → tool_result blocks (in user messages)
   */
  private buildToolExecutionChains(
    messages: ParsedMessage[],
    progressMap: Map<string, string[]>
  ): ToolExecution[] {
    const executions: ToolExecution[] = [];

    // Collect all tool_use blocks with their source message
    const toolUseMap = new Map<string, { messageId: string; name: string; input: unknown; timestamp: number }>();
    for (const m of messages) {
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          toolUseMap.set(tc.id, {
            messageId: m.uuid,
            name: tc.name,
            input: tc.input,
            timestamp: m.timestamp,
          });
        }
      }
    }

    // Collect all tool_result blocks with their source message
    const toolResultMap = new Map<string, { messageId: string; content: string; isError: boolean; timestamp: number }>();
    for (const m of messages) {
      if (m.toolResults) {
        for (const tr of m.toolResults) {
          toolResultMap.set(tr.toolUseId, {
            messageId: m.uuid,
            content: tr.content,
            isError: tr.isError || false,
            timestamp: m.timestamp,
          });
        }
      }
    }

    // Pair them up
    for (const [toolUseId, use] of toolUseMap) {
      const result = toolResultMap.get(toolUseId);
      const inputStr = typeof use.input === 'string' ? use.input : JSON.stringify(use.input);

      executions.push({
        id: toolUseId,
        conversationId: '', // filled by caller
        toolUseMessageId: use.messageId,
        toolResultMessageId: result?.messageId,
        toolUseId,
        toolName: use.name,
        inputSummary: inputStr.slice(0, 500),
        outputSummary: result?.content?.slice(0, 500),
        isError: result?.isError || false,
        durationMs: result ? result.timestamp - use.timestamp : undefined,
        timestamp: use.timestamp,
      });
    }

    return executions.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Fix #3: Discover subagent files
   */
  private discoverSubagents(filePath: string, rawLines: ClaudeRawLine[]): SubagentRef[] {
    const subagents: SubagentRef[] = [];
    const sessionDir = filePath.replace(/\.jsonl$/, '');

    // Check for subagents directory
    const subagentsDir = path.join(sessionDir, 'subagents');
    if (fs.existsSync(subagentsDir)) {
      try {
        const files = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          // agent-{agentId}.jsonl
          const match = file.match(/^agent-(.+)\.jsonl$/);
          if (match) {
            subagents.push({
              agentId: match[1],
              filePath: path.join(subagentsDir, file),
            });
          }
        }
      } catch {
        // Directory might not be readable
      }
    }

    // Also extract agentId/slug from messages that reference subagents
    const seenAgents = new Set(subagents.map(s => s.agentId));
    for (const raw of rawLines) {
      if (raw.agentId && !seenAgents.has(raw.agentId)) {
        seenAgents.add(raw.agentId);
        // Try to find the file
        const agentFile = path.join(subagentsDir, `agent-${raw.agentId}.jsonl`);
        if (fs.existsSync(agentFile)) {
          subagents.push({
            agentId: raw.agentId,
            slug: raw.slug,
            filePath: agentFile,
          });
        }
      }
    }

    return subagents;
  }

  /**
   * Aggregate token usage across all messages
   */
  private aggregateTokenUsage(messages: ParsedMessage[]): SessionTokenUsage {
    const result: SessionTokenUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      models: new Set(),
    };

    for (const m of messages) {
      if (m.usage) {
        result.totalInputTokens += m.usage.inputTokens;
        result.totalOutputTokens += m.usage.outputTokens;
        result.totalCacheCreationTokens += m.usage.cacheCreationTokens;
        result.totalCacheReadTokens += m.usage.cacheReadTokens;
        if (m.usage.model) result.models.add(m.usage.model);
      }
    }

    return result;
  }
}
