/**
 * Export Engine
 * Export conversations to JSON or Markdown
 */

import fs from 'fs-extra';
import path from 'path';
import type { DatabaseManager } from '../storage/DatabaseManager.js';
import type { ExportOptions, VestiConversation, VestiMessage } from '../types/index.js';

export class ExportEngine {
  constructor(private db: DatabaseManager) {}

  async exportConversation(conversationId: string, options: ExportOptions): Promise<string> {
    const conv = this.db.getConversation(conversationId);
    if (!conv) throw new Error(`Conversation not found: ${conversationId}`);

    const messages = this.db.getMessages(conversationId);

    let content: string;
    let ext: string;

    if (options.format === 'json') {
      content = this.toJSON(conv, messages, options);
      ext = 'json';
    } else {
      content = this.toMarkdown(conv, messages, options);
      ext = 'md';
    }

    if (options.outputPath) {
      const outputFile = options.outputPath.endsWith(`.${ext}`)
        ? options.outputPath
        : path.join(options.outputPath, `${conv.sessionId}.${ext}`);
      await fs.ensureDir(path.dirname(outputFile));
      await fs.writeFile(outputFile, content, 'utf-8');
      return outputFile;
    }

    return content;
  }

  private toJSON(conv: VestiConversation, messages: VestiMessage[], options: ExportOptions): string {
    const filtered = messages.map(m => {
      const obj: Record<string, unknown> = {
        id: m.id,
        role: m.role,
        type: m.type,
        text: m.contentText,
        timestamp: m.timestamp,
      };
      if (options.includeThinking && m.contentThinking) obj.thinking = m.contentThinking;
      if (options.includeToolCalls && m.contentToolName) {
        obj.toolName = m.contentToolName;
        obj.toolInput = m.contentToolInput;
        obj.toolOutput = m.contentToolOutput;
      }
      return obj;
    });

    return JSON.stringify({ conversation: conv, messages: filtered }, null, 2);
  }

  private toMarkdown(conv: VestiConversation, messages: VestiMessage[], options: ExportOptions): string {
    const lines: string[] = [];
    lines.push(`# ${conv.title}`);
    lines.push('');
    lines.push(`- Platform: ${conv.platform}`);
    lines.push(`- Project: ${conv.projectPath}`);
    lines.push(`- Date: ${new Date(conv.startedAt).toISOString()}`);
    lines.push(`- Messages: ${conv.messageCount}`);
    if (conv.totalInputTokens > 0) {
      lines.push(`- Tokens: ${conv.totalInputTokens.toLocaleString()} in / ${conv.totalOutputTokens.toLocaleString()} out`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const m of messages) {
      const roleLabel = m.role === 'user' ? '**User**' : '**Assistant**';
      lines.push(`### ${roleLabel}`);
      lines.push('');

      if (options.includeThinking && m.contentThinking) {
        lines.push('<details><summary>Thinking</summary>');
        lines.push('');
        lines.push(m.contentThinking);
        lines.push('');
        lines.push('</details>');
        lines.push('');
      }

      if (m.contentText) {
        lines.push(m.contentText);
        lines.push('');
      }

      if (options.includeToolCalls && m.contentToolName) {
        lines.push(`> Tool: \`${m.contentToolName}\``);
        if (m.contentToolOutput) {
          const output = m.contentToolOutput.slice(0, 500);
          lines.push(`> Output: ${output}${m.contentToolOutput.length > 500 ? '...' : ''}`);
        }
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }
}
