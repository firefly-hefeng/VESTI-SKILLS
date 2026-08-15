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
    const result = searchFiles(fixture(), { query: 'migrations.ts' });
    expect(result).toEqual({
      query: 'migrations.ts',
      count: 1,
      results: [{
        path: 'packages/capture-core/src/storage/migrations.ts',
        projects: ['C:/work/vesti'],
        touches: 3,
        last_touched: '2026-07-21T00:00:00.000Z',
        sessions: [{ session_id: 'session-a', title: 'Migration work' }],
        matched_via: ['session-content', 'name'],
        score: 7.525452,
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

  it('separates an inline project hint from filename tokens and filters before recall', () => {
    let recalledQuery = '';
    let recalledProjects: string[] | undefined;
    let nameTokens: string[] = [];
    const result = searchFiles(fixture({
      listProjects: () => [
        { projectPath: 'C:/bench/vesti-skills' },
        { projectPath: 'C:/bench/vesti-app' },
      ],
      recall: (query, _limit, options) => {
        recalledQuery = query;
        recalledProjects = options?.projectPaths;
        return [];
      },
      findToolInputsContaining: (tokens) => {
        nameTokens = tokens;
        return [];
      },
      findDigestFilesContaining: () => [{
        sessionId: 'skills-session',
        keyFiles: '["src/i18n/languageRegistry.ts"]',
        title: 'Registry work',
        projectPath: 'C:/bench/vesti-skills',
        startedAt: Date.UTC(2026, 7, 1),
      }, {
        sessionId: 'app-session',
        keyFiles: '["src/i18n/languageRegistry.ts"]',
        title: 'Copy',
        projectPath: 'C:/bench/vesti-app',
        startedAt: Date.UTC(2026, 7, 2),
      }],
    }), { query: 'languageRegistry.ts in skills', includeTrace: true });

    expect(recalledQuery).toBe('languageRegistry.ts');
    expect(recalledProjects).toEqual(['C:/bench/vesti-skills']);
    expect(nameTokens).toEqual(['languageregistry.ts']);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].projects).toEqual(['C:/bench/vesti-skills']);
    expect(result.trace?.query.projectHint).toBe('skills');
  });

  it('does not let one generic filename token outrank recalled semantic evidence', () => {
    const result = searchFiles(fixture({
      recall: () => [{ sessionId: 'semantic', score: 0.03 }],
      getSession: id => id === 'semantic' ? {
        id,
        title: 'Rollback safeguards',
        projectPath: 'C:/work/vesti',
        startedAt: Date.UTC(2026, 7, 1),
      } : undefined,
      getDigestKeyFiles: id => id === 'semantic' ? '["src/opaque/Aster.ts"]' : null,
      getToolInputs: () => [],
      findDigestFilesContaining: () => [{
        sessionId: 'decoy',
        keyFiles: '["src/decoys/migrationRegistry.ts"]',
        title: 'Unrelated registry',
        projectPath: 'C:/work/vesti',
        startedAt: Date.UTC(2026, 7, 2),
      }],
    }), { query: 'migration rollback coordinated pipeline files' });

    expect(result.results[0].path).toBe('src/opaque/Aster.ts');
    expect(result.results.some(hit => hit.path.endsWith('migrationRegistry.ts'))).toBe(false);
  });

  it('exposes recall limit and internal diagnostics only when requested', () => {
    let limit = 0;
    const source = fixture({
      recall: (_query, receivedLimit) => {
        limit = receivedLimit;
        return { candidates: [], trace: { lists: { messages: ['s-1'] } } };
      },
    });
    const traced = searchFiles(source, {
      query: 'migration rollback',
      sessionRecallLimit: 30,
      includeTrace: true,
    });
    expect(limit).toBe(30);
    expect(traced.trace?.sessionRecallLimit).toBe(30);
    expect(traced.trace?.recall).toEqual({ lists: { messages: ['s-1'] } });
    expect(searchFiles(source, { query: 'migration rollback' }).trace).toBeUndefined();
  });

  it('keeps POSIX project paths case-sensitive while treating basename aliases as case-insensitive', () => {
    let scopedProjects: string[] | undefined;
    const source = fixture({
      listProjects: () => [
        { projectPath: '/srv/work/Repo' },
        { projectPath: '/srv/archive/repo' },
      ],
      recall: (_query, _limit, options) => {
        scopedProjects = options?.projectPaths;
        return [];
      },
      findDigestFilesContaining: () => [],
    });

    searchFiles(source, { query: 'policy', project: '/srv/work/Repo' });
    expect(scopedProjects).toEqual(['/srv/work/Repo']);
    expect(() => searchFiles(source, { query: 'policy', project: '/srv/work/repo' }))
      .toThrow(/Project not found/);
    expect(() => searchFiles(source, { query: 'policy', project: 'REPO' }))
      .toThrow(/Ambiguous project/);
  });

  it('matches Windows project paths without case sensitivity', () => {
    let scopedProjects: string[] | undefined;
    searchFiles(fixture({
      listProjects: () => [{ projectPath: 'C:/Bench/Vesti-App' }],
      recall: (_query, _limit, options) => {
        scopedProjects = options?.projectPaths;
        return [];
      },
      findDigestFilesContaining: () => [],
    }), { query: 'policy', project: 'c:\\bench\\vesti-app' });
    expect(scopedProjects).toEqual(['C:/Bench/Vesti-App']);
  });

  it('preserves UNC roots and matches them without case sensitivity', () => {
    let scopedProjects: string[] | undefined;
    searchFiles(fixture({
      listProjects: () => [{ projectPath: '\\\\Server\\Share\\Vesti-App' }],
      recall: (_query, _limit, options) => {
        scopedProjects = options?.projectPaths;
        return [];
      },
      findDigestFilesContaining: () => [],
    }), { query: 'policy', project: '//server/share/vesti-app' });
    expect(scopedProjects).toEqual(['\\\\Server\\Share\\Vesti-App']);
  });

  it('deduplicates Windows file paths across case and separator variants', () => {
    const result = searchFiles(fixture({
      recall: () => [{ sessionId: 'windows', score: 0.02 }],
      getSession: () => ({
        id: 'windows',
        title: 'Windows paths',
        projectPath: 'C:\\Bench\\App',
        startedAt: 1,
      }),
      getDigestKeyFiles: () => '["SRC/Feature/Policy.ts"]',
      getToolInputs: () => [{
        inputSummary: JSON.stringify({ file_path: 'src\\feature\\policy.ts' }),
        timestamp: 2,
      }],
      findDigestFilesContaining: () => [],
    }), { query: 'policy behavior' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].touches).toBe(2);
  });

  it('reports ambiguous case-insensitive project labels', () => {
    const source = fixture({
      listProjects: () => [
        { projectPath: '/srv/one', label: 'Desktop' },
        { projectPath: '/srv/two', label: 'desktop' },
      ],
    });
    expect(() => searchFiles(source, { query: 'policy', project: 'DESKTOP' }))
      .toThrow(/Ambiguous project/);
  });

  it('keeps project-aware output order and trace ranks consistent', () => {
    const sessions = {
      'project-a': {
        id: 'project-a', title: 'A adapters', projectPath: 'C:/work/a', startedAt: 1,
      },
      'project-b': {
        id: 'project-b', title: 'B adapters', projectPath: 'C:/work/b', startedAt: 2,
      },
    } as const;
    const result = searchFiles(fixture({
      recall: () => [
        { sessionId: 'project-a', score: 0.03 },
        { sessionId: 'project-b', score: 0.029 },
      ],
      getSession: id => sessions[id as keyof typeof sessions],
      getDigestKeyFiles: id => id === 'project-a'
        ? '["src/a1.ts","src/a2.ts"]'
        : '["src/b1.ts"]',
      getToolInputs: () => [],
      findDigestFilesContaining: () => [],
    }), { query: 'oauth adapters across projects', topK: 2, includeTrace: true });

    expect(result.trace?.strategy).toBe('project-aware');
    expect(result.results.map(hit => hit.path)).toEqual(['src/a1.ts', 'src/b1.ts']);
    expect(result.trace?.ranking.filter(row => row.selectedRank != null).map(row => row.path))
      .toEqual(result.results.map(hit => hit.path));
    expect(result.trace?.ranking.map(row => [row.preRank, row.postRank, row.selectedRank])).toEqual([
      [1, 1, 1],
      [3, 2, 2],
      [2, 3, null],
    ]);
  });

  it('uses relevance-weighted group coverage without rewarding a noisy long session', () => {
    const sessions = new Map([
      ['target-one', { id: 'target-one', title: 'Target one', projectPath: 'C:/work/app', startedAt: 1 }],
      ['target-two', { id: 'target-two', title: 'Target two', projectPath: 'C:/work/app', startedAt: 2 }],
      ['long-noise', { id: 'long-noise', title: 'Long noisy session', projectPath: 'C:/work/app', startedAt: 3 }],
    ]);
    const noiseFiles = Array.from({ length: 60 }, (_, index) => `src/noise/noise-${index}.ts`);
    const result = searchFiles(fixture({
      recall: () => [
        { sessionId: 'target-one', score: 0.03 },
        { sessionId: 'target-two', score: 0.029 },
        { sessionId: 'long-noise', score: 0.028 },
      ],
      getSession: id => sessions.get(id),
      getDigestKeyFiles: id => id === 'target-one'
        ? '["src/targets/one.ts"]'
        : id === 'target-two' ? '["src/targets/two.ts"]' : JSON.stringify(noiseFiles),
      getToolInputs: () => [],
      findDigestFilesContaining: () => [],
    }), { query: 'which files implement the coordinated policy', topK: 2, includeTrace: true });

    expect(result.trace?.strategy).toBe('group-aware');
    expect(result.results.map(hit => hit.path)).toEqual(['src/targets/one.ts', 'src/targets/two.ts']);
  });

  it('keeps group coverage soft rather than imposing a session quota', () => {
    const result = searchFiles(fixture({
      recall: () => [
        { sessionId: 'strong', score: 0.03 },
        { sessionId: 'weak', score: 0.01 },
      ],
      getSession: id => ({
        id,
        title: id,
        projectPath: 'C:/work/app',
        startedAt: id === 'strong' ? 1 : 2,
      }),
      getDigestKeyFiles: id => id === 'strong'
        ? '["src/targets/one.ts","src/targets/two.ts"]'
        : '["src/noise/other.ts"]',
      getToolInputs: () => [],
      findDigestFilesContaining: () => [],
    }), { query: 'which files implement the coordinated policy', topK: 2 });
    expect(result.results.map(hit => hit.path)).toEqual(['src/targets/one.ts', 'src/targets/two.ts']);
  });

  it('does not treat a singular file request as multi-file intent', () => {
    const result = searchFiles(fixture(), { query: '需要修改这个文件', includeTrace: true });
    expect(result.trace?.strategy).toBe('score');
  });
});
