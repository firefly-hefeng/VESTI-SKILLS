import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli, type CaptureRuntimeClient, type CliIo } from '../src/index.js';

const ASSET_DIR = fileURLToPath(new URL('../assets/vesti-memory', import.meta.url));

let homeDir: string;
let mcpEntry: string;
let output: string[];
let errors: string[];
let io: CliIo;
let ensureCalls: number;
let syncReasons: Array<string | undefined>;
let runtime: CaptureRuntimeClient;

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-memory-cli-'));
  mcpEntry = path.join(homeDir, 'package', 'vesti-mcp', 'cli.js');
  await fs.mkdir(path.dirname(mcpEntry), { recursive: true });
  await fs.writeFile(mcpEntry, '// mcp fixture\n', 'utf8');
  output = [];
  errors = [];
  io = {
    out: message => output.push(message),
    error: message => errors.push(message),
  };
  ensureCalls = 0;
  syncReasons = [];
  runtime = {
    ensure: async () => {
      ensureCalls += 1;
      return { state: 'running', initialSyncComplete: true };
    },
    status: async () => ({ state: 'running', initialSyncComplete: true }),
    sync: async reason => {
      syncReasons.push(reason);
      return { ok: true, sessionsProcessed: 3 };
    },
  };
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe('setup dry-run', () => {
  it('selects only detected hosts for --host all and performs no writes or daemon start', async () => {
    await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true });

    const code = await runCli(['setup', '--host', 'all', '--dry-run'], {
      homeDir,
      assetDir: ASSET_DIR,
      mcpEntry,
      nodeCommand: 'C:\\node\\node.exe',
      runtime,
      io,
    });

    expect(code).toBe(0);
    expect(ensureCalls).toBe(0);
    expect(output.join('\n')).toContain('would register');
    expect(output.join('\n')).toContain('dry-run');
    expect(await exists(path.join(homeDir, '.codex', 'config.toml'))).toBe(false);
    expect(await exists(path.join(homeDir, '.agents', 'skills', 'vesti-memory'))).toBe(false);
    expect(await exists(path.join(homeDir, '.claude.json'))).toBe(false);
    expect(await exists(path.join(homeDir, '.kimi-code'))).toBe(false);
    expect(await exists(path.join(homeDir, '.cursor'))).toBe(false);
  });

  it('does not guess a host when --host all detects none', async () => {
    const code = await runCli(['setup', '--host', 'all', '--dry-run'], {
      homeDir,
      assetDir: ASSET_DIR,
      mcpEntry,
      runtime,
      io,
    });

    expect(code).toBe(1);
    expect(ensureCalls).toBe(0);
    expect(errors.join('\n')).toContain('No supported client was detected');
    expect(await fs.readdir(homeDir)).toEqual(['package']);
  });

  it('allows an explicit undetected host while remaining write-free', async () => {
    const code = await runCli(['setup', '--host', 'claude-code', '--dry-run'], {
      homeDir,
      assetDir: ASSET_DIR,
      mcpEntry,
      runtime,
      io,
    });

    expect(code).toBe(0);
    expect(output.join('\n')).toContain('would register');
    expect(await exists(path.join(homeDir, '.claude.json'))).toBe(false);
    expect(await exists(path.join(homeDir, '.claude'))).toBe(false);
  });
});

