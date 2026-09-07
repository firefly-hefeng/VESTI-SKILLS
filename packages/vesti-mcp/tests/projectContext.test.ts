import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openVestiDb, type VestiDatabase } from '../src/db.js';
import {
  deriveProjectKey,
  normalizeProjectPath,
  vestiGetHandoffContext,
  vestiGetProjectContext,
} from '../src/projectContext.js';
import {
  createFixtureDb,
  upgradeFixtureToMemoryV2,
  SESSION_A,
  SESSION_B,
  SESSION_SUB,
  type Fixture,
} from './helpers/fixture.js';

let fixture: Fixture;
let db: VestiDatabase;

beforeEach(() => {
  fixture = createFixtureDb();
  db = openVestiDb(fixture.dbPath);
  // Several scenarios seed derived project layers after opening the fixture.
  db.pragma('query_only = OFF');
});

afterEach(() => {
  db.close();
  fixture.cleanup();
});

/** Derived key of the fixture's "vesti" project (claude-code/native at C:/work/vesti). */
const VESTI_KEY = deriveProjectKey({ platform: 'claude-code', host: 'native', projectPath: 'C:/work/vesti' });
/** Same for the "blog" project (codex/native at C:/work/blog). */
const BLOG_KEY = deriveProjectKey({ platform: 'codex', host: 'native', projectPath: 'C:/work/blog' });

const NOW = Date.UTC(2026, 0, 10, 12, 0, 0);

/** Seed project_state / project_briefs rows under the DERIVED keys (the
 * helper's upgradeFixtureToMemoryV2 uses a placeholder key, which exercises
 * vesti_project_brief but not the derived-key merge done here). */
function seedDerivedMemoryLayers(): void {
  upgradeFixtureToMemoryV2(fixture.dbPath);
  db.prepare(
    `INSERT INTO project_state (project_key, one_liner, active_files, open_questions, session_count, last_active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    VESTI_KEY,
    'Derived L0 card one-liner',
    JSON.stringify([{ path: 'src/storage/migrations.ts', touches: 7, lastTouched: '2026-01-10T12:30:00.000Z' }]),
    JSON.stringify(['是否切换到 WAL2？']),
    2,
    '2026-01-10T13:00:00.000Z',
    '2026-01-10T13:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO project_briefs (project_key, content_markdown, version, last_ops, updated_at)
     VALUES (?, ?, ?, '[]', ?)`,
  ).run(VESTI_KEY, '# vesti 项目简报\n\n派生 key 的简报。', 5, '2026-01-10T14:00:00.000Z');
}

describe('project key derivation (port of capture-core projectRegistry)', () => {
  it('normalizes Windows paths: slashes, duplicates, trailing, drive case', () => {
    expect(normalizeProjectPath('C:\\work\\vesti\\')).toBe('c:/work/vesti');
    expect(normalizeProjectPath('C:/work//vesti')).toBe('c:/work/vesti');
    expect(normalizeProjectPath('/home/u/Proj/')).toBe('/home/u/Proj');
    expect(normalizeProjectPath('  ')).toBe('');
  });

  it('derives the capture-core key: cli_ + sha256(platform|host|basis)[:16]', () => {
    const basis = 'c:/work/vesti';
    const expected = `cli_${createHash('sha256').update(`claude-code|native|${basis}`).digest('hex').slice(0, 16)}`;
    expect(VESTI_KEY).toBe(expected);
    expect(BLOG_KEY).not.toBe(VESTI_KEY);
  });
});

