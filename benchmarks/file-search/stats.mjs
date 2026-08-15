function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function numeric(rows, getter) {
  return rows
    .map(getter)
    .filter(value => typeof value === 'number' && Number.isFinite(value));
}

function summarizeRows(rows) {
  return {
    n: rows.length,
    primaryN: numeric(rows, row => row.metrics.taskSuccess).length,
    taskSuccess: mean(numeric(rows, row => row.metrics.taskSuccess)),
    hit1: mean(numeric(rows, row => row.metrics.hit1)),
    hit3: mean(numeric(rows, row => row.metrics.hit3)),
    hit5: mean(numeric(rows, row => row.metrics.hit5)),
    recall5: mean(numeric(rows, row => row.metrics.recall5)),
    allTargets5: mean(numeric(rows, row => row.metrics.allTargets5)),
    mrr: mean(numeric(rows, row => row.metrics.mrr)),
    projectAccuracy: mean(numeric(rows, row => row.metrics.projectAccuracy)),
    evidenceAccuracy: mean(numeric(rows, row => row.metrics.evidenceAccuracy)),
    negativeFalsePositive: mean(numeric(rows, row => row.metrics.negativeFalsePositive)),
    toolCallsMedian: median(numeric(rows, row => row.trace.toolCallsMedian)),
    modelVisiblePayloadBytesMedian: median(numeric(rows, row => row.trace.modelVisiblePayloadBytesMedian)),
    jsonrpcRequestBytesMedian: median(numeric(rows, row => row.trace.jsonrpcRequestBytesMedian)),
    jsonrpcResponseBytesMedian: median(numeric(rows, row => row.trace.jsonrpcResponseBytesMedian)),
    armLatencyMsMedian: median(numeric(rows, row => row.trace.armLatencyMsMedian)),
    errors: rows.filter(row => row.error).length,
  };
}

export function summarizeArm(rows) {
  const arms = [...new Set(rows.map(row => row.arm))].sort();
  return arms.map(arm => ({ arm, ...summarizeRows(rows.filter(row => row.arm === arm)) }));
}

export function summarizeBy(rows, key) {
  const groups = [...new Set(rows.map(row => row[key]))].sort();
  const arms = [...new Set(rows.map(row => row.arm))].sort();
  return groups.flatMap(group => arms.map(arm => ({
    [key]: group,
    arm,
    ...summarizeRows(rows.filter(row => row[key] === group && row.arm === arm)),
  })));
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function pairedBootstrapCi(differences, {
  seed = 221250144,
  iterations = 10_000,
  alpha = 0.05,
} = {}) {
  if (differences.length === 0) return [null, null];
  const random = seededRandom(seed);
  const estimates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let draw = 0; draw < differences.length; draw += 1) {
      sum += differences[Math.floor(random() * differences.length)];
    }
    estimates.push(sum / differences.length);
  }
  estimates.sort((a, b) => a - b);
  return [quantile(estimates, alpha / 2), quantile(estimates, 1 - alpha / 2)];
}

function pairedClusterBootstrapCi(pairs, {
  seed = 221250144,
  iterations = 10_000,
  alpha = 0.05,
} = {}) {
  if (pairs.length === 0) return [null, null];
  const clusters = new Map();
  for (const pair of pairs) {
    const rows = clusters.get(pair.clusterId) ?? [];
    rows.push(pair.treatment - pair.baseline);
    clusters.set(pair.clusterId, rows);
  }
  const clusterIds = [...clusters.keys()];
  const random = seededRandom(seed);
  const estimates = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    let count = 0;
    for (let draw = 0; draw < clusterIds.length; draw += 1) {
      const clusterId = clusterIds[Math.floor(random() * clusterIds.length)];
      for (const difference of clusters.get(clusterId)) {
        sum += difference;
        count += 1;
      }
    }
    estimates.push(sum / count);
  }
  estimates.sort((a, b) => a - b);
  return [quantile(estimates, alpha / 2), quantile(estimates, 1 - alpha / 2)];
}

