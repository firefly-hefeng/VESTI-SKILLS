import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hostConfigPaths,
  inspectHost,
  installHost,
  persistText,
  type McpLaunch,
  type SetupHost,
} from '../src/installer.js';

const ASSET_DIR = fileURLToPath(new URL('../assets/vesti-memory', import.meta.url));
const FIXED_NOW = new Date('2026-09-07T02:03:04.005Z');

let homeDir: string;
let mcpEntry: string;
let launch: McpLaunch;

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupFiles(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory, { recursive: true }))
      .map(value => String(value))
      .filter(value => value.includes('.vesti-bak-'));
  } catch {
    return [];
  }
}

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-memory-installer-'));
  mcpEntry = path.join(homeDir, 'runtime', 'vesti-mcp', 'cli.js');
  await fs.mkdir(path.dirname(mcpEntry), { recursive: true });
  await fs.writeFile(mcpEntry, '// fixture MCP entry\n', 'utf8');
  launch = {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [mcpEntry],
  };
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe('Codex TOML registration', () => {
  it('uses Codex config.toml and the shared Agent Skills directory', () => {
    expect(hostConfigPaths('codex', homeDir)).toEqual({
      configPath: path.join(homeDir, '.codex', 'config.toml'),
      skillPath: path.join(homeDir, '.agents', 'skills', 'vesti-memory'),
    });
  });

  it('updates only the anchored VESTI section, preserves other keys/comments, backs up, and is idempotent', async () => {
    const { configPath, skillPath } = hostConfigPaths('codex', homeDir);
    const original = [
      '# user comment must survive',
      'model = "gpt-test"',
      '',
      '[mcp_servers.other]',
      'command = "other-server"',
      'args = ["--keep"]',
      '',
      '[mcp_servers.vesti]',
      '# VESTI-local option must survive',
      'command = "C:/old/node.exe"',
      'args = ["C:/old/vesti.js"]',
      'startup_timeout_sec = 42',
      '',
      '[windows]',
      'sandbox = "restricted"',
      '',
    ].join('\r\n');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, original, 'utf8');

    const first = await installHost('codex', homeDir, ASSET_DIR, launch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });

    expect(first.changed).toBe(true);
    expect(first.status.error).toBeUndefined();
    expect(first.status.registrationUpToDate).toBe(true);
    expect(first.status.skillUpToDate).toBe(true);
    expect(first.backups).toHaveLength(1);
    expect(await fs.readFile(first.backups[0], 'utf8')).toBe(original);
    expect(await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf8'))
      .toBe(await fs.readFile(path.join(ASSET_DIR, 'SKILL.md'), 'utf8'));

    const updated = await fs.readFile(configPath, 'utf8');
    expect(updated).toContain('# user comment must survive');
    expect(updated).toContain('[mcp_servers.other]');
    expect(updated).toContain('args = ["--keep"]');
    expect(updated).toContain('# VESTI-local option must survive');
    expect(updated).toContain('startup_timeout_sec = 42');
    expect(updated).toContain('[windows]');
    expect(updated).toContain('sandbox = "restricted"');
    expect(updated).toContain('command = "C:/Program Files/nodejs/node.exe"');
    expect(updated).toContain(`args = ["${mcpEntry.replace(/\\/g, '/')}"]`);
    expect(updated).not.toContain('C:/old/vesti.js');

    const backupsAfterFirstRun = await backupFiles(homeDir);
    const second = await installHost('codex', homeDir, ASSET_DIR, launch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });
    expect(second.changed).toBe(false);
    expect(second.backups).toEqual([]);
    expect(await fs.readFile(configPath, 'utf8')).toBe(updated);
    expect(await backupFiles(homeDir)).toEqual(backupsAfterFirstRun);
  });

  it('backs up and replaces an outdated installed Skill without deleting unrelated files', async () => {
    const { skillPath } = hostConfigPaths('codex', homeDir);
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(path.join(skillPath, 'SKILL.md'), 'old skill\n', 'utf8');
    await fs.writeFile(path.join(skillPath, 'user-note.txt'), 'keep me\n', 'utf8');

    const result = await installHost('codex', homeDir, ASSET_DIR, launch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });

    const skillBackup = result.backups.find(value => value.includes('SKILL.md.vesti-bak-'));
    expect(skillBackup).toBeDefined();
    expect(await fs.readFile(skillBackup!, 'utf8')).toBe('old skill\n');
    expect(await fs.readFile(path.join(skillPath, 'user-note.txt'), 'utf8')).toBe('keep me\n');
    expect(await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf8'))
      .toBe(await fs.readFile(path.join(ASSET_DIR, 'SKILL.md'), 'utf8'));
  });

  it('removes remote/disabled fields, persists VESTI paths in env, and preserves unrelated TOML', async () => {
    const { configPath } = hostConfigPaths('codex', homeDir);
    const configuredLaunch: McpLaunch = {
      ...launch,
      env: {
        VESTI_HOME: path.join(homeDir, 'stable-home'),
        VESTI_DB_PATH: path.join(homeDir, 'stable-home', 'db', 'memory.db'),
        VESTI_DATA_DIR: path.join(homeDir, 'stable-data'),
        KIMI_CODE_HOME: path.join(homeDir, 'stable-kimi-home'),
      },
    };
    const original = [
      '[mcp_servers.vesti]',
      'command = "old-node"',
      'args = ["old-server"]',
      'url = "https://remote.invalid/mcp"',
      'transport = "sse"',
      'http_headers = { Authorization = "secret" }',
      'disabled = true',
      'enabled = false',
      'startup_timeout_sec = 27',
      '',
      '[mcp_servers.vesti.env]',
      'OTHER_VALUE = "keep"',
      'VESTI_HOME = "old-home"',
      '',
      '[mcp_servers.other]',
      'command = "keep-other"',
      '',
    ].join('\n');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, original, 'utf8');

    const first = await installHost('codex', homeDir, ASSET_DIR, configuredLaunch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });
    expect(first.status.registrationUpToDate).toBe(true);
    const updated = await fs.readFile(configPath, 'utf8');
    expect(updated).not.toMatch(/^\s*(?:url|transport|http_headers|disabled|enabled)\s*=/m);
    expect(updated).toContain('startup_timeout_sec = 27');
    expect(updated).toContain('OTHER_VALUE = "keep"');
    for (const [key, value] of Object.entries(configuredLaunch.env!)) {
      expect(updated).toContain(`${key} = "${value.replace(/\\/g, '/')}"`);
    }
    expect(updated).toContain('[mcp_servers.other]');
    expect(updated).toContain('command = "keep-other"');

    const backups = await backupFiles(homeDir);
    const second = await installHost('codex', homeDir, ASSET_DIR, configuredLaunch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });
    expect(second.changed).toBe(false);
    expect(await fs.readFile(configPath, 'utf8')).toBe(updated);
    expect(await backupFiles(homeDir)).toEqual(backups);
  });

  it.each([
    ['duplicate sections', [
      '[mcp_servers.vesti]',
      'command = "one"',
      'args = ["one"]',
      '[mcp_servers.vesti]',
      'command = "two"',
      'args = ["two"]',
      '',
    ].join('\n')],
    ['multiline args', [
      '[mcp_servers.vesti]',
      'command = "node"',
      'args = [',
      '  "server.js",',
      ']',
      '',
    ].join('\n')],
    ['nested remote section', [
      '[mcp_servers.vesti]',
      'command = "node"',
      'args = ["server.js"]',
      '[mcp_servers.vesti.oauth]',
      'client_id = "do-not-guess"',
      '',
    ].join('\n')],
  ])('refuses ambiguous %s and leaves it byte-for-byte unchanged', async (_label, original) => {
    const { configPath, skillPath } = hostConfigPaths('codex', homeDir);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, original, 'utf8');

    const result = await installHost('codex', homeDir, ASSET_DIR, launch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });

    expect(result.changed).toBe(false);
    expect(result.status.error).toBeTruthy();
    expect(result.status.manualSteps?.join('\n')).toContain('[mcp_servers.vesti]');
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
    expect(await exists(skillPath)).toBe(false);
    expect(await backupFiles(homeDir)).toEqual([]);
  });
});

