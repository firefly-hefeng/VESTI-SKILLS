/**
 * Message Converter v2
 * Converts ParsedSession → ConvertedSession (WorkSession + Turns + SessionMessages + ToolExecutions + SystemEvents)
 * Implements Turn detection and MessageSource classification
 */

import path from 'path';
import type { ParsedSession, ParsedMessage } from '../types/agent.js';
import type { VestiConversation, VestiMessage, ToolExecution } from '../types/index.js';
import type {
  WorkSession,
  Turn,
  SessionMessage,
  UnifiedToolExecution,
  SystemEvent,
  SubagentLink,
  ContextCompaction,
  ConvertedSession,
  MessageSource,
  TokenUsageEvent,
} from '../types/unified.js';
import { classifyTool } from '../types/unified.js';
import { stripInjectedContextBlocks } from '../utils/injectedBlocks.js';

export class MessageConverter {

  /**
   * v2: Convert a parsed session into the full unified output
   */
  static convertV2(session: ParsedSession): ConvertedSession {
    const now = Date.now();
    const sessionId = `${session.platform}:${session.sessionId}`;
    const normalizedSession: ParsedSession = {
      ...session,
      messages: session.messages.flatMap(message => {
        if (message.role !== 'user' || message.isToolResult) return [message];
        const contentText = stripInjectedContextBlocks(message.contentText ?? '');
        if (!contentText && !message.toolCalls?.length && !message.toolResults?.length) return [];
        return [{ ...message, contentText: contentText || undefined }];
      }),
    };

    // Classify messages and build turns
    const { turns, messages, systemEvents } = MessageConverter.buildTurnsAndMessages(normalizedSession, sessionId, now);

    // Build tool executions with turn assignment and category
    const toolExecutions = MessageConverter.buildToolExecutions(normalizedSession, sessionId, turns, messages);

    // Build subagent links
    const subagentLinks: SubagentLink[] = session.subagents.map(sub => ({
      id: `${sessionId}:${sub.agentId}`,
      parentSessionId: sessionId,
      childSessionId: sub.childSessionId,
      agentId: sub.agentId,
      agentRole: sub.agentRole,
      slug: sub.slug,
      filePath: sub.filePath,
      messageCount: 0,
    }));
    // Child-side lineage (e.g. Cursor background agents, kimi-code sub
    // wires): when the adapter names an agentId the link id matches the
    // parent-side ref (`parent:agent`), so the two insert paths dedup; the
    // upsert in insertSubagentLink upgrades child_session_id either way.
    if (session.subagentOf) {
      const agentId = session.subagentOf.agentId ?? session.sessionId;
      subagentLinks.push({
        id: `${session.subagentOf.parentSessionId}:${agentId}`,
        parentSessionId: session.subagentOf.parentSessionId,
        childSessionId: sessionId,
        agentId,
        agentRole: session.subagentOf.agentRole,
        slug: session.subagentOf.agentRole,
        filePath: typeof session.meta?.source_database === 'string' ? session.meta.source_database : '',
        messageCount: messages.length,
      });
    }

    // Count stats
    const userInputMessages = messages.filter(m => m.source === 'user_input');
    const assistantMessages = messages.filter(m =>
      m.source === 'assistant_text'
      || m.source === 'assistant_commentary'
      || m.source === 'tool_request'
    );
    const thinkingMessages = messages.filter(m => m.contentThinking);
    const fileSnapshotMessages = messages.filter(m => m.source === 'file_snapshot');
    const toolCallCount = normalizedSession.messages.reduce((sum, m) => sum + (m.toolCalls?.length || 0), 0);
    const codeBlockCount = MessageConverter.countCodeBlocks(normalizedSession.messages);

    // Classify session type
    const hasRealContent = userInputMessages.length > 0 || assistantMessages.length > 0;
    const onlySnapshots = !hasRealContent && fileSnapshotMessages.length > 0;
    const sessionType: 'conversation' | 'file_snapshot' | 'empty' = hasRealContent
      ? 'conversation'
      : onlySnapshots ? 'file_snapshot' : 'empty';

    // Title generation priority chain:
    // 0. session.meta.session_title (kimi state.json explicit title)
    // 1. First user_input text (> 5 chars, not interrupted, injected
    //    context blocks like <environment_context> stripped)
    // 2. First assistant_text text
    // 3. session.meta.first_prompt (from session-meta)
    // 4. "File snapshots - {projectDir}" (file_snapshot type)
    // 5. "Empty session" (empty type)
    let title = 'Untitled';
    const metaTitle = session.meta?.session_title;
    if (typeof metaTitle === 'string' && metaTitle.trim().length > 0) {
      title = metaTitle.trim().split('\n')[0].slice(0, 80);
    }
    if (title === 'Untitled') {
      for (const m of userInputMessages) {
        if (m.contentText) {
          const text = stripInjectedContextBlocks(m.contentText);
          if (text.length > 5 && !text.startsWith('[Request interrupted')) {
            title = text.split('\n')[0].slice(0, 80) || 'Untitled';
            break;
          }
        }
      }
    }
    if (title === 'Untitled') {
      for (const m of assistantMessages) {
        if (m.contentText) {
          const text = m.contentText.trim();
          if (text.length > 5) {
            title = text.split('\n')[0].slice(0, 80);
            break;
          }
        }
      }
    }
    if (title === 'Untitled' && session.meta) {
      const firstPrompt = (session.meta as Record<string, unknown>).first_prompt;
      if (typeof firstPrompt === 'string') {
        const visibleFirstPrompt = stripInjectedContextBlocks(firstPrompt);
        if (visibleFirstPrompt) title = visibleFirstPrompt.split('\n')[0].slice(0, 80);
      }
    }
    if (title === 'Untitled' && sessionType === 'file_snapshot') {
      const dir = session.projectPath ? path.basename(session.projectPath) : 'unknown';
      title = `File snapshots - ${dir}`;
    }
    if (title === 'Untitled' && sessionType === 'empty') {
      title = 'Empty session';
    }

    const timestamps = messages.filter(m => m.timestamp > 0).map(m => m.timestamp);
    const startTime = timestamps.length > 0 ? Math.min(...timestamps) : session.startTime;
    const endTime = timestamps.length > 0 ? Math.max(...timestamps) : session.endTime;

    const modelsSet = session.tokenUsage.models;
    const modelsArr = [...modelsSet];

    // Supplement token stats from session-meta if JSONL totals are 0
    let totalInputTokens = session.tokenUsage.totalInputTokens;
    let totalOutputTokens = session.tokenUsage.totalOutputTokens;
    if (session.meta) {
      const meta = session.meta as Record<string, unknown>;
      if (totalInputTokens === 0 && typeof meta.input_tokens === 'number') {
        totalInputTokens = meta.input_tokens;
      }
      if (totalOutputTokens === 0 && typeof meta.output_tokens === 'number') {
        totalOutputTokens = meta.output_tokens;
      }
    }

    // Build context compactions from parsed session
    const contextCompactions: ContextCompaction[] = (session.contextCompactions || []).map(c => ({
      id: `${sessionId}:compaction:${c.sequence}`,
      sessionId,
      sequence: c.sequence,
      compactedAt: c.compactedAt,
      summary: c.summary,
    }));

    // Prefer adapter-provided invocation/delta events. Claude Code and Cursor
    // already attach usage to individual assistant messages, so derive the
    // same normalized rows for adapters that do not need an explicit stream.
    const parsedUsageEvents = session.tokenUsageEvents ?? [];
    const tokenUsageEvents: TokenUsageEvent[] = parsedUsageEvents.length > 0
      ? parsedUsageEvents
          .filter(event => event.timestamp > 0 && (
            event.inputTokens > 0 || event.outputTokens > 0 ||
            event.cacheCreationTokens > 0 || event.cacheReadTokens > 0 ||
            (event.reasoningTokens ?? 0) > 0
          ))
          .map(event => ({
            id: `${sessionId}:token:${event.id}`,
            sessionId,
            dedupeKey: event.dedupeKey ?? `${sessionId}:token:${event.id}`,
            sourceScope: session.sourceFileKey ?? event.sourceScope ?? '',
            timestamp: event.timestamp,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            cacheCreationTokens: event.cacheCreationTokens,
            cacheReadTokens: event.cacheReadTokens,
            reasoningTokens: event.reasoningTokens ?? 0,
            model: event.model,
            source: event.source,
          }))
      : messages
          .filter(message => message.timestamp > 0 && (
            (message.tokenInput ?? 0) > 0 || (message.tokenOutput ?? 0) > 0 ||
            (message.tokenCacheCreation ?? 0) > 0 || (message.tokenCacheRead ?? 0) > 0 ||
            (message.tokenReasoning ?? 0) > 0
          ))
          .map(message => ({
            id: `${sessionId}:token:message:${message.id}`,
            sessionId,
            dedupeKey: `${sessionId}:token:message:${message.id}`,
            sourceScope: session.sourceFileKey ?? '',
            timestamp: message.timestamp,
            inputTokens: message.tokenInput ?? 0,
            outputTokens: message.tokenOutput ?? 0,
            cacheCreationTokens: message.tokenCacheCreation ?? 0,
            cacheReadTokens: message.tokenCacheRead ?? 0,
            reasoningTokens: message.tokenReasoning ?? 0,
            model: message.model,
            source: 'message_usage',
          }));

    // Build agent meta with peakContextUsage
    let agentMeta: string | undefined;
    if (session.meta || session.peakContextUsage || session.warnings?.length) {
      const metaObj: Record<string, unknown> = session.meta ? { ...session.meta } : {};
      if (session.peakContextUsage) {
        metaObj.peakContextUsage = session.peakContextUsage;
      }
      if (session.warnings?.length) {
        metaObj.parse_warnings = session.warnings;
      }
      agentMeta = JSON.stringify(metaObj);
    }

    // Determine archived status
    const isArchived = session.meta?.archived === true;

    // Fork lineage: adapters put the parent session id (or a fully-qualified
    // work_sessions.id) in meta.forked_from; qualify bare ids with the
    // platform prefix so the column always stores a work_sessions.id.
    let forkedFrom: string | null = null;
    const rawForkedFrom = session.meta?.forked_from;
    if (typeof rawForkedFrom === 'string' && rawForkedFrom.trim()) {
      const value = rawForkedFrom.trim();
      forkedFrom = value.includes(':') ? value : `${session.platform}:${value}`;
      if (forkedFrom === sessionId) forkedFrom = null; // self-loop guard
    }

    const ws: WorkSession = {
      id: sessionId,
      sessionId: session.sessionId,
      platform: session.platform,
      host: session.host ?? 'native',
      platformVersion: session.claudeCodeVersion,
      projectPath: session.projectPath,
      gitBranch: session.gitBranch,
      model: session.model,
      models: modelsArr.length > 0 ? JSON.stringify(modelsArr) : undefined,
      title,
      tags: [],
      status: isArchived ? 'archived' : 'active',
      sessionType,
      startedAt: startTime,
      endedAt: endTime,
      lastActivityAt: endTime || startTime,
      durationMs: (endTime || startTime) - startTime,
      messageCount: messages.length,
      userInputCount: userInputMessages.length,
      assistantMessageCount: assistantMessages.length,
      thinkingCount: thinkingMessages.length,
      toolCallCount,
      codeBlockCount,
      turnCount: turns.length,
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreationTokens: session.tokenUsage.totalCacheCreationTokens,
      totalCacheReadTokens: session.tokenUsage.totalCacheReadTokens,
      hasSubagents: session.subagents.length > 0,
      hasContextCompaction: contextCompactions.length > 0,
      agentMeta,
      claudeCodeVersion: session.claudeCodeVersion,
      forkedFrom,
      createdAt: now,
      updatedAt: now,
    };

    return {
      session: ws,
      turns,
      messages,
      toolExecutions,
      systemEvents,
      subagentLinks,
      contextCompactions,
      tokenUsageEvents,
    };
  }

