/**
 * Kimi Code Parser
 *
 * Parses wire.jsonl event streams into the unified session model.
 * Supports two on-disk protocols, dispatched per line:
 * - Legacy: {timestamp: float_seconds, message: {type, payload}}
 * - Protocol 1.4 (current): flat events {type, time: ms_epoch, ...payload},
 *   first line {"type":"metadata","protocol_version":"1.4"}
 *
 * Anti-silent-failure: when most lines cannot be classified, or no messages
 * come out of a non-trivial wire file, the session carries `warnings`.
 */

import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import type {
  ParsedSession,
  ParsedMessage,
  ParsedTokenUsageEvent,
  ToolCallBlock,
  ToolResultBlock,
  SessionTokenUsage,
} from '../../types/agent.js';
import type { ToolExecution } from '../../types/index.js';
import type {
  KimiWireLine,
  KimiSessionMetadata,
  KimiConfig,
  KimiTurnBeginPayload,
  KimiContentPartPayload,
  KimiToolCallPayload,
  KimiToolResultPayload,
  KimiStatusUpdatePayload,
  KimiSubagentEventPayload,
  KimiApprovalRequestPayload,
  KimiApprovalResponsePayload,
  Kimi14AppendMessage,
  Kimi14LoopEvent,
  Kimi14UsageRecord,
  Kimi14LlmRequest,
} from './types.js';
import os from 'os';

/** Protocol 1.4 event types we know but intentionally do not store. */
const KNOWN_STRUCTURAL_14 = new Set([
  'metadata',
  'config.update',
  'turn.prompt',          // duplicated by the following context.append_message
  'turn.steer',           // duplicated by the following context.append_message
  'tools.set_active_tools',
  'tools.update_store',
  'llm.tools_snapshot',
  'swarm_mode.enter',
  'swarm_mode.exit',
  'plan_mode.enter',
  'plan_mode.exit',
  'permission.set_mode',
  'permission.record_approval_result',
  'turn.cancel',
]);

export interface KimiParseContext {
  /** Extra fields merged into ParsedSession.meta (state.json etc.). */
  meta?: Record<string, unknown>;
  /** Agent directory name ('main', 'agent-0', …) for the agents/ layout. */
  agentName?: string;
}

export class KimiCodeParser {

  /**
   * Legacy entry point: session directory containing wire.jsonl directly.
   */
  async parseSessionDir(sessionDir: string): Promise<ParsedSession> {
    const wireFile = path.join(sessionDir, 'wire.jsonl');
    if (!await fs.pathExists(wireFile)) {
      throw new Error(`wire.jsonl not found in ${sessionDir}`);
    }
    const content = await fs.readFile(wireFile, 'utf-8');
    const sessionId = path.basename(sessionDir);
    const hashDir = path.basename(path.dirname(sessionDir));
    const projectPath = await this.resolveProjectPath(hashDir);
    return this.parseWireContent(content, {
      sessionId,
      projectPath,
      metadata: await this.readLegacyMetadata(sessionDir),
    });
  }

  /**
   * Legacy streaming variant kept for large old-layout files.
   */
  async parseSessionDirStream(sessionDir: string): Promise<ParsedSession> {
    const wireFile = path.join(sessionDir, 'wire.jsonl');
    if (!await fs.pathExists(wireFile)) {
      throw new Error(`wire.jsonl not found in ${sessionDir}`);
    }

    const lines: KimiWireLine[] = [];
    let badJsonLines = 0;
    const fileStream = fs.createReadStream(wireFile);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch { badJsonLines++; }
    }

    const sessionId = path.basename(sessionDir);
    const hashDir = path.basename(path.dirname(sessionDir));
    const projectPath = await this.resolveProjectPath(hashDir);

