const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1, 8, 0, 0);

export const DATASET_ID = 'vesti-file-search-large-v2';
export const DATASET_SEED = 221250144;

export const projects = [
  { id: 'app', root: 'C:/bench/vesti-app', platform: 'codex' },
  { id: 'cli', root: 'C:/bench/vesti-cli', platform: 'claude-code' },
  { id: 'extension', root: 'C:/bench/vesti-extension', platform: 'cursor' },
  { id: 'auth', root: 'C:/bench/vesti-auth', platform: 'kimi-code' },
  { id: 'skills', root: 'C:/bench/vesti-skills', platform: 'codex' },
  { id: 'landing', root: 'C:/bench/vesti-landing', platform: 'claude-code' },
  { id: 'analytics', root: 'C:/bench/vesti-analytics', platform: 'cursor' },
  { id: 'importer', root: 'C:/bench/vesti-importer', platform: 'kimi-code' },
];

// Concept families are split-isolated by index: dev (0-1), test (2-9), and
// provisional holdout (10-11) never reuse a subject, filename, or concept id.
// The order also keeps each split from being a proxy for query language.
const concepts = [
  { id: 'oauth', language: 'en', subject: 'oauth', semantic: 'nonce', multi: 'callback', cross: 'refresh', stale: 'implicit', filename: 'redirectPolicy.ts' },
  { id: 'capture', language: 'zh', subject: '采集', semantic: '增量', multi: '会话', cross: '同步', stale: '轮询', filename: 'captureRegistry.ts' },
  { id: 'scheduler', language: 'mixed', subject: 'scheduler', semantic: '队列', multi: '重试', cross: 'cron', stale: 'legacy', filename: 'schedulerRegistry.ts' },
  { id: 'migration', language: 'en', subject: 'migration', semantic: 'rollback', multi: 'transaction', cross: 'schema', stale: 'bootstrap', filename: 'migrationRegistry.ts' },
  { id: 'proxy', language: 'zh', subject: '代理', semantic: '重试', multi: '网关', cross: '鉴权', stale: '白名单', filename: 'proxyRegistry.ts' },
  { id: 'dashboard', language: 'en', subject: 'dashboard', semantic: 'tooltip', multi: 'series', cross: 'metrics', stale: 'overview', filename: 'chartRegistry.tsx' },
  { id: 'embedding', language: 'zh', subject: '向量', semantic: '批处理', multi: '索引', cross: '召回', stale: '缓存', filename: 'embeddingRegistry.ts' },
  { id: 'installer', language: 'en', subject: 'installer', semantic: 'shortcut', multi: 'wizard', cross: 'artifact', stale: 'squirrel', filename: 'setupPolicy.ts' },
  { id: 'export', language: 'zh', subject: '导出', semantic: '增量', multi: '文档', cross: '归档', stale: '旧版', filename: 'exportRegistry.ts' },
  { id: 'sync', language: 'mixed', subject: 'sync', semantic: '冲突', multi: '合并', cross: 'checkpoint', stale: 'legacy', filename: 'syncRegistry.ts' },
  { id: 'localization', language: 'en', subject: 'localization', semantic: 'fallback', multi: 'catalog', cross: 'locale', stale: 'bundle', filename: 'languageRegistry.ts' },
  { id: 'membership', language: 'zh', subject: '会员', semantic: '过期', multi: '权益', cross: '续期', stale: '本地', filename: 'membershipRegistry.ts' },
];

const FILE_CODES = [
  'Aster', 'Birch', 'Cedar', 'Dahlia', 'Elm', 'Fjord',
  'Garnet', 'Harbor', 'Indigo', 'Juniper', 'Kestrel', 'Lumen',
];

const BASENAME_COLLISION_INDICES = new Set([0, 3, 6, 10]);
const HIGH_FANOUT_INDICES = new Set([1, 5, 8, 10]);
const HARD_NEGATIVE_INDICES = new Set([1, 3, 6, 8, 9, 11]);

// Each project occurs three or four times across the cross-project stratum.
// Four cases deliberately require three projects instead of two.
const CROSS_PROJECT_GROUPS = [
  [0, 1], [2, 3, 4], [5, 6], [7, 0],
  [1, 2, 3], [4, 5], [6, 7], [0, 2, 4],
  [1, 3], [5, 7], [0, 4, 6], [2, 5],
];

const MULTI_FILE_COUNTS = [2, 3, 2, 4, 2, 3, 2, 4, 2, 3, 2, 3];

const sessions = [];
const cases = [];
let serial = 0;

function projectAt(index) {
  return projects[((index % projects.length) + projects.length) % projects.length];
}

function splitAt(index) {
  if (index < 2) return 'dev';
  if (index < 10) return 'test';
  return 'provisional-holdout';
}

