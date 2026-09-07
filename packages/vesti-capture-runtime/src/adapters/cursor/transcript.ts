/**
 * Cursor 2.x agent transcripts (verified on-disk, 2026-07):
 *
 *   ~/.cursor/projects/<project-slug>/agent-transcripts/<agentId>/
 *     <agentId>.jsonl            — main conversation, one JSON per line:
 *                                  {"role":"user"|"assistant","message":{content:[...]}}
 *                                  and {"type":"turn_ended",...} events
 *     subagents/<childId>.jsonl  — one file per spawned subagent (lineage is
 *                                  literally the directory layout)
 *
 *   ~/.cursor/chats/<workspace-md5>/<agentId>/
 *     meta.json                  — title / cwd / createdAtMs / updatedAtMs
 *     store.db (blobs+meta)      — meta.'0' is hex-encoded JSON carrying
 *                                  lastUsedModel and (on children)
 *                                  subagentInfo{parentAgentId,typeName,toolCallId}
 *
 * Recent Cursor versions stopped writing these conversations to state.vscdb,
 * so this sidecar is the only local source for them. Lines carry no
 * timestamps or usage; user text embeds <timestamp> tags we anchor on, and
 * token totals come from the shared character estimate.
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { ParsedMessage, ParsedSession, SessionTokenUsage, SubagentRef } from '../../types/agent.js';
import type { ToolExecution } from '../../types/index.js';
import { estimateTokensFromText } from './estimate.js';

type JsonObject = Record<string, unknown>;

interface ChatMeta {
  title?: string;
  cwd?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  model?: string;
  subagent?: { parentAgentId?: string; typeName?: string; toolCallId?: string };
}

function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** Parses Cursor's inline "<timestamp>Tuesday, Jul 21, 2026, 3:19 AM (UTC-7)</timestamp>" anchors. */
export function parseInlineTimestamp(text: string): number | null {
  const match = /<timestamp>[^,<]*,\s*(\w{3})\w*\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)<\/timestamp>/.exec(text);
  if (!match) return null;
  const month = MONTHS[match[1]];
  if (month === undefined) return null;
  let hour = Number(match[4]) % 12;
  if (match[6] === 'PM') hour += 12;
  const offsetMinutes = Number(match[7]) * 60 + (match[7].startsWith('-') ? -1 : 1) * Number(match[8] ?? 0);
  return Date.UTC(Number(match[3]), month, Number(match[2]), hour, Number(match[5])) - offsetMinutes * 60_000;
}

export class CursorTranscriptParser {
  constructor(private readonly cursorHome = path.join(os.homedir(), '.cursor')) {}

  /** All main transcript files under ~/.cursor/projects/<slug>/agent-transcripts. */
  async listMainTranscripts(): Promise<string[]> {
    const projectsRoot = path.join(this.cursorHome, 'projects');
    if (!(await fs.pathExists(projectsRoot))) return [];
    const files: string[] = [];
    for (const project of await fs.readdir(projectsRoot)) {
      const transcriptsDir = path.join(projectsRoot, project, 'agent-transcripts');
      if (!(await fs.pathExists(transcriptsDir))) continue;
      for (const agentId of await fs.readdir(transcriptsDir)) {
        const main = path.join(transcriptsDir, agentId, `${agentId}.jsonl`);
        if (await fs.pathExists(main)) files.push(main);
      }
    }
    return files;
  }

