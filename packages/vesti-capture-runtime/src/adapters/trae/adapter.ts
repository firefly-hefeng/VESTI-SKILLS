/**
 * Trae adapter (ByteDance Trae IDE, read-only access to its state.vscdb).
 *
 * Trae is a VS Code fork; each product variant keeps an Electron user-data
 * dir with a User/ profile:
 *   Windows: %APPDATA%\<Product>\User
 *   macOS:   ~/Library/Application Support/<Product>/User
 *   Linux:   ~/.config/<Product>/User  (also the layout probed in WSL homes)
 * Known products: Trae (international), Trae CN, TRAE SOLO CN.
 * Chats live in <User>/globalStorage/state.vscdb and
 * <User>/workspaceStorage/<hash>/state.vscdb — see parser.ts for the schema.
 */

import fs from 'fs-extra';
import path from 'path';
import { glob } from 'glob';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';
import { nativeHomeRoot, type HomeRoot } from '../../platform/PathResolver.js';
import { TraeParser } from './parser.js';

const TRAE_PRODUCTS = ['Trae', 'Trae CN', 'TRAE SOLO CN'];

function configBase(home: HomeRoot): string {
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

export class TraeAdapter implements AgentAdapter {
  readonly platform = 'trae' as const;
  readonly name = 'Trae';
  readonly shouldBackupSource = false;

  private readonly parser = new TraeParser();
  private homes: HomeRoot[] = [nativeHomeRoot()];

  setHomeRoots(homes: HomeRoot[]): void {
    this.homes = homes;
  }

  private userDirs(): string[] {
    return this.homes.flatMap(home =>
      TRAE_PRODUCTS.map(product => path.join(configBase(home), product, 'User')));
  }

  async detect(): Promise<AgentDetectResult> {
    const files = await this.getSessionFiles();
    if (files.length === 0) return { installed: false };

    let sessionCount = 0;
    for (const file of files) {
      try { sessionCount += await this.parser.countSessions(file); } catch { /* Trae may hold a write lock */ }
    }
    return {
      installed: true,
      installPath: this.userDirs().find(dir => files.some(file => file.startsWith(dir))) ?? path.dirname(files[0]),
      sessionCount,
    };
  }

  async parseSession(filePath: string): Promise<ParsedSession> {
    const sessions = await this.parseSessions(filePath);
    if (sessions.length === 0) throw new Error(`No Trae conversations found in ${filePath}`);
    return sessions[0];
  }

  parseSessions(filePath: string): Promise<ParsedSession[]> {
    return this.parser.parseDatabase(filePath);
  }

  async getSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const userDir of this.userDirs()) {
      const globalDb = path.join(userDir, 'globalStorage', 'state.vscdb');
      if (await fs.pathExists(globalDb)) files.push(globalDb);
      const workspaceStorage = path.join(userDir, 'workspaceStorage');
      if (await fs.pathExists(workspaceStorage)) {
        files.push(...await glob('*/state.vscdb', { cwd: workspaceStorage, absolute: true }));
      }
    }
    return files;
  }

  getWatchPatterns(): string[] {
    const databases = this.userDirs().flatMap(userDir => [
      path.join(userDir, 'globalStorage', 'state.vscdb'),
      path.join(userDir, 'workspaceStorage', '*', 'state.vscdb'),
    ]);
    // SQLite WAL mode can keep every committed change in the sidecar while
    // the main database's size and mtime remain unchanged until checkpoint.
    return databases.flatMap(database => [database, `${database}-wal`, `${database}-shm`]);
  }
}