  /**
   * Build turns and classify messages
   */
  private static buildTurnsAndMessages(
    session: ParsedSession,
    sessionId: string,
    now: number,
  ): { turns: Turn[]; messages: SessionMessage[]; systemEvents: SystemEvent[] } {
    const turns: Turn[] = [];
    const messages: SessionMessage[] = [];
    const systemEvents: SystemEvent[] = [];

    let currentTurn: Turn | null = null;
    let currentSourceTurnId: string | undefined;
    const strictNativeTurns = session.meta?.capture_strict_native_turns === true;
    const nativeTurnBySourceId = new Map<string, Turn>();
    const assignedTurn = (message: ParsedMessage): Turn | undefined => {
      if (!strictNativeTurns) return currentTurn ?? undefined;
      return message.sourceTurnId
        ? nativeTurnBySourceId.get(message.sourceTurnId)
        : undefined;
    };
    let turnSequence = 0;
    let msgSequence = 0;

    for (const m of session.messages) {
      const source = MessageConverter.classifySource(m);

      const startTurn = (): Turn => {
        turnSequence++;
        return {
          id: `${sessionId}:turn:${turnSequence}`,
          sessionId,
          sequence: turnSequence,
          messageCount: 0,
          toolExecutionCount: 0,
          thinkingTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          startedAt: m.timestamp,
          durationMs: 0,
        };
      };

      // System events go to separate table
      if (source === 'system_event') {
        // Use systemSubtype for finer-grained event types
        let eventType = m.systemSubtype || m.type;
        if (m.isCompactSummary) eventType = 'compact_summary';
        if (m.isApiError && m.role === 'assistant') eventType = 'api_error_response';

        systemEvents.push({
          id: `${sessionId}:evt:${m.uuid}`,
          sessionId,
          turnId: assignedTurn(m)?.id,
          eventType,
          message: m.contentText,
          metadata: m.errorDetails || undefined,
          timestamp: m.timestamp,
        });
        continue;
      }

      // File snapshots stored as messages but don't start turns
      if (source === 'file_snapshot') {
        messages.push(MessageConverter.toSessionMessage(m, sessionId, assignedTurn(m)?.id, source, msgSequence++, now));
        continue;
      }

      // Progress messages attach to current turn
      if (source === 'progress') {
        messages.push(MessageConverter.toSessionMessage(m, sessionId, assignedTurn(m)?.id, source, msgSequence++, now));
        continue;
      }

      // New turn starts on real user input
      if (source === 'user_input') {
        if (!m.sourceTurnId) {
          if (currentTurn) {
            MessageConverter.closeTurn(currentTurn, messages);
            turns.push(currentTurn);
          }
          currentTurn = startTurn();
          currentSourceTurnId = undefined;
        } else if (!currentTurn || currentSourceTurnId !== m.sourceTurnId) {
          if (currentTurn) {
            MessageConverter.closeTurn(currentTurn, messages);
            if (!turns.includes(currentTurn)) turns.push(currentTurn);
          }
          currentTurn = nativeTurnBySourceId.get(m.sourceTurnId) ?? startTurn();
          currentSourceTurnId = m.sourceTurnId;
          nativeTurnBySourceId.set(m.sourceTurnId, currentTurn);
        }
        // The first real user message is the task prompt. Later user messages
        // sharing the native id remain members of this turn as follow-ups.
        // Native ids seen only on assistant/tool events represent continuations
        // or child-agent runs, not new user tasks, so they stay in the active
        // task (or remain unassigned in an assistant-only rollout).
        if (currentTurn && !currentTurn.userInputMessageId) {
          currentTurn.userInput = m.contentText?.slice(0, 500);
          currentTurn.userInputMessageId = m.uuid;
        }
      }

      // Create the message
      const messageTurn = source === 'user_input' ? currentTurn : assignedTurn(m);
      const sm = MessageConverter.toSessionMessage(m, sessionId, messageTurn?.id, source, msgSequence++, now);
      messages.push(sm);

      // Update turn stats
      if (messageTurn) {
        messageTurn.messageCount++;
        if (sm.tokenInput) messageTurn.inputTokens += sm.tokenInput;
        if (sm.tokenOutput) messageTurn.outputTokens += sm.tokenOutput;

        // Track last assistant text as the response
        if (source === 'assistant_text' && sm.contentText) {
          messageTurn.assistantResponse = sm.contentText.slice(0, 500);
          messageTurn.assistantResponseMessageId = sm.id;
        }
        if (source === 'tool_request') {
          messageTurn.toolExecutionCount += (m.toolCalls?.length || 0);
        }
      }
    }

    // Close final turn
    if (currentTurn) {
      MessageConverter.closeTurn(currentTurn, messages);
      if (!turns.includes(currentTurn)) turns.push(currentTurn);
    }
    for (const turn of turns) MessageConverter.closeTurn(turn, messages);

    return { turns, messages, systemEvents };
  }

