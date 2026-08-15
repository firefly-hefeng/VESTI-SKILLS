import {
  cases as sourceCases,
  sessions as sourceSessions,
} from '../large-corpus.mjs';
import {
  cases as v1Cases,
  sessions as v1Sessions,
} from '../corpus.mjs';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const START = Date.UTC(2026, 5, 1, 9, 0, 0);

export const DATASET_ID = 'vesti-file-search-formal-v2';
export const DATASET_SEED = 815202617;

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

function stableUuid(namespace, logicalKey) {
  const words = Array.from({ length: 4 }, (_, index) =>
    seedHash(`${namespace}:${logicalKey}:${index}`).toString(16).padStart(8, '0'));
  const raw = words.join('').split('');
  raw[12] = '4';
  raw[16] = ['8', '9', 'a', 'b'][Number.parseInt(raw[16], 16) % 4];
  const hex = raw.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const PROJECT_ROWS = [
  ['alder', 'codex'],
  ['cobalt', 'claude-code'],
  ['fable', 'cursor'],
  ['granite', 'kimi-code'],
  ['kindle', 'codex'],
  ['mosaic', 'claude-code'],
  ['quill', 'cursor'],
  ['saffron', 'kimi-code'],
  ['tundra', 'codex'],
  ['willow', 'claude-code'],
];

export const projects = Object.freeze(seededShuffle(PROJECT_ROWS, 'projects').map(([id, platform]) => Object.freeze({
  id,
  root: `C:/workspace/${id}-lab`,
  platform,
})));

// These subjects are deliberately unrelated to every concept family in the
// large-v2 corpus. Language is a concept-level stratum, so all six categories
// have exactly the same 8 zh / 8 en / 4 mixed distribution.
const CONCEPTS = Object.freeze([
  Object.freeze({
    id: 'kerning', language: 'zh', code: 'Nimbus', subject: '字形字距',
    semantic: '光学边距校正', multi: '字偶间距链路', cross: '排版组件协作',
    stale: '金属字模兼容层', filename: 'GlyphSpacingLedger.ts',
  }),
  Object.freeze({
    id: 'seismology', language: 'zh', code: 'Opal', subject: '震源定位',
    semantic: '走时残差求解', multi: '震相拾取链路', cross: '台站联合反演',
    stale: '纸带震记兼容层', filename: 'HypocenterResidual.ts',
  }),
  Object.freeze({
    id: 'herbarium', language: 'zh', code: 'Prairie', subject: '植物标本',
    semantic: '叶脉特征判读', multi: '压制装帧流程', cross: '馆藏鉴定协作',
    stale: '手写馆藏号底稿', filename: 'SpecimenDrawerMap.ts',
  }),
  Object.freeze({
    id: 'acoustics', language: 'zh', code: 'Quasar', subject: '混响衰减',
    semantic: '早期反射估计', multi: '脉冲响应链路', cross: '声场测量协作',
    stale: '磁带尾音算法', filename: 'ImpulseDecayEnvelope.ts',
  }),
  Object.freeze({
    id: 'astrometry', language: 'zh', code: 'Rowan', subject: '恒星视差',
    semantic: '大气折射修正', multi: '星表测量链路', cross: '观测台联合解算',
    stale: '照相底片解算器', filename: 'ParallaxTransitTable.ts',
  }),
  Object.freeze({
    id: 'titration', language: 'zh', code: 'Timber', subject: '滴定曲线',
    semantic: '等当点拟合', multi: '试剂读数链路', cross: '实验台复核协作',
    stale: '玻璃滴管估读法', filename: 'EquivalenceCurveFit.ts',
  }),
  Object.freeze({
    id: 'plumage', language: 'zh', code: 'Umber', subject: '羽毛换羽',
    semantic: '翼羽代次判定', multi: '羽区记录链路', cross: '环志站鉴别协作',
    stale: '纸质羽图比对器', filename: 'MoltFeatherAtlas.ts',
  }),
  Object.freeze({
    id: 'seriation', language: 'zh', code: 'Velvet', subject: '陶片序列',
    semantic: '口沿型式排序', multi: '器形编码链路', cross: '遗址分期协作',
    stale: '方格纸排序法', filename: 'ShardSeriationMatrix.ts',
  }),
  Object.freeze({
    id: 'thermocline', language: 'en', code: 'Wren', subject: 'ocean thermocline',
    semantic: 'salinity inflection estimate', multi: 'depth profile sequence',
    cross: 'research vessel comparison', stale: 'bottle cast approximation',
    filename: 'ThermoclineProfile.ts',
  }),
  Object.freeze({
    id: 'anemometry', language: 'en', code: 'Yarrow', subject: 'anemometer gust reading',
    semantic: 'cup inertia correction', multi: 'wind chamber measurement chain',
    cross: 'weather mast comparison', stale: 'smoked drum approximation',
    filename: 'GustVaneReading.ts',
  }),
  Object.freeze({
    id: 'infiltration', language: 'en', code: 'Zenith', subject: 'soil capillary infiltration',
    semantic: 'wetting front estimate', multi: 'field ring measurement chain',
    cross: 'test plot comparison', stale: 'graph paper infiltration fit',
    filename: 'CapillaryInfiltration.ts',
  }),
  Object.freeze({
    id: 'kinematics', language: 'en', code: 'Acorn', subject: 'robot gripper kinematics',
    semantic: 'joint pose solution', multi: 'finger linkage calculation',
    cross: 'robot cell comparison', stale: 'cardboard linkage approximation',
    filename: 'GripperPoseChain.ts',
  }),
  Object.freeze({
    id: 'dosage', language: 'en', code: 'Citrus', subject: 'clinical dosage triage',
    semantic: 'contraindication weighting', multi: 'dose review workflow',
    cross: 'ward review comparison', stale: 'paper nomogram method',
    filename: 'ContraindicationDoseRule.ts',
  }),
  Object.freeze({
    id: 'weaving', language: 'en', code: 'Delta', subject: 'loom warp tension',
    semantic: 'selvedge pressure estimate', multi: 'heddle motion workflow',
    cross: 'weaving floor comparison', stale: 'wooden gauge method',
    filename: 'WarpTensionBeam.ts',
  }),
  Object.freeze({
    id: 'birefringence', language: 'en', code: 'Ember', subject: 'crystal birefringence',
    semantic: 'optic axis estimate', multi: 'thin section reading workflow',
    cross: 'petrography bench comparison', stale: 'paper interference sketch',
    filename: 'BirefringenceAxis.ts',
  }),
  Object.freeze({
    id: 'buckling', language: 'en', code: 'Flint', subject: 'truss brace buckling',
    semantic: 'slenderness load estimate', multi: 'joint load calculation',
    cross: 'structural bay comparison', stale: 'slide rule approximation',
    filename: 'BucklingBraceLoad.ts',
  }),
  Object.freeze({
    id: 'riposte', language: 'mixed', code: 'Grove', subject: '击剑 riposte',
    semantic: '还击 tempo 判断', multi: '步法 blade-work 链路',
    cross: '训练馆 bout comparison', stale: '纸质 scorecard 判定法',
    filename: 'RiposteTempoWindow.ts',
  }),
  Object.freeze({
    id: 'counterpoint', language: 'mixed', code: 'Heliotrope', subject: '对位 counterpoint',
    semantic: '声部 contrary-motion 判断', multi: '和声 voice-leading 链路',
    cross: '乐谱版本 score comparison', stale: '纸带 rulebook 判定法',
    filename: 'VoiceLeadingCadence.ts',
  }),
  Object.freeze({
    id: 'firn', language: 'mixed', code: 'Ivory', subject: '粒雪 firn 密度',
    semantic: '年层 chronology 估计', multi: '冰芯 layer-reading 链路',
    cross: '钻孔 site comparison', stale: '纸质 density worksheet 方法',
    filename: 'FirnDensityLayer.ts',
  }),
  Object.freeze({
    id: 'dovetail', language: 'mixed', code: 'Jade', subject: '榫接 dovetail',
    semantic: '木纹 allowance 估计', multi: '划线 chisel-work 链路',
    cross: '木工坊 joint comparison', stale: '纸质 story-stick 方法',
    filename: 'DovetailGrainAllowance.ts',
  }),
]);

const MULTI_FILE_COUNTS = Object.freeze([
  2, 3, 2, 4, 2, 3, 2, 4, 2, 3,
  2, 3, 2, 4, 2, 3, 2, 4, 2, 3,
]);
const THREE_PROJECT_CROSS = new Set([1, 4, 7, 10, 14, 18]);
const STALE_KINDS = Object.freeze([
  'deleted', 'moved', 'renamed', 'deleted', 'moved', 'renamed',
  'deleted', 'moved', 'renamed', 'deleted', 'moved', 'renamed',
  'deleted', 'moved', 'renamed', 'deleted', 'moved', 'renamed',
  'deleted', 'moved',
]);
const HARD_NEGATIVE_INDICES = new Set([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);

const mutableSessions = [];
const mutableCases = [];
const interferenceAnchorByCaseId = new Map();
const absentTermsByNegativeCaseId = new Map();
const matchedDistractorByCaseId = new Map();
const discriminativeAnchorByCaseId = new Map();

function projectAt(index) {
  return projects[((index % projects.length) + projects.length) % projects.length];
}

function relativePath(concept, logicalKey, filename) {
  const directory = seedHash(`directory:${concept.id}:${logicalKey}`).toString(16).padStart(8, '0');
  return `src/modules/${directory}/${filename}`;
}

function basename(value) {
  return String(value).replaceAll('\\', '/').split('/').at(-1);
}

function stem(value) {
  return basename(value).replace(/\.[^.]+$/, '').toLowerCase();
}

function rawPath(value, salt) {
  return salt % 3 === 1 ? value.replaceAll('/', '\\') : value;
}

function toolInput(value, salt) {
  const path = rawPath(value, salt);
  if (salt % 3 === 0) return JSON.stringify({ path, operation: 'inspect' });
  if (salt % 3 === 1) return `Review ${path} against the acceptance notes`;
  return `apply_patch ${path}`;
}

function scheduledStart(timeGroup, side = 'target', rowIndex = 0) {
  const baseHour = seedHash(`clock:${timeGroup}`) % (180 * 24);
  const targetFirst = seedHash(`clock-order:${timeGroup}`) % 2 === 0;
  const sideOffset = side === 'target'
    ? (targetFirst ? 0 : 12)
    : side === 'distractor'
      ? (targetFirst ? 12 : 0)
      : 6;
  return START + baseHour * HOUR + (sideOffset + rowIndex * 5) * MINUTE;
}

function sessionTitle(concept, logicalKey) {
  const suffix = seedHash(`title:${logicalKey}`).toString(16).padStart(8, '0').slice(0, 6).toUpperCase();
  if (concept.language === 'zh') return `工作札记 ${suffix}`;
  if (concept.language === 'mixed') return `工作札记 log ${suffix}`;
  return `Workshop log ${suffix}`;
}

function categoryAnchor(concept, category) {
  const base = {
    'semantic-single': concept.semantic,
    'filename-only': concept.language === 'zh'
      ? '源码索引'
      : concept.language === 'mixed'
        ? 'source 索引'
        : 'source index',
    'multi-file': concept.multi,
    'cross-project': concept.cross,
    'stale-path': concept.stale,
  }[category];
  return `${concept.subject}｜${base}`;
}

function activityText(concept, category, distractor = false) {
  if (distractor) {
    if (concept.language === 'zh') {
      return `${concept.subject}工作札记梳理术语、输入条件、边界约束与观测结果。`;
    }
    if (concept.language === 'mixed') {
      return `${concept.subject} worklog 记录 terminology、inputs、boundary conditions 与 observed behavior。`;
    }
    return `The ${concept.subject} worklog records terminology, inputs, boundary conditions, and observed behavior.`;
  }
  const anchor = categoryAnchor(concept, category);
  if (concept.language === 'zh') {
    return `工作札记围绕“${anchor}”梳理输入条件、边界约束与观测结果。`;
  }
  if (concept.language === 'mixed') {
    return `worklog 围绕“${anchor}”记录 inputs、boundary conditions 与 observed behavior。`;
  }
  return `The worklog examines "${anchor}" through inputs, boundary conditions, and observed behavior.`;
}

function addSession({ logicalKey, project, concept, category, files, timeGroup, side = 'target', rowIndex = 0, body }) {
  const id = stableUuid('session', logicalKey);
  const startedAt = scheduledStart(timeGroup, side, rowIndex);
  const durationMinutes = 40 + seedHash(`duration:${timeGroup}:${rowIndex}`) % 61;
  const summary = body ?? activityText(concept, category, side === 'distractor');
  const session = {
    id,
    platformSessionId: stableUuid('platform-session', logicalKey),
    title: sessionTitle(concept, logicalKey),
    summary,
    searchText: summary,
    projectPath: project.root,
    platform: project.platform,
    startedAt,
    lastActivityAt: startedAt + durationMinutes * MINUTE,
    keyFiles: files.map((file, index) => rawPath(file, seedHash(`${logicalKey}:path:${index}`))),
    toolInputs: files.map((file, index) => ({
      inputSummary: toolInput(file, seedHash(`${logicalKey}:tool:${index}`)),
      timestamp: startedAt + (index + 1) * 1000,
    })),
    conceptId: concept.id,
  };
  mutableSessions.push(session);
  return session;
}

function expectedTarget(file, project, session, currentState = 'exists', extra = {}) {
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

function caseQuery(concept, category, filename, project) {
  const ordinal = CONCEPTS.findIndex(row => row.id === concept.id);
  const select = variants => variants[seedHash(`query:${concept.id}:${category}`) % variants.length];
  const quoted = categoryAnchor(concept, category);
  if (category === 'filename-only') {
    if (concept.language === 'zh') {
      return select([
        `在工作区 ${project.id} 内，返回与“${quoted}”相符且 basename 为 ${filename} 的源码路径。`,
        `查阅工作区 ${project.id}，给出“${quoted}”记录中 basename 等于 ${filename} 的源码位置。`,
        `工作区 ${project.id} 里哪条“${quoted}”源码记录使用了 basename ${filename}？`,
        `请从工作区 ${project.id} 的“${quoted}”记录返回 basename ${filename} 对应的源码位置。`,
      ]);
    }
    if (concept.language === 'mixed') {
      return select([
        `在 workspace ${project.id} 中，返回“${quoted}”记录里 basename ${filename} 对应的 source path。`,
        `Review workspace ${project.id}，给出“${quoted}”且 basename 为 ${filename} 的源码位置。`,
        `workspace ${project.id} 的“${quoted}”记录中，哪个 source path 使用 basename ${filename}？`,
        `从 workspace ${project.id} 返回“${quoted}”对应的 basename ${filename} 源码位置。`,
      ]);
    }
    return select([
      `Inside workspace ${project.id}, return the source path whose basename is ${filename} and whose record concerns "${quoted}".`,
      `Review workspace ${project.id} for the "${quoted}" record carrying basename ${filename}; report its source path.`,
      `Which source path in workspace ${project.id} pairs basename ${filename} with the "${quoted}" record?`,
      `From workspace ${project.id}, report the "${quoted}" source path recorded with basename ${filename}.`,
    ]);
  }
  if (concept.language === 'zh') {
    const templates = {
      'semantic-single': [
        `回看“${quoted}”这条记录，源码落点是什么？`,
        `请从会话记录找出“${quoted}”对应的源码落点。`,
        `“${quoted}”涉及的代码位置，请给出记录中的路径。`,
        `针对“${quoted}”，返回会话里记下的源码位置。`,
      ],
      'multi-file': [
        `整理“${quoted}”相关记录，列全涉及的源码路径。`,
        `“${quoted}”这项工作触及哪些源码路径？请完整列出。`,
        `请汇总“${quoted}”在会话中出现过的全部代码位置。`,
        `回看“${quoted}”记录，把成组出现的源码位置列齐。`,
      ],
      'cross-project': [
        `按工作区归纳“${quoted}”对应的源码位置。`,
        `“${quoted}”分散在若干工作区，请逐区列出代码位置。`,
        `请将“${quoted}”的记录按工作区分组，并列出路径。`,
        `回看“${quoted}”，哪些工作区各自留下了源码位置？`,
      ],
      'stale-path': [
        `追溯“${quoted}”，当时记下的源码位置是什么？`,
        `“${quoted}”早先对应哪条源码路径？`,
        `请恢复“${quoted}”记录中的先前源码位置。`,
        `回看“${quoted}”旧记录，给出当时的代码位置。`,
      ],
    };
    return templates[category][ordinal % templates[category].length];
  }
  if (concept.language === 'mixed') {
    const templates = {
      'semantic-single': [
        `回看“${quoted}” record，返回对应的 source path。`,
        `请从 session notes 提取“${quoted}”的源码落点。`,
        `“${quoted}”对应哪条 recorded code path？`,
        `针对“${quoted}”，report 会话中记下的源码位置。`,
      ],
      'multi-file': [
        `汇总“${quoted}”记录，列齐 associated source paths。`,
        `“${quoted}”触及的 recorded code paths 有哪些？`,
        `请把“${quoted}”会话里的全部 source paths 列出。`,
        `回看“${quoted}”，enumerate 成组出现的源码位置。`,
      ],
      'cross-project': [
        `按 workspace 整理“${quoted}”对应的 source paths。`,
        `“${quoted}”涉及若干 workspaces，请逐个列出代码位置。`,
        `请把“${quoted}”记录按 workspace 分组并给出 paths。`,
        `回看“${quoted}”，哪些 workspaces 留下了源码位置？`,
      ],
      'stale-path': [
        `追溯“${quoted}”，earlier recorded source path 是什么？`,
        `“${quoted}”先前对应哪条 recorded code path？`,
        `请恢复“${quoted}”会话中的 earlier source path。`,
        `回看“${quoted}”旧记录，report 当时的源码位置。`,
      ],
    };
    return templates[category][ordinal % templates[category].length];
  }
  const templates = {
    'semantic-single': [
      `Review the record for "${quoted}" and report its source path.`,
      `Recover the source path associated with the "${quoted}" worklog.`,
      `Return the recorded code path for "${quoted}".`,
      `Trace "${quoted}" to the source path noted in the session history.`,
    ],
    'multi-file': [
      `Enumerate every recorded source path associated with "${quoted}".`,
      `List the complete set of code paths touched by the "${quoted}" worklog.`,
      `Collect all source paths appearing in records about "${quoted}".`,
      `Return the full group of recorded code paths for "${quoted}".`,
    ],
    'cross-project': [
      `Organize the recorded source paths for "${quoted}" by workspace.`,
      `Group every code path associated with "${quoted}" under its workspace.`,
      `Report the workspaces and source paths recorded for "${quoted}".`,
      `Map the "${quoted}" session records to their workspaces and code paths.`,
    ],
    'stale-path': [
      `Recover the earlier recorded source path for "${quoted}".`,
      `Report the source path previously associated with "${quoted}".`,
      `Trace "${quoted}" back to its prior recorded code path.`,
      `Return the earlier source path preserved in records about "${quoted}".`,
    ],
  };
  return templates[category][ordinal % templates[category].length];
}

function addCase({
  id,
  concept,
  category,
  query,
  targets,
  note,
  negativeKind,
  nuisanceFlags = [],
  interferenceAnchor,
  discriminativeAnchor,
}) {
  const testCase = {
    id,
    category,
    split: 'formal',
    phase: 'formal',
    query,
    language: concept.language,
    topK: 10,
    targets,
    conceptId: concept.id,
    mustAbstain: category === 'negative',
    ...(negativeKind ? { negativeKind } : {}),
    nuisanceFlags,
    note,
  };
  mutableCases.push(testCase);
  if (interferenceAnchor) interferenceAnchorByCaseId.set(id, interferenceAnchor.toLowerCase());
  if (discriminativeAnchor) discriminativeAnchorByCaseId.set(id, discriminativeAnchor.toLowerCase());
}

for (const [index, concept] of CONCEPTS.entries()) {
  const ordinal = String(index + 1).padStart(2, '0');
  const semanticProject = projectAt(index);
  const filenameProject = projectAt(index + 2);
  const multiProject = projectAt(index + 4);
  const staleProject = projectAt(index + 6);

  const semanticFile = relativePath(concept, 'a0', `${concept.code}Orbit.ts`);
  const filenameFile = relativePath(concept, 'a1', concept.filename);
  const multiFiles = Array.from({ length: MULTI_FILE_COUNTS[index] }, (_, fileIndex) =>
    relativePath(concept, `a2-${fileIndex}`, `${concept.code}Unit${fileIndex + 1}.ts`));
  const staleFile = relativePath(concept, 'a4', `${concept.code}Ledger.ts`);

  const semanticSession = addSession({
    logicalKey: `${concept.id}:a0:t`,
    project: semanticProject,
    concept,
    category: 'semantic-single',
    files: [semanticFile],
    timeGroup: `${concept.id}:a0`,
  });
  const semanticCaseId = `formal-semantic-${ordinal}`;
  addCase({
    id: semanticCaseId,
    concept,
    category: 'semantic-single',
    query: caseQuery(concept, 'semantic-single'),
    targets: [expectedTarget(semanticFile, semanticProject, semanticSession)],
    note: 'The query vocabulary is absent from the opaque target basename.',
    nuisanceFlags: ['query-token-interference', 'basename-collision'],
    interferenceAnchor: concept.subject,
    discriminativeAnchor: categoryAnchor(concept, 'semantic-single'),
  });

  const filenameSession = addSession({
    logicalKey: `${concept.id}:a1:t`,
    project: filenameProject,
    concept,
    category: 'filename-only',
    files: [filenameFile],
    timeGroup: `${concept.id}:a1`,
  });
  const filenameCaseId = `formal-filename-${ordinal}`;
  addCase({
    id: filenameCaseId,
    concept,
    category: 'filename-only',
    query: caseQuery(concept, 'filename-only', concept.filename, filenameProject),
    targets: [expectedTarget(filenameFile, filenameProject, filenameSession)],
    note: 'The exact basename appears only in file evidence; workspace and record context disambiguate it.',
    nuisanceFlags: ['query-token-interference', 'basename-collision'],
    interferenceAnchor: concept.subject,
    discriminativeAnchor: categoryAnchor(concept, 'filename-only'),
  });

  const multiSession = addSession({
    logicalKey: `${concept.id}:a2:t`,
    project: multiProject,
    concept,
    category: 'multi-file',
    files: multiFiles,
    timeGroup: `${concept.id}:a2`,
  });
  const multiCaseId = `formal-multi-${ordinal}`;
  addCase({
    id: multiCaseId,
    concept,
    category: 'multi-file',
    query: caseQuery(concept, 'multi-file'),
    targets: multiFiles.map(file => expectedTarget(file, multiProject, multiSession)),
    note: `All ${multiFiles.length} files in one project are required.`,
    nuisanceFlags: ['query-token-interference', 'basename-collision'],
    interferenceAnchor: concept.subject,
    discriminativeAnchor: categoryAnchor(concept, 'multi-file'),
  });

  const crossCount = THREE_PROJECT_CROSS.has(index) ? 3 : 2;
  const crossRows = Array.from({ length: crossCount }, (_, rowIndex) => {
    const project = projectAt(index * 2 + rowIndex * 3);
    const file = relativePath(concept, `a3-${rowIndex}`, `${concept.code}Node${rowIndex + 1}.ts`);
    const session = addSession({
      logicalKey: `${concept.id}:a3:t:${rowIndex}`,
      project,
      concept,
      category: 'cross-project',
      files: [file],
      timeGroup: `${concept.id}:a3`,
      rowIndex,
    });
    return { project, file, session };
  });
  const crossCaseId = `formal-cross-${ordinal}`;
  addCase({
    id: crossCaseId,
    concept,
    category: 'cross-project',
    query: caseQuery(concept, 'cross-project'),
    targets: crossRows.map(row => expectedTarget(row.file, row.project, row.session)),
    note: `Every file across all ${crossRows.length} distinct projects is required.`,
    nuisanceFlags: ['query-token-interference', 'basename-collision'],
    interferenceAnchor: concept.subject,
    discriminativeAnchor: categoryAnchor(concept, 'cross-project'),
  });

  const staleKind = STALE_KINDS[index];
  const replacementPath = staleKind === 'deleted'
    ? undefined
    : relativePath(concept, 'a4-r', `${concept.code}Revision.ts`);
  const staleSession = addSession({
    logicalKey: `${concept.id}:a4:t`,
    project: staleProject,
    concept,
    category: 'stale-path',
    files: [staleFile],
    timeGroup: `${concept.id}:a4`,
  });
  const staleCaseId = `formal-stale-${ordinal}`;
  addCase({
    id: staleCaseId,
    concept,
    category: 'stale-path',
    query: caseQuery(concept, 'stale-path'),
    targets: [expectedTarget(staleFile, staleProject, staleSession, 'missing', {
      staleKind,
      ...(replacementPath ? { replacementPath } : {}),
    })],
    note: 'Gold evidence is historical and must not be represented as a currently existing path.',
    nuisanceFlags: ['query-token-interference', 'basename-collision'],
    interferenceAnchor: concept.subject,
    discriminativeAnchor: categoryAnchor(concept, 'stale-path'),
  });

  const isHardNegative = HARD_NEGATIVE_INDICES.has(index);
  const impossibleTerm = `moonlace${ordinal}`;
  const cleanTermA = `xanthisle${ordinal}`;
  const cleanTermB = `quartzibex${ordinal}`;
  const negativeQuery = isHardNegative
    ? concept.language === 'zh'
      ? `会话证据是否把“${concept.subject}”与标记“${impossibleTerm}”联系起来？`
      : concept.language === 'mixed'
        ? `session evidence 是否把“${concept.subject}”与 marker “${impossibleTerm}”联系起来？`
        : `Does any recorded source evidence connect "${concept.subject}" to marker "${impossibleTerm}"?`
    : concept.language === 'zh'
      ? `检查会话证据中是否同时出现“${cleanTermA}”与“${cleanTermB}”。`
      : concept.language === 'mixed'
        ? `检查 session evidence 是否同时出现“${cleanTermA}”与“${cleanTermB}”。`
        : `Check recorded source evidence for both "${cleanTermA}" and "${cleanTermB}".`;
  const negativeCaseId = `formal-negative-${ordinal}`;
  addCase({
    id: negativeCaseId,
    concept,
    category: 'negative',
    query: negativeQuery,
    targets: [],
    negativeKind: isHardNegative ? 'hard' : 'clean',
    note: isHardNegative
      ? 'A broad subject is present, but the requested mechanism has never existed.'
      : 'Neither distinctive query term occurs in any session evidence.',
    nuisanceFlags: isHardNegative ? ['query-token-interference', 'partial-token-overlap'] : [],
    interferenceAnchor: isHardNegative ? concept.subject : undefined,
  });
  absentTermsByNegativeCaseId.set(
    negativeCaseId,
    isHardNegative ? [impossibleTerm] : [cleanTermA, cleanTermB],
  );

  const makeCopies = (files, key) => files.map((file, fileIndex) =>
    relativePath(concept, `${key}:${fileIndex}`, basename(file)));
  const pairedRows = [
    {
      caseId: semanticCaseId,
      category: 'semantic-single',
      project: semanticProject,
      files: makeCopies([semanticFile], 'b0'),
      timeGroup: `${concept.id}:a0`,
      logicalKey: `${concept.id}:a0:d`,
    },
    {
      caseId: filenameCaseId,
      category: 'filename-only',
      project: filenameProject,
      files: makeCopies([filenameFile], 'b1'),
      timeGroup: `${concept.id}:a1`,
      logicalKey: `${concept.id}:a1:d`,
    },
    {
      caseId: multiCaseId,
      category: 'multi-file',
      project: multiProject,
      files: makeCopies(multiFiles, 'b2'),
      timeGroup: `${concept.id}:a2`,
      logicalKey: `${concept.id}:a2:d`,
    },
    {
      caseId: crossCaseId,
      category: 'cross-project',
      project: crossRows[0].project,
      files: makeCopies(crossRows.map(row => row.file), 'b3'),
      timeGroup: `${concept.id}:a3`,
      logicalKey: `${concept.id}:a3:d`,
    },
    {
      caseId: staleCaseId,
      category: 'stale-path',
      project: staleProject,
      files: makeCopies([staleFile], 'b4'),
      timeGroup: `${concept.id}:a4`,
      logicalKey: `${concept.id}:a4:d`,
    },
  ];
  for (const row of pairedRows) {
    const distractor = addSession({
      logicalKey: row.logicalKey,
      project: row.project,
      concept,
      category: row.category,
      files: row.files,
      timeGroup: row.timeGroup,
      side: 'distractor',
    });
    matchedDistractorByCaseId.set(row.caseId, distractor.id);
  }

  addSession({
    logicalKey: `${concept.id}:a5:d`,
    project: projectAt(index + 9),
    concept,
    category: 'semantic-single',
    files: [relativePath(concept, 'b5', `${concept.code}Memo.ts`)],
    timeGroup: `${concept.id}:a5`,
    side: 'topic',
    body: activityText(concept, 'semantic-single', true),
  });
}

function freezeSession(session) {
  return Object.freeze({
    ...session,
    keyFiles: Object.freeze([...session.keyFiles]),
    toolInputs: Object.freeze(session.toolInputs.map(row => Object.freeze({ ...row }))),
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
  'semantic-single': 20,
  'filename-only': 20,
  'multi-file': 20,
  'cross-project': 20,
  'stale-path': 20,
  negative: 20,
});
const EXPECTED_LANGUAGE_COUNTS = Object.freeze({ en: 48, mixed: 24, zh: 48 });
const EXPECTED_PER_CATEGORY_LANGUAGES = Object.freeze({ en: 8, mixed: 4, zh: 8 });
const EXPECTED_NEGATIVE_KINDS = Object.freeze({ clean: 10, hard: 10 });
const EXPECTED_MULTI_COUNTS = Object.freeze({ 2: 10, 3: 6, 4: 4 });
const EXPECTED_CROSS_COUNTS = Object.freeze({ 2: 14, 3: 6 });
const EXPECTED_STALE_KINDS = Object.freeze({ deleted: 7, moved: 7, renamed: 6 });
const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUERY_NGRAM_SIZE = 8;
const FORBIDDEN_EXPOSED_LABELS = Object.freeze([
  'semantic', 'filename', 'multi', 'cross', 'stale', 'noise', 'focus',
  'named', 'cluster', 'facet', 'retired', 'decoys', 'formal',
]);
const FORBIDDEN_PROSE_CUES = Object.freeze([
  'completed', 'not requested', 'unrelated', 'exploratory', 'did not contain',
  'never implemented', 'never existed', 'without implementing',
  'no requested', 'only as background',
]);
const PRIOR_QUERY_TEMPLATE_FRAGMENTS = Object.freeze([
  '防护在哪个文件', '需要修改哪些文件', '跨项目实现在哪里', '旧实现以前在哪里',
  'failure handling location', 'pipeline files', 'cross project adapters',
  'old implementation path', 'failure protection location',
  'coordinated pipeline files', 'adapters across projects',
  'retired implementation path', 'where is the', 'which files complete',
  'across projects', 'what historical file held', 'locate', 'find the',
]);
const FORBIDDEN_THEME_TERMS = Object.freeze([
  'oauth', 'authentication', 'authorization', 'login', 'credential',
  'capture', 'ingest', 'collector', 'harvest',
  'scheduler', 'scheduling', 'cron', 'timer', 'queue',
  'migration', 'migrate', 'porting', 'schema evolution',
  'proxy', 'gateway', 'relay', 'tunnel',
  'dashboard', 'chart', 'metric', 'visualization', 'overview',
  'embedding', 'vector search', 'similarity index',
  'installer', 'setup', 'packaging', 'shortcut', 'wizard',
  'export', 'outbound archive', 'serialize', 'dump',
  'synchronize', 'synchronization', 'merge conflict', 'replication', 'checkpoint',
  'localization', 'locale', 'translation', 'i18n', 'language pack',
  'membership', 'subscription', 'entitlement', 'renewal', 'billing',
  '认证', '登录', '授权', '采集', '捕获', '收集', '调度', '定时', '队列',
  '迁移', '代理', '网关', '转发', '仪表盘', '看板', '图表', '指标',
  '向量', '嵌入', '安装包', '快捷方式', '导出', '归档', '同步', '合并',
  '冲突', '本地化', '翻译', '语言包', '会员', '订阅', '权益', '续费',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`[${DATASET_ID}] ${message}`);
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

function canonicalPath(value) {
  return String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function sessionEvidenceText(session) {
  return canonicalPath([
    session.title,
    session.summary,
    session.searchText,
    ...session.keyFiles,
    ...session.toolInputs.map(row => row.inputSummary),
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

function pathExtension(value) {
  const match = basename(value).match(/(\.[^.]+)$/);
  return match?.[1]?.toLowerCase() ?? '';
}

function pathDepth(value) {
  return canonicalPath(value).split('/').filter(Boolean).length;
}

function titleTone(value) {
  return String(value).replace(/[0-9A-F]{6}$/u, '<id>');
}

function collisionStats() {
  const fileRows = sessions.flatMap(session => session.keyFiles.map(file => ({
    sessionId: session.id,
    basename: basename(file).toLowerCase(),
    path: canonicalPath(file),
    projectPath: canonicalPath(session.projectPath),
  })));
  const targetRows = cases.flatMap(testCase => testCase.targets.map(target => ({ testCase, target })));
  const hasCollision = (target, predicate = () => true) => fileRows.some(row =>
    row.basename === basename(target.path).toLowerCase()
      && row.path !== canonicalPath(target.path)
      && predicate(row));
  const collided = targetRows.filter(({ target }) => hasCollision(target));
  const sameProject = targetRows.filter(({ target }) => hasCollision(
    target,
    row => row.projectPath === canonicalPath(target.projectPath),
  ));
  const crossProject = targetRows.filter(({ target }) => hasCollision(
    target,
    row => row.projectPath !== canonicalPath(target.projectPath),
  ));
  const candidateCollisions = targetRows.filter(({ testCase, target }) => {
    const distractorId = matchedDistractorByCaseId.get(testCase.id);
    const anchor = interferenceAnchorByCaseId.get(testCase.id);
    const distractor = sessions.find(session => session.id === distractorId);
    return distractor
      && anchor
      && canonicalPath(testCase.query).includes(canonicalPath(anchor))
      && sessionEvidenceText(distractor).includes(canonicalPath(anchor))
      && distractor.keyFiles.some(file => basename(file).toLowerCase() === basename(target.path).toLowerCase());
  });
  return {
    targets: collided.length,
    totalTargets: targetRows.length,
    ratio: collided.length / targetRows.length,
    sameProjectTargets: sameProject.length,
    sameProjectRatio: sameProject.length / targetRows.length,
    crossProjectTargets: crossProject.length,
    crossProjectRatio: crossProject.length / targetRows.length,
    candidateTargets: candidateCollisions.length,
    candidateRatio: candidateCollisions.length / targetRows.length,
  };
}

function matchedPairStats(sessionsById) {
  const positiveCases = cases.filter(testCase => testCase.category !== 'negative');
  let matched = 0;
  let targetFiles = 0;
  for (const testCase of positiveCases) {
    const distractorId = matchedDistractorByCaseId.get(testCase.id);
    const distractor = sessionsById.get(distractorId);
    invariant(distractor, `case ${testCase.id} lacks its matched distractor`);
    const supportingSessions = testCase.targets.flatMap(target =>
      target.sessionIds.map(sessionId => sessionsById.get(sessionId)));
    invariant(supportingSessions.every(Boolean), `case ${testCase.id} has missing supporting sessions`);
    invariant(!supportingSessions.some(session => session.id === distractor.id), `case ${testCase.id} reuses target evidence as a distractor`);

    const targetBasenames = testCase.targets.map(target => basename(target.path).toLowerCase()).sort();
    const distractorBasenames = distractor.keyFiles.map(file => basename(file).toLowerCase()).sort();
    invariant(
      JSON.stringify(targetBasenames) === JSON.stringify(distractorBasenames),
      `case ${testCase.id} distractor does not mirror target basenames`,
    );
    const targetExtensions = testCase.targets.map(target => pathExtension(target.path)).sort();
    const distractorExtensions = distractor.keyFiles.map(pathExtension).sort();
    invariant(
      JSON.stringify(targetExtensions) === JSON.stringify(distractorExtensions),
      `case ${testCase.id} extension distribution is unmatched`,
    );
    const targetDepths = testCase.targets.map(target => pathDepth(target.path)).sort((a, b) => a - b);
    const distractorDepths = distractor.keyFiles.map(pathDepth).sort((a, b) => a - b);
    invariant(
      JSON.stringify(targetDepths) === JSON.stringify(distractorDepths),
      `case ${testCase.id} directory-depth distribution is unmatched`,
    );
    invariant(
      supportingSessions.every(session => titleTone(session.title) === titleTone(distractor.title)),
      `case ${testCase.id} title tone differs between target and distractor`,
    );
    invariant(
      supportingSessions.every(session => Math.abs(session.startedAt - distractor.startedAt) <= 30 * MINUTE),
      `case ${testCase.id} timestamps are not paired within 30 minutes`,
    );

    const discriminativeAnchor = discriminativeAnchorByCaseId.get(testCase.id);
    invariant(discriminativeAnchor, `case ${testCase.id} lacks its discriminative anchor`);
    invariant(canonicalPath(testCase.query).includes(canonicalPath(discriminativeAnchor)), `case ${testCase.id} query omits its discriminative anchor`);
    invariant(
      supportingSessions.every(session => sessionEvidenceText(session).includes(canonicalPath(discriminativeAnchor))),
      `case ${testCase.id} target evidence omits its discriminative anchor`,
    );
    invariant(
      !sessionEvidenceText(distractor).includes(canonicalPath(discriminativeAnchor)),
      `case ${testCase.id} distractor contains the full discriminative anchor`,
    );
    matched += 1;
    targetFiles += testCase.targets.length;
  }
  invariant(matched === matchedDistractorByCaseId.size, 'matched distractor registry contains extra rows');
  return { cases: matched, targetFiles };
}

function goldAnchorExclusivityStats(sessionsById) {
  const positiveCases = cases.filter(testCase => testCase.category !== 'negative');
  const anchorRows = positiveCases.map(testCase => ({
    testCase,
    anchor: canonicalPath(discriminativeAnchorByCaseId.get(testCase.id)),
  }));
  invariant(anchorRows.every(row => row.anchor.length > 0), 'every positive case must define a complete discriminative anchor');
  invariant(new Set(anchorRows.map(row => row.anchor)).size === anchorRows.length, 'complete discriminative anchors must be globally unique');
  for (let left = 0; left < anchorRows.length; left += 1) {
    for (let right = left + 1; right < anchorRows.length; right += 1) {
      invariant(
        !anchorRows[left].anchor.includes(anchorRows[right].anchor)
          && !anchorRows[right].anchor.includes(anchorRows[left].anchor),
        `complete anchors overlap between ${anchorRows[left].testCase.id} and ${anchorRows[right].testCase.id}`,
      );
    }
  }

  let nonGoldSessionChecks = 0;
  let unconstrainedCases = 0;
  const checkedByCategory = {};
  for (const { testCase, anchor } of anchorRows) {
    const goldSessionIds = new Set(testCase.targets.flatMap(target => target.sessionIds));
    const goldSessions = [...goldSessionIds].map(sessionId => sessionsById.get(sessionId));
    invariant(
      goldSessions.every(session => session && sessionEvidenceText(session).includes(anchor)),
      `case ${testCase.id} has gold evidence without its complete anchor`,
    );
    const nonGoldSessions = sessions.filter(session => !goldSessionIds.has(session.id));
    for (const session of nonGoldSessions) {
      invariant(
        !sessionEvidenceText(session).includes(anchor),
        `case ${testCase.id} complete anchor appears in non-gold session ${session.id}`,
      );
      nonGoldSessionChecks += 1;
    }
    if (testCase.category !== 'filename-only') unconstrainedCases += 1;
    checkedByCategory[testCase.category] = (checkedByCategory[testCase.category] ?? 0) + 1;
  }
  return {
    anchors: anchorRows.length,
    uniqueAnchors: new Set(anchorRows.map(row => row.anchor)).size,
    unconstrainedCases,
    nonGoldSessionChecks,
    violations: 0,
    checkedByCategory,
  };
}

function interferenceStats(sessionsById) {
  let verified = 0;
  for (const testCase of cases) {
    const anchor = interferenceAnchorByCaseId.get(testCase.id);
    if (!anchor) continue;
    invariant(canonicalPath(testCase.query).includes(canonicalPath(anchor)), `case ${testCase.id} omits its interference anchor`);
    const evidenceSessionIds = new Set(testCase.targets.flatMap(target => target.sessionIds));
    const hasUnrelatedHit = sessions.some(session =>
      !evidenceSessionIds.has(session.id)
        && sessionEvidenceText(session).includes(canonicalPath(anchor)));
    invariant(hasUnrelatedHit, `case ${testCase.id} lacks an unrelated query-token distractor`);
    invariant(
      testCase.nuisanceFlags.includes('query-token-interference'),
      `case ${testCase.id} must declare query-token-interference`,
    );
    verified += 1;
  }
  invariant(verified === interferenceAnchorByCaseId.size, 'not every interference anchor was verified');
  return { cases: verified, totalCases: cases.length, ratio: verified / cases.length };
}

function normalizeQuery(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function queryNgrams(value, size = QUERY_NGRAM_SIZE) {
  const characters = [...normalizeQuery(value)];
  const grams = new Set();
  for (let index = 0; index + size <= characters.length; index += 1) {
    grams.add(characters.slice(index, index + size).join(''));
  }
  return grams;
}

function queryIsolationStats() {
  const priorQueries = [...v1Cases, ...sourceCases].map(testCase => testCase.query);
  let sharedNgrams = 0;
  let forbiddenTemplateHits = 0;
  const priorGramSets = priorQueries.map(query => queryNgrams(query));
  for (const testCase of cases) {
    const normalized = normalizeQuery(testCase.query);
    for (const fragment of PRIOR_QUERY_TEMPLATE_FRAGMENTS) {
      if (normalized.includes(normalizeQuery(fragment))) forbiddenTemplateHits += 1;
    }
    const grams = queryNgrams(testCase.query);
    for (const priorGrams of priorGramSets) {
      for (const gram of grams) {
        if (priorGrams.has(gram)) sharedNgrams += 1;
      }
    }
  }
  invariant(sharedNgrams === 0, `formal queries share ${sharedNgrams} ${QUERY_NGRAM_SIZE}-character n-grams with prior corpora`);
  invariant(forbiddenTemplateHits === 0, `formal queries reuse ${forbiddenTemplateHits} prior intent templates`);
  return {
    priorQueries: priorQueries.length,
    queryNgramSize: QUERY_NGRAM_SIZE,
    sharedNgrams,
    forbiddenTemplateHits,
  };
}

function leakageStats() {
  const rows = [];
  for (const project of projects) rows.push({ field: 'projectPath', value: project.root });
  for (const session of sessions) {
    rows.push(
      { field: 'title', value: session.title },
      { field: 'summary', value: session.summary },
      { field: 'searchText', value: session.searchText },
      { field: 'projectPath', value: session.projectPath },
      ...session.keyFiles.map(value => ({ field: 'keyFile', value })),
      ...session.toolInputs.map(row => ({ field: 'toolInput', value: row.inputSummary })),
    );
  }
  const labelHits = [];
  const proseCueHits = [];
  for (const row of rows) {
    const normalized = String(row.value).toLowerCase();
    for (const label of FORBIDDEN_EXPOSED_LABELS) {
      if (normalized.includes(label)) labelHits.push({ field: row.field, label });
    }
    if (['title', 'summary', 'searchText'].includes(row.field)) {
      for (const cue of FORBIDDEN_PROSE_CUES) {
        if (normalized.includes(cue)) proseCueHits.push({ field: row.field, cue });
      }
    }
  }
  invariant(labelHits.length === 0, `exposed session fields contain ${labelHits.length} answer-label hits`);
  invariant(proseCueHits.length === 0, `session prose contains ${proseCueHits.length} direct answer-cue hits`);
  return {
    scannedValues: rows.length,
    forbiddenLabels: FORBIDDEN_EXPOSED_LABELS.length,
    labelHits: labelHits.length,
    forbiddenProseCues: FORBIDDEN_PROSE_CUES.length,
    proseCueHits: proseCueHits.length,
  };
}

function assertSourceIsolation() {
  const sourceConceptIds = new Set(sourceCases.map(testCase => String(testCase.conceptId).toLowerCase()));
  const sourceBasenameStems = new Set(
    [...v1Sessions, ...sourceSessions].flatMap(session => session.keyFiles.map(stem)),
  );
  const formalBasenameStems = new Set(sessions.flatMap(session => session.keyFiles.map(stem)));

  for (const concept of CONCEPTS) {
    invariant(!sourceConceptIds.has(concept.id.toLowerCase()), `concept ${concept.id} leaks from large-v2`);
    const fingerprint = canonicalPath([
      concept.id,
      concept.subject,
      concept.semantic,
      concept.multi,
      concept.cross,
      concept.stale,
      concept.filename,
    ].join(' '));
    for (const forbidden of FORBIDDEN_THEME_TERMS) {
      invariant(!fingerprint.includes(canonicalPath(forbidden)), `concept ${concept.id} reuses forbidden theme term ${forbidden}`);
    }
  }

  for (const formalStem of formalBasenameStems) {
    invariant(!sourceBasenameStems.has(formalStem), `basename stem ${formalStem} leaks from large-v2`);
  }
  for (const target of cases.flatMap(testCase => testCase.targets)) {
    const targetStem = stem(target.path);
    for (const forbidden of FORBIDDEN_THEME_TERMS) {
      invariant(!targetStem.includes(canonicalPath(forbidden).replaceAll(' ', '')), `target basename ${targetStem} uses forbidden term ${forbidden}`);
    }
  }
  return queryIsolationStats();
}

function assertCorpusIntegrity() {
  invariant(DATASET_SEED === 815202617, `seed changed: ${DATASET_SEED}`);
  invariant(projects.length >= 8, `expected at least 8 projects, got ${projects.length}`);
  invariant(sessions.length >= 240, `expected at least 240 sessions, got ${sessions.length}`);
  invariant(sessions.length === 246, `expected deterministic session count 246, got ${sessions.length}`);
  invariant(cases.length === 120, `expected 120 cases, got ${cases.length}`);
  invariant(CONCEPTS.length === 20, `expected 20 concepts, got ${CONCEPTS.length}`);
  invariant(new Set(CONCEPTS.map(concept => concept.id)).size === CONCEPTS.length, 'concept ids must be unique');
  invariant(new Set(CONCEPTS.map(concept => concept.code)).size === CONCEPTS.length, 'concept file codes must be unique');
  invariant(new Set(CONCEPTS.map(concept => stem(concept.filename))).size === CONCEPTS.length, 'concept filename stems must be unique');
  invariant(
    JSON.stringify(projects.map(project => project.id))
      === JSON.stringify(seededShuffle(PROJECT_ROWS, 'projects').map(([id]) => id)),
    'project order is not controlled by DATASET_SEED',
  );
  invariant(
    JSON.stringify(sessions.map(session => session.id))
      === JSON.stringify(seededShuffle(mutableSessions, 'session-order').map(session => session.id)),
    'session order is not controlled by DATASET_SEED',
  );
  invariant(
    JSON.stringify(cases.map(testCase => testCase.id))
      === JSON.stringify(seededShuffle(mutableCases, 'case-order').map(testCase => testCase.id)),
    'case order is not controlled by DATASET_SEED',
  );

  const projectIds = new Set();
  const projectRoots = new Set();
  for (const [index, project] of projects.entries()) {
    invariant(project && typeof project === 'object', `projects[${index}] must be an object`);
    invariant(typeof project.id === 'string' && project.id.length > 0, `projects[${index}].id is invalid`);
    invariant(typeof project.root === 'string' && project.root.length > 0, `projects[${index}].root is invalid`);
    invariant(typeof project.platform === 'string' && project.platform.length > 0, `projects[${index}].platform is invalid`);
    invariant(!projectIds.has(project.id), `duplicate project id: ${project.id}`);
    invariant(!projectRoots.has(canonicalPath(project.root)), `duplicate project root: ${project.root}`);
    projectIds.add(project.id);
    projectRoots.add(canonicalPath(project.root));
  }

  const sessionIds = new Set();
  const sessionsById = new Map();
  for (const [index, session] of sessions.entries()) {
    invariant(session && typeof session === 'object', `sessions[${index}] must be an object`);
    invariant(typeof session.id === 'string' && session.id.length > 0, `sessions[${index}].id is invalid`);
    invariant(SESSION_UUID_PATTERN.test(session.id), `session id is not an opaque UUID: ${session.id}`);
    invariant(!sessionIds.has(session.id), `duplicate session id: ${session.id}`);
    invariant(projectRoots.has(canonicalPath(session.projectPath)), `session ${session.id} has unknown project`);
    for (const field of ['platformSessionId', 'title', 'summary', 'searchText', 'platform']) {
      invariant(typeof session[field] === 'string' && session[field].length > 0, `session ${session.id}.${field} is invalid`);
    }
    invariant(SESSION_UUID_PATTERN.test(session.platformSessionId), `session ${session.id} platform id is not an opaque UUID`);
    invariant(session.platformSessionId !== session.id, `session ${session.id} reuses its id as platform id`);
    invariant(CONCEPTS.some(concept => concept.id === session.conceptId), `session ${session.id} has a non-domain concept tag`);
    invariant(Number.isFinite(session.startedAt), `session ${session.id}.startedAt is invalid`);
    invariant(Number.isFinite(session.lastActivityAt), `session ${session.id}.lastActivityAt is invalid`);
    invariant(session.lastActivityAt >= session.startedAt, `session ${session.id} has reversed timestamps`);
    invariant(Array.isArray(session.keyFiles) && session.keyFiles.length > 0, `session ${session.id}.keyFiles is invalid`);
    invariant(Array.isArray(session.toolInputs) && session.toolInputs.length > 0, `session ${session.id}.toolInputs is invalid`);
    invariant(session.keyFiles.every(file => typeof file === 'string' && file.length > 0), `session ${session.id} has invalid key file`);
    invariant(session.toolInputs.every(row => typeof row.inputSummary === 'string' && Number.isFinite(row.timestamp)), `session ${session.id} has invalid tool input`);
    sessionIds.add(session.id);
    sessionsById.set(session.id, session);
  }

  const caseIds = new Set();
  const targetKeys = new Set();
  for (const [index, testCase] of cases.entries()) {
    invariant(testCase && typeof testCase === 'object', `cases[${index}] must be an object`);
    invariant(typeof testCase.id === 'string' && testCase.id.length > 0, `cases[${index}].id is invalid`);
    invariant(!caseIds.has(testCase.id), `duplicate case id: ${testCase.id}`);
    invariant(testCase.split === 'formal' && testCase.phase === 'formal', `case ${testCase.id} must be formal`);
    invariant(CONCEPTS.some(concept => concept.id === testCase.conceptId), `case ${testCase.id} has unknown concept`);
    invariant(Object.hasOwn(EXPECTED_CATEGORY_COUNTS, testCase.category), `case ${testCase.id} has unknown category`);
    invariant(['zh', 'en', 'mixed'].includes(testCase.language), `case ${testCase.id} has unknown language`);
    invariant(typeof testCase.query === 'string' && testCase.query.trim().length > 0, `case ${testCase.id} has empty query`);
    invariant(Number.isInteger(testCase.topK) && testCase.topK > 0, `case ${testCase.id}.topK is invalid`);
    invariant(Array.isArray(testCase.targets), `case ${testCase.id}.targets is invalid`);
    invariant(Array.isArray(testCase.nuisanceFlags), `case ${testCase.id}.nuisanceFlags is invalid`);
    invariant(new Set(testCase.nuisanceFlags).size === testCase.nuisanceFlags.length, `case ${testCase.id} repeats nuisance flags`);

    if (testCase.category === 'negative') {
      invariant(testCase.mustAbstain === true, `negative case ${testCase.id} must abstain`);
      invariant(testCase.targets.length === 0, `negative case ${testCase.id} must have no target`);
      invariant(['hard', 'clean'].includes(testCase.negativeKind), `negative case ${testCase.id} has invalid kind`);
      const absentTerms = absentTermsByNegativeCaseId.get(testCase.id);
      invariant(Array.isArray(absentTerms) && absentTerms.length > 0, `negative case ${testCase.id} lacks absent-term gold`);
      for (const absentTerm of absentTerms) {
        invariant(canonicalPath(testCase.query).includes(canonicalPath(absentTerm)), `negative case ${testCase.id} omits absent term ${absentTerm}`);
        invariant(
          sessions.every(session => !sessionEvidenceText(session).includes(canonicalPath(absentTerm))),
          `negative case ${testCase.id} absent term ${absentTerm} occurs in session evidence`,
        );
      }
    } else {
      invariant(testCase.mustAbstain === false, `positive case ${testCase.id} cannot require abstention`);
      invariant(testCase.negativeKind == null, `positive case ${testCase.id} cannot define negativeKind`);
      invariant(testCase.targets.length > 0, `positive case ${testCase.id} has no target`);
    }

    for (const [targetIndex, target] of testCase.targets.entries()) {
      const prefix = `case ${testCase.id} target ${targetIndex}`;
      invariant(typeof target.path === 'string' && target.path.length > 0, `${prefix}.path is invalid`);
      invariant(projectRoots.has(canonicalPath(target.projectPath)), `${prefix} has unknown project`);
      invariant(Array.isArray(target.sessionIds) && target.sessionIds.length > 0, `${prefix}.sessionIds is invalid`);
      invariant(new Set(target.sessionIds).size === target.sessionIds.length, `${prefix} repeats session ids`);
      invariant(target.sessionIds.every(sessionId => sessionIds.has(sessionId)), `${prefix} has unknown session id`);
      invariant(Array.isArray(target.evidenceChannels) && target.evidenceChannels.length > 0, `${prefix}.evidenceChannels is invalid`);
      assertExactCounts(countBy(target.evidenceChannels, value => value), { 'key-files': 1, 'tool-input': 1 }, `${prefix}.evidenceChannels`);

      const key = `${canonicalPath(target.projectPath)}::${canonicalPath(target.path)}`;
      invariant(!targetKeys.has(key), `${prefix} duplicates target key ${key}`);
      targetKeys.add(key);

      const supportingSessions = target.sessionIds.map(sessionId => sessionsById.get(sessionId));
      invariant(supportingSessions.every(session => canonicalPath(session.projectPath) === canonicalPath(target.projectPath)), `${prefix} has cross-project evidence`);
      const targetPath = canonicalPath(target.path);
      invariant(
        supportingSessions.some(session => session.keyFiles.some(file => canonicalPath(file) === targetPath)),
        `${prefix} is not closed by keyFiles`,
      );
      invariant(
        supportingSessions.some(session => session.toolInputs.some(row => canonicalPath(row.inputSummary).includes(targetPath))),
        `${prefix} is not closed by toolInputs`,
      );

      if (testCase.category === 'stale-path') {
        invariant(target.currentState === 'missing', `${prefix} must be historical-only`);
        invariant(['deleted', 'moved', 'renamed'].includes(target.staleKind), `${prefix}.staleKind is invalid`);
        invariant(target.staleKind === 'deleted' ? target.replacementPath == null : typeof target.replacementPath === 'string', `${prefix}.replacementPath disagrees with stale kind`);
      } else {
        invariant(target.currentState === 'exists', `${prefix} must currently exist`);
      }
    }
    caseIds.add(testCase.id);
  }

  assertExactCounts(countBy(cases, testCase => testCase.category), EXPECTED_CATEGORY_COUNTS, 'categories');
  assertExactCounts(countBy(cases, testCase => testCase.language), EXPECTED_LANGUAGE_COUNTS, 'languages');
  assertExactCounts(countBy(cases, testCase => testCase.split), { formal: 120 }, 'splits');
  assertExactCounts(countBy(cases, testCase => testCase.phase), { formal: 120 }, 'phases');
  assertExactCounts(countBy(cases, testCase => testCase.conceptId), Object.fromEntries(CONCEPTS.map(concept => [concept.id, 6])), 'concepts');
  for (const concept of CONCEPTS) {
    assertExactCounts(
      countBy(cases.filter(testCase => testCase.conceptId === concept.id), testCase => testCase.category),
      Object.fromEntries(Object.keys(EXPECTED_CATEGORY_COUNTS).map(category => [category, 1])),
      `conceptCategories.${concept.id}`,
    );
  }
  for (const category of Object.keys(EXPECTED_CATEGORY_COUNTS)) {
    assertExactCounts(
      countBy(cases.filter(testCase => testCase.category === category), testCase => testCase.language),
      EXPECTED_PER_CATEGORY_LANGUAGES,
      `categoryLanguages.${category}`,
    );
  }
  assertExactCounts(
    countBy(cases.filter(testCase => testCase.category === 'negative'), testCase => testCase.negativeKind),
    EXPECTED_NEGATIVE_KINDS,
    'negativeKinds',
  );
  for (const [language, expected] of Object.entries({ zh: { clean: 4, hard: 4 }, en: { clean: 4, hard: 4 }, mixed: { clean: 2, hard: 2 } })) {
    assertExactCounts(
      countBy(cases.filter(testCase => testCase.category === 'negative' && testCase.language === language), testCase => testCase.negativeKind),
      expected,
      `negativeKindsByLanguage.${language}`,
    );
  }
  assertExactCounts(countBy(cases.filter(testCase => testCase.category === 'multi-file'), testCase => testCase.targets.length), EXPECTED_MULTI_COUNTS, 'multiTargetCounts');
  assertExactCounts(
    countBy(cases.filter(testCase => testCase.category === 'cross-project'), testCase => new Set(testCase.targets.map(target => canonicalPath(target.projectPath))).size),
    EXPECTED_CROSS_COUNTS,
    'crossProjectCounts',
  );
  for (const testCase of cases.filter(testCase => testCase.category === 'cross-project')) {
    invariant(new Set(testCase.targets.map(target => canonicalPath(target.projectPath))).size === testCase.targets.length, `case ${testCase.id} repeats a cross-project target`);
  }
  assertExactCounts(
    countBy(cases.filter(testCase => testCase.category === 'stale-path'), testCase => testCase.targets[0].staleKind),
    EXPECTED_STALE_KINDS,
    'staleKinds',
  );

  const collisions = collisionStats();
  invariant(collisions.ratio >= 0.4, `basename collision ratio must be >= 40%, got ${(collisions.ratio * 100).toFixed(1)}%`);
  invariant(collisions.candidateRatio >= 0.4, `query-candidate collision ratio must be >= 40%, got ${(collisions.candidateRatio * 100).toFixed(1)}%`);
  invariant(collisions.sameProjectTargets > 0, 'basename collisions must include same-project conflicts');
  invariant(collisions.crossProjectTargets > 0, 'basename collisions must include cross-project conflicts');
  matchedPairStats(sessionsById);
  goldAnchorExclusivityStats(sessionsById);
  const interference = interferenceStats(sessionsById);
  invariant(interference.ratio >= 0.5, `query-token interference ratio must be >= 50%, got ${(interference.ratio * 100).toFixed(1)}%`);
  leakageStats();
  assertSourceIsolation();
}

export function datasetIntegrity() {
  assertCorpusIntegrity();
  const collisions = collisionStats();
  const sessionsById = new Map(sessions.map(session => [session.id, session]));
  const interference = interferenceStats(sessionsById);
  const matchedPairs = matchedPairStats(sessionsById);
  const goldAnchorExclusivity = goldAnchorExclusivityStats(sessionsById);
  const leakage = leakageStats();
  const queryIsolation = queryIsolationStats();
  return {
    datasetId: DATASET_ID,
    seed: DATASET_SEED,
    projects: projects.length,
    sessions: sessions.length,
    cases: cases.length,
    concepts: countBy(cases, testCase => testCase.conceptId),
    categories: countBy(cases, testCase => testCase.category),
    languages: countBy(cases, testCase => testCase.language),
    categoryLanguages: Object.fromEntries(Object.keys(EXPECTED_CATEGORY_COUNTS).map(category => [
      category,
      countBy(cases.filter(testCase => testCase.category === category), testCase => testCase.language),
    ])),
    negativeKinds: countBy(cases.filter(testCase => testCase.category === 'negative'), testCase => testCase.negativeKind),
    negativeKindsByLanguage: Object.fromEntries(['zh', 'en', 'mixed'].map(language => [
      language,
      countBy(cases.filter(testCase => testCase.category === 'negative' && testCase.language === language), testCase => testCase.negativeKind),
    ])),
    splits: countBy(cases, testCase => testCase.split),
    phases: countBy(cases, testCase => testCase.phase),
    multiTargetCounts: countBy(cases.filter(testCase => testCase.category === 'multi-file'), testCase => testCase.targets.length),
    crossProjectCounts: countBy(cases.filter(testCase => testCase.category === 'cross-project'), testCase => new Set(testCase.targets.map(target => canonicalPath(target.projectPath))).size),
    staleKinds: countBy(cases.filter(testCase => testCase.category === 'stale-path'), testCase => testCase.targets[0].staleKind),
    targetsByCategory: targetCountsByCategory(),
    nuisanceFlags: countBy(cases.flatMap(testCase => testCase.nuisanceFlags), flag => flag),
    basenameCollision: collisions,
    queryTokenInterference: interference,
    matchedPairs,
    goldAnchorExclusivity,
    leakage,
    queryIsolation,
    seedControl: {
      projectOrder: projects.map(project => project.id),
      firstSessionIds: sessions.slice(0, 3).map(session => session.id),
      firstCaseIds: cases.slice(0, 3).map(testCase => testCase.id),
    },
    sourceIsolation: {
      sourceDatasets: ['vesti-file-search-v1', 'vesti-file-search-large-v2', 'vesti-file-search-calibration-v2'],
      reusedConceptIds: 0,
      reusedBasenameStems: 0,
      sharedQueryNgrams: queryIsolation.sharedNgrams,
      reusedQueryTemplates: queryIsolation.forbiddenTemplateHits,
    },
  };
}

// This is an authored, deterministic formal corpus. Import-time validation
// prevents accidental drift before any benchmark process can consume it.
assertCorpusIntegrity();
