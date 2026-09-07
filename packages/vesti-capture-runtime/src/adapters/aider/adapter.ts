/**
 * Aider Adapter
 * Reads aider's global `.aider.chat.history.md` (markdown chat history).
 * Supports multiple home roots (native + WSL) via setHomeRoots.
 */

import fs from 'fs-extra';
import path from 'path';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';
import { nativeHomeRoot, type HomeRoot } from '../../platform/PathResolver.js';
import { AiderParser } from './parser.js';

const HISTORY_FILE = '.aider.chat.history.md';

export class AiderAdapter implements AgentAdapter {
  readonly platform = 'aider' as const;
  readonly name = 'Aider';

  private readonly parser = new AiderParser();
  private homes: HomeRoot[] = [nativeHomeRoot()];

  setHomeRoots(homes: HomeRoot[]): void {
    this.homes = homes;
  }

  private historyFiles(): string[] {
    return this.homes.map(home => path.join(home.homeDir, HISTORY_FILE));
  }

  async detect(): Promise<AgentDetectResult> {
    const files = await this.getSessionFiles();
    if (files.length === 0) return { installed: false };

    let sessionCount = 0;
    for (const file of files) {
      try {
        sessionCount += (await this.parser.parseFile(file)).length;
      } catch { /* unreadable history file */ }
    }
    return { installed: true, installPath: files[0], sessionCount };
  }

  async parseSession(filePath: string): Promise<ParsedSession> {
    const sessions = await this.parseSessions(filePath);
    if (sessions.length === 0) throw new Error(`No aider chat found in ${filePath}`);
    return sessions[0];
  }

  parseSessions(filePath: string): Promise<ParsedSession[]> {
    return this.parser.parseFile(filePath);
  }

  async getSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const candidate of this.historyFiles()) {
      if (await fs.pathExists(candidate)) files.push(candidate);
    }
    return files;
  }

  getWatchPatterns(): string[] {
    return this.historyFiles();
  }
}