  /**
   * Parses one transcript source. A main file yields the main session plus
   * every subagents/<child>.jsonl session (with lineage mounted on the
   * parent); a subagents/ file yields just that child session, so watcher
   * events on child files stay cheap.
   */
  async parseFile(filePath: string): Promise<ParsedSession[]> {
    const agentId = path.basename(filePath, '.jsonl');
    const isChildFile = path.basename(path.dirname(filePath)) === 'subagents';
    const meta = await this.readChatMeta(agentId);
    const session = await this.parseTranscript(filePath, agentId, meta);
    if (!session) return [];

    // Background subagents own a TOP-LEVEL transcript (not a subagents/
    // entry); their lineage exists only in the chat meta. Emit it child-side
    // so the link lands even though the parent transcript never mentions the
    // child file.
    if (meta.subagent?.parentAgentId && meta.subagent.parentAgentId !== agentId) {
      session.subagentOf = {
        parentSessionId: `cursor:${meta.subagent.parentAgentId}`,
        agentRole: meta.subagent.typeName,
        toolCallId: meta.subagent.toolCallId,
      };
      session.meta = {
        ...(session.meta ?? {}),
        is_subagent: true,
        parent_composer_id: meta.subagent.parentAgentId,
        ...(meta.subagent.typeName ? { subagent_type: meta.subagent.typeName } : {}),
        ...(meta.subagent.toolCallId ? { spawned_by_tool_call: meta.subagent.toolCallId } : {}),
      };
    }
    if (isChildFile) return [session];

    const sessions: ParsedSession[] = [session];
    const subagentsDir = path.join(path.dirname(filePath), 'subagents');
    if (await fs.pathExists(subagentsDir)) {
      for (const entry of await fs.readdir(subagentsDir)) {
        if (!entry.endsWith('.jsonl')) continue;
        const childId = entry.replace(/\.jsonl$/, '');
        const childPath = path.join(subagentsDir, entry);
        const childMeta = await this.readChatMeta(childId);
        const child = await this.parseTranscript(childPath, childId, childMeta);
        if (!child) continue;
        // Headless children have no cwd of their own; project attribution
        // follows the parent so the tree mounts them together.
        if (!child.projectPath) child.projectPath = session.projectPath;
        const role = childMeta.subagent?.typeName;
        child.meta = {
          ...(child.meta ?? {}),
          is_subagent: true,
          parent_composer_id: agentId,
          ...(role ? { subagent_type: role } : {}),
          ...(childMeta.subagent?.toolCallId ? { spawned_by_tool_call: childMeta.subagent.toolCallId } : {}),
        };
        const ref: SubagentRef = {
          agentId: childId,
          slug: role,
          agentRole: role,
          filePath: childPath,
          childSessionId: `cursor:${childId}`,
        };
        session.subagents.push(ref);
        sessions.push(child);
      }
    }
    return sessions;
  }

  private async parseTranscript(filePath: string, agentId: string, meta: ChatMeta): Promise<ParsedSession | null> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    const fallbackStart = meta.createdAtMs ?? (await fs.stat(filePath).catch(() => null))?.birthtimeMs ?? Date.now();

    const messages: ParsedMessage[] = [];
    const toolExecutions: ToolExecution[] = [];
    let firstPrompt = '';
    let lastTs = Math.round(fallbackStart);
    let index = 0;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry: JsonObject;
      try { entry = JSON.parse(line) as JsonObject; } catch { continue; }
      const role = entry.role;
      if (role !== 'user' && role !== 'assistant') { index++; continue; }

      const content = record(entry.message).content;
      const parts = Array.isArray(content) ? content.map(record) : [];
      const text = parts
        .filter(part => part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text as string)
        .join('\n')
        .trim();
      const toolUses = parts.filter(part => part.type === 'tool_use');

      // User lines embed wall-clock anchors; everything between anchors keeps
      // ordering via +1ms steps.
      const anchor = role === 'user' ? parseInlineTimestamp(text) : null;
      const ts = anchor && anchor > 0 ? anchor : lastTs + 1;
      lastTs = Math.max(lastTs, ts);

