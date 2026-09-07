/**
 * Claude Code Adapter
 * Single entry point for Claude Code integration
 */

import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';
import { nativeHomeRoot, type HomeRoot } from '../../platform/PathResolver.js';
import { ClaudeCodeParser } from './parser.js';
import type { ClaudeSessionMeta } from './types.js';

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly platform = 'claude-code' as const;
  readonly name = 'Claude Code';
  readonly parserVersion = 1;

  private parser = new ClaudeCodeParser();
  private homes: HomeRoot[] = [nativeHomeRoot()];

  setHomeRoots(homes: HomeRoot[]): void {
    this.homes = homes;
  }

  private claudeDirs(): string[] {
    return this.homes.map(home => path.join(home.homeDir, '.claude'));
  }

  private projectsDirs(): string[] {
    return this.homes.map(home => path.join(home.homeDir, '.claude', 'projects'));
  }

  async detect(): Promise<AgentDetectResult> {
    let installPath: string | undefined;
    for (const dir of this.claudeDirs()) {
      if (await fs.pathExists(dir)) {
        installPath = dir;
        break;
      }
    }
    if (!installPath) {
      return { installed: false };
    }

    let version: string | undefined;
    let sessionCount = 0;

    try {
      const files = await this.getSessionFiles();
      sessionCount = files.length;

      // Try to get version from most recent session
      if (files.length > 0) {
        const stats = await Promise.all(
          files.slice(0, 5).map(async f => ({ f, mtime: (await fs.stat(f)).mtimeMs }))
        );
        stats.sort((a, b) => b.mtime - a.mtime);
        const content = await fs.readFile(stats[0].f, 'utf-8');
        const firstLine = content.split('\n')[0];
        if (firstLine) {
          try {
            const parsed = JSON.parse(firstLine);
            version = parsed.version;
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    return {
      installed: true,
      version,
      installPath,
      sessionCount,
    };
  }

  async parseSession(filePath: string): Promise<ParsedSession> {
    return this.parser.parseFile(filePath);
  }

  async parseSessionIncremental(filePath: string, byteOffset: number): Promise<{ session: ParsedSession; newOffset: number }> {
    return this.parser.parseIncremental(filePath, byteOffset);
  }

  async getSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const projectsDir of this.projectsDirs()) {
      if (!(await fs.pathExists(projectsDir))) continue;
      // Subagent transcripts (**/subagents/agent-*.jsonl) are included so they
      // sync as standalone sessions; resolveSubagentLinks() then attaches them
      // to their parent via subagent_links.file_path.
      files.push(...await glob('**/*.jsonl', {
        cwd: projectsDir,
        absolute: true,
      }));
    }
    return files;
  }

  getWatchPatterns(): string[] {
    return this.projectsDirs().map(projectsDir => path.join(projectsDir, '**', '*.jsonl'));
  }

  /**
   * Get all project directories under each home's .claude/projects/
   */
  async getProjectDirs(): Promise<string[]> {
    const dirs: string[] = [];
    for (const projectsDir of this.projectsDirs()) {
      if (!(await fs.pathExists(projectsDir))) continue;
      const entries = await fs.readdir(projectsDir, { withFileTypes: true });
      dirs.push(...entries
        .filter(e => e.isDirectory())
        .map(e => path.join(projectsDir, e.name)));
    }
    return dirs;
  }

  /**
   * Get session-meta data from .claude/usage-data/session-meta/{sessionId}.json
   * (searched across all home roots)
   */
  async getSessionMeta(sessionId: string): Promise<ClaudeSessionMeta | null> {
    for (const claudeDir of this.claudeDirs()) {
      const metaFile = path.join(claudeDir, 'usage-data', 'session-meta', `${sessionId}.json`);
      try {
        if (await fs.pathExists(metaFile)) {
          return await fs.readJSON(metaFile) as ClaudeSessionMeta;
        }
      } catch { /* ignore */ }
    }
    return null;
  }
}
