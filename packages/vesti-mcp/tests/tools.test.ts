import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openVestiDb, VestiDbNotFoundError, type VestiDatabase } from '../src/db.js';
import { vestiGetTurns, vestiSearch, vestiTimeline } from '../src/tools.js';
import { createFixtureDb, SESSION_A, SESSION_B, SESSION_SUB, type Fixture } from './helpers/fixture.js';

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

describe('openVestiDb', () => {
  it('throws a friendly error when the database file is missing', () => {
    expect(() => openVestiDb(fixture.dbPath + '.missing')).toThrow(VestiDbNotFoundError);
    expect(() => openVestiDb(fixture.dbPath + '.missing'))
      .toThrow(/standalone VESTI capture runtime/);
    expect(() => openVestiDb(fixture.dbPath + '.missing'))
      .toThrow(/vesti setup/);
  });

  it('opens the MCP connection in SQLite query_only mode', () => {
    expect(db.pragma('query_only', { simple: true })).toBe(1);
    expect(() => db.exec('CREATE TABLE _write_probe (id TEXT)')).toThrow(/readonly/i);
  });
});

describe('vesti_search', () => {
  it('finds the session whose messages match the query', () => {
    const result = vestiSearch(db, { query: 'transactional migrations' });
    expect(result.count).toBeGreaterThanOrEqual(1);
    const hit = result.results.find(r => r.session_id === SESSION_A);
    expect(hit).toBeDefined();
    expect(hit!.title).toBe('Refactoring the sqlite storage layer');
    expect(hit!.platform).toBe('claude-code');
    expect(hit!.project_path).toBe('C:/work/vesti');
    expect(hit!.started_at).toBe('2026-01-10T12:00:00.000Z');
    expect(hit!.one_liner).toBe('Made the sqlite migration runner transactional');
    expect(hit!.key_topics).toEqual(['sqlite', 'migrations', 'transactions']);
    expect(hit!.snippet.length).toBeGreaterThan(0);
    expect(hit!.score).toBeGreaterThan(0);
  });

  it('matches on session titles via sessions_fts', () => {
    const result = vestiSearch(db, { query: 'deploying' });
    expect(result.results.some(r => r.session_id === SESSION_B)).toBe(true);
  });

  it('falls back to the title for sessions without a digest or snippet', () => {
    const result = vestiSearch(db, { query: 'deploy' });
    const hit = result.results.find(r => r.session_id === SESSION_B);
    expect(hit).toBeDefined();
    expect(hit!.one_liner).toBeNull();
    expect(hit!.snippet.length).toBeGreaterThan(0);
  });

  it('respects topK and returns an empty list for noise', () => {
    expect(vestiSearch(db, { query: 'transactional', topK: 1 }).results).toHaveLength(1);
    expect(vestiSearch(db, { query: 'zzzqqq-nothing' }).count).toBe(0);
  });
});

