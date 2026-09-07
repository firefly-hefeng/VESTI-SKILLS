import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';

export type SetupHost = 'codex' | 'claude' | 'kimi-code' | 'cursor';

export interface McpLaunch {
  command: string;
  args: string[];
  /** Environment values that must survive after the setup process exits. */
  env?: Record<string, string>;
}

export interface HostEnvironment {
  KIMI_CODE_HOME?: string;
}

export interface HostStatus {
  host: SetupHost;
  label: string;
  detected: boolean;
  configPath: string;
  skillPath: string;
  registered: boolean;
  registrationUpToDate: boolean;
  skillInstalled: boolean;
  skillUpToDate: boolean;
  error?: string;
  manualSteps?: string[];
}

export interface HostInstallResult {
  host: SetupHost;
  changed: boolean;
  actions: string[];
  backups: string[];
  status: HostStatus;
}

export interface PersistOptions {
  dryRun: boolean;
  now: () => Date;
}

interface PersistResult {
  changed: boolean;
  backupPath?: string;
}

interface ConfigEdit {
  next?: string;
  registered: boolean;
  upToDate: boolean;
  error?: string;
  manualSteps?: string[];
}

interface HostSpec {
  host: SetupHost;
  label: string;
  configPath(homeDir: string, environment: HostEnvironment): string;
  skillPath(homeDir: string, environment: HostEnvironment): string;
  detected(homeDir: string, environment: HostEnvironment): Promise<boolean>;
  editConfig(previous: string | null, desired: McpLaunch): ConfigEdit;
}

function slash(value: string): string {
  return value.replace(/\\/g, '/');
}

function desiredLaunch(launch: McpLaunch): McpLaunch {
  return {
    command: slash(launch.command),
    args: launch.args.map(slash),
    ...(launch.env && Object.keys(launch.env).length > 0
      ? { env: Object.fromEntries(Object.entries(launch.env).map(([key, value]) => [key, slash(value)])) }
      : {}),
  };
}

function jsonManualSteps(
  configPath: string,
  desired: McpLaunch,
  requireType: boolean,
): string[] {
  const entry = {
    ...(requireType ? { type: 'stdio' } : {}),
    ...desiredLaunch(desired),
  };
  return [
    `Open ${configPath}.`,
    'Keep the existing JSON object and add this entry under "mcpServers":',
    JSON.stringify({ vesti: entry }, null, 2),
  ];
}

