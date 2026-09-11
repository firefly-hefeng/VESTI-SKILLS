import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

import {
  inspectHost,
  installHost,
  SETUP_HOSTS,
  type HostStatus,
  type McpLaunch,
  type SetupHost,
} from './installer.js';
import {
  daemonLooksReady,
  loadCaptureRuntimeClient,
  type CaptureRuntimeClient,
} from './runtime.js';

export type { CaptureRuntimeClient, CaptureRuntimeConnectionOptions } from './runtime.js';
export type { HostEnvironment, HostInstallResult, HostStatus, McpLaunch, SetupHost } from './installer.js';
export { daemonLooksReady, inspectHost, installHost, loadCaptureRuntimeClient };

export interface CliIo {
  out(message: string): void;
  error(message: string): void;
}

export interface CliContext {
  homeDir?: string;
  assetDir?: string;
  mcpEntry?: string | null;
  nodeCommand?: string;
  runtime?: CaptureRuntimeClient;
  io?: CliIo;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
}

interface ResolvedContext {
  homeDir: string;
  assetDir: string;
  mcpEntry: string | null;
  nodeCommand: string;
  runtime?: CaptureRuntimeClient;
  io: CliIo;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
}

interface ParsedCli {
  command: 'setup' | 'status' | 'sync' | 'doctor' | 'help';
  host: SetupHost | 'all';
  dryRun: boolean;
}

const HELP = `VESTI standalone memory

Usage:
  vesti setup [--host ${SETUP_HOSTS.join('|')}|all] [--dry-run]
  vesti status
  vesti sync [--dry-run]
  vesti doctor

Commands:
  setup   Install the bundled vesti-memory Skill, register the stdio MCP,
          and start the capture daemon for the target database.
  status  Show Skill, MCP, database and capture-daemon status.
  sync    Ask the capture daemon to scan all supported sources now.
  doctor  Validate the installation and return a non-zero code on problems.

No command installs an operating-system startup task. Re-running setup is safe.`;

function defaultIo(): CliIo {
  return {
    out: message => console.log(message),
    error: message => console.error(message),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function packageRoot(): string {
  return fileURLToPath(new URL('../', import.meta.url));
}

function resolveMcpEntry(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.VESTI_MCP_SERVER_PATH?.trim();
  if (explicit) return path.resolve(explicit);
  try {
    return fileURLToPath(import.meta.resolve('@vesti/mcp/cli'));
  } catch {
    const sibling = path.resolve(packageRoot(), '..', 'vesti-mcp', 'dist', 'cli.js');
    return sibling;
  }
}

function resolveContext(input: CliContext): ResolvedContext {
  // An explicitly isolated home must not discover/write real desktop profiles.
  const env = input.env ?? (input.homeDir ? {} : process.env);
  return {
    homeDir: input.homeDir ?? os.homedir(),
    assetDir: input.assetDir ?? path.join(packageRoot(), 'assets', 'vesti-memory'),
    mcpEntry: input.mcpEntry === undefined ? resolveMcpEntry(env) : input.mcpEntry,
    nodeCommand: input.nodeCommand ?? process.execPath,
    runtime: input.runtime,
    io: input.io ?? defaultIo(),
    now: input.now ?? (() => new Date()),
    env,
    nodeVersion: input.nodeVersion ?? process.versions.node,
  };
}

function parseCli(argv: string[]): ParsedCli {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    return { command: 'help', host: 'all', dryRun: false };
  }
  const command = argv[0];
  if (!['setup', 'status', 'sync', 'doctor'].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  let host: ParsedCli['host'] = 'all';
  let dryRun = false;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (value === '--host') {
      const selected = argv[++index];
      const aliases: Record<string, ParsedCli['host']> = {
        ...Object.fromEntries(SETUP_HOSTS.map(value => [value, value])),
        codex: 'codex',
        claude: 'claude',
        'claude-code': 'claude',
        kimi: 'kimi-code',
        'kimi-code': 'kimi-code',
        cursor: 'cursor',
        all: 'all',
      };
      if (!selected || !aliases[selected]) {
        throw new Error(`--host must be ${SETUP_HOSTS.join(', ')}, or all`);
      }
      host = aliases[selected];
      continue;
    }
    throw new Error(`unknown option: ${value}`);
  }
  if (host !== 'all' && command !== 'setup') {
    throw new Error('--host is only valid with setup');
  }
  return { command: command as ParsedCli['command'], host, dryRun };
}

function selectedHosts(host: ParsedCli['host']): SetupHost[] {
  if (host === 'all') return [...SETUP_HOSTS];
  return [host];
}

function statusLine(status: HostStatus): string {
  const skill = status.skillUpToDate ? 'ready' : status.skillInstalled ? 'outdated' : 'missing';
  const mcp = status.registrationUpToDate ? 'ready' : status.registered ? 'outdated' : 'missing';
  return `${status.label}: Skill=${skill}, MCP=${mcp}, detected=${status.detected ? 'yes' : 'no'}`;
}

function captureDbPath(context: ResolvedContext): string {
  const explicitDb = context.env.VESTI_DB_PATH?.trim();
  if (explicitDb) return path.resolve(explicitDb);
  const dataHome = context.env.VESTI_HOME?.trim() || context.env.VESTI_DATA_DIR?.trim();
  return path.resolve(dataHome || path.join(context.homeDir, '.vesti'), 'db', 'vesti.db');
}

function persistentMcpEnvironment(context: ResolvedContext): Record<string, string> | undefined {
  const environment: Record<string, string> = {};
  for (const key of ['VESTI_HOME', 'VESTI_DB_PATH', 'VESTI_DATA_DIR', 'KIMI_CODE_HOME'] as const) {
    const value = context.env[key]?.trim();
    if (value) environment[key] = path.resolve(value);
  }
  return Object.keys(environment).length > 0 ? environment : undefined;
}

function mcpLaunch(context: ResolvedContext): McpLaunch {
  const environment = persistentMcpEnvironment(context);
  return {
    command: context.nodeCommand,
    args: context.mcpEntry ? [context.mcpEntry] : [],
    ...(environment ? { env: environment } : {}),
  };
}

function isNpxCachePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return /(?:^|\/)_npx\/[^/]+\/node_modules(?:\/|$)/i.test(normalized);
}

