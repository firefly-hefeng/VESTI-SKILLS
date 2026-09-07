/**
 * MessageConverter Tests
 * Tests MessageSource classification and Turn detection
 */

import { describe, it, expect } from 'vitest';
import { MessageConverter } from '../src/storage/MessageConverter.js';
import { mergeCodexLogicalSession } from '../src/sync/SyncEngine.js';
import type { ParsedSession, ParsedMessage } from '../src/types/agent.js';

describe('MessageConverter', () => {
  describe('MessageSource Classification', () => {
    it('uses a native source turn id and keeps later user input as a follow-up', () => {
      const session: ParsedSession = {
        sessionId: 'native-turn-session',
        platform: 'codex',
        projectPath: '/test',
        messages: [
          {
            uuid: 'user-primary',
            type: 'user',
            role: 'user',
            timestamp: 1_000,
            contentText: '修复白屏',
            sourceTurnId: 'task-1',
            isToolResult: false,
            depth: 0,
          },
          {
            uuid: 'assistant-progress',
            type: 'assistant',
            role: 'assistant',
            timestamp: 1_100,
            contentText: '正在定位',
            sourceTurnId: 'task-1',
            assistantPhase: 'commentary',
            isToolResult: false,
            depth: 0,
          },
          {
            uuid: 'user-followup',
            type: 'user',
            role: 'user',
            timestamp: 1_200,
            contentText: '并且告诉我怎么构建',
            sourceTurnId: 'task-1',
            isToolResult: false,
            depth: 0,
          },
          {
            uuid: 'assistant-final',
            type: 'assistant',
            role: 'assistant',
            timestamp: 1_300,
            contentText: '已经修复',
            sourceTurnId: 'task-1',
            assistantPhase: 'final_answer',
            isToolResult: false,
            depth: 0,
          },
          {
            uuid: 'user-next',
            type: 'user',
            role: 'user',
            timestamp: 2_000,
            contentText: '下一个任务',
            sourceTurnId: 'task-2',
            isToolResult: false,
            depth: 0,
          },
        ],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 1_000,
      };

      const result = MessageConverter.convertV2(session);

      expect(result.turns).toHaveLength(2);
      expect(result.turns[0]).toMatchObject({
        userInput: '修复白屏',
        userInputMessageId: 'user-primary',
        assistantResponse: '已经修复',
        assistantResponseMessageId: 'assistant-final',
      });
      expect(result.messages.slice(0, 4).map(message => message.turnId)).toEqual([
        result.turns[0].id,
        result.turns[0].id,
        result.turns[0].id,
        result.turns[0].id,
      ]);
      expect(result.messages[1].source).toBe('assistant_commentary');
      expect(result.session.turnCount).toBe(2);
    });

    it('does not create a task turn for an assistant-only native child run', () => {
      const session: ParsedSession = {
        sessionId: 'assistant-only-child',
        platform: 'codex',
        projectPath: '/test',
        messages: [
          {
            uuid: 'child-progress',
            type: 'assistant',
            role: 'assistant',
            timestamp: 1_000,
            contentText: '正在审查',
            sourceTurnId: 'child-task',
            assistantPhase: 'commentary',
            isToolResult: false,
            depth: 0,
          },
          {
            uuid: 'child-final',
            type: 'assistant',
            role: 'assistant',
            timestamp: 1_100,
            contentText: '审查完成',
            sourceTurnId: 'child-task',
            assistantPhase: 'final_answer',
            isToolResult: false,
            depth: 0,
          },
        ],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 1_000,
      };

      const result = MessageConverter.convertV2(session);

      expect(result.turns).toHaveLength(0);
      expect(result.session.turnCount).toBe(0);
      expect(result.messages.map(message => message.turnId)).toEqual([undefined, undefined]);
    });

    it('keeps assistant-only native child runs inside the active user task', () => {
      const base = (overrides: Partial<ParsedMessage>): ParsedMessage => ({
        uuid: 'message',
        type: 'assistant',
        role: 'assistant',
        timestamp: 1_000,
        isToolResult: false,
        depth: 0,
        ...overrides,
      });
      const session: ParsedSession = {
        sessionId: 'embedded-child',
        platform: 'codex',
        projectPath: '/test',
        messages: [
          base({ uuid: 'user-1', type: 'user', role: 'user', contentText: '主任务', sourceTurnId: 'task-1' }),
          base({ uuid: 'child-progress', contentText: '子代理检查', sourceTurnId: 'task-1', assistantPhase: 'commentary', timestamp: 1_100 }),
          base({ uuid: 'child-final', contentText: '子代理结论', sourceTurnId: 'task-1', assistantPhase: 'final_answer', timestamp: 1_200 }),
          base({ uuid: 'root-final', contentText: '主任务结论', sourceTurnId: 'task-1', assistantPhase: 'final_answer', timestamp: 1_300 }),
          base({ uuid: 'user-2', type: 'user', role: 'user', contentText: '下一任务', sourceTurnId: 'task-2', timestamp: 2_000 }),
        ],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 1_000,
        meta: { capture_strict_native_turns: true },
      };

      const result = MessageConverter.convertV2(session);

      expect(result.turns).toHaveLength(2);
      expect(result.messages.slice(0, 4).map(message => message.turnId))
        .toEqual(Array(4).fill(result.turns[0].id));
      expect(result.turns[0].assistantResponse).toBe('主任务结论');
    });

    it('leaves a delayed unmatched native child fragment outside the next task', () => {
      const session: ParsedSession = {
        sessionId: 'strict-native-orphan',
        platform: 'codex',
        projectPath: '/test',
        messages: [
          {
            uuid: 'user-1', type: 'user', role: 'user', timestamp: 1_000,
            contentText: '第一个任务', sourceTurnId: 'task-1', isToolResult: false, depth: 0,
          },
          {
            uuid: 'answer-1', type: 'assistant', role: 'assistant', timestamp: 1_100,
            contentText: '第一个答案', sourceTurnId: 'task-1', isToolResult: false, depth: 0,
          },
          {
            uuid: 'user-2', type: 'user', role: 'user', timestamp: 2_000,
            contentText: '第二个任务', sourceTurnId: 'task-2', isToolResult: false, depth: 0,
          },
          {
            uuid: 'orphan', type: 'assistant', role: 'assistant', timestamp: 2_100,
            contentText: '迟到的子代理结果', sourceTurnId: 'unmapped-child', isToolResult: false, depth: 0,
          },
        ],
        toolExecutions: [], subagents: [],
        tokenUsage: {
          totalInputTokens: 0, totalOutputTokens: 0,
          totalCacheCreationTokens: 0, totalCacheReadTokens: 0, models: new Set(),
        },
        startTime: 1_000,
        meta: { capture_strict_native_turns: true },
      };

      const result = MessageConverter.convertV2(session);

      expect(result.messages.find(message => message.id === 'orphan')?.turnId).toBeUndefined();
      expect(result.turns[1].assistantResponse).toBeUndefined();
    });

    it('maps each reused Codex child run to its explicit parent even when its result arrives late', () => {
      const tokenUsage = () => ({
        totalInputTokens: 0, totalOutputTokens: 0,
        totalCacheCreationTokens: 0, totalCacheReadTokens: 0, models: new Set<string>(),
      });
      const root: ParsedSession = {
        sessionId: 'logical', platform: 'codex', projectPath: '/test',
        messages: [
          { uuid: 'u1', type: 'user', role: 'user', timestamp: 1_000, contentText: '任务一', sourceTurnId: 'parent-1', isToolResult: false, depth: 0 },
          { uuid: 'u2', type: 'user', role: 'user', timestamp: 2_000, contentText: '任务二', sourceTurnId: 'parent-2', isToolResult: false, depth: 0 },
        ],
        toolExecutions: [], subagents: [], tokenUsage: tokenUsage(), startTime: 1_000,
        meta: {
          capture_strict_native_turns: true,
          codex_child_activities: [
            { childThreadId: 'child', parentSourceTurnId: 'parent-1', timestamp: 1_100, callId: 'spawn' },
            { childThreadId: 'child', parentSourceTurnId: 'parent-2', timestamp: 2_100, callId: 'followup' },
          ],
        },
      };
      const child: ParsedSession = {
        sessionId: 'logical', platform: 'codex', projectPath: '/test',
        messages: [
          { uuid: 'child-1', type: 'assistant', role: 'assistant', timestamp: 2_200, contentText: '任务一的迟到结果', sourceTurnId: 'child-run-1', assistantPhase: 'final_answer', isToolResult: false, depth: 0 },
          { uuid: 'child-2', type: 'assistant', role: 'assistant', timestamp: 2_300, contentText: '任务二的结果', sourceTurnId: 'child-run-2', assistantPhase: 'final_answer', isToolResult: false, depth: 0 },
        ],
        toolExecutions: [], subagents: [], tokenUsage: tokenUsage(), startTime: 2_100,
        meta: {
          capture_append_only: true,
          capture_strict_native_turns: true,
          codex_rollout_id: 'child',
          codex_child_task_runs: [
            { sourceTurnId: 'child-run-1', timestamp: 1_150 },
            { sourceTurnId: 'child-run-2', timestamp: 2_150 },
          ],
        },
      };

      const merged = mergeCodexLogicalSession([child, root]);
      expect(merged).toBeDefined();
      const result = MessageConverter.convertV2(merged!);

      expect(result.turns).toHaveLength(2);
      expect(result.messages.find(message => message.id === 'child-1')?.turnId).toBe(result.turns[0].id);
      expect(result.messages.find(message => message.id === 'child-2')?.turnId).toBe(result.turns[1].id);
      expect(result.turns.map(turn => turn.assistantResponse)).toEqual(['任务一的迟到结果', '任务二的结果']);
    });

    it('recursively maps a reused grandchild rollout through its child task runs', () => {
      const tokenUsage = () => ({
        totalInputTokens: 0, totalOutputTokens: 0,
        totalCacheCreationTokens: 0, totalCacheReadTokens: 0, models: new Set<string>(),
      });
      const root: ParsedSession = {
        sessionId: 'logical', platform: 'codex', projectPath: '/test',
        messages: [
          { uuid: 'u1', type: 'user', role: 'user', timestamp: 1_000, contentText: '任务一', sourceTurnId: 'parent-1', isToolResult: false, depth: 0 },
          { uuid: 'u2', type: 'user', role: 'user', timestamp: 2_000, contentText: '任务二', sourceTurnId: 'parent-2', isToolResult: false, depth: 0 },
        ],
        toolExecutions: [], subagents: [], tokenUsage: tokenUsage(), startTime: 1_000,
        meta: {
          capture_strict_native_turns: true,
          codex_child_activities: [
            { childThreadId: 'child-a', parentSourceTurnId: 'parent-1', timestamp: 1_050, callId: 'spawn-a' },
            { childThreadId: 'child-a', parentSourceTurnId: 'parent-2', timestamp: 2_050, callId: 'follow-a' },
          ],
        },
      };
      const child: ParsedSession = {
        sessionId: 'logical', platform: 'codex', projectPath: '/test', messages: [],
        toolExecutions: [], subagents: [], tokenUsage: tokenUsage(), startTime: 1_100,
        meta: {
          capture_append_only: true,
          capture_strict_native_turns: true,
          codex_rollout_id: 'child-a',
          codex_child_task_runs: [
            { sourceTurnId: 'child-run-1', timestamp: 1_100 },
            { sourceTurnId: 'child-run-2', timestamp: 2_100 },
          ],
          codex_child_activities: [
            { childThreadId: 'grandchild-b', parentSourceTurnId: 'child-run-1', timestamp: 1_200, callId: 'spawn-b' },
            { childThreadId: 'grandchild-b', parentSourceTurnId: 'child-run-2', timestamp: 2_200, callId: 'follow-b' },
          ],
        },
      };
      const grandchild: ParsedSession = {
        sessionId: 'logical', platform: 'codex', projectPath: '/test',
        messages: [
          { uuid: 'grandchild-1', type: 'assistant', role: 'assistant', timestamp: 1_300, contentText: '孙代理任务一', sourceTurnId: 'grandchild-run-1', assistantPhase: 'final_answer', isToolResult: false, depth: 0 },
          { uuid: 'grandchild-2', type: 'assistant', role: 'assistant', timestamp: 2_300, contentText: '孙代理任务二', sourceTurnId: 'grandchild-run-2', assistantPhase: 'final_answer', isToolResult: false, depth: 0 },
        ],
        toolExecutions: [], subagents: [], tokenUsage: tokenUsage(), startTime: 1_250,
        meta: {
          capture_append_only: true,
          capture_strict_native_turns: true,
          codex_rollout_id: 'grandchild-b',
          codex_child_task_runs: [
            { sourceTurnId: 'grandchild-run-1', timestamp: 1_250 },
            { sourceTurnId: 'grandchild-run-2', timestamp: 2_250 },
          ],
        },
      };

      const merged = mergeCodexLogicalSession([grandchild, child, root]);
      expect(merged).toBeDefined();
      const result = MessageConverter.convertV2(merged!);

      expect(result.turns).toHaveLength(2);
      expect(result.messages.find(message => message.id === 'grandchild-1')?.turnId).toBe(result.turns[0].id);
      expect(result.messages.find(message => message.id === 'grandchild-2')?.turnId).toBe(result.turns[1].id);
      expect(result.turns.map(turn => turn.assistantResponse)).toEqual(['孙代理任务一', '孙代理任务二']);
    });

    it('drops shared system envelopes before creating messages, turns and counts', () => {
      const session: ParsedSession = {
        sessionId: 'sanitized-session',
        platform: 'claude-code',
        projectPath: '/test',
        messages: [
          {
            uuid: 'system-only',
            type: 'user',
            role: 'user',
            timestamp: 900,
            contentText: '<environment_context>generated</environment_context>',
            isToolResult: false,
            depth: 0,
          },
          {
            uuid: 'real-user',
            type: 'user',
            role: 'user',
            timestamp: 1000,
            contentText: '<user_instructions>generated</user_instructions>\n\n这是一个真实问题',
            isToolResult: false,
            depth: 0,
          },
        ],
        toolExecutions: [],
        subagents: [],
        subagentOf: {
          parentSessionId: 'claude-code:parent',
          agentId: 'child-1',
        },
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 900,
      };

      const result = MessageConverter.convertV2(session);

      expect(result.messages.map(message => message.contentText)).toEqual(['这是一个真实问题']);
      expect(result.turns).toHaveLength(1);
      expect(result.session).toMatchObject({
        title: '这是一个真实问题',
        messageCount: 1,
        userInputCount: 1,
        turnCount: 1,
      });
      expect(result.subagentLinks).toHaveLength(1);
      expect(result.subagentLinks[0].messageCount).toBe(1);
    });

    it('sanitizes the metadata first-prompt fallback before creating a title', () => {
      const session: ParsedSession = {
        sessionId: 'sanitized-metadata-title',
        platform: 'claude-code',
        projectPath: '/test',
        messages: [],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 900,
        meta: {
          first_prompt: '<recommended_plugins>generated</recommended_plugins>\n\n真实标题',
        },
      };

      expect(MessageConverter.convertV2(session).session.title).toBe('真实标题');
    });

    it('should classify real user input', () => {
      const session: ParsedSession = {
        sessionId: 'test-1',
        platform: 'claude-code',
        projectPath: '/test',
        messages: [
          {
            uuid: 'msg-1',
            type: 'user',
            role: 'user',
            timestamp: 1000,
            contentText: 'Hello',
            isToolResult: false,
            depth: 0,
          },
        ],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 1000,
      };

      const result = MessageConverter.convertV2(session);
      expect(result.messages[0].source).toBe('user_input');
    });

    it('should classify tool_result messages', () => {
      const session: ParsedSession = {
        sessionId: 'test-2',
        platform: 'claude-code',
        projectPath: '/test',
        messages: [
          {
            uuid: 'msg-1',
            type: 'user',
            role: 'user',
            timestamp: 1000,
            toolResults: [{ toolUseId: 'tool-1', content: 'output', isError: false }],
            isToolResult: true,
            depth: 0,
          },
        ],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 1000,
      };

      const result = MessageConverter.convertV2(session);
      expect(result.messages[0].source).toBe('tool_result');
    });

    it('should classify assistant text', () => {
      const session: ParsedSession = {
        sessionId: 'test-3',
        platform: 'claude-code',
        projectPath: '/test',
        messages: [
          {
            uuid: 'msg-1',
            type: 'assistant',
            role: 'assistant',
            timestamp: 1000,
            contentText: 'Response',
            isToolResult: false,
            depth: 0,
          },
        ],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 1000,
      };

      const result = MessageConverter.convertV2(session);
      expect(result.messages[0].source).toBe('assistant_text');
    });

    it('should classify tool_request', () => {
      const session: ParsedSession = {
        sessionId: 'test-4',
        platform: 'claude-code',
        projectPath: '/test',
        messages: [
          {
            uuid: 'msg-1',
            type: 'assistant',
            role: 'assistant',
            timestamp: 1000,
            toolCalls: [{ id: 'tool-1', name: 'Bash', input: 'ls' }],
            isToolResult: false,
            depth: 0,
          },
        ],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 1000,
      };

      const result = MessageConverter.convertV2(session);
      expect(result.messages[0].source).toBe('tool_request');
    });
  });

  describe('Token usage events', () => {
    const baseSession = (): ParsedSession => ({
      sessionId: 'token-session',
      platform: 'claude-code',
      projectPath: '/test',
      messages: [{
        uuid: 'assistant-1',
        type: 'assistant',
        role: 'assistant',
        timestamp: Date.UTC(2026, 6, 21, 23, 59),
        contentText: 'Response',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationTokens: 3,
          cacheReadTokens: 40,
          model: 'claude-test',
        },
        isToolResult: false,
        depth: 0,
      }],
      toolExecutions: [],
      subagents: [],
      tokenUsage: {
        totalInputTokens: 100,
        totalOutputTokens: 20,
        totalCacheCreationTokens: 3,
        totalCacheReadTokens: 40,
        models: new Set(['claude-test']),
      },
      startTime: Date.UTC(2026, 6, 21, 23, 59),
    });

    it('derives timestamped events from message-level usage', () => {
      const result = MessageConverter.convertV2(baseSession());

      expect(result.tokenUsageEvents).toHaveLength(1);
      expect(result.tokenUsageEvents[0]).toMatchObject({
        sessionId: 'claude-code:token-session',
        timestamp: Date.UTC(2026, 6, 21, 23, 59),
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 3,
        cacheReadTokens: 40,
        model: 'claude-test',
        source: 'message_usage',
      });
    });

    it('prefers explicit adapter events instead of double-counting message usage', () => {
      const session = baseSession();
      session.tokenUsageEvents = [{
        id: 'reported-1',
        timestamp: Date.UTC(2026, 6, 22, 0, 1),
        inputTokens: 250,
        outputTokens: 30,
        cacheCreationTokens: 0,
        cacheReadTokens: 200,
        reasoningTokens: 9,
        model: 'explicit-model',
        source: 'reported_usage',
      }];

      const result = MessageConverter.convertV2(session);

      expect(result.tokenUsageEvents).toHaveLength(1);
      expect(result.tokenUsageEvents[0]).toMatchObject({
        inputTokens: 250,
        outputTokens: 30,
        reasoningTokens: 9,
        model: 'explicit-model',
        source: 'reported_usage',
      });
    });
  });
});