function canonicalPath(index, bucket, filename) {
  return `src/modules/${bucket}${String(index + 1).padStart(2, '0')}/${filename}`;
}

function opaqueFilename(index, role, extension = 'ts') {
  return `${FILE_CODES[index]}${role}.${extension}`;
}

function taskQuery(concept, task) {
  const anchor = concept[task];
  if (concept.language === 'zh') {
    const intent = {
      semantic: '防护在哪个文件',
      multi: '需要修改哪些文件',
      cross: '跨项目实现在哪里',
      stale: '旧实现以前在哪里',
    }[task];
    // Natural Chinese queries are normally written without artificial spaces.
    // This deliberately exercises trigram planning plus short-term fallbacks.
    return `${concept.subject}${anchor}${intent}`;
  }
  if (concept.language === 'mixed') {
    const intent = {
      semantic: 'failure handling location',
      multi: 'pipeline files',
      cross: 'cross project adapters',
      stale: 'old implementation path',
    }[task];
    return `${concept.subject} ${anchor} ${intent}`;
  }
  const intent = {
    semantic: 'failure protection location',
    multi: 'coordinated pipeline files',
    cross: 'adapters across projects',
    stale: 'retired implementation path',
  }[task];
  return `${concept.subject} ${anchor} ${intent}`;
}

function taskSearchText(concept, task) {
  const anchor = concept[task];
  if (concept.language === 'zh') {
    const detail = {
      semantic: '校验已经加入流程并完成验证',
      multi: '读写两侧组件需要协同更新',
      cross: '规则已分别接入不同平台',
      stale: '历史流程在迁移后已经移除',
    }[task];
    return `${concept.subject} 流程针对 ${anchor} 的${detail}`;
  }
  const detail = {
    semantic: 'safeguards were verified under failure conditions',
    multi: 'reader and writer components were updated together',
    cross: 'rules were applied independently on each platform',
    stale: 'historical flow was removed after migration',
  }[task];
  return `${concept.subject} workflow addressed ${anchor}; ${detail}`;
}

function rawPath(file, index) {
  return index % 3 === 1 ? file.replaceAll('/', '\\') : file;
}

function toolInput(file, index) {
  const raw = rawPath(file, index);
  if (index % 3 === 0) return JSON.stringify({ path: raw, operation: 'edit' });
  if (index % 3 === 1) return `Edit ${raw} and run focused verification`;
  return `apply_patch ${raw}`;
}

function addSession({
  id,
  title,
  summary,
  searchText,
  project,
  files,
  conceptId,
  timeOffset = 0,
  repeatTouches = 1,
}) {
  const startedAt = START + (serial * 2 + timeOffset) * HOUR;
  serial += 1;
  const toolInputs = [];
  for (let touch = 0; touch < repeatTouches; touch += 1) {
    files.forEach((file, fileIndex) => {
      toolInputs.push({
        inputSummary: toolInput(file, serial + fileIndex + touch),
        timestamp: startedAt + (touch * files.length + fileIndex + 1) * 1000,
      });
    });
  }
  const session = {
    id,
    platformSessionId: `platform-${id}`,
    title,
    summary,
    searchText,
    projectPath: project.root,
    platform: project.platform,
    startedAt,
    lastActivityAt: startedAt + HOUR,
    keyFiles: files.map((file, index) => rawPath(file, serial + index)),
    toolInputs,
    conceptId,
  };
  sessions.push(session);
  return session;
}

function target(file, project, session, currentState = 'exists', extra = {}) {
  return {
    path: file,
    projectPath: project.root,
    sessionIds: [session.id],
    evidenceChannels: ['key-files', 'tool-input'],
    historicalState: 'present',
    currentState,
    ...extra,
  };
}

function addCase({
  id,
  category,
  query,
  language,
  index,
  targets,
  note,
  conceptId,
  mustAbstain = false,
  negativeKind,
  nuisanceFlags = [],
}) {
  cases.push({
    id,
    category,
    split: splitAt(index),
    query,
    language,
    topK: 10,
    targets,
    conceptId,
    mustAbstain,
    ...(negativeKind ? { negativeKind } : {}),
    nuisanceFlags,
    note,
  });
}

