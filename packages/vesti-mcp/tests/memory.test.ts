import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openVestiDb, type VestiDatabase } from '../src/db.js';
import { hasMemorySpace, vestiMemoryGet, vestiMemorySearch } from '../src/memory.js';
import {
  createFixtureDb,
  upgradeFixtureToMemorySpace,
  MEM_ARCHIVED,
  MEM_DEPOSIT,
  MEM_DREAM,
  MEM_DREAM_LOG,
  MEM_NOTE,
  type Fixture,
} from './helpers/fixture.js';

/**
 * Does this SQLite build link the FTS5 trigram tokenizer? CJK substring
 * matching depends on it (under the unicode61 fallback a whole unspaced CJK
 * run is one token — migration 5's caveat). Same probe the fixture runs.
 */
function probeTrigram(): boolean {
  const probe = new Database(':memory:');
  try {
    probe.exec("CREATE VIRTUAL TABLE _probe USING fts5(x, tokenize='trigram')");
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}
const TRIGRAM = probeTrigram();

let fixture: Fixture;
let db: VestiDatabase;

beforeEach(() => {
  fixture = createFixtureDb();
});

afterEach(() => {
  db.close();
  fixture.cleanup();
});

/** Open the fixture with the schema-v14 memory space applied. */
function openMemoryDb(): VestiDatabase {
  upgradeFixtureToMemorySpace(fixture.dbPath);
  return openVestiDb(fixture.dbPath);
}

describe('vesti_memory_search', () => {
  it('FTS-matches query keywords over title/content/tags', () => {
    db = openMemoryDb();
    // 'vesti' matches under both the trigram and the unicode61 fallback
    // tokenizer (deposit title/content 'VESTI', note content/tags).
    const result = vestiMemorySearch(db, { query: 'vesti' });
    expect(result.count).toBeGreaterThanOrEqual(1);
    const hit = result.results.find(r => r.id === MEM_DEPOSIT);
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe('deposit');
    expect(hit!.title).toBe('个人背景与写作风格');
    expect(hit!.summary).toBe('个人背景、写作风格与当前项目状态');
    expect(hit!.entry_date).toBe('2026-01-05');
    expect(hit!.tags).toEqual(['profile', 'writing']);
    expect(hit!.updated_at).toBe('2026-01-05T12:00:00.000Z');
    expect(hit!.snippet.length).toBeGreaterThan(0);
    expect(hit!.snippet.length).toBeLessThanOrEqual(170);
  });

  it.runIf(TRIGRAM)('matches unspaced CJK substrings under the trigram tokenizer', () => {
    db = openMemoryDb();
    const result = vestiMemorySearch(db, { query: '写作风格' });
    expect(result.results.some(r => r.id === MEM_DEPOSIT)).toBe(true);
  });

  it('returns active entries only by default, archived with include_archived', () => {
    db = openMemoryDb();
    const activeOnly = vestiMemorySearch(db, { query: 'deprecated' });
    expect(activeOnly.count).toBe(0);
    const withArchived = vestiMemorySearch(db, { query: 'deprecated', include_archived: true });
    expect(withArchived.results.map(r => r.id)).toEqual([MEM_ARCHIVED]);
  });

  it('combines the query with a kind filter', () => {
    db = openMemoryDb();
    const result = vestiMemorySearch(db, { query: 'vesti', kind: 'note' });
    expect(result.results.map(r => r.id)).toEqual([MEM_NOTE]);
  });

  it('browse mode (no query) lists active entries newest first', () => {
    db = openMemoryDb();
    const result = vestiMemorySearch(db, {});
    expect(result.query).toBeNull();
    expect(result.results.map(r => r.id)).toEqual([MEM_NOTE, MEM_DREAM_LOG, MEM_DREAM, MEM_DEPOSIT]);
    // The archived entry is excluded even though it is newer than the deposit.
    expect(result.results.some(r => r.id === MEM_ARCHIVED)).toBe(false);
  });

  it('browse mode filters by kind and entry_date', () => {
    db = openMemoryDb();
    expect(vestiMemorySearch(db, { kind: 'dream' }).results.map(r => r.id)).toEqual([MEM_DREAM]);
    expect(vestiMemorySearch(db, { entry_date: '2026-01-09' }).results.map(r => r.id)).toEqual([MEM_DREAM_LOG]);
    expect(
      vestiMemorySearch(db, { include_archived: true, kind: 'dream' }).results.map(r => r.id),
    ).toEqual([MEM_DREAM, MEM_ARCHIVED]);
  });

  it('clamps limit to [1, 20] with default 10', () => {
    db = openMemoryDb();
    expect(vestiMemorySearch(db, { limit: 2 }).results).toHaveLength(2);
    expect(vestiMemorySearch(db, { limit: 0 }).results).toHaveLength(1);
    // 5 seeded rows total; a huge limit just returns all active ones.
    expect(vestiMemorySearch(db, { limit: 100 }).results).toHaveLength(4);
  });

  it('returns an empty result for a query nothing matches', () => {
    db = openMemoryDb();
    expect(vestiMemorySearch(db, { query: 'zzzqqq 不存在' }).count).toBe(0);
  });

  it('fails with a friendly message when the database predates schema v14', () => {
    db = openVestiDb(fixture.dbPath);
    expect(hasMemorySpace(db)).toBe(false);
    expect(() => vestiMemorySearch(db, { query: 'vesti' })).toThrow(/memory space is not set up/);
    expect(() => vestiMemorySearch(db, { query: 'vesti' })).toThrow(/schema v14/);
  });
});

describe('vesti_memory_get', () => {
  it('returns full documents including content, source_session_ids and version', () => {
    db = openMemoryDb();
    const result = vestiMemoryGet(db, { ids: [MEM_DREAM, MEM_DEPOSIT] });
    expect(result.requested).toBe(2);
    expect(result.count).toBe(2);
    expect(result.missing).toEqual([]);

    const [dream, deposit] = result.entries;
    expect(dream.id).toBe(MEM_DREAM);
    expect(dream.content_markdown).toContain('对冗长解释表现出不耐烦');
    expect(dream.source_session_ids).toHaveLength(1);
    expect(dream.version).toBe(1);
    expect(dream.status).toBe('active');
    expect(dream.created_at).toBe('2026-01-08T12:00:00.000Z');

    expect(deposit.version).toBe(3);
    expect(deposit.scope).toBe('personal');
    expect(deposit.template).toBe('profile');
  });

  it('marks unknown ids as missing without failing the whole call', () => {
    db = openMemoryDb();
    const result = vestiMemoryGet(db, { ids: [MEM_DREAM, 'mem-nope'] });
    expect(result.count).toBe(1);
    expect(result.missing).toEqual(['mem-nope']);
  });

  it('treats archived ids as missing unless include_archived is passed', () => {
    db = openMemoryDb();
    expect(vestiMemoryGet(db, { ids: [MEM_ARCHIVED] }).missing).toEqual([MEM_ARCHIVED]);
    const result = vestiMemoryGet(db, { ids: [MEM_ARCHIVED], include_archived: true });
    expect(result.count).toBe(1);
    expect(result.entries[0].status).toBe('archived');
    expect(result.entries[0].prev_id).toBe(MEM_DREAM);
  });

  it('rejects an empty id list and lists over 10 ids', () => {
    db = openMemoryDb();
    expect(() => vestiMemoryGet(db, { ids: [] })).toThrow(/ids is required/);
    const eleven = Array.from({ length: 11 }, (_, i) => `mem-${i}`);
    expect(() => vestiMemoryGet(db, { ids: eleven })).toThrow(/at most 10/);
  });

  it('fails with a friendly message when the database predates schema v14', () => {
    db = openVestiDb(fixture.dbPath);
    expect(() => vestiMemoryGet(db, { ids: [MEM_DREAM] })).toThrow(/memory space is not set up/);
  });
});
