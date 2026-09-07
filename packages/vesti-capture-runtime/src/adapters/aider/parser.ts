/**
 * Aider Parser
 * Parses `.aider.chat.history.md` files: sessions are delimited by
 * `# aider chat started at <timestamp>` headers, messages by `#### USER`
 * and `#### ASSISTANT` blocks. Lines quoted with `> ` are aider's own
 * meta output and are skipped.
 */

import fs from 'fs-extra';
import type { ParsedMessage, ParsedSession, SessionTokenUsage } from '../../types/agent.js';

const CHAT_HEADER = /^#\s+aider chat started at\s+(.+)$/i;
const MESSAGE_HEADER = /^####\s+(USER|ASSISTANT)\s*$/i;

function emptyTokenUsage(): SessionTokenUsage {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    models: new Set<string>(),
  };
}

export class AiderParser {
  /** One markdown history file can hold many chat sessions. */
  async parseFile(filePath: string): Promise<ParsedSession[]> {
    const content = await fs.readFile(filePath, 'utf-8');
    return this.parseContent(content);
  }

  parseContent(content: string): ParsedSession[] {
    const sessions: ParsedSession[] = [];
    let currentMessages: ParsedMessage[] | null = null;
    let blockRole: 'user' | 'assistant' | null = null;
    let blockLines: string[] = [];
    let sessionStart = 0;
    let sessionIndex = 0;

    const flushBlock = () => {
      if (!currentMessages || !blockRole) return;
      const text = blockLines.join('\n').trim();
      blockLines = [];
      if (!text) return;
      const index = currentMessages.length;
      currentMessages.push({
        uuid: `${sessions.length}-${index}`,
        type: blockRole,
        role: blockRole,
        timestamp: sessionStart + index,
        contentText: text,
        isToolResult: false,
        depth: 0,
      });
    };

    const flushSession = () => {
      flushBlock();
      blockRole = null;
      if (!currentMessages) return;
      if (currentMessages.length > 0) {
        sessions.push({
          sessionId: sessionStart > 0 ? `chat-${sessionStart}` : `chat-${sessionIndex}`,
          platform: 'aider',
          projectPath: '',
          messages: currentMessages,
          toolExecutions: [],
          subagents: [],
          tokenUsage: emptyTokenUsage(),
          startTime: sessionStart > 0 ? sessionStart : 0,
          endTime: currentMessages[currentMessages.length - 1].timestamp || undefined,
        });
      }
      currentMessages = null;
      sessionIndex++;
    };

    for (const line of content.split('\n')) {
      const chatStart = line.match(CHAT_HEADER);
      if (chatStart) {
        flushSession();
        currentMessages = [];
        const parsed = Date.parse(chatStart[1].trim());
        sessionStart = Number.isNaN(parsed) ? 0 : parsed;
        continue;
      }
      if (!currentMessages) continue; // skip preamble before the first chat header
      const messageStart = line.match(MESSAGE_HEADER);
      if (messageStart) {
        flushBlock();
        blockRole = messageStart[1].toLowerCase() === 'user' ? 'user' : 'assistant';
        continue;
      }
      if (blockRole && !line.startsWith('>')) blockLines.push(line);
    }
    flushSession();

    return sessions;
  }
}
