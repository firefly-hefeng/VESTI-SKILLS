/**
 * WorkBuddy adapter (Tencent WorkBuddy / CodeBuddy desktop agent).
 *
 * Sessions are JSONL files under <home>/.workbuddy/projects/ (see parser.ts
 * for the wire format), one file per session, with subagent transcripts
 * nested under <sessionId>/subagents/. %APPDATA%\WorkBuddy holds app state
 * but no readable transcripts, so discovery stays on the documented
 * projects/ tree; absent directories are skipped silently.
 */

import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';
import { nativeHomeRoot, type HomeRoot } from '../../platform/PathResolver.js';
import { WorkBuddyParser } from './parser.js';

export class WorkBuddyAdapter implements AgentAdapter {
  readonly platform = 'workbuddy' as const;
  readonly name = 'WorkBuddy';

  private readonly parser = new WorkBuddyParser();
  private homes: HomeRoot[] = [nativeHomeRoot()];

  setHomeRoots(homes: HomeRoot[]): void {
    this.homes = homes;
  }

  private projectsDirs(): string[] {
    return this.homes.map(home => path.join(home.homeDir, '.workbuddy', 'projects'));
  }

  private async existingProjectsDirs(): Promise<string[]> {
    const dirs: string[] = [];
    for (const dir of this.projectsDirs()) {
      if (await fs.pathExists(dir)) dirs.push(dir);
    }
    return dirs;
  }

  async detect(): Promise<AgentDetectResult> {
    const dirs = await this.existingProjectsDirs();
    if (dirs.length === 0) return { installed: false };

    let sessionCount = 0;
    try {
      sessionCount = (await this.getSessionFiles()).length;
    } catch { /* ignore */ }
    return {
      installed: true,
      installPath: path.dirname(dirs[0]),
      sessionCount,
    };
  }

  async parseSession(filePath: string): Promise<ParsedSession> {
    const session = await this.parser.parseFile(filePath);
    if (!session) throw new Error(`No WorkBuddy conversation found in ${filePath}`);

    const parentDir = path.dirname(filePath);
    if (path.basename(parentDir) === 'subagents') {
      // Child-side lineage: <project>/<session>/subagents/<agent>.jsonl
      const parentSessionId = path.basename(path.dirname(parentDir));
      if (parentSessionId && parentSessionId !== 'subagents') {
        session.sessionId = `${parentSessionId}--${session.sessionId}`;
        session.subagentOf = {
          parentSessionId: `workbuddy:${parentSessionId}`,
          agentId: path.basename(filePath, '.jsonl'),
        };
      }
    } else {
      session.subagents = this.parser.discoverSubagents(filePath);
    }
    return session;
  }

  async getSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const projectsDir of await this.existingProjectsDirs()) {
      // Subagent transcripts are included so they sync as standalone sessions;
      // the child-side lineage attaches them to their parent.
      files.push(...await glob('**/*.jsonl', { cwd: projectsDir, absolute: true }));
    }
    const stats = await Promise.all(files.map(async file => ({ file, mtime: (await fs.stat(file)).mtimeMs })));
    return stats.sort((a, b) => b.mtime - a.mtime).map(item => item.file);
  }

  getWatchPatterns(): string[] {
    return this.projectsDirs().map(dir => path.join(dir, '**', '*.jsonl'));
  }
}