describe('persistent setup', () => {
  it('uses KIMI_CODE_HOME and writes explicit stable VESTI paths into the host MCP environment', async () => {
    const kimiHome = path.join(homeDir, 'kimi-custom');
    const kimiHomeInput = path.relative(process.cwd(), kimiHome);
    const vestiHome = path.join(homeDir, 'persistent-vesti-home');
    const dbPath = path.join(homeDir, 'persistent-db', 'vesti.db');
    const dataDir = path.join(homeDir, 'persistent-data');
    const code = await runCli(['setup', '--host', 'kimi-code'], {
      homeDir,
      assetDir: ASSET_DIR,
      mcpEntry,
      nodeCommand: 'C:\\node\\node.exe',
      runtime,
      io,
      env: {
        KIMI_CODE_HOME: kimiHomeInput,
        VESTI_HOME: vestiHome,
        VESTI_DB_PATH: dbPath,
        VESTI_DATA_DIR: dataDir,
      },
    });

    expect(code).toBe(0);
    expect(ensureCalls).toBe(1);
    expect(await exists(path.join(kimiHome, 'skills', 'vesti-memory', 'SKILL.md'))).toBe(true);
    const config = JSON.parse(await fs.readFile(path.join(kimiHome, 'mcp.json'), 'utf8')) as Record<string, any>;
    expect(config.mcpServers.vesti).not.toHaveProperty('type');
    expect(config.mcpServers.vesti.env).toEqual({
      VESTI_HOME: vestiHome.replace(/\\/g, '/'),
      VESTI_DB_PATH: dbPath.replace(/\\/g, '/'),
      VESTI_DATA_DIR: dataDir.replace(/\\/g, '/'),
      KIMI_CODE_HOME: kimiHome.replace(/\\/g, '/'),
    });
    expect(await exists(path.join(homeDir, '.kimi-code'))).toBe(false);
  });

  it('refuses to persist an MCP executable from npm temporary _npx cache', async () => {
    const cachedEntry = path.join(
      homeDir,
      '.npm',
      '_npx',
      'temporary-hash',
      'node_modules',
      '@vesti',
      'mcp',
      'dist',
      'cli.js',
    );
    await fs.mkdir(path.dirname(cachedEntry), { recursive: true });
    await fs.writeFile(cachedEntry, '// temporary npx entry\n', 'utf8');

    const code = await runCli(['setup', '--host', 'codex'], {
      homeDir,
      assetDir: ASSET_DIR,
      mcpEntry: cachedEntry,
      runtime,
      io,
    });

    expect(code).toBe(1);
    expect(ensureCalls).toBe(0);
    expect(errors.join('\n')).toContain('temporary _npx cache');
    expect(errors.join('\n')).toContain('npm install -g @vesti/memory');
    expect(await exists(path.join(homeDir, '.codex', 'config.toml'))).toBe(false);
    expect(await exists(path.join(homeDir, '.agents', 'skills', 'vesti-memory'))).toBe(false);
  });

  it('reports the same temporary _npx blocker during dry-run without writing anything', async () => {
    const cachedEntry = path.join(
      homeDir,
      '_npx',
      'temporary-hash',
      'node_modules',
      '@vesti',
      'mcp',
      'dist',
      'cli.js',
    );
    await fs.mkdir(path.dirname(cachedEntry), { recursive: true });
    await fs.writeFile(cachedEntry, '// temporary npx entry\n', 'utf8');

    const code = await runCli(['setup', '--host', 'codex', '--dry-run'], {
      homeDir,
      assetDir: ASSET_DIR,
      mcpEntry: cachedEntry,
      runtime,
      io,
    });

    expect(code).toBe(1);
    expect(ensureCalls).toBe(0);
    expect(errors.join('\n')).toContain('dry-run: persistent setup would refuse');
    expect(output).toEqual([]);
    expect(await exists(path.join(homeDir, '.codex'))).toBe(false);
    expect(await exists(path.join(homeDir, '.agents'))).toBe(false);
  });
});

describe('runtime commands', () => {
  it('sync forwards an explicit manual reason to the runtime client', async () => {
    const code = await runCli(['sync'], { homeDir, runtime, io, mcpEntry, assetDir: ASSET_DIR });
    expect(code).toBe(0);
    expect(syncReasons).toEqual(['vesti-cli-manual']);
    expect(output.join('\n')).toContain('sessionsProcessed');
  });

  it('sync --dry-run does not contact the runtime', async () => {
    const code = await runCli(['sync', '--dry-run'], {
      homeDir,
      runtime,
      io,
      mcpEntry,
      assetDir: ASSET_DIR,
    });
    expect(code).toBe(0);
    expect(syncReasons).toEqual([]);
    expect(ensureCalls).toBe(0);
    expect(output.join('\n')).toContain('would ensure');
  });
});
