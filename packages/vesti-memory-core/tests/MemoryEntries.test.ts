/**
 * Memory Entries (记忆空间) Tests
 * Covers: migration v14 schema (table / FTS / triggers / meta kv), CRUD
 * round-trips, FTS search with CJK keywords and hostile query text.
 */

import os from 'os';
import path from 'path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import type { MemoryEntry } from '../src/types.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function makeManager(prefix: string): Promise<{ manager: DatabaseManager; dbPath: string }> {
  const dir = await makeTempDir(prefix);
  const dbPath = path.join(dir, 'vesti.db');
  const manager = new DatabaseManager(dbPath);
  await manager.initialize();
  return { manager, dbPath };
}

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'deposit:2026-08-01',
    kind: 'deposit',
    title: '背景知识沉淀',
    contentMarkdown: '# 背景\n用户是前端工程师，最近在做状态管理选型。',
    summary: null,
    scope: null,
    template: 'background_knowledge',
    sourceSessionIds: ['kimi-code:session-1'],
    tags: ['前端', '状态管理'],
    version: 1,
    prevId: null,
    lastOps: null,
    status: 'active',
    entryDate: '2026-08-01',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('migration v14: memory_entries', () => {
  it('creates the table, indexes, FTS table, triggers and the meta kv table', async () => {
    const { manager, dbPath } = await makeManager('vesti-mem-schema-');
    await manager.close();

    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
        .map(row => row.name);
      expect(tables).toEqual(expect.arrayContaining(['memory_entries', 'memory_entries_fts', 'memory_meta']));

      const columns = (db.prepare('PRAGMA table_info(memory_entries)').all() as Array<{ name: string }>)
        .map(row => row.name);
      expect(columns).toEqual([
        'id', 'kind', 'title', 'content_markdown', 'summary', 'scope', 'template',
        'source_session_ids', 'tags', 'version', 'prev_id', 'last_ops', 'status',
        'entry_date', 'created_at', 'updated_at',
      ]);

      const indexes = (db.prepare("PRAGMA index_list('memory_entries')").all() as Array<{ name: string }>)
        .map(row => row.name);
      expect(indexes).toEqual(expect.arrayContaining(['idx_memory_entries_kind', 'idx_memory_entries_date']));

      const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>)
        .map(row => row.name);
      expect(triggers).toEqual(expect.arrayContaining(['mem_fts_insert', 'mem_fts_delete', 'mem_fts_update']));

      // CJK content must be searchable → trigram tokenizer (migration 5 decision).
      const ftsSql = (db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_entries_fts'",
      ).get() as { sql: string }).sql;
      expect(ftsSql.toLowerCase()).toContain('trigram');

      const migration = db.prepare('SELECT name FROM schema_migrations WHERE version = 14').get() as
        | { name: string }
        | undefined;
      expect(migration?.name).toBe('memory_entries');
    } finally {
      db.close();
    }
  });
});

