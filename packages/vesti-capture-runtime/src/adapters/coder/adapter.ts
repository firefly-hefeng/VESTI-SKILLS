/**
 * Coder adapter (Qoder, Alibaba's agentic IDE/CLI).
 *
 * Session transcripts are Claude Code-format JSONL files under per-project
 * directories. Discovery roots (per home root):
 *   <home>/.qoder/projects
 *   <home>/.qoderwork/projects
 *   <userData>/Qoder/SharedClientCache/cli/projects   (IDE installs; Windows
 *     keeps its real sessions here even when ~/.qoder is absent)
 * <userData> is %APPDATA% (Windows), ~/Library/Application Support (macOS) or
 * ~/.config (Linux / WSL homes over UNC).
 * Layout: <projects>/<encodedProject>/<sessionId>.jsonl plus optional
 * <sessionId>/subagents/agent-*.jsonl subagent transcripts and
 * <sessionId>-session.json sidecars. A SharedClientCache root may also hold
 * session files flat, with no per-project subdirectory.
 */

import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';
import { nativeHomeRoot, type HomeRoot } from '../../platform/PathResolver.js';
import { CoderParser } from './parser.js';

function userDataBase(home: HomeRoot): string {
  if (home.host === 'native') {
    if (process.platform === 'win32') {
      return process.env.APPDATA || path.join(home.homeDir, 'AppData', 'Roaming');
    }
    if (process.platform === 'darwin') {
      return path.join(home.homeDir, 'Library', 'Application Support');
    }
    return process.env.XDG_CONFIG_HOME || path.join(home.homeDir, '.config');
  }
  // WSL homes expose a Linux filesystem over UNC.
  return path.join(home.homeDir, '.config');
}

export class CoderAdapter implements AgentAdapter {
  readonly platform = 'coder' as const;
  readonly name = 'Qoder';

  private readonly parser = new CoderParser();
  private homes: HomeRoot[] = [nativeHomeRoot()];

  setHomeRoots(homes: HomeRoot[]): void {
    this.homes = homes;
  }

  private projectsDirs(): string[] {
    return this.homes.flatMap(home => [
      path.join(home.homeDir, '.qoder', 'projects'),
      path.join(home.homeDir, '.qoderwork', 'projects'),
      path.join(userDataBase(home), 'Qoder', 'SharedClientCache', 'cli', 'projects'),
    ]);
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

  parseSession(filePath: string): Promise<ParsedSession> {
    return this.parser.parseFile(filePath);
  }

  async getSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const projectsDir of await this.existingProjectsDirs()) {
      // Subagent transcripts (**/subagents/agent-*.jsonl) are included so they
      // sync as standalone sessions; the child-side lineage set by the parser
      // attaches them to their parent.
      files.push(...await glob('**/*.jsonl', { cwd: projectsDir, absolute: true }));
    }
    const stats = await Promise.all(files.map(async file => ({ file, mtime: (await fs.stat(file)).mtimeMs })));
    return stats.sort((a, b) => b.mtime - a.mtime).map(item => item.file);
  }

  getWatchPatterns(): string[] {
    return this.projectsDirs().map(dir => path.join(dir, '**', '*.jsonl'));
  }
}
