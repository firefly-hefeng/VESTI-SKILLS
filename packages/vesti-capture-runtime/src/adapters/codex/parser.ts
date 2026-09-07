/**
 * Parses Codex rollout JSONL into Vesti's platform-neutral session contract.
 * Supports the current response_item/event_msg format and the older
 * ExecCommandBegin/End style event stream.
 */

import fs from 'fs-extra';
import path from 'path';
import type {
  ParsedMessage,
  ParsedSession,
  ParsedTokenUsageEvent,
  SessionTokenUsage,
  ToolCallBlock,
  ToolResultBlock,
} from '../../types/agent.js';
import type { ToolExecution } from '../../types/index.js';
import { sanitizeCodexUserText } from '../../utils/codexUserText.js';

function visibleCodexUserText(text: string): string {
  return sanitizeCodexUserText(text);
}

interface RolloutRow {
  timestamp?: string | number;
  type?: string;
  payload?: Record<string, unknown>;
}

interface ActiveTool {
  callId: string;
  messageId: string;
  name: string;
  input: unknown;
  timestamp: number;
}

interface CodexTokenSnapshot {
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asTimestamp(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') return asTimestamp(numeric, fallback);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function tokenValue(record: Record<string, unknown>, key: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined) {
    return undefined;
  }
  const value = Number(record[key]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function tokenSnapshot(value: unknown): CodexTokenSnapshot | undefined {
  const record = asRecord(value);
  const snapshot: CodexTokenSnapshot = {
    input: tokenValue(record, 'input_tokens'),
    output: tokenValue(record, 'output_tokens'),
    cacheRead: tokenValue(record, 'cached_input_tokens'),
    reasoning: tokenValue(record, 'reasoning_output_tokens'),
  };
  return Object.values(snapshot).some(value => value !== undefined) ? snapshot : undefined;
}

function tokenSnapshotFingerprint(snapshot?: CodexTokenSnapshot): string {
  return [snapshot?.input, snapshot?.output, snapshot?.cacheRead, snapshot?.reasoning]
    .map(value => value === undefined ? 'missing' : String(value))
    .join('-');
}

function tokenDelta(current: CodexTokenSnapshot, previous?: CodexTokenSnapshot): CodexTokenSnapshot {
  const delta: CodexTokenSnapshot = {};
  for (const field of ['input', 'output', 'cacheRead', 'reasoning'] as const) {
    const currentValue = current[field];
    if (currentValue === undefined) continue;
    const previousValue = previous?.[field];
    // Counters are independent: one field can be omitted or reset while the
    // remaining fields continue monotonically. A newly observed/reset field
    // begins its own cumulative segment at the reported value.
    delta[field] = previousValue === undefined || currentValue < previousValue
      ? currentValue
      : currentValue - previousValue;
  }
  return delta;
}

function mergeTokenSnapshot(
  previous: CodexTokenSnapshot | undefined,
  current: CodexTokenSnapshot,
): CodexTokenSnapshot {
  return {
    input: current.input ?? previous?.input,
    output: current.output ?? previous?.output,
    cacheRead: current.cacheRead ?? previous?.cacheRead,
    reasoning: current.reasoning ?? previous?.reasoning,
  };
}

function jsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  const record = asRecord(value);
  for (const key of ['output', 'text', 'content', 'aggregated_output', 'stdout', 'message']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}

function messageContent(payload: Record<string, unknown>): string {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .map(item => {
      const part = asRecord(item);
      return typeof part.text === 'string' ? part.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function reasoningSummary(payload: Record<string, unknown>): string {
  if (typeof payload.summary === 'string') return payload.summary.trim();
  if (!Array.isArray(payload.summary)) return '';
  return payload.summary
    .map(item => {
      const part = asRecord(item);
      return typeof part.text === 'string' ? part.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

interface CodexChildActivity {
  childThreadId: string;
  parentSourceTurnId: string;
  timestamp: number;
  callId: string;
}

interface CodexChildTaskRun {
  sourceTurnId: string;
  timestamp: number;
}

function sourceTurnId(payload: Record<string, unknown>, activeTurnId?: string): string | undefined {
  const passthrough = asRecord(payload.internal_chat_message_metadata_passthrough);
  const value = passthrough.turn_id ?? payload.turn_id ?? activeTurnId;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function assistantPhase(payload: Record<string, unknown>): ParsedMessage['assistantPhase'] {
  return payload.phase === 'commentary' || payload.phase === 'final_answer'
    ? payload.phase
    : undefined;
}

function toolNameFromLegacy(type: string): string {
  if (/ExecCommand/i.test(type)) return 'shell_command';
  if (/PatchApply/i.test(type)) return 'apply_patch';
  if (/WebSearch/i.test(type)) return 'web_search';
  if (/McpToolCall/i.test(type)) return 'mcp_tool';
  return type.replace(/(?:Begin|End)$/i, '') || 'tool';
}

export class CodexParser {
  async parseFile(filePath: string): Promise<ParsedSession> {
    const raw = await fs.readFile(filePath, 'utf8');
    const rows: RolloutRow[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line) as RolloutRow); } catch { /* tolerate a trailing partial line */ }
    }

    const stat = await fs.stat(filePath);
    const metaRow = rows.find(row => row.type === 'session_meta');
    const meta = asRecord(metaRow?.payload);
    const fallbackId = path.basename(filePath, '.jsonl').match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0]
      ?? path.basename(filePath, '.jsonl');
    const sourceMeta = asRecord(meta.source);
    const subagentSource = asRecord(sourceMeta.subagent);
    const isGuardianSession = subagentSource.other === 'guardian';
    const sessionId = String(meta.session_id ?? meta.id ?? fallbackId);
    const threadSpawnSource = asRecord(subagentSource.thread_spawn);
    const isSpawnedThread = Object.keys(threadSpawnSource).length > 0
      || (typeof meta.forked_from_id === 'string' && meta.forked_from_id.length > 0);
    const spawnInvocationBoundaryIndex = isSpawnedThread
      ? rows.findIndex(row => row.type === 'inter_agent_communication_metadata')
      : -1;

    const messages: ParsedMessage[] = [];
    const toolExecutions: ToolExecution[] = [];
    const activeTools = new Map<string, ActiveTool>();
    const tokenUsage: SessionTokenUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      models: new Set<string>(),
    };
    const tokenUsageEvents: ParsedTokenUsageEvent[] = [];
    const rolloutScope = path.basename(filePath, path.extname(filePath));
    const sourceScope = `codex:${rolloutScope}`;
    const tokenEventOccurrences = new Map<string, number>();
    const tokenDedupeOccurrences = new Map<string, number>();
    const tokenEventId = (kind: string, timestamp: number, snapshot: CodexTokenSnapshot): string => {
      const key = `${kind}-${timestamp}-${tokenSnapshotFingerprint(snapshot)}`;
      const occurrence = tokenEventOccurrences.get(key) ?? 0;
      tokenEventOccurrences.set(key, occurrence + 1);
      return `codex-${sessionId}-${rolloutScope}-token-${key}-${occurrence}`;
    };
    // For thread_spawn rollouts, only inspect the child-owned section. The
    // replayed parent can use cumulative rows even when the child invocation
    // itself uses the older last_token_usage-only format.
    const tokenFormatRows = isSpawnedThread
      ? (spawnInvocationBoundaryIndex >= 0 ? rows.slice(spawnInvocationBoundaryIndex + 1) : [])
      : rows;
    const hasCumulativeTokenRows = tokenFormatRows.some(row => {
      if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') return false;
      return tokenSnapshot(asRecord(row.payload.info).total_token_usage) !== undefined;
    });
    let previousCumulativeTokens: CodexTokenSnapshot | undefined;
    // Current Codex thread_spawn files replay the parent's complete event
    // stream before this marker. Those rows establish the cumulative
    // baseline but are not new usage by the spawned thread.
    let spawnedThreadUsageStarted = !isSpawnedThread;
    const contextCompactions: Array<{ sequence: number; compactedAt: number; summary?: string }> = [];

    let index = 0;
    let projectPath = typeof meta.cwd === 'string' ? meta.cwd : '';
    let model = '';
    let firstPrompt = '';
    let gitBranch: string | undefined;
    let activeTaskTurnId: string | undefined;
    let pendingChildTaskRun: CodexChildTaskRun | undefined;
    let spawnedThreadContentStarted = !isSpawnedThread;
    const childTaskRuns: CodexChildTaskRun[] = [];
    const collaborationCalls = new Map<string, { parentSourceTurnId: string; timestamp: number }>();
    const childActivities: CodexChildActivity[] = [];
    const git = asRecord(meta.git);
    if (typeof git.branch === 'string') gitBranch = git.branch;

    const newId = (kind: string, preferred?: unknown) =>
      `codex-${sessionId}-${kind}-${typeof preferred === 'string' && preferred ? preferred : index++}`;

    const finishTool = (callId: string, resultId: string, result: string, isError: boolean, ts: number) => {
      const active = activeTools.get(callId);
      if (!active) return;
      toolExecutions.push({
        id: `codex-${sessionId}-tool-${callId}`,
        conversationId: '',
        toolUseMessageId: active.messageId,
        toolResultMessageId: resultId,
        toolUseId: callId,
        toolName: active.name,
        inputSummary: outputText(active.input).slice(0, 500),
        outputSummary: result.slice(0, 500),
        isError,
        durationMs: ts >= active.timestamp ? ts - active.timestamp : undefined,
        timestamp: active.timestamp,
      });
      activeTools.delete(callId);
    };

    for (const row of rows) {
      const payload = asRecord(row.payload);
      const ts = asTimestamp(row.timestamp, stat.mtimeMs);

      if (row.type === 'inter_agent_communication_metadata') {
        spawnedThreadUsageStarted = true;
        spawnedThreadContentStarted = true;
        if (isSpawnedThread && payload.trigger_turn === true && pendingChildTaskRun) {
          if (!childTaskRuns.some(run => run.sourceTurnId === pendingChildTaskRun?.sourceTurnId)) {
            childTaskRuns.push(pendingChildTaskRun);
          }
          pendingChildTaskRun = undefined;
        }
        continue;
      }

      if (row.type === 'turn_context') {
        if (typeof payload.cwd === 'string') projectPath = payload.cwd;
        if (typeof payload.model === 'string') {
          model = payload.model;
          tokenUsage.models.add(model);
        }
        continue;
      }

      if (row.type === 'compacted') {
        if (isGuardianSession) continue;
        if (!spawnedThreadContentStarted) continue;
        contextCompactions.push({
          sequence: contextCompactions.length + 1,
          compactedAt: ts,
          summary: typeof payload.summary === 'string' ? payload.summary : undefined,
        });
        continue;
      }

      if (row.type === 'response_item') {
        if (isGuardianSession) continue;
        if (!spawnedThreadContentStarted) continue;
        const itemType = String(payload.type ?? '');
        if (itemType === 'message') {
          const role = String(payload.role ?? '');
          if (role !== 'user' && role !== 'assistant') continue;
          const rawText = messageContent(payload);
          const text = role === 'user' ? visibleCodexUserText(rawText) : rawText;
          if (!text) continue;
          const uuid = newId('message', payload.id);
          if (role === 'user' && !firstPrompt) {
            firstPrompt = text;
          }
          messages.push({
            uuid,
            type: role,
            role,
            timestamp: ts,
            sourceTurnId: sourceTurnId(payload, activeTaskTurnId),
            assistantPhase: role === 'assistant' ? assistantPhase(payload) : undefined,
            contentText: text,
            cwd: projectPath || undefined,
            gitBranch,
            isToolResult: false,
            depth: 0,
          });
          continue;
        }

        if (itemType === 'reasoning') {
          const summary = reasoningSummary(payload);
          if (summary) {
            messages.push({
              uuid: newId('reasoning', payload.id),
              type: 'assistant',
              role: 'assistant',
              timestamp: ts,
              sourceTurnId: sourceTurnId(payload, activeTaskTurnId),
              contentThinking: summary,
              cwd: projectPath || undefined,
              isToolResult: false,
              depth: 0,
            });
          }
          continue;
        }

        if (itemType === 'function_call' || itemType === 'custom_tool_call') {
          const callId = String(payload.call_id ?? payload.id ?? `call-${index}`);
          const name = String(payload.name ?? itemType);
          const parentSourceTurnId = sourceTurnId(payload, activeTaskTurnId);
          if (
            payload.namespace === 'collaboration'
            && (name === 'spawn_agent' || name === 'followup_task')
            && parentSourceTurnId
          ) {
            collaborationCalls.set(callId, { parentSourceTurnId, timestamp: ts });
          }
          const input = jsonish(payload.arguments ?? payload.input ?? {});
          const messageId = newId('tool-call', callId);
          const toolCall: ToolCallBlock = { id: callId, name, input };
          messages.push({
            uuid: messageId,
            type: 'assistant',
            role: 'assistant',
            timestamp: ts,
            sourceTurnId: sourceTurnId(payload, activeTaskTurnId),
            toolCalls: [toolCall],
            cwd: projectPath || undefined,
            isToolResult: false,
            depth: 0,
          });
          activeTools.set(callId, { callId, messageId, name, input, timestamp: ts });
          continue;
        }

        if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
          const callId = String(payload.call_id ?? '');
          const text = outputText(payload.output);
          const isError = Boolean(payload.is_error) || String(payload.status ?? '').toLowerCase() === 'error';
          const messageId = newId('tool-result', `${callId}-${index++}`);
          const toolResult: ToolResultBlock = { toolUseId: callId, content: text, isError };
          messages.push({
            uuid: messageId,
            type: 'user',
            role: 'user',
            timestamp: ts,
            sourceTurnId: sourceTurnId(payload, activeTaskTurnId),
            toolResults: [toolResult],
            cwd: projectPath || undefined,
            isToolResult: true,
            depth: 0,
          });
          finishTool(callId, messageId, text, isError, ts);
          continue;
        }
      }

      if (row.type === 'event_msg') {
        const eventType = String(payload.type ?? '');
        if (eventType === 'task_started') {
          activeTaskTurnId = sourceTurnId(payload, activeTaskTurnId);
          if (isSpawnedThread && activeTaskTurnId) {
            pendingChildTaskRun = { sourceTurnId: activeTaskTurnId, timestamp: ts };
          }
          continue;
        }
        if (eventType === 'task_complete') {
          const completedTurnId = sourceTurnId(payload, activeTaskTurnId);
          if (!completedTurnId || completedTurnId === activeTaskTurnId) activeTaskTurnId = undefined;
          continue;
        }
        if (eventType === 'token_count') {
          const info = asRecord(payload.info);
          const cumulative = tokenSnapshot(info.total_token_usage);
          // total_token_usage is authoritative. Codex may emit the exact same
          // token_count row repeatedly, so last_token_usage cannot be summed
          // when a cumulative counter is available.
          if (cumulative) {
            const delta = tokenDelta(cumulative, previousCumulativeTokens);
            const mergedCumulative = mergeTokenSnapshot(previousCumulativeTokens, cumulative);
            if (
              spawnedThreadUsageStarted
              && (delta.input || delta.output || delta.cacheRead || delta.reasoning)
            ) {
              // Forked Codex rollouts replay the complete cumulative history.
              // Keep a physical event id for source replacement, but give the
              // same logical before->after transition the same analytics key.
              const transition = `codex:cumulative:${tokenSnapshotFingerprint(previousCumulativeTokens)}->${tokenSnapshotFingerprint(mergedCumulative)}`;
              const transitionOccurrence = tokenDedupeOccurrences.get(transition) ?? 0;
              tokenDedupeOccurrences.set(transition, transitionOccurrence + 1);
              const event: ParsedTokenUsageEvent & { sourceScope: string } = {
                id: tokenEventId('cumulative', asTimestamp(row.timestamp, 0), cumulative),
                dedupeKey: `${transition}:${transitionOccurrence}`,
                timestamp: ts,
                inputTokens: delta.input ?? 0,
                outputTokens: delta.output ?? 0,
                cacheCreationTokens: 0,
                cacheReadTokens: delta.cacheRead ?? 0,
                reasoningTokens: delta.reasoning || undefined,
                model: model || undefined,
                source: 'codex:token_count:total_token_usage',
                sourceScope,
              };
              tokenUsageEvents.push(event);
            }
            // Missing fields mean "not reported", not zero. Preserve their
            // last cumulative values for the next snapshot that includes them.
            previousCumulativeTokens = mergedCumulative;
          } else if (!hasCumulativeTokenRows && spawnedThreadUsageStarted) {
            // Older rollouts can omit total_token_usage entirely. Only in that
            // format is last_token_usage safe to use as a per-request event.
            const last = tokenSnapshot(info.last_token_usage);
            if (last && (last.input || last.output || last.cacheRead || last.reasoning)) {
              const event: ParsedTokenUsageEvent & { sourceScope: string } = {
                id: tokenEventId('last', asTimestamp(row.timestamp, 0), last),
                timestamp: ts,
                inputTokens: last.input ?? 0,
                outputTokens: last.output ?? 0,
                cacheCreationTokens: 0,
                cacheReadTokens: last.cacheRead ?? 0,
                reasoningTokens: last.reasoning || undefined,
                model: model || undefined,
                source: 'codex:token_count:last_token_usage',
                sourceScope,
              };
              tokenUsageEvents.push(event);
            }
          }
          continue;
        }

        if (eventType === 'sub_agent_activity' && spawnedThreadContentStarted) {
          const callId = typeof payload.event_id === 'string' ? payload.event_id : '';
          const childThreadId = typeof payload.agent_thread_id === 'string'
            ? payload.agent_thread_id
            : '';
          const call = collaborationCalls.get(callId);
          if (call && childThreadId) {
            childActivities.push({
              childThreadId,
              parentSourceTurnId: call.parentSourceTurnId,
              timestamp: ts,
              callId,
            });
            collaborationCalls.delete(callId);
          }
          continue;
        }

        if (isGuardianSession) continue;
        if (!spawnedThreadContentStarted) continue;

        if (/Begin$/i.test(eventType) && typeof payload.call_id === 'string') {
          const callId = payload.call_id;
          if (activeTools.has(callId)) continue;
          const name = toolNameFromLegacy(eventType);
          const input = payload.command ?? payload.changes ?? payload.arguments ?? payload;
          const messageId = newId('legacy-tool-call', callId);
          messages.push({
            uuid: messageId,
            type: 'assistant',
            role: 'assistant',
            timestamp: ts,
            sourceTurnId: sourceTurnId(payload, activeTaskTurnId),
            toolCalls: [{ id: callId, name, input }],
            cwd: typeof payload.cwd === 'string' ? payload.cwd : projectPath || undefined,
            isToolResult: false,
            depth: 0,
          });
          activeTools.set(callId, { callId, messageId, name, input, timestamp: ts });
          continue;
        }

        if (/End$/i.test(eventType) && typeof payload.call_id === 'string') {
          const callId = payload.call_id;
          if (!activeTools.has(callId)) continue;
          const text = outputText(payload.aggregated_output ?? payload.stdout ?? payload.output ?? payload);
          const isError = payload.success === false || Number(payload.exit_code ?? 0) !== 0;
          const messageId = newId('legacy-tool-result', `${callId}-${index++}`);
          messages.push({
            uuid: messageId,
            type: 'user',
            role: 'user',
            timestamp: ts,
            sourceTurnId: sourceTurnId(payload, activeTaskTurnId),
            toolResults: [{ toolUseId: callId, content: text, isError }],
            isToolResult: true,
            depth: 0,
          });
          finishTool(callId, messageId, text, isError, ts);
        }
      }
    }

    for (const active of activeTools.values()) {
      toolExecutions.push({
        id: `codex-${sessionId}-tool-${active.callId}`,
        conversationId: '',
        toolUseMessageId: active.messageId,
        toolUseId: active.callId,
        toolName: active.name,
        inputSummary: outputText(active.input).slice(0, 500),
        isError: false,
        timestamp: active.timestamp,
      });
    }

    const timestamps = messages.map(message => message.timestamp).filter(value => value > 0);
    const startTime = timestamps.length ? Math.min(...timestamps) : asTimestamp(meta.timestamp, stat.birthtimeMs);
    const endTime = timestamps.length ? Math.max(...timestamps) : stat.mtimeMs;
    const cliVersion = typeof meta.cli_version === 'string' ? meta.cli_version : undefined;
    if (!model && typeof meta.model === 'string') model = meta.model;
    if (model) tokenUsage.models.add(model);

    // Derive the session total from the same non-cumulative events used by
    // analytics. For normal monotonic counters this is exactly the final
    // total_token_usage snapshot; it also remains correct across resets.
    tokenUsage.totalInputTokens = tokenUsageEvents.reduce((sum, event) => sum + event.inputTokens, 0);
    tokenUsage.totalOutputTokens = tokenUsageEvents.reduce((sum, event) => sum + event.outputTokens, 0);
    tokenUsage.totalCacheCreationTokens = tokenUsageEvents.reduce((sum, event) => sum + event.cacheCreationTokens, 0);
    tokenUsage.totalCacheReadTokens = tokenUsageEvents.reduce((sum, event) => sum + event.cacheReadTokens, 0);

    return {
      sessionId,
      platform: 'codex',
      projectPath,
      gitBranch,
      claudeCodeVersion: cliVersion,
      model: model || undefined,
      messages,
      toolExecutions,
      subagents: [],
      tokenUsage,
      tokenUsageEvents: tokenUsageEvents.length ? tokenUsageEvents : undefined,
      startTime,
      endTime,
      contextCompactions: contextCompactions.length ? contextCompactions : undefined,
      meta: {
        first_prompt: firstPrompt || undefined,
        cli_version: cliVersion,
        model_provider: meta.model_provider,
        source: meta.source,
        archived: filePath.includes(`${path.sep}archived_sessions${path.sep}`),
        reasoning_output_tokens: tokenUsageEvents.reduce(
          (sum, event) => sum + (event.reasoningTokens ?? 0),
          0,
        ),
        capture_usage_only: isGuardianSession || undefined,
        // Spawned/continued rollouts share the logical parent session id but
        // contain only their child-owned suffix. During a parser upgrade they
        // must be appended after the root snapshot instead of replacing it.
        capture_append_only: isSpawnedThread || undefined,
        capture_strict_native_turns: true,
        codex_rollout_id: typeof meta.id === 'string' ? meta.id : fallbackId,
        codex_parent_thread_id: typeof meta.parent_thread_id === 'string'
          ? meta.parent_thread_id
          : typeof threadSpawnSource.parent_thread_id === 'string'
            ? threadSpawnSource.parent_thread_id
            : undefined,
        codex_child_task_runs: childTaskRuns.length ? childTaskRuns : undefined,
        codex_child_activities: childActivities.length ? childActivities : undefined,
      },
    };
  }
}