function printManual(status: HostStatus, io: CliIo): void {
  if (status.error) io.error(`${status.label}: ${status.error}`);
  if (status.manualSteps?.length) {
    io.error(`${status.label}: manual registration steps:`);
    for (const line of status.manualSteps) io.error(`  ${line}`);
  }
}

async function runtimeFor(context: ResolvedContext): Promise<CaptureRuntimeClient> {
  return context.runtime ?? loadCaptureRuntimeClient({
    dbPath: captureDbPath(context),
    env: context.env,
    homeDir: context.homeDir,
  });
}

async function commandSetup(parsed: ParsedCli, context: ResolvedContext): Promise<number> {
  if (!await exists(context.assetDir)) {
    context.io.error(`Bundled Skill asset is missing: ${context.assetDir}`);
    return 1;
  }
  if (!context.mcpEntry || !await exists(context.mcpEntry)) {
    context.io.error(`VESTI MCP entry is missing: ${context.mcpEntry ?? '(unresolved)'}`);
    context.io.error('Install/build @vesti/mcp, then run `vesti setup` again.');
    return 1;
  }
  if (isNpxCachePath(context.mcpEntry)) {
    context.io.error(
      `${parsed.dryRun ? 'dry-run: persistent setup would refuse' : 'Refusing to save'} `
      + 'an MCP path from npm\'s temporary _npx cache.',
    );
    context.io.error('Install persistently with `npm install -g @vesti/memory`, then run `vesti setup` again.');
    return 1;
  }

  const launch = mcpLaunch(context);
  let hosts = selectedHosts(parsed.host);
  if (parsed.host === 'all') {
    const statuses = await Promise.all(hosts.map(host => (
      inspectHost(host, context.homeDir, context.assetDir, launch, context.env)
    )));
    hosts = statuses.filter(status => status.detected).map(status => status.host);
    if (hosts.length === 0) {
      context.io.error(
        `No supported client was detected. Use --host ${SETUP_HOSTS.join(', ')} to install explicitly.`,
      );
      return 1;
    }
  }
  let failed = false;
  for (const host of hosts) {
    const result = await installHost(host, context.homeDir, context.assetDir, launch, {
      dryRun: parsed.dryRun,
      now: context.now,
    }, context.env);
    if (result.actions.length === 0 && !result.status.error) {
      context.io.out(`${result.status.label}: already up to date.`);
    } else {
      for (const action of result.actions) context.io.out(action);
    }
    for (const backup of result.backups) context.io.out(`backup: ${backup}`);
    if (result.status.error) {
      failed = true;
      printManual(result.status, context.io);
    }
  }

  if (parsed.dryRun) {
    context.io.out('dry-run: capture daemon would be initialized and started.');
    return failed ? 1 : 0;
  }
  try {
    const runtime = await runtimeFor(context);
    await runtime.ensure();
    context.io.out('Capture daemon: ready.');
  } catch (error) {
    failed = true;
    context.io.error(`Capture daemon: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failed ? 1 : 0;
}

async function collectStatuses(context: ResolvedContext): Promise<HostStatus[]> {
  const launch = mcpLaunch(context);
  return Promise.all(SETUP_HOSTS.map(host => (
    inspectHost(host, context.homeDir, context.assetDir, launch, context.env)
  )));
}

function renderRuntimeStatus(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'unavailable';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function commandStatus(context: ResolvedContext): Promise<number> {
  context.io.out(`Home: ${context.homeDir}`);
  context.io.out(`MCP entry: ${context.mcpEntry ?? 'unresolved'}`);
  for (const status of await collectStatuses(context)) {
    context.io.out(statusLine(status));
    if (status.error) printManual(status, context.io);
  }
  const dbPath = captureDbPath(context);
  context.io.out(`Database: ${await exists(dbPath) ? dbPath : `missing (${dbPath})`}`);
  try {
    const runtime = await runtimeFor(context);
    const status = await runtime.status();
    context.io.out(`Capture daemon: ${renderRuntimeStatus(status)}`);
  } catch (error) {
    context.io.error(`Capture daemon: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}

async function commandSync(parsed: ParsedCli, context: ResolvedContext): Promise<number> {
  if (parsed.dryRun) {
    context.io.out('dry-run: would ensure the capture daemon and request a full incremental sync.');
    return 0;
  }
  try {
    const runtime = await runtimeFor(context);
    const result = await runtime.sync('vesti-cli-manual');
    context.io.out(`Sync complete: ${renderRuntimeStatus(result)}`);
    return 0;
  } catch (error) {
    context.io.error(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function nodeVersionSupported(version: string): boolean {
  const [major, minor] = version.split('.').map(value => Number.parseInt(value, 10));
  return major > 22 || (major === 22 && minor >= 12);
}

async function commandDoctor(context: ResolvedContext): Promise<number> {
  const checks: Array<{ ok: boolean; message: string }> = [];
  checks.push({
    ok: nodeVersionSupported(context.nodeVersion),
    message: `Node.js ${context.nodeVersion} (requires >=22.12.0)`,
  });
  checks.push({
    ok: await exists(context.assetDir),
    message: `bundled Skill asset at ${context.assetDir}`,
  });
  checks.push({
    ok: Boolean(context.mcpEntry && await exists(context.mcpEntry)),
    message: `MCP entry at ${context.mcpEntry ?? '(unresolved)'}`,
  });

  const statuses = await collectStatuses(context);
  const configured = statuses.filter(status => status.registrationUpToDate && status.skillUpToDate);
  checks.push({
    ok: configured.length > 0,
    message: configured.length
      ? `configured hosts: ${configured.map(status => status.label).join(', ')}`
      : 'at least one host has both the current Skill and MCP registration',
  });
  for (const status of statuses.filter(item => item.detected && item.error)) {
    checks.push({ ok: false, message: `${status.label} config: ${status.error}` });
    printManual(status, context.io);
  }

  const dbPath = captureDbPath(context);
  checks.push({ ok: await exists(dbPath), message: `capture database at ${dbPath}` });
  try {
    const runtime = await runtimeFor(context);
    const daemonStatus = await runtime.status();
    checks.push({
      ok: daemonLooksReady(daemonStatus),
      message: `capture daemon status: ${renderRuntimeStatus(daemonStatus)}`,
    });
  } catch (error) {
    checks.push({
      ok: false,
      message: `capture daemon client: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  for (const check of checks) context.io.out(`${check.ok ? 'PASS' : 'FAIL'}  ${check.message}`);
  const failures = checks.filter(check => !check.ok).length;
  context.io.out(failures === 0 ? 'VESTI memory is ready.' : `${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

export async function runCli(argv: string[], input: CliContext = {}): Promise<number> {
  const context = resolveContext(input);
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    context.io.error(error instanceof Error ? error.message : String(error));
    context.io.error(HELP);
    return 2;
  }
  if (parsed.command === 'help') {
    context.io.out(HELP);
    return 0;
  }
  if (parsed.command === 'setup') return commandSetup(parsed, context);
  if (parsed.command === 'status') return commandStatus(context);
  if (parsed.command === 'sync') return commandSync(parsed, context);
  return commandDoctor(context);
}
