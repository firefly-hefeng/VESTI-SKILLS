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

const MINUTE = 60 * 1000;
const START = Date.UTC(2026, 7, 16, 2, 0, 0);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DATASET_ID = 'vesti-file-search-rapid-v3';
export const DATASET_SEED = 816202643;

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

function stem(value) {
  return basename(value).replace(/\.[^.]+$/, '');
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

function invariant(condition, message) {
  if (!condition) throw new Error(`[${DATASET_ID}] ${message}`);
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

const PROJECT_ROWS = Object.freeze([
  ['cedar-17', 'codex'],
  ['lumen-24', 'claude-code'],
  ['north-31', 'cursor'],
  ['orbit-46', 'kimi-code'],
  ['quartz-52', 'codex'],
  ['river-68', 'claude-code'],
  ['sable-73', 'cursor'],
  ['tangent-89', 'kimi-code'],
]);

export const projects = Object.freeze(PROJECT_ROWS.map(([id, platform]) => Object.freeze({
  id,
  root: `C:/rapid-workspaces/${id}`,
  platform,
})));

// Every topic, exact anchor, query, and basename below is new to V1, large-v2,
// calibration-v2, and formal-v2. Each two-case concept supplies one language
// block, giving the rapid pilot exactly 10 zh / 10 en / 4 mixed cases.
const CASE_SPECS = Object.freeze([
  Object.freeze({
    id: 'rapid-semantic-01', conceptId: 'r3-a91f', language: 'zh', category: 'semantic-single',
    topic: '古籍水印校准', anchor: '斜纹纸张的透射阈值',
    nearAnchor: '斜纹样本、纸张透射测量与候选阈值',
    basenames: ['QvraIndex.ts'], projectIndexes: [0],
  }),
  Object.freeze({
    id: 'rapid-filename-01', conceptId: 'r3-a91f', language: 'zh', category: 'filename-only',
    topic: '古籍水印校准', anchor: '朱砂批注的边缘掩码',
    nearAnchor: '朱砂样本、批注边缘与多版掩码',
    basenames: ['PalimpsestMask.ts'], projectIndexes: [1],
  }),
  Object.freeze({
    id: 'rapid-multi-02', conceptId: 'r3-b27c', language: 'zh', category: 'multi-file',
    topic: '蜂箱振动监测', anchor: '夜间振翅频谱拼接',
    nearAnchor: '夜间样本、振翅频谱与分段拼接候选',
    basenames: ['NeruSlice.ts', 'NeruJoin.ts', 'NeruGuard.ts'], projectIndexes: [2],
  }),
  Object.freeze({
    id: 'rapid-cross-02', conceptId: 'r3-b27c', language: 'zh', category: 'cross-project',
    topic: '蜂箱振动监测', anchor: '蜂王信号站点比对',
    nearAnchor: '蜂王活动、信号采样与多个站点候选',
    basenames: ['HiveRelayNorth.ts', 'HiveRelaySouth.ts'], projectIndexes: [3, 4],
  }),
  Object.freeze({
    id: 'rapid-stale-03', conceptId: 'r3-c38e', language: 'zh', category: 'stale-path',
    topic: '珐琅窑温追踪', anchor: '釉裂预警的旧版窗口',
    nearAnchor: '釉裂风险、预警阈值与新版窗口',
    basenames: ['FritWindow.ts'], projectIndexes: [5], staleKind: 'deleted',
  }),
  Object.freeze({
    id: 'rapid-negative-03', conceptId: 'r3-c38e', language: 'zh', category: 'negative',
    topic: '珐琅窑温追踪', negativeKind: 'hard', absentTerms: ['星藤闸值73'],
    query: '历史源码证据是否把“珐琅窑温追踪”与标记“星藤闸值73”明确关联？',
  }),
  Object.freeze({
    id: 'rapid-semantic-04', conceptId: 'r3-d44b', language: 'zh', category: 'semantic-single',
    topic: '潮池幼体计数', anchor: '幼体轮廓的荧光去噪',
    nearAnchor: '幼体样本、轮廓荧光与多种去噪候选',
    basenames: ['LumaContour.ts'], projectIndexes: [6],
  }),
  Object.freeze({
    id: 'rapid-negative-04', conceptId: 'r3-d44b', language: 'zh', category: 'negative',
    topic: '潮池幼体计数', negativeKind: 'clean', absentTerms: ['紫鹭刻度41', '雾杉通道58'],
    query: '检查历史源码证据中是否同时出现“紫鹭刻度41”和“雾杉通道58”。',
  }),
  Object.freeze({
    id: 'rapid-filename-05', conceptId: 'r3-e56d', language: 'zh', category: 'filename-only',
    topic: '木偶关节测绘', anchor: '腕轴回差的定位标记',
    nearAnchor: '腕轴定位、回差样本与多个标记候选',
    basenames: ['PuppetWristMarker.ts'], projectIndexes: [7],
  }),
  Object.freeze({
    id: 'rapid-multi-05', conceptId: 'r3-e56d', language: 'zh', category: 'multi-file',
    topic: '木偶关节测绘', anchor: '牵线张力的联动校验',
    nearAnchor: '牵线联动、张力样本与校验草案',
    basenames: ['MarionetteLine.ts', 'MarionetteTension.ts'], projectIndexes: [0],
  }),
  Object.freeze({
    id: 'rapid-cross-06', conceptId: 'r3-f62a', language: 'en', category: 'cross-project',
    topic: 'orchard frost mapping', anchor: 'canopy dewpoint relay',
    nearAnchor: 'canopy readings, dewpoint samples, and several relay candidates',
    basenames: ['CanopyRelayEast.ts', 'CanopyRelayWest.ts'], projectIndexes: [1, 2],
  }),
  Object.freeze({
    id: 'rapid-stale-06', conceptId: 'r3-f62a', language: 'en', category: 'stale-path',
    topic: 'orchard frost mapping', anchor: 'legacy frost pocket raster',
    nearAnchor: 'legacy mapping notes, frost pockets, and a replacement raster',
    basenames: ['FrostPocketRaster.ts'], projectIndexes: [3], staleKind: 'renamed',
    replacementBasename: 'ColdPocketGrid.ts',
  }),
  Object.freeze({
    id: 'rapid-semantic-07', conceptId: 'r3-073d', language: 'en', category: 'semantic-single',
    topic: 'paper marbling flow', anchor: 'alum plume boundary recovery',
    nearAnchor: 'alum samples, plume edges, and alternative boundary recovery trials',
    basenames: ['AlumPlumeBoundary.ts'], projectIndexes: [4],
  }),
  Object.freeze({
    id: 'rapid-negative-07', conceptId: 'r3-073d', language: 'en', category: 'negative',
    topic: 'paper marbling flow', negativeKind: 'hard', absentTerms: ['cinderlark-73'],
    query: 'Does any historical source evidence explicitly connect "paper marbling flow" to marker "cinderlark-73"?',
  }),
  Object.freeze({
    id: 'rapid-filename-08', conceptId: 'r3-184c', language: 'en', category: 'filename-only',
    topic: 'harbor buoy telemetry', anchor: 'drift checksum handoff',
    nearAnchor: 'drift samples, checksum reviews, and multiple handoff candidates',
    basenames: ['BuoyChecksum.ts'], projectIndexes: [5],
  }),
  Object.freeze({
    id: 'rapid-negative-08', conceptId: 'r3-184c', language: 'en', category: 'negative',
    topic: 'harbor buoy telemetry', negativeKind: 'clean', absentTerms: ['velvet-ibis-26', 'opal-cairn-84'],
    query: 'Check historical source evidence for both "velvet-ibis-26" and "opal-cairn-84".',
  }),
  Object.freeze({
    id: 'rapid-multi-09', conceptId: 'r3-29be', language: 'en', category: 'multi-file',
    topic: 'handbell casting resonance', anchor: 'ring resonance batch audit',
    nearAnchor: 'ring samples, resonance readings, and several batch audit drafts',
    basenames: ['BellBatchRead.ts', 'BellBatchFit.ts', 'BellBatchGate.ts'], projectIndexes: [6],
  }),
  Object.freeze({
    id: 'rapid-cross-09', conceptId: 'r3-29be', language: 'en', category: 'cross-project',
    topic: 'handbell casting resonance', anchor: 'shelf microphone transfer',
    nearAnchor: 'shelf trials, microphone readings, and transfer alternatives',
    basenames: ['ShelfMicPrimary.ts', 'ShelfMicReplica.ts'], projectIndexes: [7, 0],
  }),
  Object.freeze({
    id: 'rapid-semantic-10', conceptId: 'r3-3ac7', language: 'en', category: 'semantic-single',
    topic: 'seed vault humidity', anchor: 'desiccant rebound envelope',
    nearAnchor: 'desiccant trials, rebound samples, and several envelope estimates',
    basenames: ['DesiccantEnvelope.ts'], projectIndexes: [1],
  }),
  Object.freeze({
    id: 'rapid-filename-10', conceptId: 'r3-3ac7', language: 'en', category: 'filename-only',
    topic: 'seed vault humidity', anchor: 'cold-room latch condensation',
    nearAnchor: 'cold-room readings, latch checks, and condensation candidates',
    basenames: ['LatchCondensation.ts'], projectIndexes: [2],
  }),
  Object.freeze({
    id: 'rapid-multi-11', conceptId: 'r3-4bd8', language: 'mixed', category: 'multi-file',
    topic: '竹编 weave tension', anchor: '经纬 splice-load 校验',
    nearAnchor: '经纬走向、splice load 样本与多版校验草案',
    basenames: ['SpliceLoadMap.ts', 'SpliceLoadGuard.ts'], projectIndexes: [3],
  }),
  Object.freeze({
    id: 'rapid-negative-11', conceptId: 'r3-4bd8', language: 'mixed', category: 'negative',
    topic: '竹编 weave tension', negativeKind: 'hard', absentTerms: ['moonquartz-61'],
    query: 'session evidence 是否把“竹编 weave tension”与 marker “moonquartz-61”明确关联？',
  }),
  Object.freeze({
    id: 'rapid-cross-12', conceptId: 'r3-5ce9', language: 'mixed', category: 'cross-project',
    topic: '影偶 silhouette rig', anchor: '关节 parallax 对齐',
    nearAnchor: '关节采样、parallax readings 与多种对齐候选',
    basenames: ['ParallaxJointFront.ts', 'ParallaxJointRear.ts'], projectIndexes: [4, 5],
  }),
  Object.freeze({
    id: 'rapid-negative-12', conceptId: 'r3-5ce9', language: 'mixed', category: 'negative',
    topic: '影偶 silhouette rig', negativeKind: 'clean', absentTerms: ['霜鹊-node-37', 'amber-pulse-92'],
    query: '检查 session source evidence 是否同时出现“霜鹊-node-37”和“amber-pulse-92”。',
  }),
]);

function projectAt(index) {
  return projects[((index % projects.length) + projects.length) % projects.length];
}

function relativePath(spec, side, fileIndex, file) {
  const directory = seedHash(`path:${spec.id}:${side}:${fileIndex}`).toString(16).padStart(8, '0');
  return `src/r3/${directory}/${file}`;
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

function targetBody(spec, project, rowIndex) {
  const suffix = spec.category === 'cross-project' ? ` Workspace ${project.id}, node ${rowIndex + 1}.` : '';
  if (spec.language === 'zh') {
    return `本次${spec.topic}记录明确核验“${spec.anchor}”，并保存最终源码落点。${suffix}`;
  }
  if (spec.language === 'mixed') {
    return `${spec.topic} session 明确核验“${spec.anchor}”，并保存 final source locations。${suffix}`;
  }
  return `This ${spec.topic} record explicitly verifies "${spec.anchor}" and preserves the final source location.${suffix}`;
}

function distractorBody(spec, project, rowIndex) {
  const suffix = spec.category === 'cross-project' ? ` Workspace ${project.id}, candidate ${rowIndex + 1}.` : '';
  if (spec.language === 'zh') {
    return `本次${spec.topic}记录讨论${spec.nearAnchor}，只留下未确认的候选观察。${suffix}`;
  }
  if (spec.language === 'mixed') {
    return `${spec.topic} session 讨论${spec.nearAnchor}，只留下 unconfirmed candidates。${suffix}`;
  }
  return `This ${spec.topic} record discusses ${spec.nearAnchor}, leaving only unconfirmed candidates.${suffix}`;
}

function buildQuery(spec, project) {
  if (spec.query) return spec.query;
  if (spec.category === 'filename-only') {
    if (spec.language === 'zh') {
      return `在项目 ${project.id} 中，找到“${spec.anchor}”会话里 basename 为 ${spec.basenames[0]} 的源码路径。`;
    }
    return `In project ${project.id}, return the source path with basename ${spec.basenames[0]} from the "${spec.anchor}" record.`;
  }
  if (spec.category === 'semantic-single') {
    if (spec.language === 'zh') return `请从历史会话定位“${spec.anchor}”对应的源码路径。`;
    return `Locate the source path supported by the historical record for "${spec.anchor}".`;
  }
  if (spec.category === 'multi-file') {
    if (spec.language === 'zh') return `回看“${spec.anchor}”的完整会话，只返回该会话共同记录的全部源码路径。`;
    if (spec.language === 'mixed') return `回看“${spec.anchor}”的 exact session，只返回该 session 共同记录的全部 source paths。`;
    return `Review the exact session for "${spec.anchor}" and return every source path recorded together in that session.`;
  }
  if (spec.category === 'cross-project') {
    if (spec.language === 'zh') return `按项目列出“${spec.anchor}”精确会话所支持的源码路径，不要合并近似记录。`;
    if (spec.language === 'mixed') return `按 project 列出“${spec.anchor}”exact sessions 支持的 source paths，不要合并近似记录。`;
    return `Group by project the source paths supported by exact sessions for "${spec.anchor}"; exclude near-match records.`;
  }
  if (spec.category === 'stale-path') {
    if (spec.language === 'zh') return `追溯“${spec.anchor}”会话当时记录、如今已失效的源码路径。`;
    return `Recover the now-stale source path preserved in the historical record for "${spec.anchor}".`;
  }
  throw new Error(`Unsupported category: ${spec.category}`);
}

const mutableSessions = [];
const mutableCases = [];
const anchorByCaseId = new Map();
const matchedDistractorsByCaseId = new Map();
const absentTermsByCaseId = new Map();

function addSession({ spec, logicalKey, project, files, side, rowIndex, body }) {
  const startedAt = START + (seedHash(`clock:${logicalKey}`) % (18 * 24 * 60)) * MINUTE;
  const id = stableUuid('session', logicalKey);
  const session = {
    id,
    platformSessionId: stableUuid('platform', logicalKey),
    platform: project.platform,
    projectPath: project.root,
    title: `Work record ${seedHash(`title:${logicalKey}`).toString(16).padStart(8, '0').slice(0, 6).toUpperCase()}`,
    summary: body,
    searchText: body,
    startedAt,
    lastActivityAt: startedAt + (31 + seedHash(`duration:${logicalKey}`) % 70) * MINUTE,
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

function expectedTarget(spec, file, project, session) {
  const target = {
    path: file,
    projectPath: project.root,
    sessionIds: [session.id],
    evidenceChannels: ['key-files', 'tool-input'],
    historicalState: 'present',
    currentState: spec.category === 'stale-path' ? 'missing' : 'exists',
  };
  if (spec.category === 'stale-path') {
    target.staleKind = spec.staleKind;
    if (spec.replacementBasename) {
      target.replacementPath = relativePath(spec, 'replacement', 0, spec.replacementBasename);
    }
  }
  return target;
}

for (const spec of CASE_SPECS) {
  if (spec.category === 'negative') {
    mutableCases.push({
      id: spec.id,
      category: spec.category,
      split: 'rapid',
      phase: 'rapid',
      query: spec.query,
      language: spec.language,
      topK: 15,
      targets: [],
      conceptId: spec.conceptId,
      mustAbstain: true,
      negativeKind: spec.negativeKind,
      nuisanceFlags: spec.negativeKind === 'hard' ? ['partial-topic-overlap'] : [],
      note: spec.negativeKind === 'hard'
        ? 'The broad topic exists, but the required marker is absent from every session.'
        : 'Both distinctive marker terms are absent from the fixture.',
    });
    absentTermsByCaseId.set(spec.id, [...spec.absentTerms]);
    continue;
  }

  const targetRows = [];
  const distractorIds = [];
  if (spec.category === 'cross-project') {
    for (const [rowIndex, projectIndex] of spec.projectIndexes.entries()) {
      const project = projectAt(projectIndex);
      const filename = spec.basenames[rowIndex];
      const targetFile = relativePath(spec, 'primary', rowIndex, filename);
      const distractorFile = relativePath(spec, 'alternate', rowIndex, filename);
      const targetSession = addSession({
        spec,
        logicalKey: `${spec.id}:p:${rowIndex}`,
        project,
        files: [targetFile],
        side: 'primary',
        rowIndex,
        body: targetBody(spec, project, rowIndex),
      });
      const distractor = addSession({
        spec,
        logicalKey: `${spec.id}:a:${rowIndex}`,
        project,
        files: [distractorFile],
        side: 'alternate',
        rowIndex,
        body: distractorBody(spec, project, rowIndex),
      });
      targetRows.push(expectedTarget(spec, targetFile, project, targetSession));
      distractorIds.push(distractor.id);
    }
  } else {
    const project = projectAt(spec.projectIndexes[0]);
    const targetFiles = spec.basenames.map((filename, index) => relativePath(spec, 'primary', index, filename));
    const distractorFiles = spec.basenames.map((filename, index) => relativePath(spec, 'alternate', index, filename));
    const targetSession = addSession({
      spec,
      logicalKey: `${spec.id}:p:0`,
      project,
      files: targetFiles,
      side: 'primary',
      rowIndex: 0,
      body: targetBody(spec, project, 0),
    });
    const distractor = addSession({
      spec,
      logicalKey: `${spec.id}:a:0`,
      project,
      files: distractorFiles,
      side: 'alternate',
      rowIndex: 0,
      body: distractorBody(spec, project, 0),
    });
    targetRows.push(...targetFiles.map(file => expectedTarget(spec, file, project, targetSession)));
    distractorIds.push(distractor.id);
  }

  const queryProject = projectAt(spec.projectIndexes[0]);
  mutableCases.push({
    id: spec.id,
    category: spec.category,
    split: 'rapid',
    phase: 'rapid',
    query: buildQuery(spec, queryProject),
    language: spec.language,
    topK: 15,
    targets: targetRows,
    conceptId: spec.conceptId,
    mustAbstain: false,
    nuisanceFlags: ['basename-collision', 'exact-session-disambiguation'],
    note: spec.category === 'multi-file'
      ? 'Return the complete file group from the exact supporting session and no alternate group.'
      : spec.category === 'cross-project'
        ? 'Return only projects with exact-anchor sessions and no near-match project files.'
        : 'A same-project or same-basename near-match must be rejected by exact session evidence.',
  });
  anchorByCaseId.set(spec.id, spec.anchor);
  matchedDistractorsByCaseId.set(spec.id, distractorIds);
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
  'semantic-single': 4,
  'filename-only': 4,
  'multi-file': 4,
  'cross-project': 4,
  'stale-path': 2,
  negative: 6,
});
const EXPECTED_LANGUAGE_COUNTS = Object.freeze({ zh: 10, en: 10, mixed: 4 });
const EXPECTED_NEGATIVE_COUNTS = Object.freeze({ hard: 3, clean: 3 });
const EXPECTED_TARGET_COUNTS = Object.freeze({
  'semantic-single': 4,
  'filename-only': 4,
  'multi-file': 10,
  'cross-project': 8,
  'stale-path': 2,
  negative: 0,
});

function sessionEvidence(session) {
  return canonical([
    session.title,
    session.summary,
    session.searchText,
    ...session.keyFiles,
    ...session.toolInputs.map(tool => tool.inputSummary),
  ].join(' '));
}

function targetCountsByCategory() {
  return Object.fromEntries(Object.keys(EXPECTED_CATEGORY_COUNTS).map(category => [
    category,
    cases
      .filter(testCase => testCase.category === category)
      .reduce((total, testCase) => total + testCase.targets.length, 0),
  ]));
}

function assertSourceIsolation() {
  const sourceCases = [...v1Cases, ...largeCases, ...calibrationCases, ...formalCases];
  const sourceSessions = [...v1Sessions, ...largeSessions, ...calibrationSessions, ...formalSessions];
  const sourceQueries = new Set(sourceCases.map(testCase => canonical(testCase.query)).filter(Boolean));
  const sourceConceptIds = new Set(sourceCases.map(testCase => canonical(testCase.conceptId)).filter(Boolean));
  const sourceBasenameStems = new Set(sourceSessions.flatMap(session => session.keyFiles ?? []).map(stem));
  const sourceEvidence = sourceSessions.map(sessionEvidence).join('\n');

  for (const spec of CASE_SPECS) {
    invariant(!sourceConceptIds.has(canonical(spec.conceptId)), `concept id leaks from a prior corpus: ${spec.conceptId}`);
    if (spec.anchor) {
      invariant(!sourceEvidence.includes(canonical(spec.anchor)), `anchor leaks from a prior corpus: ${spec.anchor}`);
    }
    for (const filename of spec.basenames ?? []) {
      invariant(!sourceBasenameStems.has(stem(filename)), `basename leaks from a prior corpus: ${filename}`);
    }
  }
  for (const testCase of cases) {
    invariant(!sourceQueries.has(canonical(testCase.query)), `query exactly reuses a prior corpus query: ${testCase.id}`);
  }

  const sourceProjectRoots = new Set(sourceSessions.map(session => canonical(session.projectPath)));
  invariant(projects.every(project => !sourceProjectRoots.has(canonical(project.root))), 'rapid project root overlaps a prior fixture');
}

function assertCorpusIntegrity() {
  invariant(DATASET_SEED === 816202643, `seed changed: ${DATASET_SEED}`);
  invariant(projects.length === 8, `expected 8 projects, got ${projects.length}`);
  invariant(CASE_SPECS.length === 24, `expected 24 authored specs, got ${CASE_SPECS.length}`);
  invariant(cases.length === 24, `expected 24 cases, got ${cases.length}`);
  invariant(sessions.length === 44, `expected 44 sessions, got ${sessions.length}`);
  invariant(new Set(CASE_SPECS.map(spec => spec.conceptId)).size === 12, 'expected 12 isolated concepts');
  invariant(new Set(cases.map(testCase => testCase.id)).size === cases.length, 'case ids must be unique');
  invariant(new Set(sessions.map(session => session.id)).size === sessions.length, 'session ids must be unique');

  const projectRoots = new Set(projects.map(project => canonical(project.root)));
  invariant(projectRoots.size === projects.length, 'project roots must be unique');
  for (const project of projects) {
    invariant(typeof project.id === 'string' && project.id.length > 0, 'project id is invalid');
    invariant(typeof project.platform === 'string' && project.platform.length > 0, `project ${project.id} platform is invalid`);
    invariant(!/(gold|noise|target|distractor|semantic|filename|multi|cross|stale|negative)/i.test(project.id), `project id leaks benchmark role: ${project.id}`);
  }

  const sessionsById = new Map();
  for (const session of sessions) {
    invariant(UUID_PATTERN.test(session.id), `session id is not opaque UUID: ${session.id}`);
    invariant(UUID_PATTERN.test(session.platformSessionId), `platform session id is not opaque UUID: ${session.platformSessionId}`);
    invariant(session.id !== session.platformSessionId, `session ${session.id} reuses platform id`);
    invariant(projectRoots.has(canonical(session.projectPath)), `session ${session.id} has unknown project`);
    invariant(Number.isFinite(session.startedAt) && Number.isFinite(session.lastActivityAt), `session ${session.id} timestamps are invalid`);
    invariant(session.lastActivityAt >= session.startedAt, `session ${session.id} has reversed timestamps`);
    invariant(Array.isArray(session.keyFiles) && session.keyFiles.length > 0, `session ${session.id} has no key files`);
    invariant(Array.isArray(session.toolInputs) && session.toolInputs.length === session.keyFiles.length, `session ${session.id} tool evidence is incomplete`);
    invariant(!/(gold|noise|target|distractor|semantic|filename|multi|cross|stale|negative)/i.test(session.title), `session title leaks benchmark role: ${session.title}`);
    for (const file of session.keyFiles) {
      invariant(!/(gold|noise|target|distractor|semantic|filename|multi|cross|stale|negative)/i.test(file), `path leaks benchmark role: ${file}`);
    }
    sessionsById.set(session.id, session);
  }

  const targetKeys = new Set();
  for (const testCase of cases) {
    invariant(testCase.split === 'rapid' && testCase.phase === 'rapid', `case ${testCase.id} must be rapid`);
    invariant(Object.hasOwn(EXPECTED_CATEGORY_COUNTS, testCase.category), `case ${testCase.id} has unknown category`);
    invariant(['zh', 'en', 'mixed'].includes(testCase.language), `case ${testCase.id} has unknown language`);
    invariant(typeof testCase.query === 'string' && testCase.query.trim().length > 0, `case ${testCase.id} has empty query`);
    invariant(testCase.topK === 15, `case ${testCase.id} topK must be 15`);
    invariant(Array.isArray(testCase.targets), `case ${testCase.id} targets are invalid`);

    if (testCase.category === 'negative') {
      invariant(testCase.mustAbstain === true && testCase.targets.length === 0, `negative case ${testCase.id} must abstain with no files`);
      invariant(['hard', 'clean'].includes(testCase.negativeKind), `negative case ${testCase.id} kind is invalid`);
      const absentTerms = absentTermsByCaseId.get(testCase.id);
      invariant(Array.isArray(absentTerms) && absentTerms.length > 0, `negative case ${testCase.id} has no absent terms`);
      for (const term of absentTerms) {
        invariant(canonical(testCase.query).includes(canonical(term)), `negative query ${testCase.id} omits ${term}`);
        invariant(sessions.every(session => !sessionEvidence(session).includes(canonical(term))), `negative marker occurs in evidence: ${term}`);
      }
      if (testCase.negativeKind === 'hard') {
        const spec = CASE_SPECS.find(row => row.id === testCase.id);
        invariant(sessions.some(session => sessionEvidence(session).includes(canonical(spec.topic))), `hard negative ${testCase.id} lacks broad-topic interference`);
      }
      continue;
    }

    invariant(testCase.mustAbstain === false && testCase.targets.length > 0, `positive case ${testCase.id} must contain targets`);
    invariant(testCase.negativeKind == null, `positive case ${testCase.id} defines a negative kind`);
    const anchor = anchorByCaseId.get(testCase.id);
    invariant(typeof anchor === 'string' && canonical(testCase.query).includes(canonical(anchor)), `case ${testCase.id} query omits exact anchor`);
    const supportingIds = new Set(testCase.targets.flatMap(target => target.sessionIds));
    const supportingSessions = [...supportingIds].map(sessionId => sessionsById.get(sessionId));
    invariant(supportingSessions.every(Boolean), `case ${testCase.id} has unknown supporting session`);
    invariant(supportingSessions.every(session => sessionEvidence(session).includes(canonical(anchor))), `case ${testCase.id} gold evidence does not contain its full anchor`);
    invariant(
      sessions.filter(session => !supportingIds.has(session.id)).every(session => !sessionEvidence(session).includes(canonical(anchor))),
      `case ${testCase.id} full anchor appears in non-gold evidence`,
    );

    for (const target of testCase.targets) {
      invariant(typeof target.path === 'string' && target.path.length > 0, `case ${testCase.id} target path is invalid`);
      invariant(projectRoots.has(canonical(target.projectPath)), `case ${testCase.id} target has unknown project`);
      invariant(Array.isArray(target.sessionIds) && target.sessionIds.length === 1, `case ${testCase.id} target must have one exact supporting session`);
      invariant(JSON.stringify(target.evidenceChannels) === JSON.stringify(['key-files', 'tool-input']), `case ${testCase.id} evidence channels changed`);
      const supportingSession = sessionsById.get(target.sessionIds[0]);
      invariant(canonical(supportingSession.projectPath) === canonical(target.projectPath), `case ${testCase.id} target project disagrees with session`);
      invariant(supportingSession.keyFiles.some(file => canonical(file) === canonical(target.path)), `case ${testCase.id} target is absent from key files`);
      invariant(supportingSession.toolInputs.some(tool => canonical(tool.inputSummary).includes(canonical(target.path))), `case ${testCase.id} target is absent from tool inputs`);
      const targetKey = `${canonical(target.projectPath)}::${canonical(target.path)}`;
      invariant(!targetKeys.has(targetKey), `duplicate target key: ${targetKey}`);
      targetKeys.add(targetKey);
      if (testCase.category === 'stale-path') {
        invariant(target.currentState === 'missing', `stale case ${testCase.id} must report historical-only path`);
        invariant(['deleted', 'renamed'].includes(target.staleKind), `stale case ${testCase.id} kind is invalid`);
        invariant(target.staleKind === 'deleted' ? target.replacementPath == null : typeof target.replacementPath === 'string', `stale case ${testCase.id} replacement disagrees with kind`);
      } else {
        invariant(target.currentState === 'exists', `case ${testCase.id} target must exist`);
      }
    }

    const distractorIds = matchedDistractorsByCaseId.get(testCase.id);
    invariant(Array.isArray(distractorIds) && distractorIds.length === supportingIds.size, `case ${testCase.id} lacks matched distractors`);
    const distractorSessions = distractorIds.map(sessionId => sessionsById.get(sessionId));
    invariant(distractorSessions.every(Boolean), `case ${testCase.id} has unknown distractor session`);
    const targetBasenames = [...testCase.targets.map(target => basename(target.path))].sort();
    const distractorBasenames = distractorSessions.flatMap(session => session.keyFiles.map(basename)).sort();
    invariant(JSON.stringify(targetBasenames) === JSON.stringify(distractorBasenames), `case ${testCase.id} distractors do not reproduce every target basename`);
    invariant(distractorSessions.every(session => !sessionEvidence(session).includes(canonical(anchor))), `case ${testCase.id} distractor contains full anchor`);

    if (testCase.category === 'filename-only') {
      invariant(canonical(testCase.query).includes(basename(testCase.targets[0].path)), `filename case ${testCase.id} query omits basename`);
      invariant(canonical(testCase.query).includes(canonical(projects.find(project => canonical(project.root) === canonical(testCase.targets[0].projectPath)).id)), `filename case ${testCase.id} query omits explicit project`);
    }
    if (testCase.category === 'multi-file') {
      invariant(supportingIds.size === 1 && testCase.targets.length >= 2, `multi-file case ${testCase.id} must use one exact grouped session`);
    }
    if (testCase.category === 'cross-project') {
      invariant(new Set(testCase.targets.map(target => canonical(target.projectPath))).size === testCase.targets.length, `cross case ${testCase.id} must have one target per project`);
    }
  }

  assertExactCounts(countBy(cases, testCase => testCase.category), EXPECTED_CATEGORY_COUNTS, 'categories');
  assertExactCounts(countBy(cases, testCase => testCase.language), EXPECTED_LANGUAGE_COUNTS, 'languages');
  assertExactCounts(countBy(cases, testCase => testCase.negativeKind), EXPECTED_NEGATIVE_COUNTS, 'negativeKinds');
  assertExactCounts(countBy(cases, testCase => testCase.split), { rapid: 24 }, 'splits');
  assertExactCounts(countBy(cases, testCase => testCase.phase), { rapid: 24 }, 'phases');
  assertExactCounts(targetCountsByCategory(), EXPECTED_TARGET_COUNTS, 'targetsByCategory');
  assertExactCounts(countBy(cases, testCase => testCase.conceptId), Object.fromEntries([...new Set(CASE_SPECS.map(spec => spec.conceptId))].map(id => [id, 2])), 'concepts');
  assertExactCounts(countBy(cases.filter(testCase => testCase.category === 'negative'), testCase => `${testCase.language}:${testCase.negativeKind}`), {
    'zh:hard': 1,
    'zh:clean': 1,
    'en:hard': 1,
    'en:clean': 1,
    'mixed:hard': 1,
    'mixed:clean': 1,
  }, 'negativeLanguageKinds');

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
    concepts: countBy(cases, testCase => testCase.conceptId),
    categories: countBy(cases, testCase => testCase.category),
    languages: countBy(cases, testCase => testCase.language),
    negativeKinds: countBy(cases, testCase => testCase.negativeKind),
    targetsByCategory: targetCountsByCategory(),
    nuisanceFlags: countBy(cases.flatMap(testCase => testCase.nuisanceFlags), flag => flag),
    exactAnchorClosure: {
      positiveCases: anchorByCaseId.size,
      nonGoldFullAnchorHits: 0,
      matchedDistractorCases: matchedDistractorsByCaseId.size,
      matchedBasenameCollisionCases: matchedDistractorsByCaseId.size,
    },
    sourceIsolation: {
      comparedDatasets: [
        'vesti-file-search-v1',
        'vesti-file-search-large-v2',
        'vesti-file-search-calibration-v2',
        'vesti-file-search-formal-v2',
      ],
      reusedConceptIds: 0,
      reusedExactQueries: 0,
      reusedBasenameStems: 0,
      reusedExactAnchors: 0,
    },
    seedControl: {
      firstSessionIds: sessions.slice(0, 3).map(session => session.id),
      firstCaseIds: cases.slice(0, 3).map(testCase => testCase.id),
    },
  };
}

// The rapid pilot remains inspectable, but import-time validation prevents
// accidental leakage or count drift before the two-arm run begins.
assertCorpusIntegrity();