const JSON_STDIO_CONFLICT_KEYS = [
  'url',
  'transport',
  'headers',
  'httpHeaders',
  'http_headers',
  'envHttpHeaders',
  'env_http_headers',
  'bearerTokenEnvVar',
  'bearer_token_env_var',
  'auth',
  'oauth',
  'disabled',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactStringArray(value: unknown, desired: string[]): boolean {
  return Array.isArray(value)
    && value.every((item): item is string => typeof item === 'string')
    && value.length === desired.length
    && value.every((item, index) => item === desired[index]);
}

function editJsonConfig(
  label: string,
  previous: string | null,
  launch: McpLaunch,
  requireType: boolean,
): ConfigEdit {
  let config: Record<string, unknown> = {};
  if (previous !== null && previous.trim()) {
    try {
      const parsed = JSON.parse(previous) as unknown;
      if (!isRecord(parsed)) {
        return {
          registered: false,
          upToDate: false,
          error: `${label} config is not a JSON object; it was left untouched.`,
        };
      }
      config = parsed as Record<string, unknown>;
    } catch {
      return {
        registered: false,
        upToDate: false,
        error: `${label} config is not valid JSON; it was left untouched.`,
      };
    }
  }

  const rawServers = config.mcpServers;
  if (rawServers !== undefined && !isRecord(rawServers)) {
    return {
      registered: false,
      upToDate: false,
      error: `${label} config field "mcpServers" is not an object; it was left untouched.`,
    };
  }

  const servers = { ...((rawServers ?? {}) as Record<string, unknown>) };
  const current = servers.vesti;
  if (current !== undefined && !isRecord(current)) {
    return {
      registered: true,
      upToDate: false,
      error: `${label} "mcpServers.vesti" is not an object; it was left untouched.`,
    };
  }

  const desired = desiredLaunch(launch);
  const desiredEntry = {
    ...(requireType ? { type: 'stdio' } : {}),
    command: desired.command,
    args: desired.args,
  };
  const currentRecord = (current ?? {}) as Record<string, unknown>;
  const registered = current !== undefined;
  const rawCurrentEnv = currentRecord.env;
  const currentEnv = isRecord(rawCurrentEnv) ? rawCurrentEnv : {};
  const desiredEnvironmentReady = !desired.env || (
    isRecord(rawCurrentEnv)
    && Object.entries(desired.env).every(([key, value]) => rawCurrentEnv[key] === value)
  );
  const containsConflicts = JSON_STDIO_CONFLICT_KEYS.some(key => key in currentRecord)
    || ('enabled' in currentRecord && currentRecord.enabled !== true)
    || (requireType ? currentRecord.type !== 'stdio' : 'type' in currentRecord);
  const upToDate = registered
    && !containsConflicts
    && currentRecord.command === desired.command
    && exactStringArray(currentRecord.args, desired.args)
    && desiredEnvironmentReady;
  if (upToDate) return { next: previous ?? '', registered: true, upToDate: true };

  const nextEntry: Record<string, unknown> = {
    ...currentRecord,
    ...desiredEntry,
  };
  for (const key of JSON_STDIO_CONFLICT_KEYS) delete nextEntry[key];
  if ('enabled' in currentRecord && currentRecord.enabled !== true) delete nextEntry.enabled;
  if (!requireType) delete nextEntry.type;
  if (desired.env) nextEntry.env = { ...currentEnv, ...desired.env };
  servers.vesti = nextEntry;
  return {
    next: `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`,
    registered,
    upToDate: false,
  };
}

const TOML_SECTION = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;
const TOML_VESTI_SECTION = /^mcp_servers\.(?:vesti|"vesti"|'vesti')$/;
const TOML_VESTI_ENV_SECTION = /^mcp_servers\.(?:vesti|"vesti"|'vesti')\.(?:env|"env"|'env')$/;
const TOML_VESTI_PREFIX = /^mcp_servers\.(?:vesti|"vesti"|'vesti')(?:\.|$)/;
const TOML_DOTTED_VESTI_KEY = /^\s*mcp_servers\.(?:vesti|"vesti"|'vesti')(?:\.|\s*=)/;
const TOML_STDIO_CONFLICT_KEYS = new Set([
  'url',
  'transport',
  'type',
  'headers',
  'http_headers',
  'env_http_headers',
  'bearer_token_env_var',
  'auth',
  'oauth',
  'disabled',
]);

function tomlValue(value: string): string {
  return JSON.stringify(slash(value));
}

function codexManualSteps(configPath: string, launch: McpLaunch): string[] {
  const desired = desiredLaunch(launch);
  const steps = [
    `Open ${configPath}.`,
    'Keep every unrelated TOML section and add or update:',
    '[mcp_servers.vesti]',
    `command = ${tomlValue(desired.command)}`,
    `args = [${desired.args.map(tomlValue).join(', ')}]`,
  ];
  if (desired.env) {
    steps.push(
      '[mcp_servers.vesti.env]',
      ...Object.entries(desired.env).map(([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`),
    );
  }
  return steps;
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlAssignmentKey(line: string): string | null {
  const match = line.match(/^\s*(?:([A-Za-z0-9_-]+)|"([^"]+)"|'([^']+)')\s*=/);
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

function tomlSectionEnd(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (TOML_SECTION.test(lines[index])) return index;
  }
  return lines.length;
}

function appendBeforeTrailingBlank(lines: string[], value: string): void {
  let index = lines.length;
  while (index > 1 && !lines[index - 1].trim()) index -= 1;
  lines.splice(index, 0, value);
}

function editCodexRootBlock(block: string[], desired: McpLaunch): ConfigEdit & { block?: string[] } {
  let commandCount = 0;
  let argsCount = 0;
  let commandIndex = -1;
  let argsIndex = -1;
  const nextBlock: string[] = [];
  for (const line of block) {
    const key = tomlAssignmentKey(line);
    if (key === 'command') commandCount += 1;
    if (key === 'args') {
      argsCount += 1;
      if (!/^\s*(?:args|"args"|'args')\s*=\s*\[.*\]\s*(?:#.*)?$/.test(line)) {
        return {
          registered: true,
          upToDate: false,
          error: 'Codex VESTI args use an unsupported multiline TOML form; it was left untouched.',
        };
      }
    }
    if (key && (
      TOML_STDIO_CONFLICT_KEYS.has(key)
      || (key === 'enabled' && !/=\s*true\s*(?:#.*)?$/.test(line))
    )) continue;
    if (key === 'command') commandIndex = nextBlock.length;
    if (key === 'args') argsIndex = nextBlock.length;
    nextBlock.push(line);
  }
  if (commandCount > 1 || argsCount > 1) {
    return {
      registered: true,
      upToDate: false,
      error: 'Codex VESTI section has duplicate command/args keys; it was left untouched.',
    };
  }

  const commandLine = `command = ${tomlValue(desired.command)}`;
  const argsLine = `args = [${desired.args.map(tomlValue).join(', ')}]`;
  if (commandIndex >= 0) nextBlock[commandIndex] = commandLine;
  else appendBeforeTrailingBlank(nextBlock, commandLine);
  if (argsIndex >= 0) nextBlock[argsIndex] = argsLine;
  else appendBeforeTrailingBlank(nextBlock, argsLine);
  return { registered: true, upToDate: false, block: nextBlock };
}

function editCodexEnvBlock(block: string[], environment: Record<string, string>): ConfigEdit & { block?: string[] } {
  const nextBlock = [...block];
  for (const [key, value] of Object.entries(environment)) {
    const indexes = block.flatMap((line, index) => tomlAssignmentKey(line) === key ? [index] : []);
    if (indexes.length > 1) {
      return {
        registered: true,
        upToDate: false,
        error: `Codex VESTI environment section has duplicate ${key} keys; it was left untouched.`,
      };
    }
    const line = `${tomlKey(key)} = ${tomlValue(value)}`;
    if (indexes.length === 1) nextBlock[indexes[0]] = line;
    else appendBeforeTrailingBlank(nextBlock, line);
  }
  return { registered: true, upToDate: false, block: nextBlock };
}

function editCodexConfig(previous: string | null, launch: McpLaunch): ConfigEdit {
  const original = previous ?? '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.replace(/\r\n/g, '\n').split('\n');
  const allSections = lines.flatMap((line, index) => {
    const match = line.match(TOML_SECTION);
    return match ? [{ index, name: match[1].trim() }] : [];
  });
  const sections = allSections.filter(section => TOML_VESTI_SECTION.test(section.name));
  const environmentSections = allSections.filter(section => TOML_VESTI_ENV_SECTION.test(section.name));
  const unsupportedSections = allSections.filter(section => (
    TOML_VESTI_PREFIX.test(section.name)
    && !TOML_VESTI_SECTION.test(section.name)
    && !TOML_VESTI_ENV_SECTION.test(section.name)
  ));
  if (sections.length > 1 || environmentSections.length > 1) {
    return {
      registered: true,
      upToDate: false,
      error: 'Codex config contains duplicate VESTI MCP or environment sections; it was left untouched.',
    };
  }
  if (unsupportedSections.length > 0) {
    return {
      registered: sections.length > 0,
      upToDate: false,
      error: 'Codex config contains unsupported nested VESTI MCP sections; it was left untouched.',
    };
  }
  if (lines.some(line => TOML_DOTTED_VESTI_KEY.test(line))) {
    return {
      registered: sections.length > 0,
      upToDate: false,
      error: 'Codex config contains unsupported dotted or inline VESTI MCP keys; it was left untouched.',
    };
  }

  const desired = desiredLaunch(launch);
  const commandLine = `command = ${tomlValue(desired.command)}`;
  const argsLine = `args = [${desired.args.map(tomlValue).join(', ')}]`;
  if (sections.length === 0) {
    if (environmentSections.length > 0) {
      return {
        registered: true,
        upToDate: false,
        error: 'Codex config has a VESTI environment section without its MCP section; it was left untouched.',
      };
    }
    const trimmed = original.replace(/\s*$/, '');
    const suffix = [
      '[mcp_servers.vesti]',
      commandLine,
      argsLine,
      ...(desired.env
        ? ['', '[mcp_servers.vesti.env]', ...Object.entries(desired.env).map(
          ([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`,
        )]
        : []),
    ].join(eol);
    return {
      next: `${trimmed}${trimmed ? `${eol}${eol}` : ''}${suffix}${eol}`,
      registered: false,
      upToDate: false,
    };
  }

  const start = sections[0].index;
  if (environmentSections.length === 1 && environmentSections[0].index < start) {
    return {
      registered: true,
      upToDate: false,
      error: 'Codex VESTI environment section appears before its MCP section; it was left untouched.',
    };
  }
  const end = tomlSectionEnd(lines, start);
  const rootEdit = editCodexRootBlock(lines.slice(start, end), desired);
  if (rootEdit.error || !rootEdit.block) return rootEdit;

  const replacements: Array<{ start: number; end: number; block: string[] }> = [
    { start, end, block: rootEdit.block },
  ];
  if (desired.env && environmentSections.length === 1) {
    const environmentStart = environmentSections[0].index;
    const environmentEnd = tomlSectionEnd(lines, environmentStart);
    const environmentEdit = editCodexEnvBlock(
      lines.slice(environmentStart, environmentEnd),
      desired.env,
    );
    if (environmentEdit.error || !environmentEdit.block) return environmentEdit;
    replacements.push({ start: environmentStart, end: environmentEnd, block: environmentEdit.block });
  }

  const nextLines = [...lines];
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    nextLines.splice(replacement.start, replacement.end - replacement.start, ...replacement.block);
  }
  if (desired.env && environmentSections.length === 0) {
    const nextRootStart = nextLines.findIndex(line => {
      const match = line.match(TOML_SECTION);
      return Boolean(match && TOML_VESTI_SECTION.test(match[1].trim()));
    });
    const nextRootEnd = tomlSectionEnd(nextLines, nextRootStart);
    nextLines.splice(
      nextRootEnd,
      0,
      '',
      '[mcp_servers.vesti.env]',
      ...Object.entries(desired.env).map(([key, value]) => `${tomlKey(key)} = ${tomlValue(value)}`),
    );
  }
  let next = nextLines.join(eol);
  if (original.endsWith('\n') && !next.endsWith(eol)) next += eol;
  return {
    next,
    registered: true,
    upToDate: next === original,
  };
}

