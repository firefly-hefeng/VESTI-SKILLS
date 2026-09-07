/**
 * Coder (Qoder) parser. Qoder session transcripts use the Claude Code JSONL
 * wire format, so parsing delegates to ClaudeCodeParser and this class only
 * retags platform/lineage and applies Qoder-specific extras:
 *   <sessionStem>-session.json   sidecar: { title, parent_session_id,
 *                                fork_from, working_dir }
 *   <sessionStem>/subagents/agent-*.jsonl   subagent transcripts (child-side
 *                                lineage derives from the path alone)
 */

import path from 'path';
import fs from 'fs-extra';
import type { ParsedSession } from '../../types/agent.js';
import { ClaudeCodeParser } from '../claude-code/parser.js';

type JsonObject = Record<string, unknown>;

interface CoderSessionMeta {
  title?: string;
  parent_session_id?: string;
  fork_from?: string;
  working_dir?: string;
}

export class CoderParser {
  private readonly claude = new ClaudeCodeParser();

  async parseFile(filePath: string): Promise<ParsedSession> {
    const session = await this.claude.parseFile(filePath);
    session.platform = 'coder';

    const stem = path.basename(filePath, '.jsonl');
    const parentDir = path.dirname(filePath);

    // Subagent transcript: <sessionStem>/subagents/agent-*.jsonl. The child
    // knows its parent from the path alone, so the link lands resolved.
    if (path.basename(parentDir) === 'subagents') {
      const parentSessionId = path.basename(path.dirname(parentDir));
      if (parentSessionId && parentSessionId !== 'subagents') {
        // kimi-code style: the child id mounts under its parent session id so
        // same-named agent files in different projects never collide.
        session.sessionId = `${parentSessionId}--${stem}`;
        session.subagentOf = {
          parentSessionId: `coder:${parentSessionId}`,
          agentId: stem.replace(/^agent-/, ''),
        };
      }
    }

    const meta = this.readSessionMeta(path.join(parentDir, `${stem}-session.json`));
    const sessionMeta: JsonObject = { ...(session.meta ?? {}) };
    if (meta.title) {
      sessionMeta.session_title = meta.title;
      if (!sessionMeta.first_prompt) sessionMeta.first_prompt = meta.title;
    }
    if (meta.fork_from && !sessionMeta.forked_from) sessionMeta.forked_from = meta.fork_from;
    if (meta.parent_session_id && !sessionMeta.parent_session_id) {
      sessionMeta.parent_session_id = meta.parent_session_id;
    }
    if (Object.keys(sessionMeta).length > 0) session.meta = sessionMeta;
    if (!session.projectPath && meta.working_dir) session.projectPath = meta.working_dir;

    return session;
  }

  private readSessionMeta(metaPath: string): CoderSessionMeta {
    try {
      if (!fs.existsSync(metaPath)) return {};
      const raw = fs.readFileSync(metaPath, 'utf8');
      if (!raw.trim()) return {};
      const parsed = JSON.parse(raw) as CoderSessionMeta;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
}
