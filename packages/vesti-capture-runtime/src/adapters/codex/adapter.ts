/** OpenAI Codex CLI / Codex app rollout adapter. */

import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';
import { nativeHomeRoot, type HomeRoot } from '../../platform/PathResolver.js';
import { CodexParser } from './parser.js';

export class CodexAdapter implements AgentAdapter {
  readonly platform = 'codex' as const;
  readonly name = 'Codex';
  readonly parserVersion = 4;

  private readonly parser = new CodexParser();
  private homes: HomeRoot[] = [nativeHomeRoot()];

  setHomeRoots(homes: HomeRoot[]): void {
    this.homes = homes;
  }

  private codexDirs(): string[] {
    return this.homes.map(home => path.join(home.homeDir, '.codex'));
  }

  async detect(): Promise<AgentDetectResult> {
    let installPath: string | undefined;
    for (const dir of this.codexDirs()) {
      if (await fs.pathExists(dir)) {
        installPath = dir;
        break;
      }
    }
    if (!installPath) return { installed: false };

    const files = await this.getSessionFiles();
    let version: string | undefined;
    if (files.length > 0) {
      try {
        const firstLine = (await fs.readFile(files[0], 'utf8')).split(/\r?\n/, 1)[0];
        const row = JSON.parse(firstLine) as { type?: string; payload?: { cli_version?: string } };
        version = row.type === 'session_meta' ? row.payload?.cli_version : undefined;
      } catch { /* a rollout can be partially written */ }
    }

    return {
      installed: true,
      version,
      installPath,
      sessionCount: files.length,
    };
  }

  parseSession(filePath: string): Promise<ParsedSession> {
    return this.parser.parseFile(filePath);
  }

  async getSessionFiles(): Promise<string[]> {
    const roots = this.codexDirs().flatMap(dir => [
      path.join(dir, 'sessions'),
      path.join(dir, 'archived_sessions'),
    ]);
    const files: string[] = [];
    for (const root of roots) {
      if (!(await fs.pathExists(root))) continue;
      files.push(...await glob('**/*.jsonl', { cwd: root, absolute: true }));
    }
    const stats = await Promise.all(files.map(async file => ({ file, mtime: (await fs.stat(file)).mtimeMs })));
    return stats.sort((a, b) => b.mtime - a.mtime).map(item => item.file);
  }

  getWatchPatterns(): string[] {
    return this.codexDirs().flatMap(dir => [
      path.join(dir, 'sessions', '**', '*.jsonl'),
      path.join(dir, 'archived_sessions', '**', '*.jsonl'),
    ]);
  }
}
