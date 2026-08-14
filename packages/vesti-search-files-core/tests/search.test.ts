import { describe, expect, it } from 'vitest';

import {
  searchFiles,
  SESSION_RECALL_LIMIT,
  type FileSearchDataSource,
} from '../src/index.js';

function fixture(overrides: Partial<FileSearchDataSource> = {}): FileSearchDataSource {
  return {
    recall: () => [{ sessionId: 'session-a', score: 0.02 }],
    getSession: () => ({
      id: 'session-a',
      title: 'Migration work',
      projectPath: 'C:/work/vesti',
      startedAt: Date.UTC(2026, 6, 20),
    }),
    getDigestKeyFiles: () => '["packages/capture-core/src/storage/migrations.ts"]',
    getToolInputs: () => [{
      inputSummary: '{"file_path":"packages/capture-core/src/storage/migrations.ts"}',
      timestamp: Date.UTC(2026, 6, 21),
    }],
    findToolInputsContaining: () => [],
    findDigestFilesContaining: () => [{
      sessionId: 'session-a',
      keyFiles: '["packages/capture-core/src/storage/migrations.ts"]',
      title: 'Migration work',
      projectPath: 'C:/work/vesti',
      startedAt: Date.UTC(2026, 6, 20),
    }],
    ...overrides,
  };
}

describe('searchFiles', () => {
  it('combines recalled-session and filename evidence', () => {
    const result = searchFiles(fixture(), { query: 'transactional migrations' });
    expect(result).toEqual({
      query: 'transactional migrations',
      count: 1,
      results: [{
        path: 'packages/capture-core/src/storage/migrations.ts',
        projects: ['C:/work/vesti'],
        touches: 3,
        last_touched: '2026-07-21T00:00:00.000Z',
        sessions: [{ session_id: 'session-a', title: 'Migration work' }],
        matched_via: ['session-content', 'name'],
        score: 3.54,
      }],
    });
  });

  it('preserves the recall limit and topK contract', () => {
    let recallLimit = 0;
    const result = searchFiles(fixture({
      recall: (_query, limit) => {
        recallLimit = limit;
        return [];
      },
      findDigestFilesContaining: () => Array.from({ length: 30 }, (_, index) => ({
        sessionId: `s-${index}`,
        keyFiles: `["src/migrations-${index}.ts"]`,
        title: `Session ${index}`,
        projectPath: 'C:/work/vesti',
        startedAt: index,
      })),
    }), { query: 'migrations', topK: 100 });
    expect(recallLimit).toBe(SESSION_RECALL_LIMIT);
    expect(result.count).toBe(25);
  });

  it('degrades when an optional evidence channel is unavailable', () => {
    const result = searchFiles(fixture({
      getDigestKeyFiles: () => { throw new Error('missing column'); },
      findDigestFilesContaining: () => { throw new Error('missing table'); },
    }), { query: 'transactional work' });
    expect(result.results[0].matched_via).toEqual(['session-content']);
  });

  it('requires a query', () => {
    expect(() => searchFiles(fixture(), { query: '  ' })).toThrow(/query is required/);
  });
});