function kimiCodeRoot(homeDir: string, environment: HostEnvironment): string {
  const configured = environment.KIMI_CODE_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homeDir, '.kimi-code');
}

const HOSTS: Record<SetupHost, HostSpec> = {
  codex: {
    host: 'codex',
    label: 'Codex',
    configPath: home => path.join(home, '.codex', 'config.toml'),
    // Codex discovers user Skills from the shared Agent Skills directory.
    skillPath: home => path.join(home, '.agents', 'skills', 'vesti-memory'),
    detected: async home => exists(path.join(home, '.codex')),
    editConfig: editCodexConfig,
  },
  claude: {
    host: 'claude',
    label: 'Claude Code',
    configPath: home => path.join(home, '.claude.json'),
    skillPath: home => path.join(home, '.claude', 'skills', 'vesti-memory'),
    detected: async home => (
      await exists(path.join(home, '.claude')) || await exists(path.join(home, '.claude.json'))
    ),
    editConfig: (previous, launch) => editJsonConfig('Claude Code', previous, launch, true),
  },
  'kimi-code': {
    host: 'kimi-code',
    label: 'Kimi Code',
    configPath: (home, environment) => path.join(kimiCodeRoot(home, environment), 'mcp.json'),
    skillPath: (home, environment) => path.join(kimiCodeRoot(home, environment), 'skills', 'vesti-memory'),
    detected: async (home, environment) => exists(kimiCodeRoot(home, environment)),
    editConfig: (previous, launch) => editJsonConfig('Kimi Code', previous, launch, false),
  },
  cursor: {
    host: 'cursor',
    label: 'Cursor',
    configPath: home => path.join(home, '.cursor', 'mcp.json'),
    skillPath: home => path.join(home, '.cursor', 'skills', 'vesti-memory'),
    detected: async home => exists(path.join(home, '.cursor')),
    editConfig: (previous, launch) => editJsonConfig('Cursor', previous, launch, true),
  },
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function backupStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

async function chmodOnUnix(filePath: string, mode: number): Promise<void> {
  if (process.platform !== 'win32') await fs.chmod(filePath, mode);
}

async function createPrivateBackup(filePath: string, now: Date): Promise<string> {
  const base = `${filePath}.vesti-bak-${backupStamp(now)}`;
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = index === 1 ? base : `${base}-${index}`;
    try {
      await fs.copyFile(filePath, candidate, fsConstants.COPYFILE_EXCL);
      await chmodOnUnix(candidate, 0o600);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`could not allocate a backup path for ${filePath}`);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const missing: string[] = [];
  let cursor = directory;
  while (!await exists(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const created of missing.reverse()) await chmodOnUnix(created, 0o700);
}

async function assertContentUnchanged(filePath: string, previous: string | null): Promise<void> {
  if (await readOptional(filePath) === previous) return;
  throw new Error(
    `${filePath} changed while VESTI was preparing its update; the newer contents were not overwritten.`,
  );
}

export async function persistText(
  filePath: string,
  previous: string | null,
  next: string,
  options: PersistOptions,
): Promise<PersistResult> {
  if (previous === next) return { changed: false };
  if (options.dryRun) return { changed: true };

  await ensurePrivateDirectory(path.dirname(filePath));
  await assertContentUnchanged(filePath, previous);
  const targetMode = previous === null
    ? 0o600
    : (await fs.stat(filePath)).mode & 0o777;
  let backupPath: string | undefined;
  if (previous !== null) {
    backupPath = await createPrivateBackup(filePath, options.now());
    await assertContentUnchanged(filePath, previous);
  }
  const tempPath = `${filePath}.vesti-tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(tempPath, next, { encoding: 'utf8', flag: 'wx', mode: targetMode });
    await chmodOnUnix(tempPath, targetMode);
    await assertContentUnchanged(filePath, previous);
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
  return { changed: true, backupPath };
}

async function assetFiles(root: string): Promise<Array<{ absolute: string; relative: string }>> {
  const output: Array<{ absolute: string; relative: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) output.push({ absolute, relative: path.relative(root, absolute) });
    }
  };
  await visit(root);
  return output;
}

async function inspectSkill(assetDir: string, targetDir: string): Promise<{
  installed: boolean;
  upToDate: boolean;
}> {
  const files = await assetFiles(assetDir);
  if (files.length === 0) return { installed: false, upToDate: false };
  let installed = true;
  let upToDate = true;
  for (const file of files) {
    const desired = await fs.readFile(file.absolute);
    const target = path.join(targetDir, file.relative);
    let actual: Buffer;
    try {
      actual = await fs.readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      installed = false;
      upToDate = false;
      continue;
    }
    if (!actual.equals(desired)) upToDate = false;
  }
  return { installed, upToDate };
}

async function installSkill(
  assetDir: string,
  targetDir: string,
  options: PersistOptions,
): Promise<{ changed: boolean; actions: string[]; backups: string[] }> {
  const files = await assetFiles(assetDir);
  if (files.length === 0) throw new Error(`skill asset is empty: ${assetDir}`);
  let changed = false;
  const actions: string[] = [];
  const backups: string[] = [];
  for (const file of files) {
    const target = path.join(targetDir, file.relative);
    const desired = await fs.readFile(file.absolute, 'utf8');
    const previous = await readOptional(target);
    const result = await persistText(target, previous, desired, options);
    if (!result.changed) continue;
    changed = true;
    actions.push(`${options.dryRun ? 'would install' : 'installed'} ${target}`);
    if (result.backupPath) backups.push(result.backupPath);
  }
  return { changed, actions, backups };
}

function withManualSteps(edit: ConfigEdit, spec: HostSpec, launch: McpLaunch, configPath: string): ConfigEdit {
  if (!edit.error || edit.manualSteps) return edit;
  return {
    ...edit,
    manualSteps: spec.host === 'codex'
      ? codexManualSteps(configPath, launch)
      : jsonManualSteps(configPath, launch, spec.host !== 'kimi-code'),
  };
}

export async function inspectHost(
  host: SetupHost,
  homeDir: string,
  assetDir: string,
  launch: McpLaunch,
  environment: HostEnvironment = {},
): Promise<HostStatus> {
  const spec = HOSTS[host];
  const configPath = spec.configPath(homeDir, environment);
  const skillPath = spec.skillPath(homeDir, environment);
  const previous = await readOptional(configPath);
  const edit = withManualSteps(spec.editConfig(previous, launch), spec, launch, configPath);
  const skill = await inspectSkill(assetDir, skillPath);
  return {
    host,
    label: spec.label,
    detected: await spec.detected(homeDir, environment),
    configPath,
    skillPath,
    registered: edit.registered,
    registrationUpToDate: edit.upToDate,
    skillInstalled: skill.installed,
    skillUpToDate: skill.upToDate,
    error: edit.error,
    manualSteps: edit.manualSteps,
  };
}

export async function installHost(
  host: SetupHost,
  homeDir: string,
  assetDir: string,
  launch: McpLaunch,
  options: PersistOptions,
  environment: HostEnvironment = {},
): Promise<HostInstallResult> {
  const spec = HOSTS[host];
  const configPath = spec.configPath(homeDir, environment);
  const previous = await readOptional(configPath);
  const edit = withManualSteps(spec.editConfig(previous, launch), spec, launch, configPath);
  if (edit.error || edit.next === undefined) {
    return {
      host,
      changed: false,
      actions: [],
      backups: [],
      status: await inspectHost(host, homeDir, assetDir, launch, environment),
    };
  }

  const config = await persistText(configPath, previous, edit.next, options);
  const skill = await installSkill(assetDir, spec.skillPath(homeDir, environment), options);
  const actions = [...skill.actions];
  const backups = [...skill.backups];
  if (config.changed) {
    actions.unshift(`${options.dryRun ? 'would register' : 'registered'} VESTI MCP in ${configPath}`);
    if (config.backupPath) backups.unshift(config.backupPath);
  }
  return {
    host,
    changed: config.changed || skill.changed,
    actions,
    backups,
    status: options.dryRun
      ? await inspectHost(host, homeDir, assetDir, launch, environment)
      : await inspectHost(host, homeDir, assetDir, launch, environment),
  };
}

export function hostConfigPaths(
  host: SetupHost,
  homeDir: string,
  environment: HostEnvironment = {},
): { configPath: string; skillPath: string } {
  const spec = HOSTS[host];
  return {
    configPath: spec.configPath(homeDir, environment),
    skillPath: spec.skillPath(homeDir, environment),
  };
}
