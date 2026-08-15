const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 6, 1, 9, 0, 0);

export const sessions = [
  {
    id: 'session-oauth',
    title: 'Fix third-party login redirect handling',
    projectPath: 'C:/work/vesti-app',
    startedAt: START,
    searchText: 'oauth redirect callback pkce wechat login state validation',
    keyFiles: ['apps/desktop/src/auth/oauthCallback.ts'],
    toolInputs: [
      {
        inputSummary: '{"path":"apps/desktop/src/auth/oauthCallback.ts","operation":"edit"}',
        timestamp: START + HOUR,
      },
    ],
  },
  {
    id: 'session-membership',
    title: 'Harden entitlement expiration checks',
    projectPath: 'C:/work/vesti-app',
    startedAt: START + HOUR * 4,
    searchText: 'membership entitlement expiration clock rollback refresh race',
    keyFiles: ['src/membership/billingRules.ts'],
    toolInputs: [
      {
        inputSummary: 'Edit src/membership/billingRules.ts to use trusted server time',
        timestamp: START + HOUR * 5,
      },
    ],
  },
  {
    id: 'session-token-app',
    title: 'Correct cumulative token accounting in desktop capture',
    projectPath: 'C:/work/vesti-app',
    startedAt: START + HOUR * 8,
    searchText: 'token accounting cumulative usage double count codex desktop app',
    keyFiles: ['packages/capture-core/src/adapters/codex/parser.ts'],
    toolInputs: [
      {
        inputSummary: 'packages/capture-core/src/adapters/codex/parser.ts',
        timestamp: START + HOUR * 9,
      },
    ],
  },
  {
    id: 'session-token-cli',
    title: 'Correct cumulative token accounting in CLI capture',
    projectPath: 'C:/work/vesti-cli',
    startedAt: START + HOUR * 10,
    searchText: 'token accounting cumulative usage double count codex cli',
    keyFiles: ['packages/core/src/adapters/codex/parser.ts'],
    toolInputs: [
      {
        inputSummary: 'packages/core/src/adapters/codex/parser.ts',
        timestamp: START + HOUR * 11,
      },
    ],
  },
  {
    id: 'session-legacy-export',
    title: 'Build the first Obsidian export flow',
    projectPath: 'C:/work/vesti-app',
    startedAt: START + HOUR * 12,
    searchText: 'legacy obsidian export markdown vault conversation archive',
    keyFiles: ['src/export/legacyObsidianExporter.ts'],
    toolInputs: [
      {
        inputSummary: 'Delete src/export/legacyObsidianExporter.ts after migration',
        timestamp: START + HOUR * 13,
      },
    ],
  },
  {
    id: 'session-distractor',
    title: 'Update dashboard chart colors',
    projectPath: 'C:/work/vesti-app',
    startedAt: START + HOUR * 14,
    searchText: 'dashboard chart theme dark mode colors tooltip',
    keyFiles: ['src/ui/dashboard/TokenChart.tsx'],
    toolInputs: [
      {
        inputSummary: 'src/ui/dashboard/TokenChart.tsx',
        timestamp: START + HOUR * 15,
      },
    ],
  },
];

export const cases = [
  {
    id: 'P1-semantic',
    query: 'oauth redirect',
    expected: ['apps/desktop/src/auth/oauthCallback.ts'],
    expectedProjects: ['C:/work/vesti-app'],
    expectedSessions: ['session-oauth'],
    note: 'Semantic topic lookup.',
  },
  {
    id: 'P2-filename-only',
    query: 'billingRules.ts',
    expected: ['src/membership/billingRules.ts'],
    expectedProjects: ['C:/work/vesti-app'],
    expectedSessions: ['session-membership'],
    note: 'The filename is absent from searchable session prose.',
  },
  {
    id: 'P3-cross-project',
    query: 'token accounting',
    expected: [
      'packages/capture-core/src/adapters/codex/parser.ts',
      'packages/core/src/adapters/codex/parser.ts',
    ],
    expectedProjects: ['C:/work/vesti-app', 'C:/work/vesti-cli'],
    expectedSessions: ['session-token-app', 'session-token-cli'],
    note: 'Two files in two projects are required.',
  },
  {
    id: 'P4-stale-history',
    query: 'legacy obsidian export',
    expected: ['src/export/legacyObsidianExporter.ts'],
    expectedProjects: ['C:/work/vesti-app'],
    expectedSessions: ['session-legacy-export'],
    historicalPathExists: false,
    note: 'Retrieval should return history; an Agent must still verify the current filesystem.',
  },
  {
    id: 'P5-negative',
    query: 'stripe invoice webhook',
    expected: [],
    expectedProjects: [],
    expectedSessions: [],
    note: 'No supporting history exists.',
  },
];

function tokens(text) {
  return text.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(token => token.length >= 2);
}

function recallScore(session, query) {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return 0;
  const haystack = `${session.title} ${session.searchText}`.toLowerCase();
  const hits = queryTokens.filter(token => haystack.includes(token)).length;
  return hits === 0 ? 0 : hits / queryTokens.length;
}

export function recall(query, limit = 12) {
  return sessions
    .map(session => ({ session, score: recallScore(session, query) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || b.session.startedAt - a.session.startedAt)
    .slice(0, limit);
}

export function createDataSource() {
  const byId = new Map(sessions.map(session => [session.id, session]));
  return {
    recall(query, limit) {
      return recall(query, limit).map(row => ({
        sessionId: row.session.id,
        score: row.score,
      }));
    },
    getSession(sessionId) {
      const session = byId.get(sessionId);
      return session && {
        id: session.id,
        title: session.title,
        projectPath: session.projectPath,
        startedAt: session.startedAt,
      };
    },
    getDigestKeyFiles(sessionId) {
      const session = byId.get(sessionId);
      return session ? JSON.stringify(session.keyFiles) : undefined;
    },
    getToolInputs(sessionId) {
      return byId.get(sessionId)?.toolInputs ?? [];
    },
    findToolInputsContaining(queryTokens) {
      return sessions.flatMap(session => session.toolInputs
        .filter(row => queryTokens.some(token => row.inputSummary.toLowerCase().includes(token.toLowerCase())))
        .map(row => ({
          ...row,
          sessionId: session.id,
          title: session.title,
          projectPath: session.projectPath,
        })));
    },
    findDigestFilesContaining(queryTokens) {
      return sessions
        .filter(session => queryTokens.some(token => JSON.stringify(session.keyFiles).toLowerCase().includes(token.toLowerCase())))
        .map(session => ({
          sessionId: session.id,
          keyFiles: JSON.stringify(session.keyFiles),
          title: session.title,
          projectPath: session.projectPath,
          startedAt: session.startedAt,
        }));
    },
  };
}
