import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterManager } from '../src/adapters/AdapterManager.js';
import { CoderAdapter } from '../src/adapters/coder/adapter.js';
import { CoderParser } from '../src/adapters/coder/parser.js';
import { TraeAdapter } from '../src/adapters/trae/adapter.js';
import { TraeParser } from '../src/adapters/trae/parser.js';
import { WorkBuddyAdapter } from '../src/adapters/workbuddy/adapter.js';
import { WorkBuddyParser } from '../src/adapters/workbuddy/parser.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

/** Point native user-data resolution at a temp dir for the duration of fn. */
async function withConfigEnv<T>(base: string, fn: () => Promise<T>): Promise<T> {
  const saved = {
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.APPDATA = base;
  process.env.XDG_CONFIG_HOME = base;
  try {
    return await fn();
  } finally {
    if (saved.APPDATA === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = saved.APPDATA;
    if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
  }
}

function createTraeDb(file: string, value: unknown): void {
  fs.ensureDirSync(path.dirname(file));
  const db = new Database(file);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  if (value !== undefined) {
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('memento/icube-ai-agent-storage', typeof value === 'string' ? value : JSON.stringify(value));
  }
  db.close();
}

const traeStore = {
  list: [
    {
      sessionId: 'trae-session-1',
      createdAt: 1780000000000,
      updatedAt: 1780000060000,
      model: 'doubao-pro',
      messages: [
        { role: 'user', content: 'refactor the parser', timestamp: 1780000000000 },
        { role: 'assistant', content: 'sure, splitting it into modules', timestamp: 1780000010000, model: 'doubao-pro' },
        { role: 'user', content: 'now add tests', timestamp: 1780000020000 },
        // Empty content: the assistant reply only lives in agentTaskContent.
        { role: 'assistant', content: '', agentTaskContent: { content: 'tests added' }, timestamp: 1780000030000 },
        // A non-text role must be ignored, not fatal.
        { role: 'system', content: 'internal note', timestamp: 1780000040000 },
      ],
    },
    {
      // Empty session: no usable messages, must be skipped.
      sessionId: 'trae-empty',
      createdAt: 1780000100000,
      messages: [{ role: 'user', content: '   ', timestamp: 1780000100000 }],
    },
  ],
};

describe('trae adapter', () => {
  it('reports not installed when no Trae user dirs exist', async () => {
    const base = await makeTempDir('vesti-trae-missing-');
    const home = await makeTempDir('vesti-trae-home-');
    await withConfigEnv(base, async () => {
      const adapter = new TraeAdapter();
      adapter.setHomeRoots([{ host: 'native', homeDir: home }]);
      expect(await adapter.detect()).toEqual({ installed: false });
      expect(await adapter.getSessionFiles()).toEqual([]);
    });
  });

  it('parses multi-turn sessions from global and workspace state.vscdb', async () => {
    const base = await makeTempDir('vesti-trae-appdata-');
    const home = await makeTempDir('vesti-trae-home-');
    const userDir = path.join(base, 'Trae', 'User');

    createTraeDb(path.join(userDir, 'globalStorage', 'state.vscdb'), traeStore);
    const wsDir = path.join(userDir, 'workspaceStorage', 'abc123');
    createTraeDb(path.join(wsDir, 'state.vscdb'), traeStore);
    await fs.writeJSON(path.join(wsDir, 'workspace.json'), { folder: 'file:///c%3A/work/demo' });

    await withConfigEnv(base, async () => {
      const adapter = new TraeAdapter();
      adapter.setHomeRoots([{ host: 'native', homeDir: home }]);

      const detected = await adapter.detect();
      expect(detected.installed).toBe(true);
      expect(detected.sessionCount).toBe(4); // 2 dbs x 2 raw list entries

      const files = await adapter.getSessionFiles();
      expect(files).toHaveLength(2);

      const globalSessions = await adapter.parseSessions(path.join(userDir, 'globalStorage', 'state.vscdb'));
      expect(globalSessions).toHaveLength(1); // the empty session is skipped
      const session = globalSessions[0];
      expect(session.sessionId).toBe('trae-session-1');
      expect(session.platform).toBe('trae');
      expect(session.projectPath).toBe(''); // global db has no workspace
      expect(session.model).toBe('doubao-pro');
      expect(session.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(session.messages[3].contentText).toBe('tests added'); // agentTaskContent fallback
      expect(session.messages[0].timestamp).toBe(1780000000000);
      expect(session.meta?.first_prompt).toBe('refactor the parser');

      const wsSessions = await adapter.parseSessions(path.join(wsDir, 'state.vscdb'));
      expect(wsSessions).toHaveLength(1);
      expect(wsSessions[0].projectPath).toBe('c:/work/demo'); // from workspace.json
    });
  });

  it('returns no sessions for a db without the storage key or with corrupt JSON', async () => {
    const base = await makeTempDir('vesti-trae-corrupt-');
    const noKeyDb = path.join(base, 'nokey.vscdb');
    createTraeDb(noKeyDb, undefined);
    const corruptDb = path.join(base, 'corrupt.vscdb');
    createTraeDb(corruptDb, '{not valid json');

    const parser = new TraeParser();
    expect(await parser.parseDatabase(noKeyDb)).toEqual([]);
    expect(await parser.parseDatabase(corruptDb)).toEqual([]);
    await expect(parser.parseDatabase(path.join(base, 'missing.vscdb'))).rejects.toThrow();
  });

  it('detect() survives a state.vscdb that is not a SQLite file', async () => {
    const base = await makeTempDir('vesti-trae-broken-');
    const home = await makeTempDir('vesti-trae-home-');
    const userDir = path.join(base, 'Trae CN', 'User');
    await fs.ensureDir(path.join(userDir, 'globalStorage'));
    await fs.writeFile(path.join(userDir, 'globalStorage', 'state.vscdb'), 'garbage');

    await withConfigEnv(base, async () => {
      const adapter = new TraeAdapter();
      adapter.setHomeRoots([{ host: 'native', homeDir: home }]);
      const detected = await adapter.detect();
      expect(detected.installed).toBe(true);
      expect(detected.sessionCount).toBe(0);
      await expect(adapter.parseSessions(path.join(userDir, 'globalStorage', 'state.vscdb'))).rejects.toThrow();
    });
  });
});

const coderLines = [
  { type: 'user', uuid: 'u1', timestamp: '2026-08-01T01:00:00Z', cwd: 'C:/work/demo', message: { role: 'user', content: 'inspect this repo' } },
  {
    type: 'assistant', uuid: 'u2', parentUuid: 'u1', timestamp: '2026-08-01T01:00:05Z', cwd: 'C:/work/demo',
    message: {
      role: 'assistant', model: 'qwen3-coder-plus',
      content: [
        { type: 'text', text: 'let me look' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ],
      usage: { input_tokens: 120, output_tokens: 30 },
    },
  },
  { type: 'user', uuid: 'u3', parentUuid: 'u2', timestamp: '2026-08-01T01:00:07Z', cwd: 'C:/work/demo', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'src\npackage.json' }] } },
  {
    type: 'assistant', uuid: 'u4', parentUuid: 'u3', timestamp: '2026-08-01T01:00:10Z', cwd: 'C:/work/demo',
    message: { role: 'assistant', model: 'qwen3-coder-plus', content: [{ type: 'text', text: 'a small repo' }], usage: { input_tokens: 200, output_tokens: 10 } },
  },
];

describe('coder adapter (Qoder)', () => {
  it('reports not installed when no Qoder project dirs exist', async () => {
    const base = await makeTempDir('vesti-coder-missing-');
    const home = await makeTempDir('vesti-coder-home-');
    await withConfigEnv(base, async () => {
      const adapter = new CoderAdapter();
      adapter.setHomeRoots([{ host: 'native', homeDir: home }]);
      expect(await adapter.detect()).toEqual({ installed: false });
      expect(await adapter.getSessionFiles()).toEqual([]);
    });
  });

  it('parses Claude-format sessions with tools, usage, sidecar title and subagent lineage', async () => {
    const base = await makeTempDir('vesti-coder-appdata-');
    const home = await makeTempDir('vesti-coder-home-');
    const projectDir = path.join(home, '.qoder', 'projects', '-C-work-demo');
    const sessionFile = path.join(projectDir, 'sess-1.jsonl');
    await fs.ensureDir(projectDir);
    await fs.writeFile(sessionFile, coderLines.map(line => JSON.stringify(line)).join('\n'));
    await fs.writeJSON(path.join(projectDir, 'sess-1-session.json'), { title: 'Repo inspection', working_dir: 'C:/work/demo' });

    const subDir = path.join(projectDir, 'sess-1', 'subagents');
    await fs.ensureDir(subDir);
    await fs.writeFile(path.join(subDir, 'agent-9.jsonl'), JSON.stringify(coderLines[0]));

    await withConfigEnv(base, async () => {
      const adapter = new CoderAdapter();
      adapter.setHomeRoots([{ host: 'native', homeDir: home }]);

      const detected = await adapter.detect();
      expect(detected.installed).toBe(true);
      expect(detected.sessionCount).toBe(2);

      const session = await adapter.parseSession(sessionFile);
      expect(session.sessionId).toBe('sess-1');
      expect(session.platform).toBe('coder');
      expect(session.projectPath).toBe('C:/work/demo');
      expect(session.model).toBe('qwen3-coder-plus');
      expect(session.meta?.session_title).toBe('Repo inspection');
      expect(session.messages).toHaveLength(4);
      expect(session.messages[1].toolCalls).toEqual([{ id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }]);
      expect(session.messages[2].isToolResult).toBe(true);
      expect(session.tokenUsage.totalInputTokens).toBe(320);
      expect(session.tokenUsage.totalOutputTokens).toBe(40);
      expect(session.toolExecutions.map(t => t.toolName)).toEqual(['Bash']);
      expect(session.subagents.map(s => s.agentId)).toEqual(['9']);

      const child = await adapter.parseSession(path.join(subDir, 'agent-9.jsonl'));
      expect(child.sessionId).toBe('sess-1--agent-9');
      expect(child.subagentOf).toEqual({
        parentSessionId: 'coder:sess-1',
        agentId: '9',
      });
    });
  });

  it('discovers sessions in the SharedClientCache flat layout', async () => {
    const base = await makeTempDir('vesti-coder-scc-');
    const home = await makeTempDir('vesti-coder-home-');
    const flatDir = path.join(base, 'Qoder', 'SharedClientCache', 'cli', 'projects');
    await fs.ensureDir(flatDir);
    await fs.writeFile(path.join(flatDir, 'flat-1.jsonl'), JSON.stringify(coderLines[0]));

    await withConfigEnv(base, async () => {
      const adapter = new CoderAdapter();
      adapter.setHomeRoots([{ host: 'native', homeDir: home }]);
      expect(await adapter.getSessionFiles()).toHaveLength(1);
      const session = await adapter.parseSession(path.join(flatDir, 'flat-1.jsonl'));
      expect(session.sessionId).toBe('flat-1');
      expect(session.subagentOf).toBeUndefined();
    });
  });

  it('tolerates corrupt and empty session files', async () => {
    const dir = await makeTempDir('vesti-coder-corrupt-');
    const corruptFile = path.join(dir, 'broken.jsonl');
    await fs.writeFile(corruptFile, 'not json\n{"type":"user",');
    const parser = new CoderParser();
    const corrupt = await parser.parseFile(corruptFile);
    expect(corrupt.messages).toHaveLength(0); // graceful, not fatal

    const emptyFile = path.join(dir, 'empty.jsonl');
    await fs.writeFile(emptyFile, '');
    const empty = await parser.parseFile(emptyFile);
    expect(empty.messages).toHaveLength(0);
  });
});

const workBuddyLines = [
  { type: 'message', role: 'user', content: 'build a report', timestamp: 1780000000000, cwd: 'C:/work/demo' },
  {
    type: 'function_call', name: 'shell', callId: 'call-1', arguments: '{"cmd":"ls"}', timestamp: 1780000001000,
    providerData: { model: 'hunyuan-pro', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 } },
  },
  { type: 'function_call_result', callId: 'call-1', output: { text: 'file.xlsx' }, timestamp: 1780000002000 },
  {
    type: 'message', role: 'assistant', content: [{ text: 'report built' }], timestamp: 1780000003000,
    // prompt_tokens totals include the cached share; the parser subtracts it.
    providerData: { model: 'hunyuan-pro', usage: { prompt_tokens: 150, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 50 } } },
  },
];