/** Exact two-sided McNemar p-value over the two discordant cell counts. */
export function mcnemarExactP(baselineOnly, treatmentOnly) {
  const discordant = baselineOnly + treatmentOnly;
  if (discordant === 0) return 1;
  const tailEnd = Math.min(baselineOnly, treatmentOnly);
  let probability = 2 ** (-discordant);
  let lowerTail = probability;
  for (let successes = 0; successes < tailEnd; successes += 1) {
    probability *= (discordant - successes) / (successes + 1);
    lowerTail += probability;
  }
  return Math.min(1, 2 * lowerTail);
}

export function pairedTaskStats(rows, {
  baselineArm,
  treatmentArm,
  seed = 221250144,
  bootstrapIterations = 10_000,
  expectedExcludedPairs = 0,
} = {}) {
  if (!baselineArm || !treatmentArm) {
    throw new Error('baselineArm and treatmentArm are required');
  }
  const paired = new Map();
  for (const row of rows) {
    if (row.arm !== baselineArm && row.arm !== treatmentArm) continue;
    const entry = paired.get(row.caseId) ?? {};
    if (entry[row.arm]) throw new Error(`Duplicate ${row.arm} row for ${row.caseId}`);
    entry[row.arm] = row;
    paired.set(row.caseId, entry);
  }
  const excluded = [];
  const complete = [...paired.entries()].map(([caseId, entry]) => {
    if (!entry[baselineArm] || !entry[treatmentArm]) {
      throw new Error(`Incomplete arm pair for ${caseId}`);
    }
    const baseline = entry[baselineArm].metrics.taskSuccess;
    const treatment = entry[treatmentArm].metrics.taskSuccess;
    if (typeof baseline !== 'number' || typeof treatment !== 'number') {
      const isExpectedHardNegative =
        baseline == null &&
        treatment == null &&
        entry[baselineArm].negativeKind === 'hard' &&
        entry[treatmentArm].negativeKind === 'hard';
      if (!isExpectedHardNegative) {
        throw new Error(`Unexpected non-numeric taskSuccess pair for ${caseId}`);
      }
      excluded.push(caseId);
      return null;
    }
    return {
      caseId,
      clusterId: entry[baselineArm].conceptId ?? caseId,
      baseline,
      treatment,
    };
  }).filter(Boolean);
  if (excluded.length !== expectedExcludedPairs) {
    throw new Error(
      `Expected ${expectedExcludedPairs} excluded hard-negative pairs, found ${excluded.length}`,
    );
  }
  const differences = complete.map(pair => pair.treatment - pair.baseline);
  const bothSuccess = complete.filter(pair => pair.baseline === 1 && pair.treatment === 1).length;
  const bothFailure = complete.filter(pair => pair.baseline === 0 && pair.treatment === 0).length;
  const baselineOnly = complete.filter(pair => pair.baseline === 1 && pair.treatment === 0).length;
  const treatmentOnly = complete.filter(pair => pair.baseline === 0 && pair.treatment === 1).length;
  return {
    n: complete.length,
    excludedPairs: excluded.length,
    excludedCaseIds: excluded,
    delta: mean(differences),
    ci95: pairedClusterBootstrapCi(complete, { seed, iterations: bootstrapIterations }),
    clusterCount: new Set(complete.map(pair => pair.clusterId)).size,
    bothSuccess,
    bothFailure,
    baselineOnly,
    treatmentOnly,
    mcnemarExactP: mcnemarExactP(baselineOnly, treatmentOnly),
    discordantCaseIds: {
      baselineOnly: complete.filter(pair => pair.baseline === 1 && pair.treatment === 0).map(pair => pair.caseId),
      treatmentOnly: complete.filter(pair => pair.baseline === 0 && pair.treatment === 1).map(pair => pair.caseId),
    },
  };
}