for (const [index, concept] of concepts.entries()) {
  const split = splitAt(index);

  // Semantic single-file case: query terms never occur in the target basename.
  const semanticProject = projectAt(index);
  const semanticFile = canonicalPath(index, 's', opaqueFilename(index, 'S'));
  const semanticSession = addSession({
    id: `${split}-semantic-${concept.id}`,
    title: `Historical ${concept.id} reliability work`,
    summary: `Completed a narrowly scoped ${concept.id} reliability change`,
    searchText: taskSearchText(concept, 'semantic'),
    project: semanticProject,
    files: [semanticFile],
    conceptId: concept.id,
  });
  addCase({
    id: `semantic-${String(index + 1).padStart(2, '0')}`,
    category: 'semantic-single',
    query: taskQuery(concept, 'semantic'),
    language: concept.language,
    index,
    targets: [target(semanticFile, semanticProject, semanticSession)],
    conceptId: concept.id,
    note: 'The target basename contains neither query term.',
    nuisanceFlags: index % 2 === 0 ? ['generic-token-filename-distractor'] : [],
  });

  // Filename-only case: filename is absent from title, summary and message text.
  const filenameProject = projectAt(index + 2);
  const filenameFile = canonicalPath(index, 'f', concept.filename);
  const filenameSession = addSession({
    id: `${split}-filename-${concept.id}`,
    title: `Finalize component lifecycle policy ${index + 1}`,
    summary: 'Updated a narrowly scoped implementation policy',
    searchText: 'The component lifecycle rules were updated and verified without naming the source file',
    project: filenameProject,
    files: [filenameFile],
    conceptId: concept.id,
  });
  addCase({
    id: `filename-${String(index + 1).padStart(2, '0')}`,
    category: 'filename-only',
    query: BASENAME_COLLISION_INDICES.has(index)
      ? `${concept.filename} in ${filenameProject.id}`
      : concept.filename,
    language: 'code',
    index,
    targets: [target(filenameFile, filenameProject, filenameSession)],
    conceptId: concept.id,
    note: BASENAME_COLLISION_INDICES.has(index)
      ? 'The exact filename is project-qualified because another project has the same basename.'
      : 'Only key_files/tool input contains the filename.',
    nuisanceFlags: BASENAME_COLLISION_INDICES.has(index) ? ['basename-collision'] : [],
  });

  // Same-project multi-file case.
  const multiProject = projectAt(index + 4);
  const multiFiles = Array.from({ length: MULTI_FILE_COUNTS[index] }, (_, fileIndex) =>
    canonicalPath(index, 'm', opaqueFilename(index, `M${fileIndex + 1}`)));
  const multiSession = addSession({
    id: `${split}-multi-${concept.id}`,
    title: `${concept.id} coordinated pipeline update`,
    summary: `Updated ${multiFiles.length} related components in one project`,
    searchText: taskSearchText(concept, 'multi'),
    project: multiProject,
    files: multiFiles,
    conceptId: concept.id,
  });
  addCase({
    id: `multi-${String(index + 1).padStart(2, '0')}`,
    category: 'multi-file',
    query: taskQuery(concept, 'multi'),
    language: concept.language,
    index,
    targets: multiFiles.map(file => target(file, multiProject, multiSession)),
    conceptId: concept.id,
    note: 'Every listed file is required in the same project.',
  });

  // Cross-project case with one required file per project. The explicit group
  // schedule prevents a particular project pair from becoming a shortcut.
  const crossRows = CROSS_PROJECT_GROUPS[index].map((projectIndex, rowIndex) => {
    const project = projectAt(projectIndex);
    const file = canonicalPath(index, `c${rowIndex + 1}`, opaqueFilename(index, `C${rowIndex + 1}`));
    const session = addSession({
      id: `${split}-cross-${rowIndex + 1}-${concept.id}`,
      title: `${concept.id} platform integration ${rowIndex + 1}`,
      summary: `Applied a coordinated integration rule in ${project.id}`,
      searchText: taskSearchText(concept, 'cross'),
      project,
      files: [file],
      conceptId: concept.id,
    });
    return { project, file, session };
  });
  addCase({
    id: `cross-${String(index + 1).padStart(2, '0')}`,
    category: 'cross-project',
    query: taskQuery(concept, 'cross'),
    language: concept.language,
    index,
    targets: crossRows.map(row => target(row.file, row.project, row.session)),
    conceptId: concept.id,
    note: 'Every project and every listed file is required.',
  });

  // Historical path that is absent from the simulated current filesystem.
  const staleProject = projectAt(index + 6);
  const staleFile = `archive/v${String(index + 1).padStart(2, '0')}/${opaqueFilename(index, 'R')}`;
  const staleKind = ['deleted', 'moved', 'renamed'][index % 3];
  const replacementPath = staleKind === 'deleted'
    ? undefined
    : canonicalPath(index, 'current', opaqueFilename(index, staleKind === 'moved' ? 'Moved' : 'Renamed'));
  const staleSession = addSession({
    id: `${split}-stale-${concept.id}`,
    title: `${concept.id} historical implementation retirement`,
    summary: `Retired an old ${concept.id} implementation`,
    searchText: taskSearchText(concept, 'stale'),
    project: staleProject,
    files: [staleFile],
    conceptId: concept.id,
  });
  addCase({
    id: `stale-${String(index + 1).padStart(2, '0')}`,
    category: 'stale-path',
    query: taskQuery(concept, 'stale'),
    language: concept.language,
    index,
    targets: [target(staleFile, staleProject, staleSession, 'missing', {
      staleKind,
      ...(replacementPath ? { replacementPath } : {}),
    })],
    conceptId: concept.id,
    note: 'Retrieval gold is historical; an Agent must not claim it currently exists.',
  });

  // A direct filename distractor that shares only the broad subject token.
  if (index % 2 === 0) {
    addSession({
      id: `${split}-distractor-name-${concept.id}`,
      title: `Unrelated ${concept.id} visualization`,
      summary: `Dashboard display for generic ${concept.subject} counters`,
      searchText: `${concept.subject} dashboard visualization and theme colors`,
      project: projectAt(index + 7),
      files: [`src/ui/${concept.subject}Panel.tsx`],
      conceptId: `${concept.id}-distractor`,
      timeOffset: 200,
      repeatTouches: 4,
    });
  }

  // Basename collision for a subset of filename-only queries.
  if (BASENAME_COLLISION_INDICES.has(index)) {
    addSession({
      id: `${split}-distractor-basename-${concept.id}`,
      title: `Archived component copy ${index + 1}`,
      summary: 'An unrelated archived copy in another project',
      searchText: 'Archived component copy retained for an unrelated experiment',
      project: projectAt(index + 3),
      files: [`src/decoys/d${index + 1}/${concept.filename}`],
      conceptId: `${concept.id}-basename-distractor`,
      timeOffset: 150,
      repeatTouches: 3,
    });
  }

  // High-fanout stress is represented in every split rather than being a
  // development-only pattern. Candidates exceed SESSION_RECALL_LIMIT=12.
  if (HIGH_FANOUT_INDICES.has(index)) {
    for (let fanout = 0; fanout < 15; fanout += 1) {
      addSession({
        id: `${split}-fanout-${concept.id}-${fanout + 1}`,
        title: `${concept.id} auxiliary investigation ${fanout + 1}`,
        summary: `Auxiliary ${concept.subject} notes with no target implementation`,
        searchText: `${concept.subject} auxiliary investigation number ${fanout + 1}`,
        project: projectAt(index + fanout),
        files: [`src/noise/${concept.id}/note${fanout + 1}.md`],
        conceptId: `${concept.id}-fanout`,
        timeOffset: 300 + fanout,
      });
    }
  }

  const isHardNegative = HARD_NEGATIVE_INDICES.has(index);
  addCase({
    id: `negative-${String(index + 1).padStart(2, '0')}`,
    category: 'negative',
    query: isHardNegative
      ? `${concept.subject} neverimplemented${index + 1}`
      : `zephyr${index + 1} invoicehook${index + 1}`,
    language: concept.language,
    index,
    targets: [],
    conceptId: concept.id,
    mustAbstain: true,
    negativeKind: isHardNegative ? 'hard' : 'clean',
    note: isHardNegative
      ? 'Shares a broad domain token but the requested feature was never implemented.'
      : 'No query token occurs anywhere in the corpus.',
    nuisanceFlags: isHardNegative ? ['partial-token-overlap'] : [],
  });
}

