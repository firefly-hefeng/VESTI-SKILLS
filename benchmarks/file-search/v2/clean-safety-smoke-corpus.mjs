import {
  DATASET_SEED,
  cases as safetyCases,
  projects,
  sessions,
} from './safety-calibration-corpus.mjs';

export const DATASET_ID = 'vesti-file-search-clean-safety-smoke-v2';
export { DATASET_SEED, projects, sessions };

export const cases = Object.freeze(
  safetyCases.filter(testCase => testCase.negativeKind === 'clean'),
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
  invariant(cases.length === 2, `expected 2 clean negatives, got ${cases.length}`);
  invariant(cases.every(testCase => testCase.category === 'negative'), 'all cases must be negative');
  invariant(cases.every(testCase => testCase.negativeKind === 'clean'), 'all cases must be clean negatives');
  invariant(cases.every(testCase => testCase.targets.length === 0), 'negative cases must not have targets');

  const languages = countBy(cases, testCase => testCase.language);
  invariant(languages.en === 1, `expected 1 English case, got ${languages.en ?? 0}`);
  invariant(languages.zh === 1, `expected 1 Chinese case, got ${languages.zh ?? 0}`);

  return {
    datasetId: DATASET_ID,
    seed: DATASET_SEED,
    projects: projects.length,
    sessions: sessions.length,
    cases: cases.length,
    concepts: countBy(cases, testCase => testCase.conceptId),
    categories: countBy(cases, testCase => testCase.category),
    languages,
    negativeKinds: countBy(cases, testCase => testCase.negativeKind),
    splits: countBy(cases, testCase => testCase.split),
  };
}

datasetIntegrity();