  private static closeTurn(turn: Turn, messages: SessionMessage[]): void {
    const turnMsgs = messages.filter(m => m.turnId === turn.id);
    if (turnMsgs.length > 0) {
      const lastTs = Math.max(...turnMsgs.map(m => m.timestamp));
      turn.endedAt = lastTs;
      turn.durationMs = lastTs - turn.startedAt;
      const response = turnMsgs.filter(message =>
        (message.source === 'assistant_text' || message.source === 'assistant_commentary')
        && message.contentText,
      ).at(-1);
      const explicitResponse = turnMsgs.filter(message =>
        message.source === 'assistant_text' && message.contentText,
      ).at(-1);
      const selectedResponse = explicitResponse ?? response;
      if (selectedResponse?.contentText) {
        turn.assistantResponse = selectedResponse.contentText.slice(0, 500);
        turn.assistantResponseMessageId = selectedResponse.id;
      }
    }
  }

  /**
   * Classify a ParsedMessage into a MessageSource
   */
  private static classifySource(m: ParsedMessage): MessageSource {
    // System types
    if (m.type === 'system' || m.type === 'queue-operation') return 'system_event';
    if (m.type === 'file-history-snapshot') return 'file_snapshot';
    if (m.type === 'progress') return 'progress';

    // User messages
    if (m.role === 'user') {
      // Compact summaries are system events, not user input
      if (m.isCompactSummary) return 'system_event';
      if (m.isToolResult) return 'tool_result';
      return 'user_input';
    }

    // Assistant messages
    if (m.role === 'assistant') {
      // API error responses are system events
      if (m.isApiError) return 'system_event';
      if (m.toolCalls && m.toolCalls.length > 0) return 'tool_request';
      if (m.contentThinking && !m.contentText) return 'assistant_think';
      if (m.assistantPhase === 'commentary') return 'assistant_commentary';
      return 'assistant_text';
    }

    return 'system_event';
  }