describe('vesti_get_project_context — single project', () => {
  it('returns the full context pack for a path (backslash input tolerated)', () => {
    const result = vestiGetProjectContext(db, { paths: ['C:\\work\\vesti\\'] });
    expect(result.unmatched_paths).toEqual([]);
    expect(result.cross_project).toBeNull();
    expect(result.projects).toHaveLength(1);

    const project = result.projects[0];
    expect(project.path).toBe('c:/work/vesti');
    expect(project.label).toBe('vesti');
    expect(project.platforms).toEqual(['claude-code']);
    expect(project.session_count).toBe(2); // main session + its subagent line
    expect(project.project_keys).toEqual([VESTI_KEY]);

    // Recent sessions, newest activity first, with digest one-liners.
    expect(project.recent_sessions.map(s => s.session_id)).toEqual([SESSION_A, SESSION_SUB]);
    expect(project.recent_sessions[0].one_liner).toBe('Made the sqlite migration runner transactional');
    expect(project.recent_sessions[0].key_topics).toContain('sqlite');

    // Pre-v4 fallback: state synthesized from digests.
    expect(project.state).not.toBeNull();
    expect(project.state!.one_liner).toBe('Made the sqlite migration runner transactional');
    expect(project.active_files.map(f => f.path)).toEqual(['packages/capture-core/src/storage/migrations.ts']);
    expect(project.brief).toBeNull();
  });

  it('merges the derived-key L0 card and picks the newest L2 brief', () => {
    seedDerivedMemoryLayers();
    const result = vestiGetProjectContext(db, { paths: ['c:/work/vesti'] });
    const project = result.projects[0];
    expect(project.state!.one_liner).toBe('Derived L0 card one-liner');
    expect(project.state!.open_questions).toContain('是否切换到 WAL2？');
    expect(project.active_files).toEqual([
      { path: 'src/storage/migrations.ts', touches: 7, last_touched: '2026-01-10T12:30:00.000Z' },
    ]);
    expect(project.brief).not.toBeNull();
    expect(project.brief!.version).toBe(5);
    expect(project.brief!.content_markdown).toContain('派生 key 的简报');
    expect(project.brief!.truncated).toBe(false);
    // Registry label from the memory-v2 upgrade wins over the path basename.
    expect(project.label).toBe('vesti');
  });

  it('truncates an over-budget brief and flags it', () => {
    seedDerivedMemoryLayers();
    const result = vestiGetProjectContext(db, { paths: ['c:/work/vesti'], brief_chars: 500 });
    const brief = result.projects[0].brief!;
    expect(brief.content_markdown.length).toBeLessThanOrEqual(500);
  });

  it('defaults to the most recently active project when no paths are given', () => {
    const result = vestiGetProjectContext(db);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].path).toBe('c:/work/blog'); // SESSION_B is newest
    expect(result.hints.join(' ')).toMatch(/most recently active/);
  });

  it('reports unmatched paths gracefully and lists known projects in hints', () => {
    const result = vestiGetProjectContext(db, { paths: ['D:/nowhere'] });
    expect(result.projects).toEqual([]);
    expect(result.unmatched_paths).toEqual(['d:/nowhere']);
    expect(result.hints.join(' ')).toContain('c:/work/vesti');
  });

  it('handles an empty database with guidance instead of an error', () => {
    db.exec('DELETE FROM work_sessions');
    const result = vestiGetProjectContext(db, { paths: ['c:/work/vesti'] });
    expect(result.projects).toEqual([]);
    expect(result.hints.join(' ')).toMatch(/no captured sessions/i);
  });

  it('works on a project with no digests at all (blog: sessions only)', () => {
    const result = vestiGetProjectContext(db, { paths: ['c:/work/blog'] });
    const project = result.projects[0];
    expect(project.session_count).toBe(1);
    expect(project.recent_sessions[0].session_id).toBe(SESSION_B);
    expect(project.recent_sessions[0].one_liner).toBeNull();
    expect(project.state).toBeNull();
    expect(result.hints.join(' ')).toMatch(/No L0\/L2 memory layers/);
  });
});

