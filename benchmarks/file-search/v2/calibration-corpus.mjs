import {
  DATASET_SEED as SOURCE_DATASET_SEED,
  cases as sourceCases,
  projects as sourceProjects,
  sessions as sourceSessions,
} from '../large-corpus.mjs';

export const DATASET_ID = 'vesti-file-search-calibration-v2';
// Keep the source seed: this module is a deterministic view over the existing
// corpus rather than a newly generated corpus.
export const DATASET_SEED = SOURCE_DATASET_SEED;

const CALIBRATION_CONCEPT_IDS = Object.freeze([
  'migration',
  'proxy',
  'export',
  'localization',
]);
const CALIBRATION_CONCEPT_SET = new Set(CALIBRATION_CONCEPT_IDS);

const EXPECTED_CATEGORY_COUNTS = Object.freeze({
  'semantic-single': 4,
  'filename-only': 4,
  'multi-file': 4,
  'cross-project': 4,
  'stale-path': 4,
  negative: 4,
});
const EXPECTED_LANGUAGE_COUNTS = Object.freeze({ code: 4, en: 10, zh: 10 });
const EXPECTED_NEGATIVE_KIND_COUNTS = Object.freeze({ clean: 2, hard: 2 });
const EXPECTED_SOURCE_SPLIT_COUNTS = Object.freeze({ test: 18, 'provisional-holdout': 6 });
const EXPECTED_SPLIT_COUNTS = Object.freeze({ calibration: 24 });
const EXPECTED_STALE_KIND_COUNTS = Object.freeze({ deleted: 1, moved: 2, renamed: 1 });
const EXPECTED_TARGET_COUNTS = Object.freeze({
  'semantic-single': 4,
  'filename-only': 4,
  'multi-file': 10,
  'cross-project': 10,
  'stale-path': 4,
  negative: 0,
});
const EXPECTED_NUISANCE_FLAG_COUNTS = Object.freeze({
  'basename-collision': 2,
  'generic-token-filename-distractor': 3,
  'partial-token-overlap': 2,
});

// Projects and sessions intentionally remain the complete source fixture. The
// 120 non-target sessions are fixed distractors for the 24 calibration cases.
export const projects = Object.freeze([...sourceProjects]);
export const sessions = Object.freeze([...sourceSessions]);
export const cases = Object.freeze(
  sourceCases
    .filter(testCase => CALIBRATION_CONCEPT_SET.has(testCase.conceptId))
    .map(cloneTestCase),
);

function cloneTestCase(testCase) {
  return Object.freeze({
    ...testCase,
    sourceSplit: testCase.split,
    split: 'calibration',
    targets: Object.freeze(testCase.targets.map(target => Object.freeze({
      ...target,
      sessionIds: Object.freeze([...target.sessionIds]),
      evidenceChannels: Object.freeze([...target.evidenceChannels]),
    }))),
    nuisanceFlags: Object.freeze([...testCase.nuisanceFlags]),
  });
}

