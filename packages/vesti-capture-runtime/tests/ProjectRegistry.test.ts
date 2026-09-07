/**
 * Project Registry Tests
 * Covers: path normalization, deterministic project keys, and the automatic
 * project_registry upsert that runs inside upsertWorkSession (sync pipeline).
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import {
  deriveProjectKey,
  normalizeGitRemote,
  normalizeProjectPath,
  projectBasis,
  projectLabel,
} from '../src/storage/projectRegistry.js';
import type { WorkSession } from '../src/types/unified.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

function makeSession(overrides: Partial<WorkSession>): WorkSession {
  return {
    id: 'codex:session-1',
    sessionId: 'session-1',
    platform: 'codex',
    projectPath: 'C:\\Users\\dev\\Project',
    title: 'Session',
    tags: [],
    status: 'active',
    sessionType: 'conversation',
    startedAt: 1000,
    lastActivityAt: 2000,
    durationMs: 0,
    messageCount: 1,
    userInputCount: 1,
    assistantMessageCount: 0,
    thinkingCount: 0,
    toolCallCount: 0,
    codeBlockCount: 0,
    turnCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    hasSubagents: false,
    hasContextCompaction: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

interface RegistryRow {
  project_key: string;
  kind: string;
  label: string;
  path_or_domain: string;
  first_seen: string;
  last_seen: string;
}

async function withManager<T>(fn: (manager: DatabaseManager, dbPath: string) => T | Promise<T>): Promise<T> {
  const dir = await makeTempDir('vesti-registry-');
  const dbPath = path.join(dir, 'vesti.db');
  const manager = new DatabaseManager(dbPath);
  await manager.initialize();
  try {
    return await fn(manager, dbPath);
  } finally {
    await manager.close();
  }
}

function registryRows(dbPath: string): RegistryRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM project_registry').all() as RegistryRow[];
  } finally {
    db.close();
  }
}

describe('project key derivation', () => {
  it('normalizes windows paths for stable keying', () => {
    expect(normalizeProjectPath('C:\\Users\\dev\\Project\\')).toBe('c:/Users/dev/Project');
    expect(normalizeProjectPath('/home/dev/project/')).toBe('/home/dev/project');
    expect(normalizeProjectPath('')).toBe('');
  });

  it('normalizes git remotes as a fallback basis', () => {
    expect(normalizeGitRemote('git@github.com:org/repo.git')).toBe('git@github.com:org/repo');
    expect(normalizeGitRemote('https://github.com/org/repo.git/')).toBe('https://github.com/org/repo');
  });

  it('falls back project_path → git remote → unknown', () => {
    expect(projectBasis({ projectPath: 'C:\\x', gitRemote: 'r' })).toBe('c:/x');
    expect(projectBasis({ projectPath: '', gitRemote: 'git@github.com:org/repo.git' }))
      .toBe('git@github.com:org/repo');
    expect(projectBasis({ projectPath: '', gitRemote: '' })).toBe('unknown');
  });

  it('derives deterministic keys that distinguish platform and host', () => {
    const input = { platform: 'codex', host: 'native', projectPath: 'C:\\Users\\dev\\Project' };
    expect(deriveProjectKey(input)).toBe(deriveProjectKey({ ...input }));
    expect(deriveProjectKey(input)).toMatch(/^cli_[0-9a-f]{16}$/);
    expect(deriveProjectKey({ ...input, platform: 'cursor' })).not.toBe(deriveProjectKey(input));
    expect(deriveProjectKey({ ...input, host: 'wsl:Ubuntu' })).not.toBe(deriveProjectKey(input));
  });

  it('labels a project by its path basename', () => {
    expect(projectLabel('c:/Users/dev/Project')).toBe('Project');
    expect(projectLabel('unknown')).toBe('unknown');
  });
});

describe('project_registry sync maintenance', () => {
  it('creates a registry entry on session upsert', async () => {
    await withManager(async (manager, dbPath) => {
      const session = makeSession({});
      manager.upsertWorkSession(session);

      const rows = registryRows(dbPath);
      expect(rows).toHaveLength(1);
      expect(rows[0].project_key).toBe(deriveProjectKey({
        platform: 'codex',
        host: 'native',
        projectPath: 'C:\\Users\\dev\\Project',
      }));
      expect(rows[0].kind).toBe('cli_path');
      expect(rows[0].label).toBe('Project');
      expect(rows[0].path_or_domain).toBe('c:/Users/dev/Project');
      expect(rows[0].first_seen).toBe(new Date(1000).toISOString());
      expect(rows[0].last_seen).toBe(new Date(2000).toISOString());
    });
  });

  it('widens first_seen/last_seen across repeated upserts', async () => {
    await withManager(async (manager, dbPath) => {
      manager.upsertWorkSession(makeSession({ startedAt: 1000, lastActivityAt: 5000 }));
      manager.upsertWorkSession(makeSession({
        id: 'codex:session-2',
        sessionId: 'session-2',
        startedAt: 500,
        lastActivityAt: 3000,
      }));

      const rows = registryRows(dbPath);
      expect(rows).toHaveLength(1);
      expect(rows[0].first_seen).toBe(new Date(500).toISOString());
      expect(rows[0].last_seen).toBe(new Date(5000).toISOString());
    });
  });

  it('keys sessions without a project path under their git remote, else unknown', async () => {
    await withManager(async (manager, dbPath) => {
      manager.upsertWorkSession(makeSession({
        id: 'codex:session-3',
        sessionId: 'session-3',
        projectPath: '',
        gitRemote: 'git@github.com:org/repo.git',
      }));
      manager.upsertWorkSession(makeSession({
        id: 'codex:session-4',
        sessionId: 'session-4',
        projectPath: '',
        gitRemote: undefined,
      }));

      const rows = registryRows(dbPath);
      expect(rows).toHaveLength(2);
      const byLabel = new Map(rows.map(row => [row.label, row]));
      expect(byLabel.get('repo')?.path_or_domain).toBe('git@github.com:org/repo');
      expect(byLabel.get('unknown')?.path_or_domain).toBe('unknown');
    });
  });

  it('keeps native and WSL sessions of the same path in separate projects', async () => {
    await withManager(async (manager, dbPath) => {
      manager.upsertWorkSession(makeSession({}));
      manager.upsertWorkSession(makeSession({
        id: 'codex:wsl-Ubuntu-session-1',
        sessionId: 'wsl-Ubuntu-session-1',
        host: 'wsl:Ubuntu',
      }));

      const rows = registryRows(dbPath);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map(row => row.project_key)).size).toBe(2);
    });
  });
});