describe('JSON MCP registration', () => {
  const jsonHosts: Array<{ host: SetupHost; label: string; expectedType?: string }> = [
    { host: 'claude', label: 'Claude Code', expectedType: 'stdio' },
    { host: 'kimi-code', label: 'Kimi Code' },
    { host: 'cursor', label: 'Cursor', expectedType: 'stdio' },
    { host: 'qoder', label: 'Qoder' },
    { host: 'qoder-cli', label: 'Qoder CLI', expectedType: 'stdio' },
    { host: 'workbuddy', label: 'WorkBuddy' },
    { host: 'trae', label: 'Trae' },
    { host: 'trae-cn', label: 'Trae CN' },
    { host: 'trae-solo-cn', label: 'TRAE SOLO CN' },
  ];

  it.each(jsonHosts)('merge-preserves $label config, backs it up, and is idempotent', async ({ host, expectedType }) => {
    const { configPath } = hostConfigPaths(host, homeDir);
    const originalObject = {
      theme: 'keep-this-setting',
      nested: { untouched: [1, 2, 3] },
      mcpServers: {
        other: { command: 'other', args: ['--keep'], env: { KEEP: 'yes' } },
        vesti: { command: 'old-node', args: ['old-server'], env: { USER_VALUE: 'preserve' } },
      },
    };
    const original = `${JSON.stringify(originalObject, null, 4)}\n`;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, original, 'utf8');

    const first = await installHost(host, homeDir, ASSET_DIR, launch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });

    expect(first.changed).toBe(true);
    expect(first.status.error).toBeUndefined();
    expect(first.status.registrationUpToDate).toBe(true);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as typeof originalObject;
    expect(config.theme).toBe(originalObject.theme);
    expect(config.nested).toEqual(originalObject.nested);
    expect(config.mcpServers.other).toEqual(originalObject.mcpServers.other);
    expect(config.mcpServers.vesti.env).toEqual({ USER_VALUE: 'preserve' });
    expect(config.mcpServers.vesti.command).toBe('C:/Program Files/nodejs/node.exe');
    expect(config.mcpServers.vesti.args).toEqual([mcpEntry.replace(/\\/g, '/')]);
    if (expectedType) expect(config.mcpServers.vesti.type).toBe(expectedType);
    else expect(config.mcpServers.vesti).not.toHaveProperty('type');
    const configBackup = first.backups.find(value => value.startsWith(`${configPath}.vesti-bak-`));
    expect(configBackup).toBeDefined();
    expect(await fs.readFile(configBackup!, 'utf8')).toBe(original);

    const afterFirstRun = await fs.readFile(configPath, 'utf8');
    const backupsAfterFirstRun = await backupFiles(homeDir);
    const second = await installHost(host, homeDir, ASSET_DIR, launch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });
    expect(second.changed).toBe(false);
    expect(second.backups).toEqual([]);
    expect(await fs.readFile(configPath, 'utf8')).toBe(afterFirstRun);
    expect(await backupFiles(homeDir)).toEqual(backupsAfterFirstRun);
  });

  it.each(jsonHosts)('refuses invalid $label JSON without backup or overwrite', async ({ host }) => {
    const { configPath, skillPath } = hostConfigPaths(host, homeDir);
    const invalid = '{ "mcpServers": { this is not valid JSON }';
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, invalid, 'utf8');

    const result = await installHost(host, homeDir, ASSET_DIR, launch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });

    expect(result.changed).toBe(false);
    expect(result.status.error).toContain('not valid JSON');
    expect(result.status.manualSteps?.join('\n')).toContain('"mcpServers"');
    expect(await fs.readFile(configPath, 'utf8')).toBe(invalid);
    expect(await exists(skillPath)).toBe(false);
    expect(await backupFiles(homeDir)).toEqual([]);
  });

  it.each(jsonHosts)('normalizes conflicting $label entries and does not accept malformed args as ready', async ({ host, expectedType }) => {
    const { configPath } = hostConfigPaths(host, homeDir);
    const configuredLaunch: McpLaunch = {
      ...launch,
      env: {
        VESTI_HOME: path.join(homeDir, 'stable-home'),
        VESTI_DB_PATH: path.join(homeDir, 'stable-home', 'db', 'memory.db'),
        VESTI_DATA_DIR: path.join(homeDir, 'stable-data'),
        KIMI_CODE_HOME: path.join(homeDir, 'stable-kimi-home'),
      },
    };
    const desiredEntry = mcpEntry.replace(/\\/g, '/');
    const original = {
      keep: { nested: true },
      mcpServers: {
        other: { url: 'https://other.invalid/mcp', disabled: true },
        vesti: {
          type: expectedType ? 'sse' : 'stdio',
          command: 'C:/Program Files/nodejs/node.exe',
          args: [desiredEntry, 42],
          url: 'https://remote.invalid/mcp',
          transport: 'sse',
          headers: { Authorization: 'secret' },
          disabled: true,
          enabled: false,
          cwd: '/keep/cwd',
          env: { OTHER_VALUE: 'keep', VESTI_HOME: 'old-home' },
        },
      },
    };
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

    const before = await inspectHost(host, homeDir, ASSET_DIR, configuredLaunch);
    expect(before.registered).toBe(true);
    expect(before.registrationUpToDate).toBe(false);

    const first = await installHost(host, homeDir, ASSET_DIR, configuredLaunch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });
    expect(first.status.registrationUpToDate).toBe(true);
    const updatedText = await fs.readFile(configPath, 'utf8');
    const updated = JSON.parse(updatedText) as Record<string, any>;
    expect(updated.keep).toEqual(original.keep);
    expect(updated.mcpServers.other).toEqual(original.mcpServers.other);
    expect(updated.mcpServers.vesti).toMatchObject({
      command: 'C:/Program Files/nodejs/node.exe',
      args: [desiredEntry],
      cwd: '/keep/cwd',
      env: {
        OTHER_VALUE: 'keep',
        ...Object.fromEntries(Object.entries(configuredLaunch.env!).map(
          ([key, value]) => [key, value.replace(/\\/g, '/')],
        )),
      },
    });
    for (const key of ['url', 'transport', 'headers', 'disabled', 'enabled']) {
      expect(updated.mcpServers.vesti).not.toHaveProperty(key);
    }
    if (expectedType) expect(updated.mcpServers.vesti.type).toBe('stdio');
    else expect(updated.mcpServers.vesti).not.toHaveProperty('type');

    const backups = await backupFiles(homeDir);
    const second = await installHost(host, homeDir, ASSET_DIR, configuredLaunch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });
    expect(second.changed).toBe(false);
    expect(await fs.readFile(configPath, 'utf8')).toBe(updatedText);
    expect(await backupFiles(homeDir)).toEqual(backups);
  });

  it('does not report an otherwise current entry as ready when args contains a non-string value', async () => {
    const { configPath } = hostConfigPaths('claude', homeDir);
    const entry = mcpEntry.replace(/\\/g, '/');
    await fs.writeFile(configPath, `${JSON.stringify({
      mcpServers: {
        vesti: {
          type: 'stdio',
          command: 'C:/Program Files/nodejs/node.exe',
          args: [entry, 42],
        },
      },
    }, null, 2)}\n`, 'utf8');

    const status = await inspectHost('claude', homeDir, ASSET_DIR, launch);
    expect(status.registered).toBe(true);
    expect(status.registrationUpToDate).toBe(false);
  });

  it('refuses a non-object mcpServers field rather than replacing user data', async () => {
    const { configPath } = hostConfigPaths('claude', homeDir);
    const original = '{"mcpServers":["do-not-replace"],"other":"keep"}\n';
    await fs.writeFile(configPath, original, 'utf8');

    const result = await installHost('claude', homeDir, ASSET_DIR, launch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });

    expect(result.changed).toBe(false);
    expect(result.status.error).toContain('is not an object');
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
  });
});