describe('vesti_get_project_context — cross-project merge', () => {
  function seedBlogOverlap(): void {
    // A blog digest sharing a file and a topic with the vesti project.
    db.prepare(
      `INSERT INTO session_digests (session_id, host, platform, one_liner, key_topics, key_files, embedding_status, updated_at)
       VALUES (?, 'native', 'codex', ?, ?, ?, 'none', ?)`,
    ).run(
      SESSION_B,
      'Deployed the blog and fixed the sqlite migrations import',
      JSON.stringify(['deploy', 'sqlite']),
      JSON.stringify(['packages/capture-core/src/storage/migrations.ts', 'blog/config.yaml']),
      new Date(NOW + 86_400_000).toISOString(),
    );
    // A blog session whose window overlaps SESSION_A's [NOW, NOW+1h].
    db.prepare(
      `INSERT INTO work_sessions (id, session_id, platform, project_path, title, summary, host, started_at, ended_at, last_activity_at, message_count, turn_count, created_at, updated_at)
       VALUES (?, ?, 'codex', 'C:/work/blog', ?, NULL, 'native', ?, ?, ?, 1, 1, ?, ?)`,
    ).run('ws-bbb-004', 'platform-b-2', 'Overlapping blog fix', NOW + 1_800_000, NOW + 2_400_000, NOW + 2_400_000, NOW + 1_800_000, NOW + 1_800_000);
  }

  it('partitions per project and reports shared files/topics plus time overlap', () => {
    seedBlogOverlap();
    const result = vestiGetProjectContext(db, { paths: ['C:/work/vesti', 'C:/work/blog'] });
    expect(result.projects.map(p => p.label)).toEqual(['vesti', 'blog']);
    expect(result.unmatched_paths).toEqual([]);

    const cross = result.cross_project!;
    expect(cross.shared_files).toEqual([
      { file: 'storage/migrations.ts', projects: ['blog', 'vesti'] },
    ]);
    expect(cross.shared_topics).toEqual([{ topic: 'sqlite', projects: ['blog', 'vesti'] }]);
    expect(cross.time_overlaps).toHaveLength(1);
    expect(cross.time_overlaps[0].projects).toEqual(['vesti', 'blog']);
    expect(cross.time_overlaps[0].overlapping_session_pairs).toBeGreaterThanOrEqual(1);
    expect(cross.time_overlaps[0].latest_overlap!.start).toBe('2026-01-10T12:30:00.000Z');
  });

  it('returns an empty (not null) links object when projects share nothing', () => {
    const result = vestiGetProjectContext(db, { paths: ['c:/work/vesti', 'c:/work/blog'] });
    expect(result.cross_project).toEqual({ shared_files: [], shared_topics: [], time_overlaps: [] });
  });

  it('keeps matched projects when some paths are unmatched', () => {
    const result = vestiGetProjectContext(db, { paths: ['c:/work/vesti', 'd:/nowhere'] });
    expect(result.projects.map(p => p.label)).toEqual(['vesti']);
    expect(result.unmatched_paths).toEqual(['d:/nowhere']);
    expect(result.cross_project).toBeNull();
  });
});

describe('vesti_get_handoff_context', () => {
  it('resolves by path and returns relay-v2-aligned material', () => {
    seedDerivedMemoryLayers();
    const result = vestiGetHandoffContext(db, { path: 'C:/work/vesti' });
    expect(result.project.label).toBe('vesti');
    expect(result.file_anchors).toEqual(result.project.active_files);

    // Newest user messages first, across the project's sessions.
    expect(result.recent_user_messages.length).toBeGreaterThanOrEqual(3);
    expect(result.recent_user_messages[0].text).toBe('follow-up question 3');
    expect(result.recent_user_messages[0].session_title).toBe('Refactoring the sqlite storage layer');
    expect(result.recent_user_messages.map(m => m.text)).toContain(
      'please refactor the database migrations to be transactional',
    );

    // verifyFirst seeds: the seeded open question; no failing steps in vesti.
    expect(result.verify_first.some(v => v.check.includes('是否切换到 WAL2？'))).toBe(true);
    expect(result.verify_first.every(v => v.source.length > 0)).toBe(true);
  });

  it('resolves by session_id and surfaces the last failing step', () => {
    const result = vestiGetHandoffContext(db, { session_id: SESSION_B });
    expect(result.project.path).toBe('c:/work/blog');
    expect(result.verify_first).toEqual([
      {
        check: 'Re-check the last failing step: Bash — npm run deploy',
        source: 'Deploying a static site (2026-01-11)',
      },
    ]);
  });

  it('strips injected context blocks from user messages', () => {
    db.prepare(
      `INSERT INTO messages (id, session_id, turn_id, source, sequence, role, content_text, timestamp, created_at)
       VALUES (?, ?, NULL, 'user_input', 9, 'user', ?, ?, ?)`,
    ).run(
      'm-b2-u', SESSION_B,
      '<environment_context>cwd: C:/work/blog</environment_context> ship the fix',
      NOW + 86_500_000, NOW + 86_500_000,
    );
    const result = vestiGetHandoffContext(db, { path: 'c:/work/blog' });
    expect(result.recent_user_messages[0].text).toBe('ship the fix');
  });

  it('throws for unknown sessions and unknown paths', () => {
    expect(() => vestiGetHandoffContext(db, { session_id: 'nope' })).toThrow(/Session not found/);
    expect(() => vestiGetHandoffContext(db, { path: 'd:/nowhere' })).toThrow(/Project not found/);
  });
});