    return this.buildSession(sessionId, lines, badJsonLines, {
      projectPath,
      metadata: await this.readLegacyMetadata(sessionDir),
    });
  }

  /**
   * Current entry point: parse one agents/<name>/wire.jsonl file.
   */
  async parseWireFile(
    wirePath: string,
    options: { sessionId: string; projectPath: string } & KimiParseContext,
  ): Promise<ParsedSession> {
    const content = await fs.readFile(wirePath, 'utf-8');
    return this.parseWireContent(content, options);
  }

  /**
   * Parse raw wire.jsonl content. Pure — usable from tests without fixtures on disk.
   */
  parseWireContent(
    content: string,
    options: {
      sessionId: string;
      projectPath: string;
      metadata?: KimiSessionMetadata;
    } & KimiParseContext,
  ): ParsedSession {
    const lines: KimiWireLine[] = [];
    let badJsonLines = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch { badJsonLines++; }
    }
    return this.buildSession(options.sessionId, lines, badJsonLines, options);
  }

  private async readLegacyMetadata(sessionDir: string): Promise<KimiSessionMetadata> {
    const metaFile = path.join(sessionDir, 'metadata.json');
    try {
      if (await fs.pathExists(metaFile)) {
        const raw = await fs.readFile(metaFile, 'utf-8');
        if (raw.trim()) return JSON.parse(raw);
      }
    } catch { /* ignore */ }
    return {};
  }

  /**
   * Resolve project path from hash directory name via legacy ~/.kimi/kimi.json
   */
  private async resolveProjectPath(hashDir: string): Promise<string> {
    try {
      const configFile = path.join(os.homedir(), '.kimi', 'kimi.json');
      if (!await fs.pathExists(configFile)) return '';
      const config: KimiConfig = await fs.readJSON(configFile);
      if (!config.work_dirs) return '';

      for (const wd of config.work_dirs) {
        const hash = crypto.createHash('md5').update(wd.path).digest('hex');
        if (hash === hashDir) return wd.path;
      }
    } catch { /* ignore */ }
    return '';
  }

  private buildSession(
    sessionId: string,
    lines: KimiWireLine[],
    badJsonLines: number,
    options: {
      projectPath: string;
      metadata?: KimiSessionMetadata;
    } & KimiParseContext,
  ): ParsedSession {
    const { projectPath, metadata = {}, meta: extraMeta, agentName } = options;
    const messages: ParsedMessage[] = [];
    const toolExecutions: ToolExecution[] = [];
    const tokenUsage: SessionTokenUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      models: new Set(),
    };
    const tokenUsageEvents: ParsedTokenUsageEvent[] = [];
    type ProtocolUsageCandidate = {
      kind: 'step.end' | 'usage.record';
      event: ParsedTokenUsageEvent;
      correlationKeys: Set<string>;
    };
    // Keep the physical token-bearing order. A usage.record may replace only
    // the immediately preceding step.end fallback, never any same-valued event
    // inside an arbitrary time window.
    const protocolUsageCandidates: ProtocolUsageCandidate[] = [];
    const sourceScope = `${sessionId}\u001f${agentName ?? 'session'}`;
    const sourceScopeHash = crypto.createHash('sha256').update(sourceScope).digest('hex').slice(0, 16);
    const eventFingerprintOccurrences = new Map<string, number>();

    const correlationKeysFor = (
      value: Record<string, unknown>,
      options: { stepUuidIsUuid?: boolean } = {},
    ): Set<string> => {
      const keys = new Set<string>();
      const add = (prefix: string, raw: unknown) => {
        if (typeof raw === 'string' && raw) keys.add(`${prefix}:${raw}`);
        else if (typeof raw === 'number' && Number.isFinite(raw)) keys.add(`${prefix}:${raw}`);
      };
      add('step', value.stepUuid);
      add('step', value.stepId);
      if (options.stepUuidIsUuid) add('step', value.uuid);
      add('invocation', value.invocationId);
      add('invocation', value.invocation_id);
      add('request', value.requestId);
      add('request', value.request_id);
      add('turn', value.turnId);
      add('turn', value.turn_id);
      const turn = value.turnId ?? value.turn_id;
      if ((typeof turn === 'string' || typeof turn === 'number') && value.step !== undefined) {
        add('turn-step', `${turn}:${String(value.step)}`);
      }
      return keys;
    };

    const createUsageEvent = (
      kind: string,
      timestamp: number,
      usage: { input: number; output: number; cacheCreation: number; cacheRead: number },
      eventModel: string | undefined,
      source: string,
      semanticIdentity?: string,
    ): ParsedTokenUsageEvent => {
      // Line numbers are deliberately excluded: unrelated wire events may be
      // inserted between rescans. The local ordinal retains genuinely repeated
      // equal invocations without coupling ids to unrelated lines.
      const fingerprint = JSON.stringify([
        kind,
        semanticIdentity ?? '',
        timestamp,
        usage.input,
        usage.output,
        usage.cacheCreation,
        usage.cacheRead,
        eventModel ?? '',
      ]);
      const occurrence = eventFingerprintOccurrences.get(fingerprint) ?? 0;
      eventFingerprintOccurrences.set(fingerprint, occurrence + 1);
      const eventHash = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 20);
      return {
        id: `kimi-${sourceScopeHash}-${kind}-${eventHash}${occurrence ? `-${occurrence}` : ''}`,
        timestamp,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheCreationTokens: usage.cacheCreation,
        cacheReadTokens: usage.cacheRead,
        model: eventModel,
        source,
      };
    };

    let model: string | undefined;
    let protocolVersion: string | undefined;
    let msgIndex = 0;
    let unrecognizedLines = 0;
    const unrecognizedTypes = new Map<string, number>();

    // Track active tool calls for pairing
    const activeToolCalls = new Map<string, {
      messageId: string;
      name: string;
      input: string;
      timestamp: number;
      displayData?: any[];
    }>();

    // Track compaction events
    const contextCompactions: Array<{ sequence: number; compactedAt: number; summary?: string }> = [];
    let compactionBeginTs: number | null = null;
    let compactionSeq = 0;

    // Track peak context usage
    let peakContextUsage = 0;

    const noteUnrecognized = (kind: string) => {
      unrecognizedLines++;
      unrecognizedTypes.set(kind, (unrecognizedTypes.get(kind) || 0) + 1);
    };

    // ==================== Protocol 1.4 handlers ====================

    const handle14AppendMessage = (line: KimiWireLine, ts: number) => {
      const p = line as unknown as Kimi14AppendMessage;
      const msg = p.message;
      if (!msg) return;
      const text = (msg.content || [])
        .map(part => (typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
      if (!text) return;
      const originKind = msg.origin?.kind || 'user';
      const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;

      if (originKind === 'injection') {
        // <system-reminder> style context injections — system events, not user input
        messages.push({
          uuid,
          type: 'system',
          role: 'system',
          timestamp: ts,
          contentText: text,
          isToolResult: false,
          depth: 0,
          systemSubtype: 'injection',
        });
        return;
      }
      if (originKind === 'background_task') {
        // Background-task notifications mirrored into context
        messages.push({
          uuid,
          type: 'progress',
          role: 'system',
          timestamp: ts,
          contentText: text,
          isToolResult: false,
          depth: 0,
          systemSubtype: 'background_task',
        });
        return;
      }
      // 'user' and 'system_trigger' (a subagent's task prompt) are real input
      messages.push({
        uuid,
        type: 'user',
        role: 'user',
        timestamp: ts,
        contentText: text,
        isToolResult: false,
        depth: 0,
      });
    };

    const handle14LoopEvent = (line: KimiWireLine, ts: number, lineIndex: number) => {
      const event = (line as { event?: Kimi14LoopEvent }).event;
      if (!event || !event.type) {
        noteUnrecognized('context.append_loop_event');
        return;
      }
      switch (event.type) {
        case 'step.begin':
          // structural
          return;

        case 'step.end': {
          const u = event.usage;
          if (u) {
            const input = (u.inputOther || 0) + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
            const output = u.output || 0;
            const cacheCreation = u.inputCacheCreation || 0;
            const cacheRead = u.inputCacheRead || 0;
            if (input || output || cacheCreation || cacheRead) {
              const correlationKeys = correlationKeysFor(event as unknown as Record<string, unknown>, {
                stepUuidIsUuid: true,
              });
              const semanticIdentity = [...correlationKeys].sort().join('|');
              protocolUsageCandidates.push({
                kind: 'step.end',
                correlationKeys,
                event: createUsageEvent(
                  'step-end',
                  ts,
                  { input, output, cacheCreation, cacheRead },
                  model,
                  'kimi-code:step.end',
                  semanticIdentity || undefined,
                ),
              });
            }
          }
          return;
        }

        case 'content.part': {
          const part = event.part;
          if (!part || !part.type) {
            noteUnrecognized(`loop:content.part`);
            return;
          }
          const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
          if (part.type === 'think') {
            messages.push({
              uuid,
              type: 'assistant',
              role: 'assistant',
              timestamp: ts,
              contentThinking: part.think || '',
              isToolResult: false,
              depth: 0,
            });
          } else if (part.type === 'text') {
            messages.push({
              uuid,
              type: 'assistant',
              role: 'assistant',
              timestamp: ts,
              contentText: part.text || '',
              isToolResult: false,
              depth: 0,
            });
          }
          // other part types (e.g. images) are known-but-unstored
          return;
        }

        case 'tool.call': {
          const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
          const toolName = event.name || 'unknown';
          const toolArgs = event.args === undefined
            ? ''
            : typeof event.args === 'string' ? event.args : JSON.stringify(event.args);
          const toolCallId = event.toolCallId || event.uuid || `tc-${msgIndex}`;

          const toolCall: ToolCallBlock = { id: toolCallId, name: toolName, input: event.args ?? toolArgs };
          messages.push({
            uuid,
            type: 'assistant',
            role: 'assistant',
            timestamp: ts,
            toolCalls: [toolCall],
            isToolResult: false,
            depth: 0,
          });
          activeToolCalls.set(toolCallId, {
            messageId: uuid,
            name: toolName,
            input: toolArgs,
            timestamp: ts,
          });
          return;
        }

        case 'tool.result': {
          const uuid = `kimi-${sessionId}-msg-${msgIndex++}`;
          const toolCallId = event.toolCallId || event.parentUuid || '';
          const rv = event.result || {};
          const rawOutput = typeof rv.output === 'string'
            ? rv.output
            : rv.output === undefined || rv.output === null
              ? ''
              : JSON.stringify(rv.output);
          const output = rv.note ? `${rawOutput}${rawOutput ? '\n' : ''}${rv.note}` : rawOutput;
          const isError = rv.isError === true;

          const toolResult: ToolResultBlock = { toolUseId: toolCallId, content: output, isError };
          messages.push({
            uuid,
            type: 'user',
            role: 'user',
            timestamp: ts,
            toolResults: [toolResult],
            isToolResult: true,
            depth: 0,
          });

          const call = activeToolCalls.get(toolCallId);
          if (call) {
            toolExecutions.push({
              id: toolCallId,
              conversationId: '',
              toolUseMessageId: call.messageId,
              toolResultMessageId: uuid,
              toolUseId: toolCallId,
              toolName: call.name,
              inputSummary: call.input.slice(0, 500),
              outputSummary: output.slice(0, 500),
              isError,
              durationMs: ts > 0 && call.timestamp > 0 ? ts - call.timestamp : undefined,
              timestamp: call.timestamp,
            });
            activeToolCalls.delete(toolCallId);
          }
          return;
        }

        default:
          noteUnrecognized(`loop:${event.type}`);
      }
    };

    const handle14Event = (line: KimiWireLine, lineIndex: number) => {
      const type = line.type || '';
      const ts = typeof line.time === 'number' ? Math.round(line.time) : 0;

      if (type === 'metadata') {
        protocolVersion = line.protocol_version;
        return;
      }
      if (type === 'context.append_message') {
        handle14AppendMessage(line, ts);
        return;
      }
      if (type === 'context.append_loop_event') {
        handle14LoopEvent(line, ts, lineIndex);
        return;
      }
      if (type === 'usage.record') {
        const p = line as unknown as Kimi14UsageRecord;
        const u = p.usage;
        if (u) {
          const input = (u.inputOther || 0) + (u.inputCacheRead || 0) + (u.inputCacheCreation || 0);
          const output = u.output || 0;
          const cacheCreation = u.inputCacheCreation || 0;
          const cacheRead = u.inputCacheRead || 0;
          tokenUsage.totalInputTokens += input;
          tokenUsage.totalOutputTokens += output;
          tokenUsage.totalCacheCreationTokens += cacheCreation;
          tokenUsage.totalCacheReadTokens += cacheRead;
          if (input || output || cacheCreation || cacheRead) {
            const rawRecord = line as unknown as Record<string, unknown>;
            const correlationKeys = correlationKeysFor(rawRecord);
            const semanticIdentity = [...correlationKeys].sort().join('|');
            const event = createUsageEvent(
              'usage-record',
              ts,
              { input, output, cacheCreation, cacheRead },
              p.model || model,
              'kimi-code:usage.record',
              semanticIdentity || undefined,
            );
            tokenUsageEvents.push(event);
            protocolUsageCandidates.push({
              kind: 'usage.record',
              event,
              correlationKeys,
            });
          }
        }
        if (p.model) {
          tokenUsage.models.add(p.model);
          if (!model) model = p.model;
        }
        return;
      }
      if (type === 'llm.request') {
        const p = line as unknown as Kimi14LlmRequest;
        const m = p.modelAlias || p.model;
        if (m) {
          tokenUsage.models.add(m);
          if (!model) model = m;
        }
        return;
      }
      if (KNOWN_STRUCTURAL_14.has(type)) return;
      noteUnrecognized(type || '(missing type)');
    };

    // ==================== Main per-line dispatch ====================

    for (const [lineIndex, line] of lines.entries()) {
      if (line.message && typeof line.message.type === 'string') {
        // Legacy envelope protocol
        this.handleLegacyEvent(line, sessionId, messages, toolExecutions, tokenUsage, activeToolCalls, {
          nextMsgIndex: () => msgIndex++,
          noteUnrecognized: () => { /* legacy defaults are structural skips, not unrecognized */ },
          compaction: {
            setBegin: (ts: number) => { compactionBeginTs = ts; },
            end: (ts: number, summary?: string) => {
              compactionSeq++;
              contextCompactions.push({ sequence: compactionSeq, compactedAt: compactionBeginTs || ts, summary });
              compactionBeginTs = null;
            },
          },
          peakContext: (value: number) => { if (value > peakContextUsage) peakContextUsage = value; },
          emitTokenUsage: (source, timestamp, usage, suffix) => {
            if (!usage.input && !usage.output && !usage.cacheCreation && !usage.cacheRead) return;
            tokenUsageEvents.push(createUsageEvent(
              `legacy-${source}`,
              timestamp,
              usage,
              model,
              `kimi-code:${source}`,
              suffix,
            ));
          },
        });
        continue;
      }
      if (typeof line.type === 'string') {
        handle14Event(line, lineIndex);
        continue;
      }
      noteUnrecognized('(unrecognized line shape)');
    }

    // Pair only adjacent token-bearing protocol events. Non-token lines may sit
    // between them. Shared invocation ids win when present; otherwise exact
    // usage equality and strict order are the protocol fallback. No time window
    // is used, so a legitimate pair may cross midnight.
    const matchedStepEvents = new Set<ParsedTokenUsageEvent>();
    for (let index = 0; index < protocolUsageCandidates.length - 1; index++) {
      const step = protocolUsageCandidates[index];
      const record = protocolUsageCandidates[index + 1];
      if (step.kind !== 'step.end' || record.kind !== 'usage.record') continue;
      const sameUsage = step.event.inputTokens === record.event.inputTokens
        && step.event.outputTokens === record.event.outputTokens
        && step.event.cacheCreationTokens === record.event.cacheCreationTokens
        && step.event.cacheReadTokens === record.event.cacheReadTokens;
      if (!sameUsage) continue;
      const hasKeysOnBothSides = step.correlationKeys.size > 0 && record.correlationKeys.size > 0;
      const sharesKey = [...step.correlationKeys].some(key => record.correlationKeys.has(key));
      if (hasKeysOnBothSides && !sharesKey) continue;
      matchedStepEvents.add(step.event);
    }

    for (const candidate of protocolUsageCandidates) {
      if (candidate.kind !== 'step.end' || matchedStepEvents.has(candidate.event)) continue;
      const stepEvent = candidate.event;
      tokenUsage.totalInputTokens += stepEvent.inputTokens;
      tokenUsage.totalOutputTokens += stepEvent.outputTokens;
      tokenUsage.totalCacheCreationTokens += stepEvent.cacheCreationTokens;
      tokenUsage.totalCacheReadTokens += stepEvent.cacheReadTokens;
      tokenUsageEvents.push(stepEvent);
    }

    const timestamps = messages.filter(m => m.timestamp > 0).map(m => m.timestamp);
    const startTime = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
    const endTime = timestamps.length > 0 ? Math.max(...timestamps) : undefined;

    // ==================== Anti-silent-failure warnings ====================

    const warnings: string[] = [];
    const totalLines = lines.length + badJsonLines;
    const unrecognizedTotal = unrecognizedLines + badJsonLines;
    if (totalLines > 0 && unrecognizedTotal / totalLines > 0.5) {
      const top = [...unrecognizedTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([t, c]) => `${t}×${c}`).join(', ');
      warnings.push(
        `kimi-code wire: ${unrecognizedTotal}/${totalLines} lines unrecognized (${(unrecognizedTotal * 100 / totalLines).toFixed(0)}%)` +
        (top ? ` — top: ${top}` : '') +
        '. Parser may be out of date with the wire protocol.',
      );
    }
    if (lines.length >= 5 && messages.length === 0) {
      warnings.push(`kimi-code wire: 0 messages extracted from ${lines.length} parsed lines — silent-empty parse suspected.`);
    }

    // Title fallback for the converter's meta.first_prompt chain
    const meta: Record<string, unknown> = { ...extraMeta };
    if (protocolVersion) meta.protocol_version = protocolVersion;
    if (agentName) meta.kimi_agent = agentName;
    if (metadata.archived) {
      meta.archived = true;
      if (metadata.archived_at) meta.archived_at = metadata.archived_at;
    }

    return {
      sessionId,
      platform: 'kimi-code',
      projectPath,
      model,
      messages,
      toolExecutions,
      subagents: [],
      tokenUsage,
      tokenUsageEvents: tokenUsageEvents.length > 0 ? tokenUsageEvents : undefined,
      startTime,
      endTime,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
      contextCompactions: contextCompactions.length > 0 ? contextCompactions : undefined,
      peakContextUsage: peakContextUsage > 0 ? peakContextUsage : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Legacy envelope protocol (message.type/payload). Behavior unchanged.
   */
  private handleLegacyEvent(
    line: KimiWireLine,
    sessionId: string,
    messages: ParsedMessage[],
    toolExecutions: ToolExecution[],
    tokenUsage: SessionTokenUsage,
    activeToolCalls: Map<string, { messageId: string; name: string; input: string; timestamp: number; displayData?: any[] }>,
    hooks: {
      nextMsgIndex: () => number;
      noteUnrecognized: () => void;
      compaction: { setBegin: (ts: number) => void; end: (ts: number, summary?: string) => void };
      peakContext: (value: number) => void;
      emitTokenUsage: (
        source: string,
        timestamp: number,
        usage: { input: number; output: number; cacheCreation: number; cacheRead: number },
        suffix?: string,
      ) => void;
    },
  ): void {
    const msgType = line.message!.type;
    const payload = line.message!.payload || {};
    // Kimi legacy timestamps are float seconds
    const ts = line.timestamp ? Math.round(line.timestamp * 1000) : 0;

    switch (msgType) {
      case 'TurnBegin': {
        const p = payload as KimiTurnBeginPayload;
        const userText = typeof p.user_input === 'string'
          ? p.user_input
          : p.user_input
            ?.map(part => part.text)
            .filter(Boolean)
            .join('\n') || '';
        const uuid = `kimi-${sessionId}-msg-${hooks.nextMsgIndex()}`;
        messages.push({
          uuid,
          type: 'user',
          role: 'user',
          timestamp: ts,
          contentText: userText,
          isToolResult: false,
          depth: 0,
        });
        break;
      }

      case 'ContentPart': {
        const p = payload as KimiContentPartPayload;
        const uuid = `kimi-${sessionId}-msg-${hooks.nextMsgIndex()}`;
        if (p.type === 'think') {
          messages.push({
            uuid,
            type: 'assistant',
            role: 'assistant',
            timestamp: ts,
            contentThinking: p.think || '',
            isToolResult: false,
            depth: 0,
          });
        } else {
          messages.push({
            uuid,
            type: 'assistant',
            role: 'assistant',
            timestamp: ts,
            contentText: p.text || '',
            isToolResult: false,
            depth: 0,
          });
        }
        break;
      }

      case 'ToolCall': {
        const p = payload as KimiToolCallPayload;
        const idx = hooks.nextMsgIndex();
        const uuid = `kimi-${sessionId}-msg-${idx}`;
        const toolName = p.function?.name || 'unknown';
        const toolArgs = p.function?.arguments || '';
        const toolCallId = p.id || `tc-${idx}`;

        const toolCall: ToolCallBlock = {
          id: toolCallId,
          name: toolName,
          input: toolArgs,
        };
        messages.push({
          uuid,
          type: 'assistant',
          role: 'assistant',
          timestamp: ts,
          toolCalls: [toolCall],
          isToolResult: false,
          depth: 0,
        });
        activeToolCalls.set(toolCallId, {
          messageId: uuid,
          name: toolName,
          input: toolArgs,
          timestamp: ts,
        });
        break;
      }

      case 'ToolCallPart': {
        // Streaming tool call arguments — not used for final output
        break;
      }

      case 'ToolResult': {
        const p = payload as KimiToolResultPayload;
        const uuid = `kimi-${sessionId}-msg-${hooks.nextMsgIndex()}`;
        const toolCallId = p.tool_call_id || '';
        const rv = p.return_value || { is_error: false, output: '' };
        const rawOutput = rv.output || rv.message || '';
        const outputParts: string[] = [];

        // Main output
        const mainOutput = typeof rawOutput === 'string'
          ? rawOutput
          : Array.isArray(rawOutput)
            ? rawOutput.map((o: any) => typeof o === 'string' ? o : o.text || '').join('\n')
            : String(rawOutput);
        if (mainOutput) outputParts.push(mainOutput);

        // Extract display data (diffs, briefs) for output summary
        if (rv.display && Array.isArray(rv.display)) {
          for (const item of rv.display as any[]) {
            if (item.type === 'diff' && item.path) {
              outputParts.push(`[diff ${item.path}]`);
            } else if (item.type === 'brief' && item.text) {
              outputParts.push(item.text);
            }
          }
        }

        const output = outputParts.join('\n');
        const isError = rv.is_error || false;

        const toolResult: ToolResultBlock = {
          toolUseId: toolCallId,
          content: output,
          isError,
        };
        messages.push({
          uuid,
          type: 'user',
          role: 'user',
          timestamp: ts,
          toolResults: [toolResult],
          isToolResult: true,
          depth: 0,
        });

        // Complete tool execution chain with display data
        const call = activeToolCalls.get(toolCallId);
        if (call) {
          toolExecutions.push({
            id: toolCallId,
            conversationId: '',
            toolUseMessageId: call.messageId,
            toolResultMessageId: uuid,
            toolUseId: toolCallId,
            toolName: call.name,
            inputSummary: call.input.slice(0, 500),
            outputSummary: output.slice(0, 500),
            displayData: rv.display && Array.isArray(rv.display) ? rv.display : undefined,
            isError,
            durationMs: ts > 0 && call.timestamp > 0 ? ts - call.timestamp : undefined,
            timestamp: call.timestamp,
          });
          activeToolCalls.delete(toolCallId);
        }
        break;
      }

      case 'StatusUpdate': {
        const p = payload as KimiStatusUpdatePayload;
        if (p.token_usage) {
          const tu = p.token_usage;
          const usage = {
            input: (tu.input_other || 0) + (tu.input_cache_read || 0) + (tu.input_cache_creation || 0),
            output: tu.output || 0,
            cacheCreation: tu.input_cache_creation || 0,
            cacheRead: tu.input_cache_read || 0,
          };
          tokenUsage.totalInputTokens += usage.input;
          tokenUsage.totalOutputTokens += usage.output;
          tokenUsage.totalCacheCreationTokens += usage.cacheCreation;
          tokenUsage.totalCacheReadTokens += usage.cacheRead;
          // Legacy StatusUpdate usage is a per-update value (the pre-existing
          // parser therefore sums it); preserve that protocol semantics while
          // retaining its source timestamp for daily analytics.
          hooks.emitTokenUsage('StatusUpdate', ts, usage);
        }
        if (p.context_usage) hooks.peakContext(p.context_usage);
        break;
      }

      case 'SubagentEvent': {
        const p = payload as KimiSubagentEventPayload;
        const subEvent = p.event;
        const subType = subEvent?.type;
        const subPayload = subEvent?.payload || {};
        const taskToolCallId = p.task_tool_call_id;

        if (subType === 'ToolCall') {
          // Subagent tool call → record as tool execution
          const idx = hooks.nextMsgIndex();
          const uuid = `kimi-${sessionId}-msg-${idx}`;
          const subTc = subPayload as KimiToolCallPayload;
          const toolName = subTc.function?.name || 'unknown';
          const toolArgs = subTc.function?.arguments || '';
          const toolCallId = subTc.id || `sub-tc-${idx}`;
          messages.push({
            uuid,
            type: 'assistant',
            role: 'assistant',
            timestamp: ts,
            toolCalls: [{ id: toolCallId, name: toolName, input: toolArgs }],
            isToolResult: false,
            depth: 1,
            agentId: taskToolCallId,
          });
          activeToolCalls.set(toolCallId, {
            messageId: uuid,
            name: toolName,
            input: toolArgs,
            timestamp: ts,
          });
        } else if (subType === 'ToolResult') {
          // Subagent tool result → complete execution chain
          const uuid = `kimi-${sessionId}-msg-${hooks.nextMsgIndex()}`;
          const subTr = subPayload as KimiToolResultPayload;
          const toolCallId = subTr.tool_call_id || '';
          const rv = subTr.return_value || { is_error: false, output: '' };
          const rawOut = rv.output || rv.message || '';
          const outParts: string[] = [];
          const mainOut = typeof rawOut === 'string' ? rawOut
            : Array.isArray(rawOut) ? rawOut.map((o: any) => typeof o === 'string' ? o : o.text || '').join('\n')
            : String(rawOut);
          if (mainOut) outParts.push(mainOut);
          if (rv.display && Array.isArray(rv.display)) {
            for (const item of rv.display as any[]) {
              if (item.type === 'diff' && item.path) outParts.push(`[diff ${item.path}]`);
              else if (item.type === 'brief' && item.text) outParts.push(item.text);
            }
          }
          const output = outParts.join('\n');
          const isError = rv.is_error || false;

          messages.push({
            uuid,
            type: 'user',
            role: 'user',
            timestamp: ts,
            toolResults: [{ toolUseId: toolCallId, content: output, isError }],
            isToolResult: true,
            depth: 1,
            agentId: taskToolCallId,
          });

          const call = activeToolCalls.get(toolCallId);
          if (call) {
            toolExecutions.push({
              id: toolCallId,
              conversationId: '',
              toolUseMessageId: call.messageId,
              toolResultMessageId: uuid,
              toolUseId: toolCallId,
              toolName: call.name,
              inputSummary: call.input.slice(0, 500),
              outputSummary: output.slice(0, 500),
              displayData: rv.display && Array.isArray(rv.display) ? rv.display : undefined,
              isError,
              durationMs: ts > 0 && call.timestamp > 0 ? ts - call.timestamp : undefined,
              timestamp: call.timestamp,
            });
            activeToolCalls.delete(toolCallId);
          }
        } else if (subType === 'StatusUpdate') {
          // Subagent token usage
          const subStatus = subPayload as KimiStatusUpdatePayload;
          if (subStatus.token_usage) {
            const tu = subStatus.token_usage;
            const usage = {
              input: (tu.input_other || 0) + (tu.input_cache_read || 0) + (tu.input_cache_creation || 0),
              output: tu.output || 0,
              cacheCreation: tu.input_cache_creation || 0,
              cacheRead: tu.input_cache_read || 0,
            };
            tokenUsage.totalInputTokens += usage.input;
            tokenUsage.totalOutputTokens += usage.output;
            tokenUsage.totalCacheCreationTokens += usage.cacheCreation;
            tokenUsage.totalCacheReadTokens += usage.cacheRead;
            hooks.emitTokenUsage('SubagentEvent.StatusUpdate', ts, usage, taskToolCallId);
          }
          if (subStatus.context_usage) hooks.peakContext(subStatus.context_usage);
        } else if (subType === 'ContentPart') {
          // Subagent content → keep as message with depth=1
          const uuid = `kimi-${sessionId}-msg-${hooks.nextMsgIndex()}`;
          const subCp = subPayload as KimiContentPartPayload;
          if (subCp.type === 'think') {
            messages.push({
              uuid, type: 'assistant', role: 'assistant', timestamp: ts,
              contentThinking: subCp.think || '', isToolResult: false,
              depth: 1, agentId: taskToolCallId,
            });
          } else {
            messages.push({
              uuid, type: 'assistant', role: 'assistant', timestamp: ts,
              contentText: subCp.text || '', isToolResult: false,
              depth: 1, agentId: taskToolCallId,
            });
          }
        } else {
          // Other subagent events → progress
          const uuid = `kimi-${sessionId}-msg-${hooks.nextMsgIndex()}`;
          messages.push({
            uuid, type: 'progress', role: 'system', timestamp: ts,
            contentText: `[Subagent] ${subType || 'unknown'}`,
            isToolResult: false, depth: 1, agentId: taskToolCallId,
          });
        }
        break;
      }

      case 'ApprovalRequest': {
        const p = payload as KimiApprovalRequestPayload;
        const uuid = `kimi-${sessionId}-msg-${hooks.nextMsgIndex()}`;
        messages.push({
          uuid,
          type: 'system',
          role: 'system',
          timestamp: ts,
          contentText: `[Approval] ${p.action}: ${p.description || ''}`.slice(0, 500),
          isToolResult: false,
          depth: 0,
        });
        break;
      }

      case 'ApprovalResponse': {
        const p = payload as KimiApprovalResponsePayload;
        const uuid = `kimi-${sessionId}-msg-${hooks.nextMsgIndex()}`;
        messages.push({
          uuid,
          type: 'system',
          role: 'system',
          timestamp: ts,
          contentText: `[Approval] Response: ${p.response}`,
          isToolResult: false,
          depth: 0,
        });
        break;
      }

      case 'CompactionBegin': {
        hooks.compaction.setBegin(ts);
        const uuid = `kimi-${sessionId}-msg-${hooks.nextMsgIndex()}`;
        messages.push({
          uuid,
          type: 'system',
          role: 'system',
          timestamp: ts,
          contentText: '[Context Compaction] Begin',
          isToolResult: false,
          depth: 0,
        });
        break;
      }

      case 'CompactionEnd': {
        hooks.compaction.end(ts, (payload as any)?.summary);
        const uuid = `kimi-${sessionId}-msg-${hooks.nextMsgIndex()}`;
        messages.push({
          uuid,
          type: 'system',
          role: 'system',
          timestamp: ts,
          contentText: '[Context Compaction] End',
          isToolResult: false,
          depth: 0,
        });
        break;
      }

      // StepBegin, StepInterrupted, TurnEnd — skip (structural, not content)
      default:
        break;
    }
  }
}