describe('workbuddy adapter', () => {
  it('reports not installed when no .workbuddy/projects dir exists', async () => {
    const home = await makeTempDir('vesti-wb-missing-');
    const adapter = new WorkBuddyAdapter();
    adapter.setHomeRoots([{ host: 'native', homeDir: home }]);
    expect(await adapter.detect()).toEqual({ installed: false });
    expect(await adapter.getSessionFiles()).toEqual([]);
  });

  it('parses multi-turn sessions with tool calls, results and normalized usage', async () => {
    const home = await makeTempDir('vesti-wb-home-');
    const projectDir = path.join(home, '.workbuddy', 'projects', 'demo');
    const sessionFile = path.join(projectDir, 'wb-1.jsonl');
    await fs.ensureDir(projectDir);
    await fs.writeFile(sessionFile, workBuddyLines.map(line => JSON.stringify(line)).join('\n'));

    const subDir = path.join(projectDir, 'wb-1', 'subagents');
    await fs.ensureDir(subDir);
    await fs.writeFile(path.join(subDir, 'agent-a.jsonl'), JSON.stringify(workBuddyLines[0]));

    const adapter = new WorkBuddyAdapter();
    adapter.setHomeRoots([{ host: 'native', homeDir: home }]);

    const detected = await adapter.detect();
    expect(detected.installed).toBe(true);
    expect(detected.sessionCount).toBe(2);

    const session = await adapter.parseSession(sessionFile);
    expect(session.sessionId).toBe('wb-1');
    expect(session.platform).toBe('workbuddy');
    expect(session.projectPath).toBe('C:/work/demo');
    expect(session.messages).toHaveLength(4);
    expect(session.messages[0].contentText).toBe('build a report');
    expect(session.messages[1].toolCalls).toEqual([{ id: 'call-1', name: 'shell', input: { cmd: 'ls' } }]);
    expect(session.messages[2].isToolResult).toBe(true);
    expect(session.messages[2].toolResults).toEqual([{ toolUseId: 'call-1', content: 'file.xlsx' }]);
    expect(session.messages[3].contentText).toBe('report built');

    expect(session.toolExecutions).toHaveLength(1);
    expect(session.toolExecutions[0].toolName).toBe('shell');
    expect(session.toolExecutions[0].outputSummary).toBe('file.xlsx');

    // 100 + (150-50) input, 20+30 output, 40+50 cache-read
    expect(session.tokenUsage.totalInputTokens).toBe(200);
    expect(session.tokenUsage.totalOutputTokens).toBe(50);
    expect(session.tokenUsage.totalCacheReadTokens).toBe(90);
    expect([...session.tokenUsage.models]).toEqual(['hunyuan-pro']);
    expect(session.meta?.first_prompt).toBe('build a report');
    expect(session.subagents.map(s => s.agentId)).toEqual(['agent-a']);

    const child = await adapter.parseSession(path.join(subDir, 'agent-a.jsonl'));
    expect(child.sessionId).toBe('wb-1--agent-a');
    expect(child.subagentOf).toEqual({
      parentSessionId: 'workbuddy:wb-1',
      agentId: 'agent-a',
    });
  });

  it('skips malformed lines with a warning instead of failing', async () => {
    const dir = await makeTempDir('vesti-wb-corrupt-');
    const file = path.join(dir, 'wb-2.jsonl');
    await fs.writeFile(file, [
      'garbage line',
      JSON.stringify(workBuddyLines[0]),
      '{"type":"message",',
    ].join('\n'));

    const parser = new WorkBuddyParser();
    const session = await parser.parseFile(file);
    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(1);
    expect(session!.meta?.malformed_lines).toBe(2);
    expect(session!.warnings?.[0]).toContain('2 malformed');
  });

  it('returns null for empty sessions so the adapter throws cleanly', async () => {
    const dir = await makeTempDir('vesti-wb-empty-');
    const file = path.join(dir, 'wb-empty.jsonl');
    // An empty-content message carries no conversational payload.
    await fs.writeFile(file, JSON.stringify({ type: 'message', role: 'user', content: '  ', timestamp: 1780000000000 }));

    const parser = new WorkBuddyParser();
    expect(await parser.parseFile(file)).toBeNull();

    const adapter = new WorkBuddyAdapter();
    await expect(adapter.parseSession(file)).rejects.toThrow('No WorkBuddy conversation');
  });
});

describe('adapter manager registration', () => {
  it('registers trae, coder and workbuddy adapters', async () => {
    const manager = new AdapterManager();
    expect(manager.getAdapter('trae')?.name).toBe('Trae');
    expect(manager.getAdapter('coder')?.name).toBe('Qoder');
    expect(manager.getAdapter('workbuddy')?.name).toBe('WorkBuddy');
    const detected = await manager.detectAll();
    expect(detected.has('trae')).toBe(true);
    expect(detected.has('coder')).toBe(true);
    expect(detected.has('workbuddy')).toBe(true);
  });
});