  /**
   * Convert ParsedMessage to SessionMessage
   */
  private static toSessionMessage(
    m: ParsedMessage,
    sessionId: string,
    turnId: string | undefined,
    source: MessageSource,
    sequence: number,
    now: number,
  ): SessionMessage {
    // Extract tool info for display
    let toolName: string | undefined;
    let toolInput: string | undefined;
    let toolOutput: string | undefined;
    let toolError: string | undefined;

    if (m.toolCalls && m.toolCalls.length > 0) {
      toolName = m.toolCalls.map(tc => tc.name).join(', ');
      toolInput = JSON.stringify(m.toolCalls.length === 1 ? m.toolCalls[0].input : m.toolCalls.map(tc => ({ name: tc.name, input: tc.input })));
    }
    if (m.toolResults && m.toolResults.length > 0) {
      toolOutput = m.toolResults.map(tr => tr.content).join('\n---\n');
      const errors = m.toolResults.filter(tr => tr.isError);
      if (errors.length > 0) toolError = errors.map(e => e.content).join('\n');
    }

    return {
      id: m.uuid,
      sessionId,
      turnId,
      source,
      sequence,
      role: m.role as 'user' | 'assistant' | 'system',
      contentText: m.contentText,
      contentThinking: m.contentThinking,
      contentToolName: toolName,
      contentToolInput: toolInput,
      contentToolOutput: toolOutput,
      contentToolError: toolError,
      cwd: m.cwd,
      gitBranch: m.gitBranch,
      tokenInput: m.usage?.inputTokens,
      tokenOutput: m.usage?.outputTokens,
      tokenCacheCreation: m.usage?.cacheCreationTokens,
      tokenCacheRead: m.usage?.cacheReadTokens,
      model: m.usage?.model,
      stopReason: m.stopReason,
      parentId: m.parentUuid,
      depth: m.depth,
      isSidechain: m.isSidechain,
      agentId: m.agentId,
      timestamp: m.timestamp || 0,
      createdAt: now,
    };
  }