      if (role === 'user') {
        if (text) {
          if (!firstPrompt) {
            const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
            firstPrompt = (query?.[1] ?? text).slice(0, 500);
          }
          messages.push({
            uuid: `cursor-tr-${agentId}-${index}`,
            type: 'user',
            role: 'user',
            timestamp: ts,
            contentText: text,
            isToolResult: false,
            depth: 0,
          });
        }
      } else {
        const toolCalls = toolUses.map((part, callIndex) => ({
          id: typeof part.id === 'string' ? part.id : `cursor-tr-${agentId}-${index}-call-${callIndex}`,
          name: typeof part.name === 'string' ? part.name : 'unknown_tool',
          input: part.input,
        }));
        if (text || toolCalls.length > 0) {
          const uuid = `cursor-tr-${agentId}-${index}`;
          messages.push({
            uuid,
            type: 'assistant',
            role: 'assistant',
            timestamp: ts,
            contentText: text || undefined,
            toolCalls: toolCalls.length ? toolCalls : undefined,
            isToolResult: false,
            depth: 0,
          });
          for (const call of toolCalls) {
            let inputSummary = '';
            try { inputSummary = JSON.stringify(call.input).slice(0, 500); } catch { /* opaque input */ }
            toolExecutions.push({
              id: `cursor-tr-${agentId}-tool-${call.id}`,
              conversationId: '',
              toolUseMessageId: uuid,
              toolUseId: call.id,
              toolName: call.name,
              inputSummary,
              // Transcripts omit tool results; the call itself is still real work.
              outputSummary: '',
              isError: false,
              timestamp: ts,
            });
          }
        }
      }
      index++;
    }

    if (messages.length === 0) return null;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    for (const message of messages) {
      if (message.role === 'user') totalInputTokens += estimateTokensFromText(message.contentText ?? '');
      else totalOutputTokens += estimateTokensFromText(message.contentText ?? '');
    }
    const tokenUsage: SessionTokenUsage = {
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      models: new Set(meta.model ? [meta.model] : []),
    };

    const timestamps = messages.map(message => message.timestamp);
    return {
      sessionId: agentId,
      platform: 'cursor',
      projectPath: meta.cwd ?? '',
      model: meta.model,
      messages,
      toolExecutions,
      subagents: [],
      tokenUsage,
      startTime: Math.min(...timestamps),
      endTime: meta.updatedAtMs ?? Math.max(...timestamps),
      meta: {
        // session_title has top priority in the converter's title chain —
        // Cursor's own chat title beats the tag-laden first transcript line.
        session_title: meta.title || undefined,
        first_prompt: meta.title || firstPrompt || undefined,
        composer_name: meta.title || undefined,
        token_estimated: totalInputTokens > 0 || totalOutputTokens > 0 || undefined,
        source_database: filePath,
        transcript_format: 'agent-transcripts',
      },
    };
  }

  /**
   * Joins the transcript with its ~/.cursor/chats twin for metadata. The
   * workspace hash is unknown, so scan hash dirs for one containing agentId.
   */
  private async readChatMeta(agentId: string): Promise<ChatMeta> {
    const chatsRoot = path.join(this.cursorHome, 'chats');
    if (!(await fs.pathExists(chatsRoot))) return {};
    for (const workspace of await fs.readdir(chatsRoot)) {
      const chatDir = path.join(chatsRoot, workspace, agentId);
      if (!(await fs.pathExists(chatDir))) continue;
      const meta: ChatMeta = {};
      try {
        const parsed = record(JSON.parse(await fs.readFile(path.join(chatDir, 'meta.json'), 'utf8')));
        if (typeof parsed.title === 'string') meta.title = parsed.title;
        if (typeof parsed.cwd === 'string') meta.cwd = parsed.cwd;
        if (typeof parsed.createdAtMs === 'number') meta.createdAtMs = parsed.createdAtMs;
        if (typeof parsed.updatedAtMs === 'number') meta.updatedAtMs = parsed.updatedAtMs;
      } catch { /* subagent chats often have no meta.json */ }
      await this.mergeStoreMeta(path.join(chatDir, 'store.db'), meta);
      return meta;
    }
    return {};
  }

  /** store.db meta.'0' is hex-encoded JSON with lastUsedModel + subagentInfo. */
  private async mergeStoreMeta(storePath: string, meta: ChatMeta): Promise<void> {
    if (!(await fs.pathExists(storePath))) return;
    try {
      const BetterSqlite3 = (await import('better-sqlite3')).default;
      const db = new BetterSqlite3(storePath, { readonly: true, fileMustExist: true });
      try {
        const row = db.prepare("SELECT value FROM meta WHERE key='0'").get() as { value?: string } | undefined;
        if (!row?.value) return;
        const parsed = record(JSON.parse(Buffer.from(row.value, 'hex').toString('utf8')));
        if (!meta.title && typeof parsed.name === 'string' && parsed.name !== 'New Agent') meta.title = parsed.name;
        if (!meta.createdAtMs && typeof parsed.createdAt === 'number') meta.createdAtMs = parsed.createdAt;
        if (typeof parsed.lastUsedModel === 'string') meta.model = parsed.lastUsedModel;
        const info = record(parsed.subagentInfo);
        if (typeof info.parentAgentId === 'string') {
          meta.subagent = {
            parentAgentId: info.parentAgentId,
            typeName: typeof info.typeName === 'string' ? info.typeName : undefined,
            toolCallId: typeof info.toolCallId === 'string' ? info.toolCallId : undefined,
          };
        }
      } finally {
        db.close();
      }
    } catch { /* store may be locked by a live Cursor session — metadata is optional */ }
  }
}
