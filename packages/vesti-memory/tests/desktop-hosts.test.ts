import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopConfigRoot, hostConfigPaths, inspectHost, SETUP_HOSTS } from '../src/installer.js';
import { runCli, type CaptureRuntimeClient } from '../src/index.js';

const assetDir = fileURLToPath(new URL('../assets/vesti-memory', import.meta.url));
let homeDir: string;
let mcpEntry: string;
let output: string[];
let ensureCalls: number;
let runtime: CaptureRuntimeClient;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-desktop-setup-'));
  mcpEntry = path.join(homeDir, 'server.js');
  await fs.writeFile(mcpEntry, '// isolated fixture\n');
  output = [];
  ensureCalls = 0;
  runtime = {
    ensure: async () => { ensureCalls += 1; return { state: 'running', initialSyncComplete: true }; },
    status: async () => ({ state: 'running', initialSyncComplete: true }),
    sync: async () => ({ ok: true }),
  };
});

afterEach(async () => { await fs.rm(homeDir, { recursive: true, force: true }); });

function context() {
  return { homeDir, assetDir, mcpEntry, runtime,
    io: { out: (line: string) => output.push(line), error: (line: string) => output.push(line) } };
}

describe('desktop profile paths', () => {
  it.each([
    ['win32', ['AppData', 'Roaming']],
    ['darwin', ['Library', 'Application Support']],
    ['linux', ['.config']],
  ] as const)('resolves %s defaults under the supplied home', (platform, parts) => {
    expect(desktopConfigRoot(homeDir, {}, platform)).toBe(path.join(homeDir, ...parts));
  });

  it('honors OS-specific overrides without leaking them to other platforms', () => {
    const env = { APPDATA: path.join(homeDir, 'roaming'), XDG_CONFIG_HOME: path.join(homeDir, 'xdg') };
    expect(desktopConfigRoot(homeDir, env, 'win32')).toBe(env.APPDATA);
    expect(desktopConfigRoot(homeDir, env, 'linux')).toBe(env.XDG_CONFIG_HOME);
    expect(desktopConfigRoot(homeDir, env, 'darwin')).toBe(path.join(homeDir, 'Library', 'Application Support'));
  });

  it('keeps Qoder IDE and CLI MCP paths separate while sharing their Skill', async () => {
    const ide = hostConfigPaths('qoder', homeDir);
    const cli = hostConfigPaths('qoder-cli', homeDir);
    expect(ide.configPath).toBe(path.join(desktopConfigRoot(homeDir), 'Qoder', 'SharedClientCache', 'mcp.json'));
    expect(cli.configPath).toBe(path.join(homeDir, '.qoder', 'settings.json'));
    expect(ide.skillPath).toBe(cli.skillPath);
    await fs.mkdir(path.join(homeDir, '.qoder', 'skills'), { recursive: true });
    expect((await inspectHost('qoder-cli', homeDir, assetDir, { command: 'node', args: [mcpEntry] })).detected).toBe(false);
  });

  it('keeps Trae editions separate and uses the CN Skill directory for both CN editions', () => {
    for (const [host, product, skillHome] of [
      ['trae', 'Trae', '.trae'], ['trae-cn', 'Trae CN', '.trae-cn'],
      ['trae-solo-cn', 'TRAE SOLO CN', '.trae-cn'],
    ] as const) {
      expect(hostConfigPaths(host, homeDir)).toEqual({
        configPath: path.join(desktopConfigRoot(homeDir), product, 'User', 'mcp.json'),
        skillPath: path.join(homeDir, skillHome, 'skills', 'vesti-memory'),
      });
    }
  });
});

describe('one setup flow for desktop and CLI clients', () => {
  const addedHosts = ['qoder', 'qoder-cli', 'workbuddy', 'trae', 'trae-cn', 'trae-solo-cn'] as const;

  async function profiles() {
    for (const host of addedHosts) {
      const { configPath } = hostConfigPaths(host, homeDir);
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ keep: host, mcpServers: { other: { command: 'other' } } }));
    }
  }

  it('detects all new profiles, installs both components, and starts one runtime', async () => {
    await profiles();
    expect(await runCli(['setup'], context())).toBe(0);
    expect(ensureCalls).toBe(1);
    for (const host of addedHosts) {
      const { configPath, skillPath } = hostConfigPaths(host, homeDir);
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      expect(config.keep).toBe(host);
      expect(config.mcpServers.other).toEqual({ command: 'other' });
      expect(config.mcpServers.vesti.args).toEqual([mcpEntry.replace(/\\/g, '/')]);
      expect(await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf8')).toBe(await fs.readFile(path.join(assetDir, 'SKILL.md'), 'utf8'));
    }
    expect(await fs.stat(path.join(homeDir, '.codex')).catch(() => null)).toBeNull();
    output = [];
    expect(await runCli(['setup'], context())).toBe(0);
    expect(output.filter(line => line.includes('already up to date'))).toHaveLength(addedHosts.length);
    await fs.mkdir(path.join(homeDir, '.vesti', 'db'), { recursive: true });
    await fs.writeFile(path.join(homeDir, '.vesti', 'db', 'vesti.db'), 'fixture');
    expect(await runCli(['doctor'], context())).toBe(0);
    expect(output.join('\n')).toContain('configured hosts: Qoder, Qoder CLI, WorkBuddy, Trae, Trae CN, TRAE SOLO CN');
    output = [];
    expect(await runCli(['status'], context())).toBe(0);
    expect(output.filter(line => line.includes('Skill='))).toHaveLength(SETUP_HOSTS.length);
  });

  it('previews all new profiles without modifying configs or starting capture', async () => {
    await profiles();
    const before = await Promise.all(addedHosts.map(host => fs.readFile(hostConfigPaths(host, homeDir).configPath, 'utf8')));
    expect(await runCli(['setup', '--dry-run'], context())).toBe(0);
    expect(ensureCalls).toBe(0);
    expect(await Promise.all(addedHosts.map(host => fs.readFile(hostConfigPaths(host, homeDir).configPath, 'utf8')))).toEqual(before);
    for (const host of addedHosts) expect(await fs.stat(hostConfigPaths(host, homeDir).skillPath).catch(() => null)).toBeNull();
  });

  it.each(addedHosts)('allows explicit %s setup before automatic detection', async host => {
    expect(await runCli(['setup', '--host', host], context())).toBe(0);
    expect(ensureCalls).toBe(1);
    const status = await inspectHost(host, homeDir, assetDir, { command: process.execPath, args: [mcpEntry] });
    expect(status.registrationUpToDate && status.skillUpToDate).toBe(true);
  });
});