  /**
   * Build tool executions with turn assignment and category classification
   */
  private static buildToolExecutions(
    session: ParsedSession,
    sessionId: string,
    turns: Turn[],
    messages: SessionMessage[],
  ): UnifiedToolExecution[] {
    // Build a message-to-turn map
    const msgTurnMap = new Map<string, string>();
    for (const m of messages) {
      if (m.turnId) msgTurnMap.set(m.id, m.turnId);
    }

    return session.toolExecutions.map((te, i) => {
      const turnId = msgTurnMap.get(te.toolUseMessageId);
      return {
        id: te.id,
        sessionId,
        turnId,
        sequence: i,
        toolUseMessageId: te.toolUseMessageId,
        toolResultMessageId: te.toolResultMessageId,
        toolUseId: te.toolUseId,
        toolName: te.toolName,
        toolCategory: classifyTool(te.toolName),
        outcome: te.isError ? 'error' as const : (te.toolResultMessageId ? 'success' as const : 'pending' as const),
        inputSummary: te.inputSummary,
        outputSummary: te.outputSummary,
        displayData: te.displayData ? JSON.stringify(te.displayData) : undefined,
        isError: te.isError,
        durationMs: te.durationMs,
        timestamp: te.timestamp,
      };
    });
  }

  /**
   * v1 compat: Convert using old interface
   */
  static convert(session: ParsedSession): {
    conversation: VestiConversation;
    messages: VestiMessage[];
    toolExecutions: ToolExecution[];
  } {
    const result = MessageConverter.convertV2(session);

    // Convert WorkSession → VestiConversation
    const ws = result.session;
    const conversation: VestiConversation = {
      id: ws.id,
      sessionId: ws.sessionId,
      platform: ws.platform,
      platformVersion: ws.platformVersion,
      projectPath: ws.projectPath,
      gitBranch: ws.gitBranch,
      model: ws.model,
      title: ws.title,
      tags: ws.tags,
      status: ws.status,
      startedAt: ws.startedAt,
      endedAt: ws.endedAt,
      lastActivityAt: ws.lastActivityAt,
      durationMs: ws.durationMs,
      messageCount: ws.messageCount,
      userMessageCount: ws.userInputCount,
      assistantMessageCount: ws.assistantMessageCount,
      thinkingCount: ws.thinkingCount,
      toolCallCount: ws.toolCallCount,
      codeBlockCount: ws.codeBlockCount,
      totalInputTokens: ws.totalInputTokens,
      totalOutputTokens: ws.totalOutputTokens,
      totalCacheCreationTokens: ws.totalCacheCreationTokens,
      totalCacheReadTokens: ws.totalCacheReadTokens,
      hasSubagents: ws.hasSubagents,
      claudeCodeVersion: ws.claudeCodeVersion,
      createdAt: ws.createdAt,
      updatedAt: ws.updatedAt,
    };

    // Convert SessionMessage[] → VestiMessage[]
    const messages: VestiMessage[] = result.messages
      .filter(m => m.source !== 'progress' && m.source !== 'system_event' && m.source !== 'file_snapshot')
      .map(m => ({
        id: m.id,
        conversationId: m.sessionId,
        parentId: m.parentId,
        depth: m.depth,
        role: m.role,
        type: m.source === 'tool_result' ? 'tool_result' as const
          : m.source === 'tool_request' ? 'tool_use' as const
          : m.source === 'assistant_think' ? 'thinking' as const
          : 'message' as const,
        contentText: m.contentText,
        contentThinking: m.contentThinking,
        contentToolName: m.contentToolName,
        contentToolInput: m.contentToolInput,
        contentToolOutput: m.contentToolOutput,
        contentToolError: m.contentToolError,
        cwd: m.cwd,
        gitBranch: m.gitBranch,
        tokenInput: m.tokenInput,
        tokenOutput: m.tokenOutput,
        tokenCacheCreation: m.tokenCacheCreation,
        tokenCacheRead: m.tokenCacheRead,
        model: m.model,
        stopReason: m.stopReason,
        isSidechain: m.isSidechain,
        agentId: m.agentId,
        timestamp: m.timestamp,
        createdAt: m.createdAt,
      }));

    // Convert UnifiedToolExecution[] → ToolExecution[]
    const toolExecutions: ToolExecution[] = result.toolExecutions.map(te => ({
      id: te.id,
      conversationId: te.sessionId,
      toolUseMessageId: te.toolUseMessageId,
      toolResultMessageId: te.toolResultMessageId,
      toolUseId: te.toolUseId,
      toolName: te.toolName,
      inputSummary: te.inputSummary,
      outputSummary: te.outputSummary,
      isError: te.isError,
      durationMs: te.durationMs,
      timestamp: te.timestamp,
    }));

    return { conversation, messages, toolExecutions };
  }

  private static countCodeBlocks(messages: ParsedMessage[]): number {
    let count = 0;
    const codeBlockRegex = /```[\s\S]*?```/g;
    for (const m of messages) {
      if (m.contentText) {
        const matches = m.contentText.match(codeBlockRegex);
        if (matches) count += matches.length;
      }
    }
    return count;
  }
}
