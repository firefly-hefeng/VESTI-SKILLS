/**
 * WSL Detection Tests
 * Pure-function coverage: wsl.exe output decoding/parsing (UTF-16LE with
 * and without BOM, default markers incl. localized "(默认)", headers,
 * empty output), UNC path assembly and host/id derivation. The detector
 * class itself runs against injected fakes — no real WSL required.
 * Also covers the native-vs-WSL session id disambiguation strategy.
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeWslOutput,
  parseWslDistroList,
  wslDistroRoot,
  WslDetector,
} from '../src/platform/WslDetector.js';
import {
  hostFromPath,
  normalizeWslIdentitySegment,
  normalizeWslUserIdentitySegment,
  rewriteSessionIdForHost,
  wslHostTag,
} from '../src/platform/PathResolver.js';
import { MessageConverter } from '../src/storage/MessageConverter.js';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { AdapterManager } from '../src/adapters/AdapterManager.js';
import type { ParsedSession } from '../src/types/agent.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

describe('decodeWslOutput', () => {
  it('decodes UTF-16LE without BOM (the usual wsl.exe output)', () => {
    const buf = Buffer.from('Ubuntu\r\nDebian\r\n', 'utf16le');
    expect(decodeWslOutput(buf)).toBe('Ubuntu\r\nDebian\r\n');
  });

  it('decodes UTF-16LE with BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Ubuntu\n', 'utf16le')]);
    expect(decodeWslOutput(buf)).toBe('Ubuntu\n');
  });

  it('decodes plain UTF-8/ASCII', () => {
    expect(decodeWslOutput(Buffer.from('Ubuntu\n', 'utf8'))).toBe('Ubuntu\n');
  });

  it('handles an empty buffer', () => {
    expect(decodeWslOutput(Buffer.alloc(0))).toBe('');
  });
});

describe('parseWslDistroList', () => {
  it('parses multiple distros with CRLF endings', () => {
    expect(parseWslDistroList('Ubuntu\r\nDebian\r\ndocker-desktop\r\n')).toEqual(['Ubuntu', 'Debian', 'docker-desktop']);
  });

  it('strips "(Default)" and localized "(默认)" markers', () => {
    expect(parseWslDistroList('Ubuntu (Default)\nDebian (默认)\n')).toEqual(['Ubuntu', 'Debian']);
  });

  it('drops header lines and blank lines', () => {
    const output = '适用于 Linux 的 Windows 子系统分发：\r\nUbuntu\r\n\r\n';
    expect(parseWslDistroList(output)).toEqual(['Ubuntu']);
  });

  it('tolerates NUL padding from mis-decoded UTF-16', () => {
    expect(parseWslDistroList('Ubuntu\0\0\r\n')).toEqual(['Ubuntu']);
  });

  it('returns an empty list for empty or whitespace output', () => {
    expect(parseWslDistroList('')).toEqual([]);
    expect(parseWslDistroList('\r\n \r\n')).toEqual([]);
  });

  it('deduplicates repeated names', () => {
    expect(parseWslDistroList('Ubuntu\nUbuntu\n')).toEqual(['Ubuntu']);
  });
});

describe('UNC path helpers', () => {
  it('builds the distro filesystem root for both share variants', () => {
    expect(wslDistroRoot('Ubuntu')).toBe('\\\\wsl$\\Ubuntu');
    expect(wslDistroRoot('Ubuntu', 'wsl.localhost')).toBe('\\\\wsl.localhost\\Ubuntu');
  });

  it('derives canonical per-user WSL hosts from UNC session paths', () => {
    expect(hostFromPath('\\\\wsl$\\Ubuntu\\home\\alice\\.codex\\sessions\\x.jsonl')).toBe('wsl:ubuntu:alice');
    expect(hostFromPath('\\\\wsl.localhost\\Debian\\root\\.kimi\\sessions\\h\\u\\wire.jsonl')).toBe('wsl:debian:root');
    // forward-slash tolerant
    expect(hostFromPath('//wsl$/Ubuntu/home/alice/.claude/projects/p/s.jsonl')).toBe('wsl:ubuntu:alice');
    // glob uppercases UNC roots on Windows — the tag must not follow
    expect(hostFromPath('\\\\WSL$\\UBUNTU\\home\\alice\\.codex\\sessions\\x.jsonl')).toBe('wsl:ubuntu:alice');
  });

  it('maps native paths to the native host', () => {
    expect(hostFromPath('C:\\Users\\alice\\.codex\\sessions\\x.jsonl')).toBe('native');
    expect(hostFromPath('/home/alice/.codex/sessions/x.jsonl')).toBe('native');
  });

  it('keeps same-distro users distinct without case or Unicode folding', () => {
    expect(hostFromPath('\\\\wsl$\\Ubuntu\\home\\Alice\\.codex\\sessions\\x.jsonl')).toBe('wsl:ubuntu:~41lice');
    expect(hostFromPath('\\\\wsl$\\Ubuntu\\home\\alice\\.codex\\sessions\\x.jsonl')).toBe('wsl:ubuntu:alice');
    expect(wslHostTag('UBUNTU', 'Alice')).toBe('wsl:ubuntu:~41lice');
    expect(normalizeWslUserIdentitySegment('\u00c5')).not.toBe(normalizeWslUserIdentitySegment('\u212b'));
    expect(normalizeWslUserIdentitySegment('alice')).not.toBe(normalizeWslUserIdentitySegment(' alice '));
    // Distro share names are intentionally case-insensitive.
    expect(normalizeWslIdentitySegment('Ubuntu')).toBe(normalizeWslIdentitySegment('UBUNTU'));
  });

  it('gives adapters the exact same host tags derived from their UNC files', () => {
    const manager = new AdapterManager();
    manager.setWslHomes([
      { distro: 'Ubuntu', user: 'Alice', homeUnc: '\\\\wsl$\\Ubuntu\\home\\Alice' },
      { distro: 'Ubuntu', user: 'alice', homeUnc: '\\\\wsl$\\Ubuntu\\home\\alice' },
    ]);
    const codex = manager.getAdapter('codex') as unknown as { homes: Array<{ host: string }> };
    expect(codex.homes.map(home => home.host)).toContain('wsl:ubuntu:~41lice');
    expect(codex.homes.map(home => home.host)).toContain('wsl:ubuntu:alice');
    expect(codex.homes.map(home => home.host)).toContain(
      hostFromPath('\\\\wsl$\\Ubuntu\\home\\Alice\\.codex\\sessions\\x.jsonl'),
    );
  });
});

describe('session id disambiguation', () => {
  it('keeps native session ids unchanged', () => {
    expect(rewriteSessionIdForHost('abc-123', 'native')).toBe('abc-123');
  });

  it('prefixes canonical WSL session ids with an unambiguous user boundary', () => {
    expect(rewriteSessionIdForHost('abc-123', 'wsl:ubuntu:alice')).toBe('wsl-ubuntu~zalice-abc-123');
  });

  it('sanitizes distro names so ids stay IPC-safe', () => {
    expect(rewriteSessionIdForHost('abc', 'wsl:Ubuntu 22.04')).toBe('wsl-Ubuntu-22.04-abc');
  });

  it('does not lose a distro/user boundary when either contains hyphens', () => {
    const first = rewriteSessionIdForHost('same', 'wsl:foo-bar:baz');
    const second = rewriteSessionIdForHost('same', 'wsl:foo:bar-baz');
    expect(first).toBe('wsl-foo-bar~zbaz-same');
    expect(second).toBe('wsl-foo~zbar-baz-same');
    expect(first).not.toBe(second);
  });

  it('stores the same sessionId from native and WSL as two distinct sessions', async () => {
    const dir = await makeTempDir('vesti-wsl-id-');
    const db = new DatabaseManager(path.join(dir, 'vesti.db'));
    await db.initialize();

    const base: ParsedSession = {
      sessionId: 'shared-session',
      platform: 'codex',
      projectPath: '/work/demo',
      messages: [{
        uuid: 'm1',
        type: 'user',
        role: 'user',
        timestamp: 1_752_541_200_000,
        contentText: 'hello from both hosts',
        isToolResult: false,
        depth: 0,
      }],
      toolExecutions: [],
      subagents: [],
      tokenUsage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: 0,
        models: new Set<string>(),
      },
      startTime: 1_752_541_200_000,
    };

    // What SyncEngine does per file: tag host, rewrite WSL session ids.
    const native = { ...base, host: 'native' };
    const wsl = { ...base, host: 'wsl:ubuntu:alice', sessionId: rewriteSessionIdForHost(base.sessionId, 'wsl:ubuntu:alice') };

    const nativeConverted = MessageConverter.convertV2(native);
    const wslConverted = MessageConverter.convertV2(wsl);

    expect(nativeConverted.session.id).toBe('codex:shared-session');
    expect(nativeConverted.session.host).toBe('native');
    expect(wslConverted.session.id).toBe('codex:wsl-ubuntu~zalice-shared-session');
    expect(wslConverted.session.host).toBe('wsl:ubuntu:alice');
    // Messages follow the rewritten session id so the chains never mix.
    expect(wslConverted.messages[0].sessionId).toBe('codex:wsl-ubuntu~zalice-shared-session');

    db.upsertWorkSession(nativeConverted.session);
    db.upsertWorkSession(wslConverted.session);

    expect(db.getWorkSession('codex:shared-session')?.host).toBe('native');
    expect(db.getWorkSession('codex:wsl-ubuntu~zalice-shared-session')?.host).toBe('wsl:ubuntu:alice');
    expect(db.listWorkSessions({ platform: 'codex' })).toHaveLength(2);

    await db.close();
  });
});

describe('WslDetector (injected fakes)', () => {
  const utf16 = (text: string) => Buffer.from(text, 'utf16le');

  it('returns empty on non-Windows platforms', async () => {
    const detector = new WslDetector({ platform: 'linux' });
    const result = await detector.detect();
    expect(result).toEqual({ supported: false, distros: [], homes: [] });
  });

  it('returns empty silently when wsl.exe fails', async () => {
    const detector = new WslDetector({
      platform: 'win32',
      runWslList: () => Promise.reject(new Error('wsl.exe not found')),
    });
    const result = await detector.detect();
    expect(result).toEqual({ supported: true, distros: [], homes: [] });
  });

  it('assembles homes and platform roots from UNC probes', async () => {
    const existing = new Set([
      '\\\\wsl$\\Ubuntu\\home\\alice\\.codex\\sessions',
      '\\\\wsl$\\Ubuntu\\home\\alice\\.claude\\projects',
      '\\\\wsl$\\Ubuntu\\home\\alice\\.kimi-code\\sessions',
      '\\\\wsl$\\Ubuntu\\root',
      '\\\\wsl$\\Ubuntu\\root\\.kimi\\sessions',
      '\\\\wsl$\\Debian\\home\\bob\\.aider.chat.history.md',
    ]);
    const dirs = new Map<string, string[]>([
      ['\\\\wsl$\\Ubuntu\\home', ['alice']],
      ['\\\\wsl$\\Debian\\home', ['bob']],
    ]);
    const detector = new WslDetector({
      platform: 'win32',
      runWslList: () => Promise.resolve(utf16('Ubuntu\r\nDebian\r\n')),
      pathExists: p => Promise.resolve(existing.has(p)),
      readDir: p => {
        const entries = dirs.get(p);
        return entries ? Promise.resolve(entries) : Promise.reject(new Error('unreachable'));
      },
    });

    const result = await detector.detect();

    expect(result.supported).toBe(true);
    expect(result.distros).toEqual(['Ubuntu', 'Debian']);
    expect(result.homes).toHaveLength(3);
    const alice = result.homes.find(h => h.user === 'alice')!;
    expect(alice.distro).toBe('Ubuntu');
    expect(alice.homeUnc).toBe('\\\\wsl$\\Ubuntu\\home\\alice');
    expect(alice.roots.codex).toBe('\\\\wsl$\\Ubuntu\\home\\alice\\.codex\\sessions');
    expect(alice.roots['claude-code']).toBe('\\\\wsl$\\Ubuntu\\home\\alice\\.claude\\projects');
    expect(alice.roots['kimi-code']).toBe('\\\\wsl$\\Ubuntu\\home\\alice\\.kimi-code\\sessions');
    const rootHome = result.homes.find(h => h.user === 'root')!;
    expect(rootHome.homeUnc).toBe('\\\\wsl$\\Ubuntu\\root');
    // legacy ~/.kimi remains a valid fallback marker
    expect(rootHome.roots['kimi-code']).toBe('\\\\wsl$\\Ubuntu\\root\\.kimi\\sessions');
    const bob = result.homes.find(h => h.user === 'bob')!;
    expect(bob.roots.aider).toBe('\\\\wsl$\\Debian\\home\\bob\\.aider.chat.history.md');
  });

  it('falls back to \\\\wsl.localhost when \\\\wsl$ fails, and skips unreachable distros', async () => {
    const dirs = new Map<string, string[]>([
      ['\\\\wsl.localhost\\Ubuntu\\home', ['alice']],
    ]);
    const detector = new WslDetector({
      platform: 'win32',
      runWslList: () => Promise.resolve(utf16('Ubuntu\r\nGhost\r\n')),
      pathExists: () => Promise.resolve(false),
      readDir: p => {
        const entries = dirs.get(p);
        return entries ? Promise.resolve(entries) : Promise.reject(new Error('unreachable'));
      },
    });

    const result = await detector.detect();

    expect(result.distros).toEqual(['Ubuntu', 'Ghost']);
    expect(result.homes).toHaveLength(1);
    expect(result.homes[0].homeUnc).toBe('\\\\wsl.localhost\\Ubuntu\\home\\alice');
  });
});