describe('vesti_timeline', () => {
  it('returns the session header and per-turn outline', () => {
    const result = vestiTimeline(db, { session_id: SESSION_A });
    expect(result.session.title).toBe('Refactoring the sqlite storage layer');
    expect(result.total_turns).toBe(3);
    expect(result.turns).toHaveLength(3);
    expect(result.turns[0]).toMatchObject({
      seq: 1,
      tool_count: 1,
      input_tokens: 1200,
      output_tokens: 340,
    });
    expect(result.turns[0].user_intent).toContain('refactor the database migrations');
    expect(result.turns[0].started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts the platform session_id as an alias', () => {
    const result = vestiTimeline(db, { session_id: 'platform-b-1' });
    expect(result.session.session_id).toBe(SESSION_B);
  });

  it('lists subagent lines with role and one-liner for drill-down', () => {
    const result = vestiTimeline(db, { session_id: SESSION_A });
    expect(result.subagents).toEqual([{
      session_id: SESSION_SUB,
      role: 'generalPurpose',
      title: 'Collect trigram tokenizer prior art',
      message_count: 2,
      one_liner: 'Surveyed trigram tokenizer prior art for the FTS rebuild',
    }]);
    // Sessions without subagents omit the field entirely.
    expect(vestiTimeline(db, { session_id: SESSION_B }).subagents).toBeUndefined();
  });

  it('throws for an unknown session', () => {
    expect(() => vestiTimeline(db, { session_id: 'nope' })).toThrow(/Session not found/);
  });
});

describe('vesti_get_turns', () => {
  it('returns full content for selected turn_ids', () => {
    const result = vestiGetTurns(db, { session_id: SESSION_A, turn_ids: [1, 2] });
    expect(result.requested).toBe(2);
    expect(result.returned).toBe(2);
    expect(result.truncated).toBe(false);

    const [t1] = result.turns;
    expect(t1.seq).toBe(1);
    expect(t1.user).toContain('refactor the database migrations');
    expect(t1.assistant).toContain('wrapped every migration step in a transaction');
    expect(t1.thinking).toContain('BEGIN/COMMIT');
    expect(t1.tools).toEqual([
      {
        tool: 'Edit',
        outcome: 'success',
        input_summary: 'packages/capture-core/src/storage/migrations.ts',
        output_summary: 'wrapped migration in transaction',
        is_error: false,
      },
    ]);
    expect(result.turns[1].tools).toEqual([]);
  });

  it('preserves same-turn follow-ups, final response and ordered progress after cleanup', () => {
    db.pragma('query_only = OFF');
    const turnId = `${SESSION_B}-t1`;
    const insert = db.prepare(
      `INSERT INTO messages
       (id, session_id, turn_id, source, sequence, role, content_text, timestamp, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const base = Date.UTC(2026, 0, 11, 12, 0, 0);
    insert.run(
      'm-b1-plugins',
      SESSION_B,
      turnId,
      'user_input',
      2,
      'user',
      '<recommended_plugins><plugin>noise</plugin></recommended_plugins>',
      base + 100,
      base + 100,
    );
    insert.run(
      'm-b1-followup',
      SESSION_B,
      turnId,
      'user_input',
      3,
      'user',
      '# Files mentioned by the user:\n\n- form.png\n\n## My request:\nPlease reuse my saved phone number.\n<image src="transport"/>',
      base + 200,
      base + 200,
    );
    insert.run(
      'm-b1-aborted',
      SESSION_B,
      turnId,
      'user_input',
      4,
      'user',
      '<turn_aborted/>',
      base + 300,
      base + 300,
    );
    insert.run(
      'm-b1-commentary',
      SESSION_B,
      turnId,
      'assistant_commentary',
      5,
      'assistant',
      'I found the saved profile and am checking the form.',
      base + 400,
      base + 400,
    );
    insert.run(
      'm-b1-progress',
      SESSION_B,
      turnId,
      'progress',
      6,
      'assistant',
      'Validated the phone-number format.',
      base + 500,
      base + 500,
    );
    insert.run(
      'm-b1-final',
      SESSION_B,
      turnId,
      'assistant_text',
      7,
      'assistant',
      'The form is complete with your saved phone number.',
      base + 600,
      base + 600,
    );
    db.pragma('query_only = ON');

    const result = vestiGetTurns(db, { session_id: SESSION_B, turn_ids: [1] });
    const turn = result.turns[0];
    expect(turn.user).toContain('help me deploy the blog to gh-pages');
    expect(turn.user).toContain('Follow-up 1:\nPlease reuse my saved phone number.');
    expect(turn.user).not.toMatch(/recommended_plugins|turn_aborted|Files mentioned|<image/);
    expect(turn.assistant).toBe('The form is complete with your saved phone number.');
    expect(turn.progress).toContain('sure, here is the plan');
    expect(turn.progress).toContain('I found the saved profile');
    expect(turn.progress).toContain('Validated the phone-number format');
    expect(turn.progress).not.toContain(turn.assistant);
  });

  it('supports an inclusive range selection', () => {
    const result = vestiGetTurns(db, { session_id: SESSION_A, range: { from: 2, to: 3 } });
    expect(result.turns.map(t => t.seq)).toEqual([2, 3]);
  });

  it('marks truncated and stops when max_chars is exceeded', () => {
    const result = vestiGetTurns(db, { session_id: SESSION_A, max_chars: 500 });
    expect(result.truncated).toBe(true);
    expect(result.returned).toBeLessThan(result.requested + 1);
    // At minimum the first turn fits (or is hard-cut), never more than requested.
    expect(result.returned).toBeGreaterThanOrEqual(1);
    expect(result.returned).toBeLessThanOrEqual(3);
    const allText = result.turns
      .map(t => t.user + t.assistant + t.progress + t.thinking)
      .join('');
    expect(allText.length).toBeLessThanOrEqual(600); // cap + cut marker slack
  });

  it('hard-cuts an oversized single field and flags truncation', () => {
    // Turn 3's assistant text is ~2100 chars; a 500-char budget forces a
    // mid-field cut with an explicit marker.
    const result = vestiGetTurns(db, { session_id: SESSION_A, turn_ids: [3], max_chars: 500 });
    expect(result.truncated).toBe(true);
    expect(result.turns[0].assistant).toContain('[truncated');
    expect(result.char_count).toBeLessThanOrEqual(500);
  });

  it('throws for an unknown session', () => {
    expect(() => vestiGetTurns(db, { session_id: 'nope' })).toThrow(/Session not found/);
  });
});