describe('inspection', () => {
  it('reports a clean install as current without changing files', async () => {
    await installHost('kimi-code', homeDir, ASSET_DIR, launch, {
      dryRun: false,
      now: () => FIXED_NOW,
    });
    const before = await backupFiles(homeDir);
    const status = await inspectHost('kimi-code', homeDir, ASSET_DIR, launch);
    expect(status).toMatchObject({
      host: 'kimi-code',
      registered: true,
      registrationUpToDate: true,
      skillInstalled: true,
      skillUpToDate: true,
    });
    expect(await backupFiles(homeDir)).toEqual(before);
  });
});

describe('host paths and safe persistence', () => {
  it('uses KIMI_CODE_HOME for both Kimi config and Skill paths', () => {
    const customRoot = path.join(homeDir, 'custom-kimi-home');
    expect(hostConfigPaths('kimi-code', homeDir, { KIMI_CODE_HOME: customRoot })).toEqual({
      configPath: path.join(customRoot, 'mcp.json'),
      skillPath: path.join(customRoot, 'skills', 'vesti-memory'),
    });
  });

  it('rejects a stale previous snapshot without overwriting concurrent contents', async () => {
    const target = path.join(homeDir, 'concurrent', 'config.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'newer contents\n', 'utf8');

    await expect(persistText(target, 'stale contents\n', 'vesti contents\n', {
      dryRun: false,
      now: () => FIXED_NOW,
    })).rejects.toThrow('changed while VESTI was preparing');
    expect(await fs.readFile(target, 'utf8')).toBe('newer contents\n');
    expect(await backupFiles(homeDir)).toEqual([]);
  });

  it('never overwrites a backup name claimed by another process', async () => {
    const target = path.join(homeDir, 'backup-race', 'config.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'old\n', 'utf8');
    const claimed = `${target}.vesti-bak-2026-09-07T02-03-04-005Z`;
    await fs.writeFile(claimed, 'claimed by another writer\n', 'utf8');

    const result = await persistText(target, 'old\n', 'new\n', {
      dryRun: false,
      now: () => FIXED_NOW,
    });
    expect(await fs.readFile(claimed, 'utf8')).toBe('claimed by another writer\n');
    expect(result.backupPath).toBe(`${claimed}-2`);
    expect(await fs.readFile(result.backupPath!, 'utf8')).toBe('old\n');
  });

  if (process.platform !== 'win32') {
    it('preserves existing mode and creates private files, backups, and directories', async () => {
      const existing = path.join(homeDir, 'existing', 'config.toml');
      await fs.mkdir(path.dirname(existing), { recursive: true });
      await fs.writeFile(existing, 'old\n', { encoding: 'utf8', mode: 0o640 });
      await fs.chmod(existing, 0o640);
      const existingResult = await persistText(existing, 'old\n', 'new\n', {
        dryRun: false,
        now: () => FIXED_NOW,
      });
      expect((await fs.stat(existing)).mode & 0o777).toBe(0o640);
      expect(existingResult.backupPath).toBeTruthy();
      expect((await fs.stat(existingResult.backupPath!)).mode & 0o777).toBe(0o600);

      const created = path.join(homeDir, 'private-parent', 'private-child', 'config.json');
      await persistText(created, null, 'new\n', {
        dryRun: false,
        now: () => FIXED_NOW,
      });
      expect((await fs.stat(created)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(created))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.dirname(path.dirname(created)))).mode & 0o777).toBe(0o700);
    });
  }
});
