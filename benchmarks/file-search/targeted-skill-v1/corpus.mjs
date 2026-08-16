import {
  cases as v1Cases,
  sessions as v1Sessions,
} from '../corpus.mjs';
import {
  cases as largeCases,
  sessions as largeSessions,
} from '../large-corpus.mjs';
import {
  cases as calibrationCases,
  sessions as calibrationSessions,
} from '../v2/calibration-corpus.mjs';
import {
  cases as formalCases,
  sessions as formalSessions,
} from '../v2/formal-corpus.mjs';
import {
  cases as rapidCases,
  sessions as rapidSessions,
} from '../rapid-v3/corpus.mjs';

const MINUTE = 60 * 1000;
const START = Date.UTC(2026, 7, 16, 8, 0, 0);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_SEARCH_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export const DATASET_ID = 'vesti-file-search-targeted-skill-v1';
export const DATASET_SEED = 816202681;

function invariant(condition, message) {
  if (!condition) throw new Error(`[${DATASET_ID}] ${message}`);
}

function canonical(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function basename(value) {
  return canonical(value).split('/').at(-1) ?? '';
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) {
    const key = keyOf(value);
    if (key == null) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function assertExactCounts(actual, expected, label) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  invariant(
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    `${label} keys differ: expected ${expectedKeys.join(', ')}, got ${actualKeys.join(', ')}`,
  );
  for (const key of expectedKeys) {
    invariant(actual[key] === expected[key], `${label}.${key} must be ${expected[key]}, got ${actual[key] ?? 0}`);
  }
}

function seedHash(label) {
  let value = (DATASET_SEED ^ 0x811c9dc5) >>> 0;
  for (const codePoint of String(label)) {
    value ^= codePoint.codePointAt(0);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  value ^= value >>> 16;
  return value >>> 0;
}

function stableUuid(namespace, logicalKey) {
  const raw = Array.from({ length: 4 }, (_, index) =>
    seedHash(`${namespace}:${logicalKey}:${index}`).toString(16).padStart(8, '0'))
    .join('')
    .split('');
  raw[12] = '4';
  raw[16] = ['8', '9', 'a', 'b'][Number.parseInt(raw[16], 16) % 4];
  const hex = raw.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function seededShuffle(values, namespace) {
  const shuffled = [...values];
  let state = seedHash(`shuffle:${namespace}`) || 0x6d2b79f5;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

const PROJECT_ROWS = Object.freeze([
  ['lyra-214', 'codex'],
  ['umbra-327', 'claude-code'],
  ['vesper-438', 'cursor'],
  ['cobalt-549', 'kimi-code'],
  ['juniper-650', 'codex'],
  ['meridian-761', 'claude-code'],
  ['opal-872', 'cursor'],
  ['thistle-983', 'kimi-code'],
]);

export const projects = Object.freeze(PROJECT_ROWS.map(([id, platform]) => Object.freeze({
  id,
  root: `C:/targeted-skill-workspaces/${id}`,
  platform,
})));

// Eight independent concepts, each represented by two cases. Four concepts are
// authored in Chinese and four in English, yielding an exact 8/8 language split.
// Queries describe ordinary historical engineering requests. They never mention
// benchmark roles, paths, session ids, evidence intersection, or abstention.
const CASE_SPECS = Object.freeze([
  Object.freeze({
    id: 'targeted-zh-single-01', conceptId: 'tv1-lyric-1f6a', language: 'zh', category: 'triple-single',
    anchors: ['暮蓝握手', 'verifyOrchidLease', 'SILT-731'], projectIndexes: [0],
    basenames: ['QuenbyLease.ts'],
    query: '在 lyra-214 项目里，之前处理“暮蓝握手”、调用 verifyOrchidLease 并解决 SILT-731 时，改的是哪个源码文件？',
  }),
  Object.freeze({
    id: 'targeted-zh-multi-01', conceptId: 'tv1-lyric-1f6a', language: 'zh', category: 'minimal-multi-file',
    anchors: ['苔镜迁移', 'assembleMossIndex', 'MICA-482'], projectIndexes: [0],
    basenames: ['ZaffreManifest.ts', 'YarrowReplay.ts', 'PloverAudit.ts'],
    roles: ['生成迁移清单', '读取回放数据', '执行结果校验'],
    query: 'lyra-214 项目上次做“苔镜迁移”并通过 assembleMossIndex 处理 MICA-482 时，分别负责生成迁移清单、读取回放数据和执行结果校验的源码文件有哪些？',
  }),
  Object.freeze({
    id: 'targeted-zh-project-02', conceptId: 'tv1-tidal-2b7c', language: 'zh', category: 'project-isolation',
    anchors: ['潮汐回执', 'sealTideReceipt', 'BRINE-264'], projectIndexes: [1],
    distractorProjectIndexes: [1, 2, 3], basenames: ['NacreReceipt.ts'],
    query: '在 umbra-327 项目中，处理“潮汐回执”、使用 sealTideReceipt 修复 BRINE-264 的实现文件在哪里？',
  }),
  Object.freeze({
    id: 'targeted-zh-negative-02', conceptId: 'tv1-tidal-2b7c', language: 'zh', category: 'relational-negative',
    anchors: ['琥珀折返', 'mergeAmberRoute', 'RUNE-907'], projectIndexes: [1, 2, 3],
    basenames: ['AmberDetour.ts'],
    query: '之前处理“琥珀折返”、调用 mergeAmberRoute 解决 RUNE-907 的源码文件在哪里？',
  }),
  Object.freeze({
    id: 'targeted-zh-single-03', conceptId: 'tv1-kite-3c8d', language: 'zh', category: 'triple-single',
    anchors: ['纸鸢回压', 'trimKiteBackflow', 'GALE-518'], projectIndexes: [2],
    basenames: ['MistralBackflow.ts'],
    query: 'vesper-438 里“纸鸢回压”问题调用 trimKiteBackflow 处理 GALE-518 时，对应哪个源码文件？',
  }),
  Object.freeze({
    id: 'targeted-zh-cross-03', conceptId: 'tv1-kite-3c8d', language: 'zh', category: 'project-isolation',
    anchors: ['双塔回声', 'alignEchoSpindle', 'SONAR-346'], projectIndexes: [3, 4],
    distractorProjectIndexes: [3, 4, 5], basenames: ['OrielEast.ts', 'OrielWest.ts'],
    query: 'cobalt-549 和 juniper-650 中，“双塔回声”调用 alignEchoSpindle 处理 SONAR-346 的实现文件分别是什么？',
  }),
  Object.freeze({
    id: 'targeted-zh-multi-04', conceptId: 'tv1-porcelain-4d9e', language: 'zh', category: 'minimal-multi-file',
    anchors: ['瓷片降噪', 'stitchGlazeSamples', 'KILN-625'], projectIndexes: [3],
    basenames: ['CeladonSampler.ts', 'RakuStitcher.ts'],
    roles: ['采集釉面样本', '拼接降噪片段'],
    query: 'cobalt-549 中“瓷片降噪”通过 stitchGlazeSamples 解决 KILN-625 时，负责采集釉面样本和拼接降噪片段的文件有哪些？',
  }),
  Object.freeze({
    id: 'targeted-zh-negative-04', conceptId: 'tv1-porcelain-4d9e', language: 'zh', category: 'relational-negative',
    anchors: ['霜铃回卷', 'foldFrostBell', 'RIME-884'], projectIndexes: [3, 4, 5],
    basenames: ['FrostBellFold.ts'],
    query: '历史上修复“霜铃回卷”、使用 foldFrostBell 处理 RIME-884 的源码文件是哪一个？',
  }),
  Object.freeze({
    id: 'targeted-en-single-05', conceptId: 'tv1-ember-5eaf', language: 'en', category: 'triple-single',
    anchors: ['ember ledger rollover', 'reconcileCinderPage', 'ASH-413'], projectIndexes: [4],
    basenames: ['CinderLedger.ts'],
    query: 'Which source file in juniper-650 handled the "ember ledger rollover", called reconcileCinderPage, and fixed ASH-413?',
  }),
  Object.freeze({
    id: 'targeted-en-multi-05', conceptId: 'tv1-ember-5eaf', language: 'en', category: 'minimal-multi-file',
    anchors: ['lantern queue recovery', 'restoreLanternQueue', 'WICK-752'], projectIndexes: [4],
    basenames: ['LanternJournal.ts', 'WickReplayer.ts', 'GlowVerifier.ts'],
    roles: ['persist the recovery journal', 'replay pending entries', 'verify the restored queue'],
    query: 'For the "lantern queue recovery" in juniper-650 that used restoreLanternQueue for WICK-752, which files persisted the journal, replayed pending entries, and verified the restored queue?',
  }),
  Object.freeze({
    id: 'targeted-en-project-06', conceptId: 'tv1-orbit-6fb0', language: 'en', category: 'project-isolation',
    anchors: ['orbital receipt drift', 'pinApogeeReceipt', 'ORBIT-639'], projectIndexes: [5],
    distractorProjectIndexes: [5, 6, 7], basenames: ['ApogeeReceipt.ts'],
    query: 'In meridian-761, where is the implementation that handled "orbital receipt drift", used pinApogeeReceipt, and addressed ORBIT-639?',
  }),
  Object.freeze({
    id: 'targeted-en-negative-06', conceptId: 'tv1-orbit-6fb0', language: 'en', category: 'relational-negative',
    anchors: ['comet cache rewind', 'rewindCometCache', 'TAIL-291'], projectIndexes: [5, 6, 7],
    basenames: ['CometRewind.ts'],
    query: 'Which historical source file handled the "comet cache rewind", invoked rewindCometCache, and resolved TAIL-291?',
  }),
  Object.freeze({
    id: 'targeted-en-single-07', conceptId: 'tv1-harbor-70c1', language: 'en', category: 'triple-single',
    anchors: ['harbor beacon handoff', 'transferBeaconLease', 'PIER-845'], projectIndexes: [6],
    basenames: ['BeaconHandoff.ts'],
    query: 'Which file in opal-872 implemented the "harbor beacon handoff", called transferBeaconLease, and fixed PIER-845?',
  }),
  Object.freeze({
    id: 'targeted-en-cross-07', conceptId: 'tv1-harbor-70c1', language: 'en', category: 'project-isolation',
    anchors: ['paired harbor clocks', 'synchronizePierClock', 'TIDE-570'], projectIndexes: [6, 7],
    distractorProjectIndexes: [6, 7, 0], basenames: ['OpalPierClock.ts', 'ThistlePierClock.ts'],
    query: 'For opal-872 and thistle-983, which files handled "paired harbor clocks", used synchronizePierClock, and addressed TIDE-570?',
  }),
  Object.freeze({
    id: 'targeted-en-multi-08', conceptId: 'tv1-archive-81d2', language: 'en', category: 'minimal-multi-file',
    anchors: ['vellum archive compaction', 'compactVellumArchive', 'FOLIO-967'], projectIndexes: [7],
    basenames: ['VellumScanner.ts', 'FolioCompactor.ts'],
    roles: ['scan archive fragments', 'compact the selected folios'],
    query: 'During the "vellum archive compaction" in thistle-983 that used compactVellumArchive for FOLIO-967, which files scanned the fragments and compacted the selected folios?',
  }),
  Object.freeze({
    id: 'targeted-en-negative-08', conceptId: 'tv1-archive-81d2', language: 'en', category: 'relational-negative',
    anchors: ['marble index thaw', 'thawMarbleIndex', 'VEIN-138'], projectIndexes: [7, 0, 1],
    basenames: ['MarbleIndexThaw.ts'],
    query: 'Where is the historical source file that handled the "marble index thaw", called thawMarbleIndex, and fixed VEIN-138?',
  }),
]);

const PARTIAL_ANCHOR_INDEXES = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([0, 2]),
  Object.freeze([1, 2]),
]);

function projectAt(index) {
  return projects[((index % projects.length) + projects.length) % projects.length];
}

function relativePath(spec, variant, fileIndex, file) {
  const directory = seedHash(`path:${spec.id}:${variant}:${fileIndex}`).toString(16).padStart(8, '0');
  return `src/history/${directory}/${file}`;
}

function rawPath(value, salt) {
  return salt % 3 === 0 ? value.replaceAll('/', '\\') : value;
}

function toolInput(value, salt) {
  const rendered = rawPath(value, salt);
  if (salt % 3 === 0) return JSON.stringify({ file: rendered, action: 'inspect' });
  if (salt % 3 === 1) return `Review source file ${rendered}`;
  return `apply_patch ${rendered}`;
}

function roleSentence(spec) {
  if (!spec.roles?.length) return '';
  if (spec.language === 'zh') return `记录覆盖的职责包括：${spec.roles.join('、')}。`;
  return `The recorded responsibilities were to ${spec.roles.join(', to ')}.`;
}

function bodyFor(spec, project, anchorIndexes, files, variant) {
  const terms = anchorIndexes.map(index => spec.anchors[index]);
  const reference = seedHash(`reference:${spec.id}:${variant}`).toString(16).padStart(8, '0').slice(0, 6).toUpperCase();
  if (spec.language === 'zh') {
    return `工程记录 ${reference}，项目 ${project.id}。本次工作涉及${terms.map(term => `“${term}”`).join('、')}。${roleSentence(spec)}相关源码已保存在记录中。`;
  }
  return `Engineering record ${reference} for project ${project.id}. This work covered ${terms.map(term => `"${term}"`).join(', ')}. ${roleSentence(spec)} The related source files were retained in the record.`;
}

const mutableSessions = [];
const mutableCases = [];
const expectedGoldSessionIds = new Map();
const expectedDistractorSessionIds = new Map();
const anchorsByCaseId = new Map();

function addSession({ spec, logicalKey, project, files, anchorIndexes, variant }) {
  const startedAt = START + (seedHash(`clock:${logicalKey}`) % (21 * 24 * 60)) * MINUTE;
  const session = {
    id: stableUuid('session', logicalKey),
    platformSessionId: stableUuid('platform', logicalKey),
    platform: project.platform,
    projectPath: project.root,
    title: `Engineering note ${seedHash(`title:${logicalKey}`).toString(16).padStart(8, '0').slice(0, 6).toUpperCase()}`,
    summary: bodyFor(spec, project, anchorIndexes, files, variant),
    searchText: bodyFor(spec, project, anchorIndexes, files, variant),
    startedAt,
    lastActivityAt: startedAt + (23 + seedHash(`duration:${logicalKey}`) % 83) * MINUTE,
    keyFiles: files.map((file, index) => rawPath(file, seedHash(`${logicalKey}:key:${index}`))),
    toolInputs: files.map((file, index) => ({
      inputSummary: toolInput(file, seedHash(`${logicalKey}:tool:${index}`)),
      timestamp: startedAt + (index + 1) * 1000,
    })),
    conceptId: spec.conceptId,
  };
  mutableSessions.push(session);
  return session;
}

function targetFor(file, project, session) {
  return {
    path: file,
    projectPath: project.root,
    sessionIds: [session.id],
    evidenceChannels: ['key-files', 'tool-input'],
    historicalState: 'present',
    currentState: 'exists',
  };
}

for (const spec of CASE_SPECS) {
  anchorsByCaseId.set(spec.id, [...spec.anchors]);

  if (spec.category === 'relational-negative') {
    const splitSessionIds = [];
    for (const [index, anchorIndexes] of PARTIAL_ANCHOR_INDEXES.entries()) {
      const project = projectAt(spec.projectIndexes[index]);
      const files = spec.basenames.map((filename, fileIndex) =>
        relativePath(spec, `split-${index}`, fileIndex, filename));
      const session = addSession({
        spec,
        logicalKey: `${spec.id}:split:${index}`,
        project,
        files,
        anchorIndexes,
        variant: `split-${index}`,
      });
      splitSessionIds.push(session.id);
    }
    expectedGoldSessionIds.set(spec.id, []);
    expectedDistractorSessionIds.set(spec.id, splitSessionIds);
    mutableCases.push({
      id: spec.id,
      category: spec.category,
      split: 'targeted',
      phase: 'preregistered-targeted',
      query: spec.query,
      language: spec.language,
      topK: 15,
      targets: [],
      conceptId: spec.conceptId,
      mustAbstain: true,
      negativeKind: 'relational',
      nuisanceFlags: ['pairwise-anchor-overlap', 'no-conjunctive-session'],
      note: 'Every requested condition appears in the fixture, but no historical session supports their conjunction.',
    });
    continue;
  }

  const goldSessionIds = [];
  const targets = [];
  const goldProjects = spec.projectIndexes.map(projectAt);
  if (spec.category === 'project-isolation' && spec.projectIndexes.length > 1) {
    for (const [index, project] of goldProjects.entries()) {
      const file = relativePath(spec, `primary-${index}`, 0, spec.basenames[index]);
      const session = addSession({
        spec,
        logicalKey: `${spec.id}:primary:${index}`,
        project,
        files: [file],
        anchorIndexes: [0, 1, 2],
        variant: `primary-${index}`,
      });
      goldSessionIds.push(session.id);
      targets.push(targetFor(file, project, session));
    }
  } else {
    const project = goldProjects[0];
    const files = spec.basenames.map((filename, index) => relativePath(spec, 'primary', index, filename));
    const session = addSession({
      spec,
      logicalKey: `${spec.id}:primary:0`,
      project,
      files,
      anchorIndexes: [0, 1, 2],
      variant: 'primary',
    });
    goldSessionIds.push(session.id);
    targets.push(...files.map(file => targetFor(file, project, session)));
  }

  const distractorSessionIds = [];
  for (const [index, anchorIndexes] of PARTIAL_ANCHOR_INDEXES.entries()) {
    const projectIndex = spec.distractorProjectIndexes?.[index] ?? spec.projectIndexes[0];
    const project = projectAt(projectIndex);
    const files = spec.basenames.map((filename, fileIndex) =>
      relativePath(spec, `adjacent-${index}`, fileIndex, filename));
    const session = addSession({
      spec,
      logicalKey: `${spec.id}:adjacent:${index}`,
      project,
      files,
      anchorIndexes,
      variant: `adjacent-${index}`,
    });
    distractorSessionIds.push(session.id);
  }

  expectedGoldSessionIds.set(spec.id, goldSessionIds);
  expectedDistractorSessionIds.set(spec.id, distractorSessionIds);
  mutableCases.push({
    id: spec.id,
    category: spec.category,
    split: 'targeted',
    phase: 'preregistered-targeted',
    query: spec.query,
    language: spec.language,
    topK: 15,
    targets,
    conceptId: spec.conceptId,
    mustAbstain: false,
    nuisanceFlags: [
      'three-way-constraint',
      'three-pairwise-distractors',
      ...(spec.category === 'minimal-multi-file' ? ['minimal-complete-group'] : []),
      ...(spec.category === 'project-isolation' ? ['explicit-project-boundary'] : []),
    ],
    note: spec.category === 'minimal-multi-file'
      ? 'Return the smallest complete file group supported by the fully matching record.'
      : spec.category === 'project-isolation'
        ? 'Respect the requested project boundary while rejecting pairwise near matches.'
        : 'Resolve one file from three jointly required historical constraints.',
  });
}

function freezeSession(session) {
  return Object.freeze({
    ...session,
    keyFiles: Object.freeze([...session.keyFiles]),
    toolInputs: Object.freeze(session.toolInputs.map(tool => Object.freeze({ ...tool }))),
  });
}

function freezeCase(testCase) {
  return Object.freeze({
    ...testCase,
    targets: Object.freeze(testCase.targets.map(target => Object.freeze({
      ...target,
      sessionIds: Object.freeze([...target.sessionIds]),
      evidenceChannels: Object.freeze([...target.evidenceChannels]),
    }))),
    nuisanceFlags: Object.freeze([...testCase.nuisanceFlags]),
  });
}

export const sessions = Object.freeze(seededShuffle(mutableSessions, 'session-order').map(freezeSession));
export const cases = Object.freeze(seededShuffle(mutableCases, 'case-order').map(freezeCase));

const EXPECTED_CATEGORY_COUNTS = Object.freeze({
  'triple-single': 4,
  'minimal-multi-file': 4,
  'project-isolation': 4,
  'relational-negative': 4,
});
const EXPECTED_LANGUAGE_COUNTS = Object.freeze({ zh: 8, en: 8 });
const FORBIDDEN_QUERY_LEAKS = /(?:gold|distractor|noise|benchmark|ground truth|same session|intersection|abstain|金标|干扰项|基准|同一会话|求交|拒答|锚点|合取|策略)/i;
const FORBIDDEN_ROLE_LEAKS = /(?:gold|distractor|noise|target|positive|negative|benchmark|金标|干扰项|噪声|正例|负例|基准)/i;

function sessionEvidence(session) {
  return canonical([
    session.title,
    session.summary,
    session.searchText,
    ...session.keyFiles,
    ...session.toolInputs.map(tool => tool.inputSummary),
  ].join(' '));
}

function hasAllAnchors(session, anchors) {
  const evidence = sessionEvidence(session);
  return anchors.every(anchor => evidence.includes(canonical(anchor)));
}

function anchorHitCount(session, anchors) {
  const evidence = sessionEvidence(session);
  return anchors.filter(anchor => evidence.includes(canonical(anchor))).length;
}

function assertSourceIsolation() {
  const priorCases = [...v1Cases, ...largeCases, ...calibrationCases, ...formalCases, ...rapidCases];
  const priorSessions = [...v1Sessions, ...largeSessions, ...calibrationSessions, ...formalSessions, ...rapidSessions];
  const priorQueries = new Set(priorCases.map(testCase => canonical(testCase.query)).filter(Boolean));
  const priorConcepts = new Set(priorCases.map(testCase => canonical(testCase.conceptId)).filter(Boolean));
  const priorBasenames = new Set(priorSessions.flatMap(session => session.keyFiles ?? []).map(basename));
  const priorEvidence = priorSessions.map(sessionEvidence).join('\n');
  const priorProjectRoots = new Set(priorSessions.map(session => canonical(session.projectPath)));

  for (const spec of CASE_SPECS) {
    invariant(!priorConcepts.has(canonical(spec.conceptId)), `concept id reuses prior data: ${spec.conceptId}`);
    invariant(!priorQueries.has(canonical(spec.query)), `query reuses prior data: ${spec.id}`);
    for (const anchor of spec.anchors) {
      invariant(!priorEvidence.includes(canonical(anchor)), `anchor reuses prior evidence: ${anchor}`);
    }
    for (const filename of spec.basenames) {
      invariant(!priorBasenames.has(canonical(filename)), `basename reuses prior data: ${filename}`);
    }
  }
  invariant(projects.every(project => !priorProjectRoots.has(canonical(project.root))), 'project root overlaps a prior fixture');
}

function assertCorpusIntegrity() {
  invariant(DATASET_SEED === 816202681, `seed changed: ${DATASET_SEED}`);
  invariant(CASE_SPECS.length === 16, `expected 16 authored specs, got ${CASE_SPECS.length}`);
  invariant(cases.length === 16, `expected 16 cases, got ${cases.length}`);
  invariant(sessions.length === 62, `expected 62 authored sessions, got ${sessions.length}`);
  invariant(projects.length === 8, `expected 8 projects, got ${projects.length}`);
  invariant(new Set(CASE_SPECS.map(spec => spec.conceptId)).size === 8, 'expected 8 new concepts');
  invariant(new Set(cases.map(testCase => testCase.id)).size === 16, 'case ids must be unique');
  invariant(new Set(sessions.map(session => session.id)).size === sessions.length, 'session ids must be unique');
  assertExactCounts(countBy(cases, testCase => testCase.category), EXPECTED_CATEGORY_COUNTS, 'categories');
  assertExactCounts(countBy(cases, testCase => testCase.language), EXPECTED_LANGUAGE_COUNTS, 'languages');
  assertExactCounts(countBy(cases, testCase => testCase.conceptId), Object.fromEntries(
    [...new Set(CASE_SPECS.map(spec => spec.conceptId))].map(conceptId => [conceptId, 2]),
  ), 'concepts');

  const projectRoots = new Set(projects.map(project => canonical(project.root)));
  const sessionsById = new Map();
  for (const session of sessions) {
    invariant(UUID_PATTERN.test(session.id), `session id is not an opaque UUIDv4: ${session.id}`);
    invariant(UUID_PATTERN.test(session.platformSessionId), `platform session id is not an opaque UUIDv4: ${session.platformSessionId}`);
    invariant(session.id !== session.platformSessionId, `session ${session.id} reuses platform id`);
    invariant(projectRoots.has(canonical(session.projectPath)), `session ${session.id} has unknown project`);
    invariant(Number.isFinite(session.startedAt) && Number.isFinite(session.lastActivityAt), `session ${session.id} timestamps are invalid`);
    invariant(session.lastActivityAt >= session.startedAt, `session ${session.id} has reversed timestamps`);
    invariant(Array.isArray(session.keyFiles) && session.keyFiles.length > 0, `session ${session.id} has no key files`);
    invariant(Array.isArray(session.toolInputs) && session.toolInputs.length === session.keyFiles.length, `session ${session.id} tool evidence is incomplete`);
    invariant(!FORBIDDEN_ROLE_LEAKS.test(session.title), `session title leaks a benchmark role: ${session.title}`);
    invariant(!FORBIDDEN_ROLE_LEAKS.test(session.summary), `session summary leaks a benchmark role: ${session.id}`);
    for (const file of session.keyFiles) {
      invariant(!FORBIDDEN_ROLE_LEAKS.test(file), `session path leaks a benchmark role: ${file}`);
    }
    sessionsById.set(session.id, session);
  }

  let positiveCases = 0;
  let negativeCases = 0;
  let positiveDistractors = 0;
  let nonGoldConjunctionHits = 0;
  for (const testCase of cases) {
    const spec = CASE_SPECS.find(row => row.id === testCase.id);
    invariant(spec, `case ${testCase.id} has no authored spec`);
    invariant(testCase.split === 'targeted' && testCase.phase === 'preregistered-targeted', `case ${testCase.id} phase metadata changed`);
    invariant(testCase.topK === 15, `case ${testCase.id} topK must be 15`);
    invariant(typeof testCase.query === 'string' && testCase.query.trim().length > 0, `case ${testCase.id} has an empty query`);
    invariant(!FORBIDDEN_QUERY_LEAKS.test(testCase.query), `case ${testCase.id} leaks the evaluation strategy`);
    invariant(!/[\\/]/.test(testCase.query), `case ${testCase.id} query contains a path separator`);
    invariant(!UUID_SEARCH_PATTERN.test(testCase.query), `case ${testCase.id} query contains a session id`);
    invariant(spec.basenames.every(filename => !canonical(testCase.query).includes(canonical(filename))), `case ${testCase.id} query leaks a target basename`);
    invariant(spec.anchors.every(anchor => canonical(testCase.query).includes(canonical(anchor))), `case ${testCase.id} query omits a required condition`);

    const anchors = anchorsByCaseId.get(testCase.id);
    const conjunctionSessions = sessions.filter(session => hasAllAnchors(session, anchors));
    const expectedGoldIds = expectedGoldSessionIds.get(testCase.id);
    const expectedDistractorIds = expectedDistractorSessionIds.get(testCase.id);
    invariant(Array.isArray(expectedDistractorIds) && expectedDistractorIds.length === 3, `case ${testCase.id} must have three partial-constraint records`);
    const distractors = expectedDistractorIds.map(sessionId => sessionsById.get(sessionId));
    invariant(distractors.every(Boolean), `case ${testCase.id} has an unknown partial-constraint record`);
    invariant(distractors.every(session => anchorHitCount(session, anchors) === 2), `case ${testCase.id} partial records must each satisfy exactly two conditions`);
    invariant(
      JSON.stringify(distractors.map(session => anchors.map(anchor => sessionEvidence(session).includes(canonical(anchor)))))
        === JSON.stringify([[true, true, false], [true, false, true], [false, true, true]]),
      `case ${testCase.id} pairwise condition coverage changed`,
    );

    if (testCase.category === 'relational-negative') {
      negativeCases += 1;
      invariant(testCase.mustAbstain === true && testCase.targets.length === 0, `negative case ${testCase.id} must abstain with no targets`);
      invariant(expectedGoldIds.length === 0, `negative case ${testCase.id} unexpectedly defines a supporting session`);
      invariant(conjunctionSessions.length === 0, `negative case ${testCase.id} has a conjunctive supporting session`);
      invariant(anchors.every(anchor => sessions.some(session => sessionEvidence(session).includes(canonical(anchor)))), `negative case ${testCase.id} does not expose every requested condition separately`);
      continue;
    }

    positiveCases += 1;
    positiveDistractors += distractors.length;
    invariant(testCase.mustAbstain === false && testCase.targets.length > 0, `positive case ${testCase.id} must define targets`);
    invariant(expectedGoldIds.length > 0, `positive case ${testCase.id} has no supporting session`);
    invariant(
      JSON.stringify(conjunctionSessions.map(session => session.id).sort()) === JSON.stringify([...expectedGoldIds].sort()),
      `case ${testCase.id} full condition set is not closed over supporting sessions`,
    );
    nonGoldConjunctionHits += sessions.filter(session =>
      !expectedGoldIds.includes(session.id) && hasAllAnchors(session, anchors)).length;

    const targetSessionIds = [...new Set(testCase.targets.flatMap(target => target.sessionIds))].sort();
    invariant(JSON.stringify(targetSessionIds) === JSON.stringify([...expectedGoldIds].sort()), `case ${testCase.id} target evidence does not match its supporting records`);
    for (const target of testCase.targets) {
      invariant(typeof target.path === 'string' && target.path.length > 0, `case ${testCase.id} target path is invalid`);
      invariant(projectRoots.has(canonical(target.projectPath)), `case ${testCase.id} target has an unknown project`);
      invariant(Array.isArray(target.sessionIds) && target.sessionIds.length === 1, `case ${testCase.id} target must cite one supporting session`);
      invariant(JSON.stringify(target.evidenceChannels) === JSON.stringify(['key-files', 'tool-input']), `case ${testCase.id} evidence channels changed`);
      invariant(target.historicalState === 'present' && target.currentState === 'exists', `case ${testCase.id} historical state changed`);
      const supportingSession = sessionsById.get(target.sessionIds[0]);
      invariant(supportingSession && hasAllAnchors(supportingSession, anchors), `case ${testCase.id} target is not backed by the full condition set`);
      invariant(canonical(supportingSession.projectPath) === canonical(target.projectPath), `case ${testCase.id} target project disagrees with its session`);
      invariant(supportingSession.keyFiles.some(file => canonical(file) === canonical(target.path)), `case ${testCase.id} target is absent from key-file evidence`);
      invariant(supportingSession.toolInputs.some(tool => canonical(tool.inputSummary).includes(canonical(target.path))), `case ${testCase.id} target is absent from tool evidence`);
    }

    const targetBasenames = [...new Set(testCase.targets.map(target => basename(target.path)))].sort();
    for (const distractor of distractors) {
      const distractorBasenames = [...new Set(distractor.keyFiles.map(basename))].sort();
      invariant(JSON.stringify(distractorBasenames) === JSON.stringify(targetBasenames), `case ${testCase.id} partial record does not reproduce every candidate basename`);
    }
    if (testCase.category === 'triple-single') {
      invariant(testCase.targets.length === 1, `single-file case ${testCase.id} must have one target`);
    }
    if (testCase.category === 'minimal-multi-file') {
      invariant(testCase.targets.length >= 2, `multi-file case ${testCase.id} must have at least two targets`);
      invariant(expectedGoldIds.length === 1, `multi-file case ${testCase.id} must use one complete supporting record`);
      invariant(new Set(testCase.targets.map(target => target.sessionIds[0])).size === 1, `multi-file case ${testCase.id} files must form one evidence group`);
    }
    if (testCase.category === 'project-isolation') {
      const requestedProjectIds = spec.projectIndexes.map(index => projectAt(index).id);
      invariant(requestedProjectIds.every(projectId => canonical(testCase.query).includes(canonical(projectId))), `project case ${testCase.id} omits a requested project`);
      invariant(new Set(testCase.targets.map(target => canonical(target.projectPath))).size === spec.projectIndexes.length, `project case ${testCase.id} target project coverage changed`);
    }
  }

  invariant(positiveCases === 12 && negativeCases === 4, `expected 12 positives and 4 negatives, got ${positiveCases}/${negativeCases}`);
  invariant(positiveDistractors === 36, `expected 36 positive distractor records, got ${positiveDistractors}`);
  invariant(nonGoldConjunctionHits === 0, `expected no non-supporting full-condition hits, got ${nonGoldConjunctionHits}`);
  assertSourceIsolation();
}

export function datasetIntegrity() {
  assertCorpusIntegrity();
  return {
    datasetId: DATASET_ID,
    seed: DATASET_SEED,
    projects: projects.length,
    sessions: sessions.length,
    cases: cases.length,
    positiveCases: cases.filter(testCase => !testCase.mustAbstain).length,
    negativeCases: cases.filter(testCase => testCase.mustAbstain).length,
    concepts: countBy(cases, testCase => testCase.conceptId),
    categories: countBy(cases, testCase => testCase.category),
    languages: countBy(cases, testCase => testCase.language),
    sourceIsolation: {
      comparedDatasets: [
        'vesti-file-search-v1',
        'vesti-file-search-large-v2',
        'vesti-file-search-calibration-v2',
        'vesti-file-search-formal-v2',
        'vesti-file-search-rapid-v3',
      ],
      reusedConceptIds: 0,
      reusedQueries: 0,
      reusedBasenames: 0,
      reusedAnchors: 0,
    },
    evidenceClosure: {
      positiveSupportingCases: 12,
      positiveDistractorSessions: 36,
      nonGoldFullConditionHits: 0,
      relationalNegativesWithoutConjunctiveSession: 4,
      pairwiseConditionCoveragePerCase: 3,
    },
    leakageChecks: {
      queriesWithPaths: 0,
      queriesWithSessionIds: 0,
      queriesWithTargetBasenames: 0,
      queriesWithStrategyLabels: 0,
      recordsWithBenchmarkRoleLabels: 0,
    },
    seedControl: {
      firstSessionIds: sessions.slice(0, 3).map(session => session.id),
      firstCaseIds: cases.slice(0, 3).map(testCase => testCase.id),
    },
  };
}

// Fail fast on import if authored fixtures or preregistered counts drift.
datasetIntegrity();