function invariant(condition, message) {
  if (!condition) {
    throw new Error(`[${DATASET_ID}] ${message}`);
  }
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

function canonicalPath(value) {
  return String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function targetCountsByCategory() {
  return Object.fromEntries(Object.keys(EXPECTED_CATEGORY_COUNTS).map(category => [
    category,
    cases
      .filter(testCase => testCase.category === category)
      .reduce((total, testCase) => total + testCase.targets.length, 0),
  ]));
}

function nuisanceFlagCounts() {
  return countBy(cases.flatMap(testCase => testCase.nuisanceFlags), flag => flag);
}

function assertExactCounts(actual, expected, label) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  invariant(
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    `${label} keys differ: expected ${expectedKeys.join(', ')}, got ${actualKeys.join(', ')}`,
  );
  for (const key of expectedKeys) {
    invariant(
      actual[key] === expected[key],
      `${label}.${key} must be ${expected[key]}, got ${actual[key] ?? 0}`,
    );
  }
}

function assertCorpusIntegrity() {
  invariant(DATASET_SEED === 221250144, `seed must remain 221250144, got ${DATASET_SEED}`);
  invariant(Array.isArray(projects), 'projects must be an array');
  invariant(Array.isArray(sessions), 'sessions must be an array');
  invariant(Array.isArray(cases), 'cases must be an array');
  invariant(projects.length === 8, `expected 8 projects, got ${projects.length}`);
  invariant(sessions.length === 146, `expected all 146 source sessions, got ${sessions.length}`);
  invariant(cases.length === 24, `expected 24 calibration cases, got ${cases.length}`);
  invariant(
    sessions.length === sourceSessions.length
      && sessions.every((session, index) => session === sourceSessions[index]),
    'sessions must preserve the complete source-session array in source order',
  );

  const projectRoots = new Set();
  for (const [index, project] of projects.entries()) {
    invariant(project && typeof project === 'object', `projects[${index}] must be an object`);
    invariant(typeof project.id === 'string' && project.id.length > 0, `projects[${index}].id is invalid`);
    invariant(typeof project.root === 'string' && project.root.length > 0, `projects[${index}].root is invalid`);
    invariant(typeof project.platform === 'string' && project.platform.length > 0, `projects[${index}].platform is invalid`);
    invariant(!projectRoots.has(project.root), `duplicate project root: ${project.root}`);
    projectRoots.add(project.root);
  }

  const sessionIds = new Set();
  const sessionsById = new Map();
  for (const [index, session] of sessions.entries()) {
    invariant(session && typeof session === 'object', `sessions[${index}] must be an object`);
    invariant(typeof session.id === 'string' && session.id.length > 0, `sessions[${index}].id is invalid`);
    invariant(!sessionIds.has(session.id), `duplicate session id: ${session.id}`);
    invariant(projectRoots.has(session.projectPath), `session ${session.id} has an unknown project path`);
    invariant(Array.isArray(session.keyFiles), `session ${session.id}.keyFiles must be an array`);
    invariant(Array.isArray(session.toolInputs), `session ${session.id}.toolInputs must be an array`);
    sessionIds.add(session.id);
    sessionsById.set(session.id, session);
  }

  const caseIds = new Set();
  const targetKeys = new Set();
  for (const [index, testCase] of cases.entries()) {
    invariant(testCase && typeof testCase === 'object', `cases[${index}] must be an object`);
    invariant(typeof testCase.id === 'string' && testCase.id.length > 0, `cases[${index}].id is invalid`);
    invariant(!caseIds.has(testCase.id), `duplicate case id: ${testCase.id}`);
    invariant(CALIBRATION_CONCEPT_SET.has(testCase.conceptId), `unexpected concept: ${testCase.conceptId}`);
    invariant(typeof testCase.query === 'string' && testCase.query.trim().length > 0, `case ${testCase.id} has an empty query`);
    invariant(Object.hasOwn(EXPECTED_CATEGORY_COUNTS, testCase.category), `case ${testCase.id} has an unknown category`);
    invariant(['code', 'en', 'zh'].includes(testCase.language), `case ${testCase.id} has an unexpected language`);
    invariant(Number.isInteger(testCase.topK) && testCase.topK > 0, `case ${testCase.id}.topK is invalid`);
    invariant(Array.isArray(testCase.targets), `case ${testCase.id}.targets must be an array`);
    invariant(Array.isArray(testCase.nuisanceFlags), `case ${testCase.id}.nuisanceFlags must be an array`);
    invariant(testCase.split === 'calibration', `case ${testCase.id}.split must be calibration`);
    invariant(
      ['test', 'provisional-holdout'].includes(testCase.sourceSplit),
      `case ${testCase.id}.sourceSplit is invalid`,
    );

    if (testCase.category === 'negative') {
      invariant(testCase.mustAbstain === true, `negative case ${testCase.id} must require abstention`);
      invariant(testCase.targets.length === 0, `negative case ${testCase.id} must not have targets`);
      invariant(['clean', 'hard'].includes(testCase.negativeKind), `negative case ${testCase.id} has an invalid negativeKind`);
    } else {
      invariant(testCase.mustAbstain === false, `positive case ${testCase.id} must not require abstention`);
      invariant(testCase.negativeKind == null, `positive case ${testCase.id} must not define negativeKind`);
      invariant(testCase.targets.length > 0, `positive case ${testCase.id} must have at least one target`);
    }

    for (const [targetIndex, target] of testCase.targets.entries()) {
      const prefix = `case ${testCase.id} target ${targetIndex}`;
      invariant(target && typeof target === 'object', `${prefix} must be an object`);
      invariant(typeof target.path === 'string' && target.path.length > 0, `${prefix}.path is invalid`);
      invariant(projectRoots.has(target.projectPath), `${prefix} has an unknown project path`);
      invariant(Array.isArray(target.sessionIds) && target.sessionIds.length > 0, `${prefix}.sessionIds is invalid`);
      invariant(target.sessionIds.every(sessionId => sessionIds.has(sessionId)), `${prefix} references an unknown session`);
      invariant(Array.isArray(target.evidenceChannels) && target.evidenceChannels.length > 0, `${prefix}.evidenceChannels is invalid`);
      invariant(
        new Set(target.sessionIds).size === target.sessionIds.length,
        `${prefix}.sessionIds contains duplicates`,
      );
      invariant(
        new Set(target.evidenceChannels).size === target.evidenceChannels.length,
        `${prefix}.evidenceChannels contains duplicates`,
      );

      const targetKey = `${canonicalPath(target.projectPath)}::${canonicalPath(target.path)}`;
      invariant(!targetKeys.has(targetKey), `${prefix} duplicates target key ${targetKey}`);
      targetKeys.add(targetKey);

      const supportingSessions = target.sessionIds.map(sessionId => sessionsById.get(sessionId));
      invariant(
        supportingSessions.every(session => canonicalPath(session.projectPath) === canonicalPath(target.projectPath)),
        `${prefix} has an evidence session from a different project`,
      );
      const targetPath = canonicalPath(target.path);
      const supportedByKeyFiles = supportingSessions.some(session =>
        session.keyFiles.some(file => canonicalPath(file) === targetPath));
      const supportedByToolInput = supportingSessions.some(session =>
        session.toolInputs.some(row => canonicalPath(row.inputSummary).includes(targetPath)));
      const channelSupport = {
        'key-files': supportedByKeyFiles,
        'tool-input': supportedByToolInput,
      };
      invariant(
        target.evidenceChannels.every(channel => Object.hasOwn(channelSupport, channel)),
        `${prefix} declares an unknown evidence channel`,
      );
      invariant(
        target.evidenceChannels.every(channel => channelSupport[channel]),
        `${prefix} is not closed by every declared evidence channel`,
      );
      if (testCase.category === 'stale-path') {
        invariant(target.currentState === 'missing', `${prefix} must be marked missing`);
        invariant(['deleted', 'moved', 'renamed'].includes(target.staleKind), `${prefix}.staleKind is invalid`);
      }
    }

    caseIds.add(testCase.id);
  }

  assertExactCounts(
    countBy(cases, testCase => testCase.conceptId),
    Object.fromEntries(CALIBRATION_CONCEPT_IDS.map(conceptId => [conceptId, 6])),
    'concepts',
  );
  assertExactCounts(countBy(cases, testCase => testCase.category), EXPECTED_CATEGORY_COUNTS, 'categories');
  assertExactCounts(countBy(cases, testCase => testCase.language), EXPECTED_LANGUAGE_COUNTS, 'languages');
  assertExactCounts(
    countBy(cases.filter(testCase => testCase.category === 'negative'), testCase => testCase.negativeKind),
    EXPECTED_NEGATIVE_KIND_COUNTS,
    'negativeKinds',
  );
  for (const language of ['en', 'zh']) {
    assertExactCounts(
      countBy(
        cases.filter(testCase => testCase.category === 'negative' && testCase.language === language),
        testCase => testCase.negativeKind,
      ),
      { clean: 1, hard: 1 },
      `negativeKindsByLanguage.${language}`,
    );
  }
  assertExactCounts(countBy(cases, testCase => testCase.split), EXPECTED_SPLIT_COUNTS, 'splits');
  assertExactCounts(
    countBy(cases, testCase => testCase.sourceSplit),
    EXPECTED_SOURCE_SPLIT_COUNTS,
    'sourceSplits',
  );
  assertExactCounts(
    countBy(
      cases.filter(testCase => testCase.category === 'stale-path'),
      testCase => testCase.targets[0].staleKind,
    ),
    EXPECTED_STALE_KIND_COUNTS,
    'staleKinds',
  );
  assertExactCounts(targetCountsByCategory(), EXPECTED_TARGET_COUNTS, 'targetsByCategory');
  assertExactCounts(nuisanceFlagCounts(), EXPECTED_NUISANCE_FLAG_COUNTS, 'nuisanceFlags');

  for (const category of Object.keys(EXPECTED_CATEGORY_COUNTS).filter(category => category !== 'filename-only')) {
    assertExactCounts(
      countBy(cases.filter(testCase => testCase.category === category), testCase => testCase.language),
      { en: 2, zh: 2 },
      `categoryLanguages.${category}`,
    );
  }
  assertExactCounts(
    countBy(cases.filter(testCase => testCase.category === 'filename-only'), testCase => testCase.language),
    { code: 4 },
    'categoryLanguages.filename-only',
  );
}

export function datasetIntegrity() {
  assertCorpusIntegrity();
  return {
    datasetId: DATASET_ID,
    seed: DATASET_SEED,
    projects: projects.length,
    sessions: sessions.length,
    cases: cases.length,
    concepts: countBy(cases, testCase => testCase.conceptId),
    categories: countBy(cases, testCase => testCase.category),
    languages: countBy(cases, testCase => testCase.language),
    negativeKinds: countBy(
      cases.filter(testCase => testCase.category === 'negative'),
      testCase => testCase.negativeKind,
    ),
    splits: countBy(cases, testCase => testCase.split),
    sourceSplits: countBy(cases, testCase => testCase.sourceSplit),
    staleKinds: countBy(
      cases.filter(testCase => testCase.category === 'stale-path'),
      testCase => testCase.targets[0].staleKind,
    ),
    targetsByCategory: targetCountsByCategory(),
    nuisanceFlags: nuisanceFlagCounts(),
  };
}

// Fail fast when the upstream source corpus changes in a way that invalidates
// this frozen calibration view.
assertCorpusIntegrity();
