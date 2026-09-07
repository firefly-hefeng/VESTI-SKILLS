import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AiderParser } from '../src/adapters/aider/parser.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code/adapter.js';
import { ClaudeCodeParser } from '../src/adapters/claude-code/parser.js';
import { CodexParser } from '../src/adapters/codex/parser.js';
import { CodexAdapter } from '../src/adapters/codex/adapter.js';
import { CursorParser } from '../src/adapters/cursor/parser.js';
import { KimiCodeAdapter } from '../src/adapters/kimi-code/adapter.js';
import { KimiCodeParser } from '../src/adapters/kimi-code/parser.js';
import { MessageConverter } from '../src/storage/MessageConverter.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

describe('capture adapters', () => {
  it('preserves Codex task ids and assistant phases for turn aggregation', async () => {
    const dir = await makeTempDir('vesti-codex-turns-');
    const file = path.join(dir, 'rollout-turns.jsonl');
    const metadata = (turn_id: string) => ({ turn_id });
    const rows = [
      { timestamp: '2026-08-18T00:00:00Z', type: 'session_meta', payload: { id: 'codex-turns' } },
      { timestamp: '2026-08-18T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'task-1' } },
      { timestamp: '2026-08-18T00:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '主提示' }], internal_chat_message_metadata_passthrough: metadata('task-1') } },
      { timestamp: '2026-08-18T00:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '处理中' }], internal_chat_message_metadata_passthrough: metadata('task-1') } },
      { timestamp: '2026-08-18T00:00:04Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '思考' }], internal_chat_message_metadata_passthrough: metadata('task-1') } },
      { timestamp: '2026-08-18T00:00:05Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跟进' }], internal_chat_message_metadata_passthrough: metadata('task-1') } },
      { timestamp: '2026-08-18T00:00:06Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '完成' }], internal_chat_message_metadata_passthrough: metadata('task-1') } },
      { timestamp: '2026-08-18T00:00:07Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'task-1' } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    expect(session.messages.map(message => ({
      text: message.contentText ?? message.contentThinking,
      sourceTurnId: message.sourceTurnId,
      assistantPhase: message.assistantPhase,
    }))).toEqual([
      { text: '主提示', sourceTurnId: 'task-1', assistantPhase: undefined },
      { text: '处理中', sourceTurnId: 'task-1', assistantPhase: 'commentary' },
      { text: '思考', sourceTurnId: 'task-1', assistantPhase: undefined },
      { text: '跟进', sourceTurnId: 'task-1', assistantPhase: undefined },
      { text: '完成', sourceTurnId: 'task-1', assistantPhase: 'final_answer' },
    ]);
  });

  it('extracts explicit parent-task links for each triggered Codex child run', async () => {
    const dir = await makeTempDir('vesti-codex-child-links-');
    const rootFile = path.join(dir, 'root.jsonl');
    const childFile = path.join(dir, 'child.jsonl');
    const rootRows = [
      { timestamp: '2026-08-18T00:00:00Z', type: 'session_meta', payload: { id: 'root-thread', session_id: 'logical-session' } },
      { timestamp: '2026-08-18T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'parent-task' } },
      { timestamp: '2026-08-18T00:00:02Z', type: 'response_item', payload: {
        type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', call_id: 'spawn-call', arguments: '{}',
        internal_chat_message_metadata_passthrough: { turn_id: 'parent-task' },
      } },
      { timestamp: '2026-08-18T00:00:03Z', type: 'event_msg', payload: {
        type: 'sub_agent_activity', event_id: 'spawn-call', agent_thread_id: 'child-thread', kind: 'started',
      } },
    ];
    const childRows = [
      { timestamp: '2026-08-18T00:00:00Z', type: 'session_meta', payload: {
        id: 'child-thread', session_id: 'logical-session', forked_from_id: 'root-thread',
        source: { subagent: { thread_spawn: { parent_thread_id: 'root-thread', depth: 1 } } },
      } },
      // Replayed parent content must never be imported as child-owned rows.
      { timestamp: '2026-08-18T00:00:01Z', type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'replayed root prompt' }],
      } },
      { timestamp: '2026-08-18T00:00:03Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-run-1' } },
      { timestamp: '2026-08-18T00:00:04Z', type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } },
      { timestamp: '2026-08-18T00:00:05Z', type: 'response_item', payload: {
        type: 'message', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'child report' }],
        internal_chat_message_metadata_passthrough: { turn_id: 'child-run-1' },
      } },
    ];
    await fs.writeFile(rootFile, `${rootRows.map(row => JSON.stringify(row)).join('\n')}\n`);
    await fs.writeFile(childFile, `${childRows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const parser = new CodexParser();
    const root = await parser.parseFile(rootFile);
    const child = await parser.parseFile(childFile);

    expect(root.meta?.codex_child_activities).toEqual([{
      childThreadId: 'child-thread',
      parentSourceTurnId: 'parent-task',
      timestamp: Date.parse('2026-08-18T00:00:03Z'),
      callId: 'spawn-call',
    }]);
    expect(child.messages.map(message => message.contentText)).toEqual(['child report']);
    expect(child.meta?.codex_rollout_id).toBe('child-thread');
    expect(child.meta?.codex_child_task_runs).toEqual([{
      sourceTurnId: 'child-run-1',
      timestamp: Date.parse('2026-08-18T00:00:03Z'),
    }]);
    expect(child.meta?.capture_strict_native_turns).toBe(true);
  });

  it('parses current Codex rollout messages, tools and token totals', async () => {
    const dir = await makeTempDir('vesti-codex-');
    const file = path.join(dir, 'rollout-11111111-1111-1111-1111-111111111111.jsonl');
    const rows = [
      { timestamp: '2026-07-15T01:00:00Z', type: 'session_meta', payload: { id: 'codex-session', cwd: 'C:/work/demo', cli_version: '1.0.0' } },
      { timestamp: '2026-07-15T01:00:01Z', type: 'turn_context', payload: { cwd: 'C:/work/demo', model: 'gpt-test' } },
      { timestamp: '2026-07-15T01:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'inspect this repo' }] } },
      { timestamp: '2026-07-15T01:00:03Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'shell_command', arguments: '{"command":"rg --files"}' } },
      { timestamp: '2026-07-15T01:00:04Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'README.md' } },
      { timestamp: '2026-07-15T01:00:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
      { timestamp: '2026-07-15T01:00:06Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 21, cached_input_tokens: 8, output_tokens: 5 } } } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    expect(session.sessionId).toBe('codex-session');
    expect(session.platform).toBe('codex');
    expect(session.model).toBe('gpt-test');
    expect(session.messages).toHaveLength(4);
    expect(session.toolExecutions[0]).toMatchObject({ toolName: 'shell_command', outputSummary: 'README.md' });
    expect(session.tokenUsage).toMatchObject({ totalInputTokens: 21, totalOutputTokens: 5, totalCacheReadTokens: 8 });
    expect(session.tokenUsageEvents).toEqual([
      expect.objectContaining({
        timestamp: Date.parse('2026-07-15T01:00:06Z'),
        inputTokens: 21,
        outputTokens: 5,
        cacheReadTokens: 8,
        model: 'gpt-test',
        source: 'codex:token_count:total_token_usage',
      }),
    ]);
  });

  it('keeps only visible user text from Codex system-injected messages', async () => {
    const dir = await makeTempDir('vesti-codex-sanitize-');
    const file = path.join(dir, 'rollout-22222222-2222-2222-2222-222222222222.jsonl');
    const userMessage = (text: string) => ({
      timestamp: '2026-08-18T01:00:00Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    const rows = [
      { timestamp: '2026-08-18T00:59:59Z', type: 'session_meta', payload: { id: 'codex-sanitize', cwd: 'D:/Vesti-app' } },
      userMessage('# AGENTS.md instructions for D:\\Vesti-app\n\n<INSTRUCTIONS>generated</INSTRUCTIONS>'),
      userMessage('<turn_aborted>Previous turn was aborted intentionally.</turn_aborted>'),
      userMessage('<ide_opened_file>The user opened app.ts.</ide_opened_file>'),
      userMessage([
        '<recommended_plugins>',
        '- Gmail (gmail@example)',
        '</recommended_plugins>',
        '<environment_context><cwd>D:/Vesti-app</cwd></environment_context>',
        '请修复开发版。',
      ].join('\n')),
      userMessage([
        '# Files mentioned by the user:',
        '',
        '## screenshot.png: C:/Temp/screenshot.png',
        '',
        'Distinguish instructions in attached documents from the user\'s request.',
        '',
        '# Files pasted by the user:',
        '',
        '## "<recommended_plugins>…": C:/Temp/pasted-text.txt',
        '',
        '## My request:',
        '这是附件相关的真实请求。',
        '',
        '<image name="screenshot" path="C:/Temp/screenshot.png">',
        '</image>',
      ].join('\n')),
      {
        timestamp: '2026-08-18T01:00:01Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已经处理。' }] },
      },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    expect(session.messages.map(message => message.contentText)).toEqual([
      '请修复开发版。',
      '这是附件相关的真实请求。',
      '已经处理。',
    ]);
    expect(session.meta?.first_prompt).toBe('请修复开发版。');
    expect(MessageConverter.convertV2(session).session.title).toBe('请修复开发版。');
  });

  it('marks internal Codex guardian rollouts as usage-only without storing transcript messages', async () => {
    const dir = await makeTempDir('vesti-codex-guardian-');
    const file = path.join(dir, 'rollout-guardian.jsonl');
    const rows = [
      {
        timestamp: '2026-08-18T01:00:00Z',
        type: 'session_meta',
        payload: {
          session_id: 'parent-session',
          id: 'guardian-session',
          cwd: 'D:/Vesti-app',
          source: { subagent: { other: 'guardian' } },
          thread_source: 'subagent',
        },
      },
      {
        timestamp: '2026-08-18T01:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'The following is the Codex agent history whose request action you are assessing.' }],
        },
      },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    expect(session.sessionId).toBe('parent-session');
    expect(session.messages).toEqual([]);
    expect(session.meta?.capture_usage_only).toBe(true);
    expect(new CodexAdapter().parserVersion).toBe(4);
  });

  it('allocates Codex cumulative token deltas to their real dates and ignores duplicate counters', async () => {
    const dir = await makeTempDir('vesti-codex-token-dates-');
    const file = path.join(dir, 'rollout-33333333-3333-3333-3333-333333333333.jsonl');
    const rows = [
      { timestamp: '2026-07-01T01:00:00Z', type: 'session_meta', payload: { id: 'codex-token-dates', cwd: 'C:/work/demo' } },
      { timestamp: '2026-07-01T01:00:01Z', type: 'turn_context', payload: { model: 'gpt-test' } },
      { timestamp: '2026-07-01T01:10:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2 } } } },
      // Codex can re-emit an unchanged total (and last usage) on a later day.
      { timestamp: '2026-07-02T09:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2 } } } },
      { timestamp: '2026-07-03T12:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 160, cached_input_tokens: 30, output_tokens: 18, reasoning_output_tokens: 5 }, last_token_usage: { input_tokens: 60, cached_input_tokens: 10, output_tokens: 8, reasoning_output_tokens: 3 } } } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    expect(session.tokenUsage).toMatchObject({
      totalInputTokens: 160,
      totalOutputTokens: 18,
      totalCacheReadTokens: 30,
    });
    expect(session.tokenUsageEvents?.map(event => ({
      timestamp: event.timestamp,
      input: event.inputTokens,
      output: event.outputTokens,
      cacheRead: event.cacheReadTokens,
      reasoning: event.reasoningTokens,
    }))).toEqual([
      { timestamp: Date.parse('2026-07-01T01:10:00Z'), input: 100, output: 10, cacheRead: 20, reasoning: 2 },
      { timestamp: Date.parse('2026-07-03T12:00:00Z'), input: 60, output: 8, cacheRead: 10, reasoning: 3 },
    ]);
    expect(session.tokenUsageEvents?.reduce((sum, event) => sum + event.inputTokens, 0)).toBe(session.tokenUsage.totalInputTokens);
    expect(session.tokenUsageEvents?.reduce((sum, event) => sum + event.outputTokens, 0)).toBe(session.tokenUsage.totalOutputTokens);
  });

  it('starts a new Codex token segment when a cumulative counter resets', async () => {
    const dir = await makeTempDir('vesti-codex-token-reset-');
    const file = path.join(dir, 'rollout-44444444-4444-4444-4444-444444444444.jsonl');
    const rows = [
      { timestamp: '2026-07-01T00:00:00Z', type: 'session_meta', payload: { id: 'codex-token-reset' } },
      { timestamp: '2026-07-01T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } } } },
      { timestamp: '2026-07-02T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 25, cached_input_tokens: 5, output_tokens: 3 } } } },
      { timestamp: '2026-07-03T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40, cached_input_tokens: 8, output_tokens: 5 } } } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    expect(session.tokenUsageEvents?.map(event => [event.inputTokens, event.outputTokens, event.cacheReadTokens])).toEqual([
      [100, 10, 20],
      [25, 3, 5],
      [15, 2, 3],
    ]);
    expect(session.tokenUsage).toMatchObject({
      totalInputTokens: 140,
      totalOutputTokens: 15,
      totalCacheReadTokens: 28,
    });
  });

  it('preserves omitted Codex cumulative fields instead of treating them as zero', async () => {
    const dir = await makeTempDir('vesti-codex-token-missing-fields-');
    const file = path.join(dir, 'rollout-66666666-6666-6666-6666-666666666666.jsonl');
    const rows = [
      { timestamp: '2026-07-01T00:00:00Z', type: 'session_meta', payload: { id: 'codex-token-missing-fields' } },
      { timestamp: '2026-07-01T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 5 } } } },
      { timestamp: '2026-07-02T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 160, output_tokens: 18 } } } },
      { timestamp: '2026-07-03T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 25, output_tokens: 20, reasoning_output_tokens: 7 } } } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    expect(session.tokenUsageEvents?.map(event => [event.inputTokens, event.outputTokens, event.cacheReadTokens, event.reasoningTokens ?? 0])).toEqual([
      [100, 10, 20, 5],
      [60, 8, 0, 0],
      [40, 2, 5, 2],
    ]);
    expect(session.tokenUsage).toMatchObject({ totalInputTokens: 200, totalOutputTokens: 20, totalCacheReadTokens: 25 });
  });

  it('resets Codex cumulative fields independently', async () => {
    const dir = await makeTempDir('vesti-codex-token-field-reset-');
    const file = path.join(dir, 'rollout-77777777-7777-7777-7777-777777777777.jsonl');
    const rows = [
      { timestamp: '2026-07-01T00:00:00Z', type: 'session_meta', payload: { id: 'codex-token-field-reset' } },
      { timestamp: '2026-07-01T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 5 } } } },
      { timestamp: '2026-07-02T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 130, cached_input_tokens: 25, output_tokens: 2, reasoning_output_tokens: 7 } } } },
      { timestamp: '2026-07-03T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 150, cached_input_tokens: 28, output_tokens: 5, reasoning_output_tokens: 8 } } } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    expect(session.tokenUsageEvents?.map(event => [event.inputTokens, event.outputTokens, event.cacheReadTokens, event.reasoningTokens ?? 0])).toEqual([
      [100, 10, 20, 5],
      [30, 2, 5, 2],
      [20, 3, 3, 1],
    ]);
    expect(session.tokenUsage).toMatchObject({ totalInputTokens: 150, totalOutputTokens: 15, totalCacheReadTokens: 28 });
  });

  it('keeps Codex token event IDs stable when unrelated rows are inserted', async () => {
    const dir = await makeTempDir('vesti-codex-token-event-ids-');
    const file = path.join(dir, 'rollout-88888888-8888-8888-8888-888888888888.jsonl');
    const tokenRows = [
      { timestamp: '2026-07-01T00:00:00Z', type: 'session_meta', payload: { id: 'codex-token-event-ids' } },
      { timestamp: '2026-07-01T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
      { timestamp: '2026-07-01T01:00:01Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
      { timestamp: '2026-07-02T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 140, output_tokens: 15 } } } },
    ];
    await fs.writeFile(file, `${tokenRows.map(row => JSON.stringify(row)).join('\n')}\n`);
    const before = await new CodexParser().parseFile(file);

    const withInsertedRow = [
      tokenRows[0],
      { timestamp: '2026-07-01T00:30:00Z', type: 'event_msg', payload: { type: 'agent_message', message: 'unrelated' } },
      ...tokenRows.slice(1),
    ];
    await fs.writeFile(file, `${withInsertedRow.map(row => JSON.stringify(row)).join('\n')}\n`);
    const after = await new CodexParser().parseFile(file);

    expect(after.tokenUsageEvents).toHaveLength(2);
    expect(after.tokenUsageEvents?.map(event => event.id)).toEqual(before.tokenUsageEvents?.map(event => event.id));
    expect(after.tokenUsageEvents?.map(event => (event as typeof event & { sourceScope: string }).sourceScope)).toEqual([
      'codex:rollout-88888888-8888-8888-8888-888888888888',
      'codex:rollout-88888888-8888-8888-8888-888888888888',
    ]);
  });

  it('counts only spawned-thread usage after the Codex replay boundary', async () => {
    const dir = await makeTempDir('vesti-codex-token-fork-dedupe-');
    const mainFile = path.join(dir, 'rollout-main.jsonl');
    const forkFile = path.join(dir, 'rollout-fork.jsonl');
    const usage = (input: number, output: number) => ({
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, output_tokens: output } },
    });
    const mainRows = [
      { timestamp: '2026-07-01T00:00:00Z', type: 'session_meta', payload: { id: 'logical-session', session_id: 'logical-session' } },
      { timestamp: '2026-07-01T01:00:00Z', type: 'event_msg', payload: usage(100, 10) },
      { timestamp: '2026-07-02T01:00:00Z', type: 'event_msg', payload: usage(150, 15) },
    ];
    const forkRows = [
      {
        timestamp: '2026-07-03T00:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'child-rollout',
          session_id: 'logical-session',
          forked_from_id: 'logical-session',
          source: { subagent: { thread_spawn: { parent_thread_id: 'logical-session', depth: 1 } } },
        },
      },
      // The fork replays the main rollout's history with later timestamps.
      { timestamp: '2026-07-03T01:00:00Z', type: 'event_msg', payload: usage(100, 10) },
      { timestamp: '2026-07-03T01:00:01Z', type: 'event_msg', payload: usage(150, 15) },
      { timestamp: '2026-07-03T01:00:01.500Z', type: 'inter_agent_communication_metadata', payload: {} },
      // This transition exists only in the child and must remain countable.
      { timestamp: '2026-07-03T01:00:02Z', type: 'event_msg', payload: usage(180, 19) },
    ];
    await fs.writeFile(mainFile, `${mainRows.map(row => JSON.stringify(row)).join('\n')}\n`);
    await fs.writeFile(forkFile, `${forkRows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const parser = new CodexParser();
    const main = await parser.parseFile(mainFile);
    const fork = await parser.parseFile(forkFile);

    expect(fork.tokenUsageEvents).toHaveLength(1);
    expect(fork.tokenUsageEvents?.[0].dedupeKey)
      .not.toBe(main.tokenUsageEvents?.[1].dedupeKey);
    expect(fork.tokenUsageEvents?.map(event => [event.inputTokens, event.outputTokens]))
      .toEqual([[30, 4]]);
    expect(fork.tokenUsage).toMatchObject({ totalInputTokens: 30, totalOutputTokens: 4 });
    expect(fork.meta?.capture_append_only).toBe(true);
  });

  it('keeps a Codex guardian first cumulative snapshot as real usage', async () => {
    const dir = await makeTempDir('vesti-codex-token-guardian-');
    const file = path.join(dir, 'rollout-guardian.jsonl');
    const rows = [
      {
        timestamp: '2026-07-03T00:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'guardian-thread',
          session_id: 'logical-session',
          source: { subagent: { other: 'guardian' } },
        },
      },
      {
        timestamp: '2026-07-03T00:00:01Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 25, output_tokens: 3 } },
        },
      },
    ];
    await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');

    const guardian = await new CodexParser().parseFile(file);

    expect(guardian.tokenUsageEvents?.map(event => [event.inputTokens, event.outputTokens]))
      .toEqual([[25, 3]]);
    expect(guardian.tokenUsage).toMatchObject({ totalInputTokens: 25, totalOutputTokens: 3 });
  });

  it('uses Codex last_token_usage only when cumulative totals are unavailable', async () => {
    const dir = await makeTempDir('vesti-codex-last-token-');
    const file = path.join(dir, 'rollout-55555555-5555-5555-5555-555555555555.jsonl');
    const rows = [
      { timestamp: '2026-07-01T00:00:00Z', type: 'session_meta', payload: { id: 'codex-last-token' } },
      { timestamp: '2026-07-01T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 30, cached_input_tokens: 5, output_tokens: 4 } } } },
      { timestamp: '2026-07-02T01:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 40, cached_input_tokens: 6, output_tokens: 5 } } } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    expect(session.tokenUsage).toMatchObject({ totalInputTokens: 70, totalOutputTokens: 9, totalCacheReadTokens: 11 });
    expect(session.tokenUsageEvents?.map(event => event.source)).toEqual([
      'codex:token_count:last_token_usage',
      'codex:token_count:last_token_usage',
    ]);
  });

  it('drops a system-only environment_context message from Codex storage and titles', async () => {
    const dir = await makeTempDir('vesti-codex-env-');
    const file = path.join(dir, 'rollout-22222222-2222-2222-2222-222222222222.jsonl');
    const rows = [
      { timestamp: '2026-07-15T01:00:00Z', type: 'session_meta', payload: { id: 'codex-env-session', cwd: 'C:/work/demo' } },
      { timestamp: '2026-07-15T01:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>C:\\work\\demo</cwd>\n  <shell>powershell</shell>\n</environment_context>' }] } },
      { timestamp: '2026-07-15T01:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '修复登录页的样式问题' }] } },
      { timestamp: '2026-07-15T01:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已修复' }] } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new CodexParser().parseFile(file);

    expect(session.messages.some(m => m.contentText?.includes('<environment_context>'))).toBe(false);
    expect(session.messages.map(message => message.contentText)).toEqual(['修复登录页的样式问题', '已修复']);
    expect(session.meta?.first_prompt).toBe('修复登录页的样式问题');
    const converted = MessageConverter.convertV2(session);
    expect(converted.session.title).toBe('修复登录页的样式问题');
  });

  it('parses Cursor composer data from its SQLite key-value chain', async () => {
    const dir = await makeTempDir('vesti-cursor-');
    const file = path.join(dir, 'state.vscdb');
    const composerId = 'composer-11111111';
    const db = new Database(file);
    db.exec(`
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY,
        createdAt INTEGER,
        lastUpdatedAt INTEGER,
        isArchived INTEGER,
        isSubagent INTEGER,
        value BLOB
      );
    `);
    db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?, ?)').run(
      composerId,
      1_752_541_200_000,
      1_752_541_202_000,
      0,
      0,
      JSON.stringify({ composerId, name: 'Cursor fixture', workspaceIdentifier: { fsPath: 'C:/work/cursor-demo' } }),
    );
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `composerData:${composerId}`,
      JSON.stringify({
        composerId,
        name: 'Cursor fixture',
        modelConfig: { modelName: 'cursor-test-model' },
        tokenCount: 999_999,
        fullConversationHeadersOnly: [
          { bubbleId: 'user-1', type: 1, createdAt: 1_752_541_200_000 },
          { bubbleId: 'assistant-1', type: 2, createdAt: 1_752_541_201_000 },
        ],
      }),
    );
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `bubbleId:${composerId}:user-1`,
      JSON.stringify({ bubbleId: 'user-1', type: 1, text: 'fix the test', createdAt: 1_752_541_200_000 }),
    );
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `bubbleId:${composerId}:assistant-1`,
      JSON.stringify({
        bubbleId: 'assistant-1',
        type: 2,
        text: 'fixed',
        thinking: 'checking',
        createdAt: 1_752_541_201_000,
        tokenCount: { inputTokens: 1_200, outputTokens: 80 },
        tokenCountUpUntilHere: 999_999,
      }),
    );
    db.close();

    const sessions = await new CursorParser().parseDatabase(file);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: composerId, platform: 'cursor', model: 'cursor-test-model', projectPath: 'C:/work/cursor-demo' });
    expect(sessions[0].messages.map(message => message.contentText)).toEqual(['fix the test', 'fixed']);
    expect(sessions[0].messages[1].contentThinking).toBe('checking');
    expect(sessions[0].messages[1].usage).toMatchObject({
      inputTokens: 1_200,
      outputTokens: 80,
      model: 'cursor-test-model',
    });
    expect(sessions[0].tokenUsage).toMatchObject({
      totalInputTokens: 1_200,
      totalOutputTokens: 80,
    });
  });

  it('parses legacy Cursor inline conversations and their reported token usage', async () => {
    const dir = await makeTempDir('vesti-cursor-legacy-');
    const file = path.join(dir, 'state.vscdb');
    const composerId = 'legacy-composer-11111111';
    const db = new Database(file);
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
    db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(
      `composerData:${composerId}`,
      JSON.stringify({
        composerId,
        name: 'Legacy Cursor fixture',
        createdAt: 1_752_541_200_000,
        modelConfig: { modelName: 'cursor-legacy-model' },
        tokenCount: 888_888,
        conversation: [
          { bubbleId: 'legacy-user', type: 1, text: 'legacy question', tokenCount: { inputTokens: 0, outputTokens: 0 } },
          { bubbleId: 'legacy-assistant-1', type: 2, text: 'first answer', tokenCount: { inputTokens: 200, outputTokens: 30 } },
          { bubbleId: 'legacy-assistant-2', type: 2, text: 'second answer', tokenCount: { inputTokens: 350, outputTokens: 45 } },
        ],
      }),
    );
    db.close();

    const sessions = await new CursorParser().parseDatabase(file);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].messages.map(message => message.contentText)).toEqual([
      'legacy question',
      'first answer',
      'second answer',
    ]);
    expect(sessions[0].tokenUsage).toMatchObject({
      totalInputTokens: 550,
      totalOutputTokens: 75,
    });
    expect(MessageConverter.convertV2(sessions[0]).session).toMatchObject({
      totalInputTokens: 550,
      totalOutputTokens: 75,
    });
  });
  it('links Cursor subagent composers to their parent and inherits the project path', async () => {
    const dir = await makeTempDir('vesti-cursor-sub-');
    const file = path.join(dir, 'state.vscdb');
    const parentId = 'parent-composer-1111';
    const childId = 'child-composer-2222';
    const orphanChildId = 'child-composer-3333';
    const db = new Database(file);
    db.exec(`
      CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);
      CREATE TABLE composerHeaders (
        composerId TEXT PRIMARY KEY,
        createdAt INTEGER,
        lastUpdatedAt INTEGER,
        isArchived INTEGER,
        isSubagent INTEGER,
        value TEXT
      );
    `);
    const insertHeader = db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?, ?)');
    insertHeader.run(parentId, 1000, 4000, 0, 0, JSON.stringify({
      composerId: parentId,
      workspaceIdentifier: { fsPath: 'C:/work/parent-project' },
    }));
    insertHeader.run(childId, 2000, 3000, 0, 1, JSON.stringify({
      composerId: childId,
      // headless subagents run in an empty window — no workspace path
      workspaceIdentifier: { id: 'empty-window' },
      subagentInfo: {
        subagentType: 3,
        subagentTypeName: 'generalPurpose',
        parentComposerId: parentId,
        toolCallId: 'toolu_test_1',
      },
    }));
    // Subagent pointing at a parent that is not in the database: no link.
    insertHeader.run(orphanChildId, 2000, 3000, 0, 1, JSON.stringify({
      composerId: orphanChildId,
      subagentInfo: { parentComposerId: 'missing-parent' },
    }));

    const insertKv = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
    const composerData = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      composerId: id,
      fullConversationHeadersOnly: [
        { bubbleId: 'u1', type: 1, createdAt: 2000 },
        { bubbleId: 'a1', type: 2, createdAt: 2001 },
      ],
      ...extra,
    });
    insertKv.run(`composerData:${parentId}`, composerData(parentId, { subagentComposerIds: [childId] }));
    insertKv.run(`composerData:${childId}`, composerData(childId));
    insertKv.run(`composerData:${orphanChildId}`, composerData(orphanChildId));
    for (const id of [parentId, childId, orphanChildId]) {
      insertKv.run(`bubbleId:${id}:u1`, JSON.stringify({ bubbleId: 'u1', type: 1, text: `ask ${id}`, createdAt: 2000 }));
      insertKv.run(`bubbleId:${id}:a1`, JSON.stringify({ bubbleId: 'a1', type: 2, text: `answer ${id}`, createdAt: 2001 }));
    }
    db.close();

    const sessions = await new CursorParser().parseDatabase(file);
    const parent = sessions.find(session => session.sessionId === parentId)!;
    const child = sessions.find(session => session.sessionId === childId)!;
    const orphan = sessions.find(session => session.sessionId === orphanChildId)!;

    // Parent carries the ref with the child work-session id known at parse time.
    expect(parent.subagents).toEqual([{
      agentId: childId,
      slug: 'generalPurpose',
      agentRole: 'generalPurpose',
      filePath: file,
      childSessionId: `cursor:${childId}`,
    }]);
    // Headless child inherits the parent's project so the tree mounts it.
    expect(child.projectPath).toBe('C:/work/parent-project');
    expect(child.meta).toMatchObject({
      is_subagent: true,
      parent_composer_id: parentId,
      subagent_type: 'generalPurpose',
      spawned_by_tool_call: 'toolu_test_1',
    });
    // Orphan child: no link emitted, no inheritance.
    expect(orphan.projectPath).toBe('');
    expect(orphan.meta?.parent_composer_id).toBeUndefined();

    // Converter turns the ref into a resolved subagent link directly.
    const converted = MessageConverter.convertV2(parent);
    expect(converted.subagentLinks).toEqual([expect.objectContaining({
      parentSessionId: `cursor:${parentId}`,
      childSessionId: `cursor:${childId}`,
      agentId: childId,
      agentRole: 'generalPurpose',
    })]);
    expect(converted.session.hasSubagents).toBe(true);
  });

  it('parses Cursor 2.x agent-transcripts with subagent lineage, chat meta and estimated usage', async () => {
    const home = await makeTempDir('vesti-cursor-tr-');
    const agentId = '11111111-aaaa-bbbb-cccc-000000000001';
    const childId = '22222222-aaaa-bbbb-cccc-000000000002';

    // ~/.cursor/projects/<slug>/agent-transcripts/<agentId>/...
    const agentDir = path.join(home, 'projects', 'c-Users-me', 'agent-transcripts', agentId);
    await fs.ensureDir(path.join(agentDir, 'subagents'));
    const mainFile = path.join(agentDir, `${agentId}.jsonl`);
    await fs.writeFile(mainFile, [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Tuesday, Jul 21, 2026, 3:19 AM (UTC-7)</timestamp>\n<user_query>\n请优化捕获引擎\n</user_query>' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: '开始分析' }, { type: 'tool_use', id: 'toolu_tr_1', name: 'Task', input: { prompt: 'review' } }] } }),
      JSON.stringify({ type: 'turn_ended', status: 'success' }),
    ].join('\n'));
    await fs.writeFile(path.join(agentDir, 'subagents', `${childId}.jsonl`), [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'review the renderer' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'no blocking issues' }] } }),
    ].join('\n'));

    // ~/.cursor/chats/<ws-hash>/<agentId>/meta.json + store.db meta
    const chatDir = path.join(home, 'chats', 'ws-hash', agentId);
    await fs.ensureDir(chatDir);
    await fs.writeJson(path.join(chatDir, 'meta.json'), {
      schemaVersion: 1, title: 'Capture Engine Work', cwd: 'C:\\work\\demo',
      createdAtMs: 1_752_000_000_000, updatedAtMs: 1_752_100_000_000, hasConversation: true,
    });
    const childChatDir = path.join(home, 'chats', 'ws-hash', childId);
    await fs.ensureDir(childChatDir);
    const childStore = new Database(path.join(childChatDir, 'store.db'));
    childStore.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    childStore.prepare('INSERT INTO meta VALUES (?, ?)').run('0', Buffer.from(JSON.stringify({
      agentId: childId, lastUsedModel: 'claude-test',
      subagentInfo: { parentAgentId: agentId, typeName: 'bugbot', toolCallId: 'toolu_tr_1' },
    }), 'utf8').toString('hex'));
    childStore.close();

    const { CursorTranscriptParser } = await import('../src/adapters/cursor/transcript.js');
    const sessions = await new CursorTranscriptParser(home).parseFile(mainFile);

    expect(sessions.map(session => session.sessionId).sort()).toEqual([agentId, childId].sort());
    const main = sessions.find(session => session.sessionId === agentId)!;
    const child = sessions.find(session => session.sessionId === childId)!;

    // Chat meta joins in: title, cwd, session bounds.
    expect(main.projectPath).toBe('C:\\work\\demo');
    expect(main.meta).toMatchObject({ composer_name: 'Capture Engine Work', token_estimated: true, transcript_format: 'agent-transcripts' });
    // Inline <timestamp> anchors the user message (2026-07-21 10:19 UTC).
    expect(main.messages[0].timestamp).toBe(Date.UTC(2026, 6, 21, 10, 19));
    // Chat title wins as the display prompt (same rule as the vscdb parser);
    // the extracted <user_query> is the fallback when no title exists.
    expect(main.meta?.first_prompt).toBe('Capture Engine Work');
    expect(main.messages[1].toolCalls).toEqual([{ id: 'toolu_tr_1', name: 'Task', input: { prompt: 'review' } }]);
    // Estimated usage is non-zero and flagged, never a silent hard 0.
    expect(main.tokenUsage.totalInputTokens).toBeGreaterThan(0);
    expect(main.tokenUsage.totalOutputTokens).toBeGreaterThan(0);

    // Lineage from the directory layout + child store meta.
    expect(main.subagents).toEqual([{
      agentId: childId,
      slug: 'bugbot',
      agentRole: 'bugbot',
      filePath: path.join(agentDir, 'subagents', `${childId}.jsonl`),
      childSessionId: `cursor:${childId}`,
    }]);
    expect(child.projectPath).toBe('C:\\work\\demo');
    expect(child.model).toBe('claude-test');
    expect(child.meta).toMatchObject({ is_subagent: true, parent_composer_id: agentId, subagent_type: 'bugbot' });
  });

  it('links Cursor background agents (top-level transcript, child-side lineage) to their parent', async () => {
    const home = await makeTempDir('vesti-cursor-bg-');
    const parentId = '33333333-aaaa-bbbb-cccc-000000000003';
    const bgId = '44444444-aaaa-bbbb-cccc-000000000004';

    // Background agents own a TOP-LEVEL transcript dir — not subagents/.
    const bgDir = path.join(home, 'projects', 'c-Users-me', 'agent-transcripts', bgId);
    await fs.ensureDir(bgDir);
    const bgFile = path.join(bgDir, `${bgId}.jsonl`);
    await fs.writeFile(bgFile, [
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'rewrite the prompt plaza' }] } }),
      JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'done, 12/12 tests pass' }] } }),
    ].join('\n'));

    // Lineage lives only in the child's chat-store meta.
    const chatDir = path.join(home, 'chats', 'ws-hash', bgId);
    await fs.ensureDir(chatDir);
    const store = new Database(path.join(chatDir, 'store.db'));
    store.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    store.prepare('INSERT INTO meta VALUES (?, ?)').run('0', Buffer.from(JSON.stringify({
      agentId: bgId, subagentInfo: { parentAgentId: parentId, typeName: 'generalPurpose', toolCallId: 'toolu_bg_1' },
    }), 'utf8').toString('hex'));
    store.close();

    const { CursorTranscriptParser } = await import('../src/adapters/cursor/transcript.js');
    const [session] = await new CursorTranscriptParser(home).parseFile(bgFile);

    expect(session.subagentOf).toEqual({
      parentSessionId: `cursor:${parentId}`,
      agentRole: 'generalPurpose',
      toolCallId: 'toolu_bg_1',
    });
    expect(session.meta).toMatchObject({ is_subagent: true, parent_composer_id: parentId });

    // Converter emits the same resolved link a parent-side ref would.
    const converted = MessageConverter.convertV2(session);
    expect(converted.subagentLinks).toEqual([expect.objectContaining({
      id: `cursor:${parentId}:${bgId}`,
      parentSessionId: `cursor:${parentId}`,
      childSessionId: `cursor:${bgId}`,
      agentRole: 'generalPurpose',
    })]);
  });

  it('keeps legacy-envelope Kimi Code user, assistant and tool-result chains', async () => {
    const root = await makeTempDir('vesti-kimi-');
    const sessionDir = path.join(root, 'project-hash', 'kimi-session');
    await fs.ensureDir(sessionDir);
    const wire = [
      { timestamp: 1_752_541_200, message: { type: 'TurnBegin', payload: { user_input: 'scan files' } } },
      { timestamp: 1_752_541_201, message: { type: 'ContentPart', payload: { type: 'text', text: 'working' } } },
      { timestamp: 1_752_541_202, message: { type: 'ToolCall', payload: { id: 'kimi-call', function: { name: 'Shell', arguments: 'rg --files' } } } },
      { timestamp: 1_752_541_203, message: { type: 'ToolResult', payload: { tool_call_id: 'kimi-call', return_value: { is_error: false, output: 'README.md' } } } },
    ];
    await fs.writeFile(path.join(sessionDir, 'wire.jsonl'), `${wire.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new KimiCodeParser().parseSessionDir(sessionDir);

    expect(session.platform).toBe('kimi-code');
    expect(session.messages).toHaveLength(4);
    expect(session.toolExecutions[0]).toMatchObject({ toolName: 'Shell', outputSummary: 'README.md' });
  });

  it('keeps timestamps for legacy Kimi main and subagent token updates', () => {
    const day1 = Date.parse('2026-07-01T10:00:00Z');
    const day2 = Date.parse('2026-07-02T11:00:00Z');
    const wire = [
      { timestamp: day1 / 1000, message: { type: 'StatusUpdate', payload: { token_usage: { input_other: 50, input_cache_read: 10, input_cache_creation: 2, output: 7 } } } },
      { timestamp: day2 / 1000, message: { type: 'SubagentEvent', payload: { task_tool_call_id: 'sub-task-1', event: { type: 'StatusUpdate', payload: { token_usage: { input_other: 30, input_cache_read: 5, input_cache_creation: 1, output: 4 } } } } } },
    ];

    const session = new KimiCodeParser().parseWireContent(
      `${wire.map(row => JSON.stringify(row)).join('\n')}\n`,
      { sessionId: 'kimi-legacy-usage', projectPath: 'C:/work/demo' },
    );

    expect(session.tokenUsage).toMatchObject({
      totalInputTokens: 98,
      totalOutputTokens: 11,
      totalCacheCreationTokens: 3,
      totalCacheReadTokens: 15,
    });
    expect(session.tokenUsageEvents?.map(event => ({
      timestamp: event.timestamp,
      input: event.inputTokens,
      output: event.outputTokens,
      source: event.source,
    }))).toEqual([
      { timestamp: day1, input: 62, output: 7, source: 'kimi-code:StatusUpdate' },
      { timestamp: day2, input: 36, output: 4, source: 'kimi-code:SubagentEvent.StatusUpdate' },
    ]);
  });

  it('parses Kimi Code protocol 1.4 wire events (desensitized from real wire.jsonl)', async () => {
    // Structure mirrors real protocol-1.4 events; all text is synthetic.
    const wire = [
      { type: 'metadata', protocol_version: '1.4', created_at: 1_784_370_940_249 },
      { type: 'config.update', profileName: 'agent', systemPrompt: 'You are a test CLI agent.', time: 1_784_370_940_249 },
      { type: 'tools.set_active_tools', names: ['Read', 'Bash'], time: 1_784_370_940_249 },
      // turn.prompt duplicates the following append_message — must not double-count
      { type: 'turn.prompt', input: [{ type: 'text', text: '整理一下这个仓库的结构' }], origin: { kind: 'user' }, time: 1_784_370_960_782 },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '整理一下这个仓库的结构' }], toolCalls: [], origin: { kind: 'user' } }, time: 1_784_370_960_783 },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder> Plan mode is active.</system-reminder>' }], toolCalls: [], origin: { kind: 'injection' } }, time: 1_784_370_960_784 },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'step-uuid-1', turnId: '0', step: 1 }, time: 1_784_370_960_786 },
      { type: 'llm.request', kind: 'loop', provider: 'kimi', model: 'k3', modelAlias: 'kimi-code/k3', time: 1_784_370_960_789 },
      { type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'part-1', turnId: '0', step: 1, stepUuid: 'step-uuid-1', part: { type: 'think', think: '先列出仓库文件再总结。' } }, time: 1_784_370_960_790 },
      { type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'part-2', turnId: '0', step: 1, stepUuid: 'step-uuid-1', part: { type: 'text', text: '我先查看仓库文件。' } }, time: 1_784_370_960_791 },
      { type: 'context.append_loop_event', event: { type: 'tool.call', uuid: 'tool_call_1', toolCallId: 'tool_call_1', turnId: '0', step: 1, stepUuid: 'step-uuid-1', name: 'Bash', args: { command: 'rg --files' }, description: 'List files' }, time: 1_784_370_960_792 },
      { type: 'context.append_loop_event', event: { type: 'tool.result', parentUuid: 'tool_call_1', toolCallId: 'tool_call_1', result: { output: 'README.md\nsrc/index.ts' } }, time: 1_784_370_960_800 },
      // step.end usage duplicates usage.record (turn scope) — must not double-count
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-uuid-1', turnId: '0', step: 1, usage: { inputOther: 100, output: 20, inputCacheRead: 40, inputCacheCreation: 0 }, finishReason: 'tool_use' }, time: 1_784_370_960_801 },
      { type: 'usage.record', model: 'kimi-code/k3', usage: { inputOther: 100, output: 20, inputCacheRead: 40, inputCacheCreation: 0 }, usageScope: 'turn', time: 1_784_370_960_802 },
    ];

    const session = new KimiCodeParser().parseWireContent(
      `${wire.map(row => JSON.stringify(row)).join('\n')}\n`,
      { sessionId: 'session-fixture', projectPath: 'C:/work/demo', agentName: 'main' },
    );

    expect(session.platform).toBe('kimi-code');
    // user prompt + injection + think + text + tool call + tool result
    expect(session.messages.map(m => [m.role, m.type])).toEqual([
      ['user', 'user'],
      ['system', 'system'],
      ['assistant', 'assistant'],
      ['assistant', 'assistant'],
      ['assistant', 'assistant'],
      ['user', 'user'],
    ]);
    expect(session.messages[0].contentText).toBe('整理一下这个仓库的结构');
    expect(session.messages[2].contentThinking).toContain('先列出仓库文件');
    expect(session.messages[4].toolCalls?.[0]).toMatchObject({ name: 'Bash' });
    expect(session.messages[5].isToolResult).toBe(true);
    expect(session.toolExecutions[0]).toMatchObject({ toolName: 'Bash' });
    expect(session.toolExecutions[0].outputSummary).toContain('README.md');
    expect(session.model).toBe('kimi-code/k3');
    // usage.record only — step.end must not double the totals
    expect(session.tokenUsage).toMatchObject({
      totalInputTokens: 140,
      totalOutputTokens: 20,
      totalCacheReadTokens: 40,
    });
    expect(session.tokenUsageEvents).toEqual([
      expect.objectContaining({
        timestamp: 1_784_370_960_802,
        inputTokens: 140,
        outputTokens: 20,
        cacheReadTokens: 40,
        model: 'kimi-code/k3',
        source: 'kimi-code:usage.record',
      }),
    ]);
    expect(session.tokenUsageEvents?.some(event => event.source === 'kimi-code:step.end')).toBe(false);
    expect(session.warnings).toBeUndefined();
    expect(session.meta?.protocol_version).toBe('1.4');

    const converted = MessageConverter.convertV2(session);
    expect(converted.session.title).toBe('整理一下这个仓库的结构');
  });

  it('deduplicates Kimi usage per turn while retaining a later step.end-only turn', () => {
    const wire = [
      { type: 'metadata', protocol_version: '1.4', created_at: 1_783_000_000_000 },
      { type: 'llm.request', modelAlias: 'kimi-code/k3', time: 1_783_000_000_100 },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-day-1', usage: { inputOther: 80, inputCacheRead: 20, inputCacheCreation: 5, output: 10 } }, time: Date.parse('2026-07-01T10:00:00Z') },
      { type: 'usage.record', model: 'kimi-code/k3', usage: { inputOther: 80, inputCacheRead: 20, inputCacheCreation: 5, output: 10 }, usageScope: 'turn', time: Date.parse('2026-07-01T10:00:00Z') + 1 },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-day-2', usage: { inputOther: 40, inputCacheRead: 10, inputCacheCreation: 0, output: 6 } }, time: Date.parse('2026-07-02T11:00:00Z') },
    ];

    const session = new KimiCodeParser().parseWireContent(
      `${wire.map(row => JSON.stringify(row)).join('\n')}\n`,
      { sessionId: 'kimi-step-fallback', projectPath: 'C:/work/demo', agentName: 'main' },
    );

    expect(session.tokenUsage).toMatchObject({
      totalInputTokens: 155,
      totalOutputTokens: 16,
      totalCacheCreationTokens: 5,
      totalCacheReadTokens: 30,
    });
    expect(session.tokenUsageEvents?.map(event => ({
      timestamp: event.timestamp,
      input: event.inputTokens,
      output: event.outputTokens,
      source: event.source,
    }))).toEqual([
      { timestamp: Date.parse('2026-07-01T10:00:00Z') + 1, input: 105, output: 10, source: 'kimi-code:usage.record' },
      { timestamp: Date.parse('2026-07-02T11:00:00Z'), input: 50, output: 6, source: 'kimi-code:step.end' },
    ]);
  });

  it('pairs adjacent Kimi usage deterministically across midnight and repeated equal calls', () => {
    const firstStepTime = Date.parse('2026-07-01T23:59:00Z');
    const firstRecordTime = Date.parse('2026-07-02T00:01:00Z');
    const secondStepTime = Date.parse('2026-07-02T00:02:00Z');
    const secondRecordTime = Date.parse('2026-07-02T00:02:01Z');
    const usage = { inputOther: 70, inputCacheRead: 20, inputCacheCreation: 5, output: 9 };
    const wire = [
      { type: 'metadata', protocol_version: '1.4', created_at: firstStepTime - 1 },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-a', turnId: 'turn-a', step: 1, usage }, time: firstStepTime },
      // Unrelated lines do not break adjacency in the token-bearing stream.
      { type: 'config.update', profileName: 'agent', time: firstStepTime + 1 },
      { type: 'usage.record', turnId: 'turn-a', step: 1, model: 'kimi-code/k3', usage, usageScope: 'turn', time: firstRecordTime },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'step-b', turnId: 'turn-b', step: 1, usage }, time: secondStepTime },
      { type: 'tools.update_store', time: secondStepTime + 1 },
      { type: 'usage.record', turnId: 'turn-b', step: 1, model: 'kimi-code/k3', usage, usageScope: 'turn', time: secondRecordTime },
    ];
    const parse = (rows: unknown[]) => new KimiCodeParser().parseWireContent(
      `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
      { sessionId: 'kimi-adjacent-usage', projectPath: 'C:/work/demo', agentName: 'main' },
    );

    const session = parse(wire);
    expect(session.tokenUsage).toMatchObject({
      totalInputTokens: 190,
      totalOutputTokens: 18,
      totalCacheCreationTokens: 10,
      totalCacheReadTokens: 40,
    });
    expect(session.tokenUsageEvents?.map(event => ({
      timestamp: event.timestamp,
      source: event.source,
    }))).toEqual([
      { timestamp: firstRecordTime, source: 'kimi-code:usage.record' },
      { timestamp: secondRecordTime, source: 'kimi-code:usage.record' },
    ]);
    expect(new Set(session.tokenUsageEvents?.map(event => event.id)).size).toBe(2);

    const withInsertedUnrelatedLine = [...wire];
    withInsertedUnrelatedLine.splice(1, 0, { type: 'permission.set_mode', mode: 'ask', time: firstStepTime - 1 });
    expect(parse(withInsertedUnrelatedLine).tokenUsageEvents?.map(event => event.id))
      .toEqual(session.tokenUsageEvents?.map(event => event.id));
  });

  it('warns instead of failing silently on unrecognized Kimi wire protocols', async () => {
    const wire = [
      { type: 'metadata', protocol_version: '9.9', created_at: 1 },
      { type: 'future.event', foo: 1, time: 2 },
      { type: 'future.other', bar: 2, time: 3 },
      { type: 'future.event', foo: 3, time: 4 },
      { type: 'future.third', baz: 5, time: 6 },
    ];

    const session = new KimiCodeParser().parseWireContent(
      `${wire.map(row => JSON.stringify(row)).join('\n')}\n`,
      { sessionId: 'session-future', projectPath: '' },
    );

    expect(session.messages).toHaveLength(0);
    expect(session.warnings?.some(w => w.includes('unrecognized'))).toBe(true);
    expect(session.warnings?.some(w => w.includes('0 messages'))).toBe(true);
  });

  it('discovers Kimi Code sessions in the real sessions/<wd>/<session>/agents layout', async () => {
    const home = await makeTempDir('vesti-kimi-home-');
    const sessionDir = path.join(home, '.kimi-code', 'sessions', 'wd_demo_0123456789ab', 'session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    const mainDir = path.join(sessionDir, 'agents', 'main');
    const subDir = path.join(sessionDir, 'agents', 'agent-0');
    await fs.ensureDir(mainDir);
    await fs.ensureDir(subDir);
    await fs.writeJSON(path.join(sessionDir, 'state.json'), {
      createdAt: '2026-07-18T09:00:00.000Z',
      updatedAt: '2026-07-18T09:05:00.000Z',
      title: 'New Session',
      isCustomTitle: false,
      agents: {
        main: { type: 'main', parentAgentId: null },
        'agent-0': { type: 'sub', parentAgentId: 'main', swarmItem: '调研员' },
      },
      workDir: 'C:/work/kimi-demo',
    });
    const mainWire = [
      { type: 'metadata', protocol_version: '1.4', created_at: 1_784_370_940_249 },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '写一个演示脚本' }], toolCalls: [], origin: { kind: 'user' } }, time: 1_784_370_960_783 },
      { type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'p1', turnId: '0', step: 1, part: { type: 'text', text: '好的。' } }, time: 1_784_370_960_790 },
    ];
    const subWire = [
      { type: 'metadata', protocol_version: '1.4', created_at: 1_784_370_940_300 },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<git-context status="unavailable" reason="not-a-repo"/>\n\n调研竞争对手' }], toolCalls: [], origin: { kind: 'system_trigger', name: 'subagent' } }, time: 1_784_370_960_900 },
      { type: 'context.append_loop_event', event: { type: 'content.part', uuid: 'p2', turnId: '0', step: 1, part: { type: 'text', text: '调研结果。' } }, time: 1_784_370_961_000 },
    ];
    await fs.writeFile(path.join(mainDir, 'wire.jsonl'), `${mainWire.map(r => JSON.stringify(r)).join('\n')}\n`);
    await fs.writeFile(path.join(subDir, 'wire.jsonl'), `${subWire.map(r => JSON.stringify(r)).join('\n')}\n`);

    const adapter = new KimiCodeAdapter();
    adapter.setHomeRoots([{ host: 'native', homeDir: home }]);

    const detected = await adapter.detect();
    expect(detected.installed).toBe(true);

    const files = await adapter.getSessionFiles();
    expect(files).toHaveLength(2);

    const main = await adapter.parseSession(path.join(mainDir, 'wire.jsonl'));
    expect(main.sessionId).toBe('session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(main.projectPath).toBe('C:/work/kimi-demo');
    expect(main.messages.length).toBeGreaterThan(0);
    expect(main.subagents).toHaveLength(1);
    expect(main.subagents[0]).toMatchObject({ agentId: 'agent-0', slug: '调研员' });

    const sub = await adapter.parseSession(path.join(subDir, 'wire.jsonl'));
    expect(sub.sessionId).toBe('session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee--agent-0');
    expect(sub.projectPath).toBe('C:/work/kimi-demo');
    expect(sub.messages.length).toBeGreaterThan(0);
    // git-context injection is stripped from the title chain
    const converted = MessageConverter.convertV2(sub);
    expect(converted.session.title).toBe('调研竞争对手');
  });

  const realKimiSessions = path.join(os.homedir(), '.kimi-code', 'sessions');
  it.skipIf(!fs.existsSync(realKimiSessions))(
    'smoke: detects and parses the real ~/.kimi-code main wire with messages',
    async () => {
      const adapter = new KimiCodeAdapter();
      const detected = await adapter.detect();
      expect(detected.installed).toBe(true);
      expect(detected.sessionCount ?? 0).toBeGreaterThan(0);

      const files = await adapter.getSessionFiles();
      const mainWire = files.find(f => f.includes(`${path.sep}main${path.sep}`));
      expect(mainWire).toBeDefined();

      const session = await adapter.parseSession(mainWire!);
      expect(session.messages.length).toBeGreaterThan(0);
      expect(session.warnings ?? []).toEqual([]);
      expect(session.projectPath).not.toBe('');
    },
  );

  it('parses Claude Code user, assistant, tool chains and token usage', async () => {
    const dir = await makeTempDir('vesti-claude-');
    // The parser derives the sessionId from the file name.
    const file = path.join(dir, 'claude-session.jsonl');
    const rows = [
      { type: 'user', uuid: 'u1', timestamp: '2026-07-15T01:00:00Z', cwd: 'C:/work/demo', gitBranch: 'main', version: '1.0.0', sessionId: 'claude-session', message: { role: 'user', content: 'inspect this repo' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-07-15T01:00:01Z', cwd: 'C:/work/demo', sessionId: 'claude-session', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-07-15T01:00:02Z', sessionId: 'claude-session', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md' }] } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-07-15T01:00:03Z', sessionId: 'claude-session', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'done' }] } },
    ];
    await fs.writeFile(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const session = await new ClaudeCodeParser().parseFile(file);

    expect(session.sessionId).toBe('claude-session');
    expect(session.platform).toBe('claude-code');
    expect(session.projectPath).toBe('C:/work/demo');
    expect(session.gitBranch).toBe('main');
    expect(session.model).toBe('claude-test');
    expect(session.messages).toHaveLength(4);
    expect(session.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // The tool_result user message is classified as tool output, not user input
    expect(session.messages[2].isToolResult).toBe(true);
    expect(session.toolExecutions[0]).toMatchObject({ toolName: 'Bash', outputSummary: 'README.md' });
    expect(session.tokenUsage).toMatchObject({ totalInputTokens: 10, totalOutputTokens: 4, totalCacheCreationTokens: 1, totalCacheReadTokens: 2 });
  });

  it('enumerates Claude Code subagent transcripts so links can resolve', async () => {
    const home = await makeTempDir('vesti-claude-home-');
    const projectDir = path.join(home, '.claude', 'projects', 'demo');
    const subagentsDir = path.join(projectDir, 'claude-session', 'subagents');
    await fs.ensureDir(subagentsDir);
    const sessionFile = path.join(projectDir, 'claude-session.jsonl');
    await fs.writeFile(sessionFile, `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-07-15T01:00:00Z', cwd: 'C:/work/demo', sessionId: 'claude-session', message: { role: 'user', content: '主会话输入内容' } })}\n`);
    await fs.writeFile(
      path.join(subagentsDir, 'agent-abc123.jsonl'),
      `${JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-07-15T01:00:01Z', cwd: 'C:/work/demo', sessionId: 'claude-session', agentId: 'abc123', message: { role: 'user', content: '子代理任务内容' } })}\n`,
    );

    const adapter = new ClaudeCodeAdapter();
    expect(adapter.parserVersion).toBe(1);
    adapter.setHomeRoots([{ host: 'native', homeDir: home }]);

    // Enumeration no longer excludes **/subagents/**
    const files = await adapter.getSessionFiles();
    expect(files.some(f => f.includes('agent-abc123.jsonl'))).toBe(true);

    // The main session still advertises the subagent ref for linking
    const main = await adapter.parseSession(sessionFile);
    expect(main.subagents.map(s => s.agentId)).toContain('abc123');

    // The subagent transcript parses as a standalone session
    const subFile = files.find(f => f.includes('agent-abc123.jsonl'))!;
    const sub = await adapter.parseSession(subFile);
    expect(sub.messages.length).toBeGreaterThan(0);
  });

  it('parses aider markdown history into sessions with user/assistant messages', async () => {
    const dir = await makeTempDir('vesti-aider-');
    const file = path.join(dir, '.aider.chat.history.md');
    await fs.writeFile(file, [
      '# aider chat started at 2026-07-15 01:00:00',
      '',
      '> meta output line, skipped',
      '#### USER',
      'add a hello route',
      '',
      '#### ASSISTANT',
      'Added the route to app.py.',
      '',
      '# aider chat started at 2026-07-15 02:00:00',
      '',
      '#### USER',
      'remove it again',
      '',
      '#### ASSISTANT',
      'Reverted.',
      '',
    ].join('\n'));

    const sessions = await new AiderParser().parseFile(file);

    expect(sessions).toHaveLength(2);
    expect(sessions[0].platform).toBe('aider');
    expect(sessions[0].sessionId).toBe(`chat-${Date.parse('2026-07-15 01:00:00')}`);
    expect(sessions[0].messages.map(message => [message.role, message.contentText])).toEqual([
      ['user', 'add a hello route'],
      ['assistant', 'Added the route to app.py.'],
    ]);
    expect(sessions[0].startTime).toBe(Date.parse('2026-07-15 01:00:00'));
    expect(sessions[1].messages.map(message => message.contentText)).toEqual(['remove it again', 'Reverted.']);
  });
});