describe('memory entry CRUD', () => {
  it('round-trips an entry and applies ON CONFLICT updates on every field', async () => {
    const { manager } = await makeManager('vesti-mem-crud-');

    manager.upsertMemoryEntry(entry());
    const stored = manager.getMemoryEntry('deposit:2026-08-01');
    expect(stored).toEqual(entry());

    manager.upsertMemoryEntry(entry({
      title: '背景知识沉淀 v2',
      contentMarkdown: '# 背景\n用户已经选定 Zustand。',
      summary: '前端背景',
      scope: 'project',
      sourceSessionIds: ['kimi-code:session-1', 'codex:session-2'],
      tags: ['前端'],
      version: 2,
      prevId: 'deposit:2026-07-01',
      lastOps: '[{"op":"UPDATE"}]',
      status: 'archived',
      entryDate: '2026-08-02',
      updatedAt: 3000,
    }));
    expect(manager.getMemoryEntry('deposit:2026-08-01')).toEqual(entry({
      title: '背景知识沉淀 v2',
      contentMarkdown: '# 背景\n用户已经选定 Zustand。',
      summary: '前端背景',
      scope: 'project',
      sourceSessionIds: ['kimi-code:session-1', 'codex:session-2'],
      tags: ['前端'],
      version: 2,
      prevId: 'deposit:2026-07-01',
      lastOps: '[{"op":"UPDATE"}]',
      status: 'archived',
      entryDate: '2026-08-02',
      updatedAt: 3000,
    }));
    expect(manager.getMemoryEntry('no-such-entry')).toBeNull();
    await manager.close();
  });

  it('lists newest first with kind/status filters and pagination', async () => {
    const { manager } = await makeManager('vesti-mem-list-');
    manager.upsertMemoryEntry(entry({ id: 'deposit:a', kind: 'deposit', updatedAt: 100 }));
    manager.upsertMemoryEntry(entry({ id: 'dream:a', kind: 'dream', updatedAt: 300 }));
    manager.upsertMemoryEntry(entry({ id: 'dream:b', kind: 'dream', status: 'archived', updatedAt: 200 }));
    manager.upsertMemoryEntry(entry({ id: 'note:a', kind: 'note', updatedAt: 400 }));

    expect(manager.listMemoryEntries().map(e => e.id)).toEqual(['note:a', 'dream:a', 'dream:b', 'deposit:a']);
    expect(manager.listMemoryEntries({ kind: 'dream' }).map(e => e.id)).toEqual(['dream:a', 'dream:b']);
    expect(manager.listMemoryEntries({ status: 'archived' }).map(e => e.id)).toEqual(['dream:b']);
    expect(manager.listMemoryEntries({ kind: 'dream', status: 'active' }).map(e => e.id)).toEqual(['dream:a']);
    expect(manager.listMemoryEntries({ limit: 2 }).map(e => e.id)).toEqual(['note:a', 'dream:a']);
    expect(manager.listMemoryEntries({ limit: 2, offset: 2 }).map(e => e.id)).toEqual(['dream:b', 'deposit:a']);

    expect(manager.countMemoryEntries()).toBe(4);
    expect(manager.countMemoryEntries('dream')).toBe(2);
    expect(manager.countMemoryEntries('dream-log')).toBe(0);
    await manager.close();
  });

  it('hard-deletes entries and keeps FTS in sync', async () => {
    const { manager } = await makeManager('vesti-mem-delete-');
    manager.upsertMemoryEntry(entry());
    expect(manager.searchMemoryEntries('状态管理', 10)).toHaveLength(1);
    manager.deleteMemoryEntry('deposit:2026-08-01');
    expect(manager.getMemoryEntry('deposit:2026-08-01')).toBeNull();
    expect(manager.searchMemoryEntries('状态管理', 10)).toHaveLength(0);
    expect(manager.countMemoryEntries()).toBe(0);
    await manager.close();
  });
});

describe('memory entry search', () => {
  it('hits tight-CJK keywords in title, content and tags', async () => {
    const { manager } = await makeManager('vesti-mem-search-');
    manager.upsertMemoryEntry(entry({ id: 'm-content' }));
    manager.upsertMemoryEntry(entry({
      id: 'm-title',
      title: '支付模块负责人变更',
      contentMarkdown: '完全无关的内容。',
      tags: [],
    }));
    manager.upsertMemoryEntry(entry({
      id: 'm-tags',
      title: '无',
      contentMarkdown: '无',
      tags: ['超算集群配额'],
    }));

    expect(manager.searchMemoryEntries('状态管理', 10).map(e => e.id)).toEqual(['m-content']);
    expect(manager.searchMemoryEntries('支付模块', 10).map(e => e.id)).toEqual(['m-title']);
    expect(manager.searchMemoryEntries('超算集群', 10).map(e => e.id)).toEqual(['m-tags']);
    await manager.close();
  });

  it('survives FTS special characters and empty queries', async () => {
    const { manager } = await makeManager('vesti-mem-search-escape-');
    manager.upsertMemoryEntry(entry());

    expect(manager.searchMemoryEntries('" OR 1=1 --', 10)).toEqual([]);
    expect(manager.searchMemoryEntries('AND OR NOT NEAR ( ) *', 10)).toEqual([]);
    expect(manager.searchMemoryEntries('   ', 10)).toEqual([]);
    // Multi-word queries still hit their matchable tokens.
    expect(manager.searchMemoryEntries('用户 状态管理 选型', 10).map(e => e.id)).toEqual(['deposit:2026-08-01']);
    await manager.close();
  });
});

describe('memory meta kv', () => {
  it('round-trips values and overwrites on conflict', async () => {
    const { manager } = await makeManager('vesti-mem-meta-');
    expect(manager.getMemoryMeta('deposits.migrated')).toBeNull();
    manager.setMemoryMeta('deposits.migrated', '2026-08-12');
    expect(manager.getMemoryMeta('deposits.migrated')).toBe('2026-08-12');
    manager.setMemoryMeta('deposits.migrated', '2026-08-13');
    expect(manager.getMemoryMeta('deposits.migrated')).toBe('2026-08-13');
    await manager.close();
  });
});
