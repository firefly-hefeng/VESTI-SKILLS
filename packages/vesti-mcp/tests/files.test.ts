import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openVestiDb, type VestiDatabase } from '../src/db.js';
import { extractFilePaths, vestiSearchFiles } from '../src/files.js';
import { createFixtureDb, SESSION_A, type Fixture } from './helpers/fixture.js';

let fixture: Fixture;
let db: VestiDatabase;

beforeEach(() => {
  fixture = createFixtureDb();
  db = openVestiDb(fixture.dbPath);
});

afterEach(() => {
  db.close();
  fixture.cleanup();
});

describe('extractFilePaths', () => {
  it('reads path-named JSON keys directly', () => {
    expect(extractFilePaths('{"file_path": "src/a/b.ts", "content": "x = t.text"}')).toEqual([
      'src/a/b.ts',
    ]);
  });

  it('scans shell commands but skips content-ish values', () => {
    expect(extractFilePaths('{"command": "cat ./docs/readme.md && grep t.text"}')).toEqual([
      './docs/readme.md',
    ]);
  });

  it('falls back to the path regex for free text', () => {
    expect(extractFilePaths('edited C:/work/vesti/package.json, done')).toEqual([
      'C:/work/vesti/package.json',
    ]);
  });

  it('rejects member-access fragments, URLs and bare names', () => {
    expect(extractFilePaths('see https://example.com/a.png and EXPERTS.map or notes.txt')).toEqual(
      [],
    );
  });
});

describe('vesti_search_files', () => {
  it('finds the file behind a session recalled by content', () => {
    const result = vestiSearchFiles(db, { query: 'transactional migrations' });
    expect(result.count).toBeGreaterThanOrEqual(1);
    const hit = result.results.find(r => r.path === 'packages/capture-core/src/storage/migrations.ts');
    expect(hit).toBeDefined();
    expect(hit!.projects).toEqual(['C:/work/vesti']);
    expect(hit!.sessions.map(s => s.session_id)).toContain(SESSION_A);
    // Channel A (the session's digest key_files + tool input) and channel B
    // (the path itself contains "migrations") both fire.
    expect(hit!.matched_via).toContain('session-content');
    expect(hit!.matched_via).toContain('name');
    expect(hit!.touches).toBeGreaterThanOrEqual(2);
    expect(hit!.last_touched).not.toBeNull();
  });

  it('returns an empty list when matching sessions touched no files', () => {
    // SESSION_B is about deploying a blog; its only tool call is
    // 'npm run deploy' — no file paths anywhere.
    const result = vestiSearchFiles(db, { query: 'deploy blog gh-pages' });
    expect(result.count).toBe(0);
    expect(result.results).toEqual([]);
  });

  it('matches on the file path name alone', () => {
    const result = vestiSearchFiles(db, { query: 'migrations.ts' });
    expect(result.results.some(r => r.path.endsWith('migrations.ts'))).toBe(true);
    expect(result.results[0].matched_via).toContain('name');
  });

  it('requires a query', () => {
    expect(() => vestiSearchFiles(db, { query: '  ' })).toThrow(/query is required/);
  });

  it('caps topK', () => {
    const result = vestiSearchFiles(db, { query: 'migrations', topK: 1 });
    expect(result.count).toBeLessThanOrEqual(1);
  });
});
