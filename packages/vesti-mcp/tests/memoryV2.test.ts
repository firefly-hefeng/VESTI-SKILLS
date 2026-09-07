import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openVestiDb, type VestiDatabase } from '../src/db.js';
import { vestiProjectBrief, vestiSearch } from '../src/tools.js';
import {
  createFixtureDb,
  upgradeFixtureToMemoryV2,
  PROJECT_KEY,
  SESSION_A,
  type Fixture,
} from './helpers/fixture.js';

let fixture: Fixture;
let db: VestiDatabase;

beforeEach(() => {
  fixture = createFixtureDb();
});

afterEach(() => {
  db.close();
  fixture.cleanup();
});

describe('memory v2: capture-owned digest access tracking', () => {
  it('does not mutate access_count when vesti_search surfaces a digest', () => {
    upgradeFixtureToMemoryV2(fixture.dbPath);
    db = openVestiDb(fixture.dbPath);

    const before = db
      .prepare('SELECT access_count FROM session_digests WHERE session_id = ?')
      .get(SESSION_A) as unknown as { access_count: number };
    expect(before.access_count).toBe(0);

    const result = vestiSearch(db, { query: 'transactional migrations' });
    expect(result.results.some(r => r.session_id === SESSION_A)).toBe(true);

    const after = db
      .prepare('SELECT access_count FROM session_digests WHERE session_id = ?')
      .get(SESSION_A) as unknown as { access_count: number };
    expect(after.access_count).toBe(0);
  });

  it('searches a pre-v4 database without attempting a hidden write', () => {
    db = openVestiDb(fixture.dbPath);
    expect(db.pragma('query_only', { simple: true })).toBe(1);
    const result = vestiSearch(db, { query: 'transactional migrations' });
    expect(result.count).toBeGreaterThanOrEqual(1);
  });
});

describe('memory v2: vesti_project_brief', () => {
  it('returns the L0 card and L2 brief for a fuzzy-matched project', () => {
    upgradeFixtureToMemoryV2(fixture.dbPath);
    db = openVestiDb(fixture.dbPath);

    const result = vestiProjectBrief(db, { project: 'vesti' });
    expect(result.project_key).toBe(PROJECT_KEY);
    expect(result.label).toBe('vesti');
    expect(result.state).not.toBeNull();
    expect(result.state!.one_liner).toBe('L0 card one-liner');
    expect(result.state!.active_files).toEqual([
      { path: 'src/storage/migrations.ts', touches: 4, last_touched: '2026-01-10T12:00:00.000Z' },
    ]);
    expect(result.state!.open_questions).toEqual(['是否切换到 WAL2？']);
    expect(result.brief).not.toBeNull();
    expect(result.brief!.version).toBe(3);
    expect(result.brief!.content_markdown).toContain('存储层重构');
  });

  it('throws with the known project list for an unknown project', () => {
    upgradeFixtureToMemoryV2(fixture.dbPath);
    db = openVestiDb(fixture.dbPath);
    expect(() => vestiProjectBrief(db, { project: 'no-such-project' })).toThrow(/Project not found/);
    expect(() => vestiProjectBrief(db, { project: 'no-such-project' })).toThrow(/vesti/);
  });

  it('throws a friendly error when the memory-v2 tables do not exist yet', () => {
    db = openVestiDb(fixture.dbPath);
    // No project_registry on the pre-v4 fixture.
    expect(() => vestiProjectBrief(db, { project: 'vesti' })).toThrow();
  });
});