function tokens(text) {
  return text.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(token => [...token].length >= 2);
}

function recallScore(session, query) {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return 0;
  const haystack = `${session.title} ${session.summary} ${session.searchText}`.toLowerCase();
  const hits = queryTokens.filter(token => haystack.includes(token)).length;
  return hits === 0 ? 0 : hits / queryTokens.length;
}

export function recall(query, limit = 12) {
  return sessions
    .map(session => ({ session, score: recallScore(session, query) }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || b.session.lastActivityAt - a.session.lastActivityAt)
    .slice(0, limit);
}

export function createDataSource() {
  const byId = new Map(sessions.map(session => [session.id, session]));
  return {
    recall(query, limit) {
      return recall(query, limit).map(row => ({ sessionId: row.session.id, score: row.score }));
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

export { cases, sessions };

export function datasetIntegrity() {
  const categories = Object.fromEntries(
    [...new Set(cases.map(testCase => testCase.category))].map(category => [
      category,
      cases.filter(testCase => testCase.category === category).length,
    ]),
  );
  return {
    datasetId: DATASET_ID,
    seed: DATASET_SEED,
    projects: projects.length,
    sessions: sessions.length,
    cases: cases.length,
    categories,
    splits: Object.fromEntries(
      [...new Set(cases.map(testCase => testCase.split))].map(split => [
        split,
        cases.filter(testCase => testCase.split === split).length,
      ]),
    ),
  };
}
