import {
  DATASET_SEED,
  cases as calibrationCases,
  projects,
  sessions,
} from './calibration-corpus.mjs';

export const DATASET_ID = 'vesti-file-search-safety-calibration-v2';
export { DATASET_SEED, projects, sessions };

export const cases = Object.freeze(
  calibrationCases.filter(testCase => testCase.category === 'negative'),
);

function invariant(condition, message) {
  if (!condition) throw new Error(`[${DATASET_ID}] ${message}`);
}

function countBy(values, keyOf) {
  const counts = {};
  for (const value of values) {
    const key = keyOf(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function datasetIntegrity() {
  invariant(cases.length === 4, `expected 4 negative cases, got ${cases.length}`);
  invariant(cases.every(testCase => testCase.category === 'negative'), 'all cases must be negative');

  const negativeKinds = countBy(cases, testCase => testCase.negativeKind);
  invariant(negativeKinds.clean === 2, `expected 2 clean negatives, got ${negativeKinds.clean ?? 0}`);
  invariant(negativeKinds.hard === 2, `expected 2 hard negatives, got ${negativeKinds.hard ?? 0}`);

  const languages = countBy(cases, testCase => testCase.language);
  invariant(languages.en === 2, `expected 2 English negatives, got ${languages.en ?? 0}`);
  invariant(languages.zh === 2, `expected 2 Chinese negatives, got ${languages.zh ?? 0}`);
  invariant(cases.every(testCase => testCase.targets.length === 0), 'negative cases must not have targets');

  return {
    datasetId: DATASET_ID,
    seed: DATASET_SEED,
    projects: projects.length,
    sessions: sessions.length,
    cases: cases.length,
    concepts: countBy(cases, testCase => testCase.conceptId),
    categories: countBy(cases, testCase => testCase.category),
    languages,
    negativeKinds,
    splits: countBy(cases, testCase => testCase.split),
  };
}

datasetIntegrity();
