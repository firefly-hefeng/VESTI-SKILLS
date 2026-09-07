/**
 * WSL Detector
 * Windows-only detection of WSL distributions and agent data roots inside
 * them. Pure helpers (wsl.exe output decoding/parsing, UNC path assembly)
 * are exported for unit tests; side effects (spawning wsl.exe, probing the
 * UNC shares) are injectable so tests never need a real WSL environment.
 * Every failure mode degrades silently to an empty result — WSL is an
 * optional data source.
 */

import { execFile } from 'child_process';
import fs from 'fs-extra';
import path from 'path';

/** Platforms probed inside a WSL home, mapped to candidate marker paths
 * (first existing candidate wins; legacy names are kept as fallbacks). */
const WSL_PROBES: Record<string, string[][]> = {
  'kimi-code': [['.kimi-code', 'sessions'], ['.kimi', 'sessions']],
  codex: [['.codex', 'sessions']],
  'claude-code': [['.claude', 'projects']],
  aider: [['.aider.chat.history.md']],
  trae: [['.config', 'Trae', 'User'], ['.config', 'Trae CN', 'User'], ['.config', 'TRAE SOLO CN', 'User']],
  coder: [['.qoder', 'projects'], ['.qoderwork', 'projects'], ['.config', 'Qoder', 'SharedClientCache', 'cli', 'projects']],
  workbuddy: [['.workbuddy', 'projects']],
};

export interface WslUserHome {
  distro: string;
  user: string;
  /** UNC path of the user's home inside the distro, e.g. \\wsl$\Ubuntu\home\alice */
  homeUnc: string;
  /** platform → UNC path of the detected marker (sessions dir / history file) */
  roots: Partial<Record<string, string>>;
}

export interface WslDetection {
  supported: boolean;
  distros: string[];
  homes: WslUserHome[];
}

export interface WslDetectorOptions {
  platform?: NodeJS.Platform;
  /** Spawn `wsl.exe -l -q` and return its raw stdout bytes */
  runWslList?: () => Promise<Buffer>;
  pathExists?: (uncPath: string) => Promise<boolean>;
  readDir?: (uncPath: string) => Promise<string[]>;
}

/**
 * Decode `wsl.exe -l -q` stdout. wsl.exe emits UTF-16LE (usually without a
 * BOM); tolerate UTF-8/ASCII and partially garbled buffers instead of
 * failing — a wrong guess only yields garbage that parseWslDistroList
 * filters away.
 */
export function decodeWslOutput(buf: Buffer): string {
  if (buf.length === 0) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  // Heuristic: UTF-16LE ASCII text has NUL high bytes in most 2-byte pairs.
  let zeroHighBytes = 0;
  let pairs = 0;
  const sample = Math.min(buf.length, 128);
  for (let i = 0; i + 1 < sample; i += 2) {
    pairs++;
    if (buf[i + 1] === 0) zeroHighBytes++;
  }
  if (pairs > 0 && zeroHighBytes * 2 >= pairs) return buf.toString('utf16le');
  return buf.toString('utf8');
}

const DEFAULT_MARK = /\s*\((?:default|默认)\)\s*$/i;

/**
 * Parse `wsl.exe -l -q` output into distro names. Tolerates CRLF, NUL
 * padding from mis-decoded UTF-16, "(Default)"/"(默认)" markers, localized
 * header lines (ending in ':'/'：') and empty output.
 */
export function parseWslDistroList(output: string): string[] {
  const distros: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\0/g, '').replace(DEFAULT_MARK, '').trim();
    if (!line) continue;
    if (line.endsWith(':') || line.endsWith('：')) continue;
    if (!distros.includes(line)) distros.push(line);
  }
  return distros;
}

/** UNC root of a distro's filesystem: \\wsl$\<distro> (or the localhost variant). */
export function wslDistroRoot(distro: string, share: 'wsl$' | 'wsl.localhost' = 'wsl$'): string {
  return `\\\\${share}\\${distro}`;
}

export class WslDetector {
  private readonly platform: NodeJS.Platform;
  private readonly runWslList: () => Promise<Buffer>;
  private readonly probePath: (uncPath: string) => Promise<boolean>;
  private readonly probeDir: (uncPath: string) => Promise<string[]>;

  constructor(options: WslDetectorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runWslList = options.runWslList ?? defaultRunWslList;
    this.probePath = options.pathExists ?? (uncPath => fs.pathExists(uncPath));
    this.probeDir = options.readDir ?? (uncPath => fs.readdir(uncPath));
  }

  /** Enumerate installed WSL distros; empty on non-Windows or any failure. */
  async listDistros(): Promise<string[]> {
    if (this.platform !== 'win32') return [];
    try {
      const output = await this.runWslList();
      return parseWslDistroList(decodeWslOutput(output));
    } catch {
      return [];
    }
  }

  /**
   * Enumerate user homes inside one distro. Prefers \\wsl$, falls back to
   * \\wsl.localhost; skips the distro when neither share answers. The root
   * user's /root is probed in addition to /home/*.
   */
  async enumerateHomes(distro: string): Promise<Array<{ user: string; homeUnc: string }>> {
    let base: string | null = null;
    let users: string[] | null = null;
    for (const share of ['wsl$', 'wsl.localhost'] as const) {
      const candidate = wslDistroRoot(distro, share);
      users = await this.safeReadDir(path.win32.join(candidate, 'home'));
      if (users !== null) {
        base = candidate;
        break;
      }
    }
    if (!base || !users) return [];

    const homes = users.map(user => ({ user, homeUnc: path.win32.join(base!, 'home', user) }));
    const rootHome = path.win32.join(base, 'root');
    if (await this.safePathExists(rootHome)) homes.push({ user: 'root', homeUnc: rootHome });
    return homes;
  }

  /** Probe one WSL home for agent install markers. */
  async detectRoots(distro: string, user: string, homeUnc: string): Promise<WslUserHome> {
    const roots: Partial<Record<string, string>> = {};
    for (const [platform, candidates] of Object.entries(WSL_PROBES)) {
      for (const segments of candidates) {
        const marker = path.win32.join(homeUnc, ...segments);
        if (await this.safePathExists(marker)) {
          roots[platform] = marker;
          break;
        }
      }
    }
    return { distro, user, homeUnc, roots };
  }

  /** Full detection pass. Never throws. */
  async detect(): Promise<WslDetection> {
    if (this.platform !== 'win32') return { supported: false, distros: [], homes: [] };
    const distros = await this.listDistros();
    const homes: WslUserHome[] = [];
    for (const distro of distros) {
      try {
        for (const { user, homeUnc } of await this.enumerateHomes(distro)) {
          homes.push(await this.detectRoots(distro, user, homeUnc));
        }
      } catch { /* skip this distro */ }
    }
    return { supported: true, distros, homes };
  }

  private async safePathExists(uncPath: string): Promise<boolean> {
    try {
      return await this.probePath(uncPath);
    } catch {
      return false;
    }
  }

  private async safeReadDir(uncPath: string): Promise<string[] | null> {
    try {
      return await this.probeDir(uncPath);
    } catch {
      return null;
    }
  }
}

function defaultRunWslList(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 5000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout as Buffer);
    });
  });
}
