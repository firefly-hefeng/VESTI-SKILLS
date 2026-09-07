import { describe, expect, it } from 'vitest';
import {
  projectSessionTurnsToVesti,
  workSessionToVestiConversation,
} from '../src/api/vestiCompat.js';
import type { SessionMessage, WorkSession } from '../src/types/unified.js';

function workSession(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 'codex:compat-1',
    sessionId: 'compat-1',
    platform: 'codex',
    projectPath: 'C:/work/demo',
    title: 'Visible title',
    tags: [],
    status: 'active',
    sessionType: 'conversation',
    startedAt: 1_000,
    lastActivityAt: 2_000,
    durationMs: 1_000,
    messageCount: 1,
    userInputCount: 1,
    assistantMessageCount: 0,
    thinkingCount: 0,
    toolCallCount: 0,
    codeBlockCount: 0,
    turnCount: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    hasSubagents: false,
    hasContextCompaction: false,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

describe('workSessionToVestiConversation', () => {
  it('sanitizes stale CLI titles and snippets at the API boundary', () => {
    const conversation = workSessionToVestiConversation(
      workSession({
        title: '<recommended_plugins>generated</recommended_plugins>',
      }),
      '<environment_context>generated</environment_context>\n\n可见摘要',
    );

    expect(conversation.title).toBe('可见摘要');
    expect(conversation.snippet).toBe('可见摘要');
  });

  it('uses the visible snippet when a legacy title is a truncated system block', () => {
    const conversation = workSessionToVestiConversation(
      workSession({
        title: '<recommended_plugins> Here is a list of plugins that are available but not insta',
      }),
      '还是这个样子啊',
    );

    expect(conversation.title).toBe('还是这个样子啊');
    expect(conversation.snippet).toBe('还是这个样子啊');
  });

  it.each([
    '<git-context branch="main"',
    '<timestamp>2026-08-18',
    '<user_info>generated',
    '<system_notification>generated',
    '<system_reminder>generated',
    '<user_query>truncated wrapper',
  ])('replaces a truncated shared-system title: %s', title => {
    const conversation = workSessionToVestiConversation(
      workSession({ platform: 'claude-code', title }),
      '可见问题',
    );

    expect(conversation.title).toBe('可见问题');
  });
});

describe('projectSessionTurnsToVesti', () => {
  const message = (
    id: string,
    turnId: string,
    source: SessionMessage['source'],
    role: SessionMessage['role'],
    content: string,
    sequence: number,
  ): SessionMessage => ({
    id,
    sessionId: 'codex:compat-1',
    turnId,
    source,
    sequence,
    role,
    ...(source === 'assistant_think' ? { contentThinking: content } : { contentText: content }),
    depth: 0,
    timestamp: 1_000 + sequence,
    createdAt: 2_000,
  });

  it('projects each task into at most one user and one assistant bubble', () => {
    const result = projectSessionTurnsToVesti([
      message('u1', 'turn-1', 'user_input', 'user', '主提示', 0),
      message('p1', 'turn-1', 'assistant_commentary', 'assistant', '进度一', 1),
      message('t1', 'turn-1', 'assistant_think', 'assistant', '思考一', 2),
      message('u2', 'turn-1', 'user_input', 'user', '追加要求', 3),
      message('p2', 'turn-1', 'assistant_commentary', 'assistant', '进度二', 4),
      message('a1', 'turn-1', 'assistant_text', 'assistant', '最终答案', 5),
      message('u3', 'turn-2', 'user_input', 'user', '第二个任务', 6),
      message('a2', 'turn-2', 'assistant_text', 'assistant', '先检查', 7),
      message('a3', 'turn-2', 'assistant_text', 'assistant', '第二个答案', 8),
    ], 42, 'codex');

    expect(result.turnCount).toBe(2);
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]).toMatchObject({
      role: 'user',
      content_text: '主提示',
      _turn_id: 'turn-1',
      _turn_sequence: 1,
      _message_kind: 'turn_prompt',
      _followups: [expect.objectContaining({ content_text: '追加要求' })],
    });
    expect(result.messages[1]).toMatchObject({
      role: 'ai',
      content_text: '最终答案',
      _message_kind: 'turn_response',
      _progress_segments: [
        expect.objectContaining({ content_text: '进度一' }),
        expect.objectContaining({ content_text: '进度二' }),
      ],
      _thinking_segments: [expect.objectContaining({ content_text: '思考一' })],
    });
    expect(result.messages[0]._member_message_ids).toHaveLength(2);
    expect(result.messages[1]._member_message_ids).toHaveLength(4);
    expect(result.messages[3]).toMatchObject({
      content_text: '第二个答案',
      _progress_segments: [expect.objectContaining({ content_text: '先检查' })],
    });
  });

  it('keeps incomplete turns and omits empty sanitized prompts', () => {
    const result = projectSessionTurnsToVesti([
      message('system-user', 'turn-1', 'user_input', 'user', '<environment_context>generated</environment_context>', 0),
      message('u1', 'turn-1', 'user_input', 'user', '真实问题', 1),
      message('t1', 'turn-1', 'assistant_think', 'assistant', '仍在思考', 2),
    ], 42, 'codex');

    expect(result.turnCount).toBe(1);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].content_text).toBe('真实问题');
    expect(result.messages[1]).toMatchObject({
      role: 'ai',
      content_text: '',
      _thinking_segments: [expect.objectContaining({ content_text: '仍在思考' })],
    });
  });

  it('uses legacy user boundaries only when turn ids are absent and clears them on empty system input', () => {
    const legacyPrompt = { ...message('u1', 'legacy', 'user_input', 'user', '旧格式任务', 0), turnId: undefined };
    const legacyAnswer = { ...message('a1', 'legacy', 'assistant_text', 'assistant', '旧格式答案', 1), turnId: undefined };
    const emptySystemInput = {
      ...message('system', 'legacy', 'user_input', 'user', '<environment_context>generated</environment_context>', 2),
      turnId: undefined,
    };
    const strayAssistant = { ...message('stray', 'legacy', 'assistant_text', 'assistant', '不应污染上一轮', 3), turnId: undefined };

    const result = projectSessionTurnsToVesti([
      legacyPrompt,
      legacyAnswer,
      emptySystemInput,
      strayAssistant,
    ], 42, 'codex');

    expect(result.turnCount).toBe(1);
    expect(result.messages.map(item => item.content_text)).toEqual(['旧格式任务', '旧格式答案']);
  });

  it('folds explicitly parent-mapped child runs into their task and ignores unmatched orphans', () => {
    const rootPrompt = { ...message('u1', 'turn-1', 'user_input', 'user', '主任务', 100), timestamp: 1_000 };
    const rootProgress = { ...message('p1', 'turn-1', 'assistant_commentary', 'assistant', '主任务进度', 101), timestamp: 1_100 };
    const childProgress = { ...message('cp1', 'turn-1', 'assistant_commentary', 'assistant', '子代理检查', 0), timestamp: 1_200 };
    const childFinal = { ...message('ca1', 'turn-1', 'assistant_text', 'assistant', '子代理结论', 1), timestamp: 1_300 };
    const rootFinal = { ...message('a1', 'turn-1', 'assistant_text', 'assistant', '主任务结论', 102), timestamp: 1_400 };
    const nextPrompt = { ...message('u2', 'turn-2', 'user_input', 'user', '下一任务', 103), timestamp: 2_000 };
    const delayedOrphan = { ...message('orphan', 'unmapped-child-turn', 'assistant_text', 'assistant', '不应误归到下一任务', 104), timestamp: 2_100 };

    const result = projectSessionTurnsToVesti([
      rootPrompt,
      rootProgress,
      childProgress,
      childFinal,
      rootFinal,
      nextPrompt,
      delayedOrphan,
    ], 42, 'codex');

    expect(result.turnCount).toBe(2);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]).toMatchObject({
      role: 'ai',
      content_text: '主任务结论',
      _progress_segments: [
        expect.objectContaining({ content_text: '主任务进度' }),
        expect.objectContaining({ content_text: '子代理检查' }),
        expect.objectContaining({ content_text: '子代理结论' }),
      ],
    });
    expect(result.messages.some(item => item.content_text === '不应误归到下一任务')).toBe(false);
    expect(result.messages.some(item => item._turn_id === 'unmapped-child-turn')).toBe(false);
  });
});
