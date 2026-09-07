import os from 'node:os';
import path from 'node:path';
import { gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultManager } from '../src/storage/VaultManager.js';

const gunzip = promisify(gunzipCallback);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-vault-'));
  tempRoots.push(root);
  return root;
}

async function readBackup(filePath: string): Promise<Buffer> {
  return gunzip(await fs.readFile(filePath));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map(root => fs.remove(root)));
});

describe('VaultManager', () => {
  it('keeps different source files with the same logical session id separate', async () => {
    const root = await makeTempRoot();
    const vault = new VaultManager(path.join(root, 'vault'));
    const firstSource = path.join(root, 'source-a', 'rollout.jsonl');
    const secondSource = path.join(root, 'source-b', 'rollout.jsonl');
    await fs.outputFile(firstSource, '{"source":"a"}\n');
    await fs.outputFile(secondSource, '{"source":"b"}\n');

    const [firstBackup, secondBackup] = await Promise.all([
      vault.backup(firstSource, 'codex', 'shared-session'),
      vault.backup(secondSource, 'codex', 'shared-session'),
    ]);

    expect(firstBackup).not.toBe(secondBackup);
    expect(path.basename(firstBackup)).toMatch(/^shared-session-[a-f0-9]{12}\.jsonl\.gz$/);
    expect(path.basename(secondBackup)).toMatch(/^shared-session-[a-f0-9]{12}\.jsonl\.gz$/);
    expect((await readBackup(firstBackup)).toString()).toBe('{"source":"a"}\n');
    expect((await readBackup(secondBackup)).toString()).toBe('{"source":"b"}\n');
  });

  it('archives a bounded stat snapshot when the source grows during backup', async () => {
    const root = await makeTempRoot();
    const vault = new VaultManager(path.join(root, 'vault'));
    const source = path.join(root, 'rollout.jsonl');
    const initial = Buffer.from('{"turn":1}\n'.repeat(1024));
    const appended = Buffer.from('{"turn":2}\n');
    await fs.outputFile(source, initial);

    const originalStat = fs.stat.bind(fs);
    let releaseStat!: () => void;
    let snapshotSeen!: () => void;
    const statGate = new Promise<void>(resolve => { releaseStat = resolve; });
    const snapshotCaptured = new Promise<void>(resolve => { snapshotSeen = resolve; });
    vi.spyOn(fs, 'stat').mockImplementation((async (target: fs.PathLike) => {
      const result = await originalStat(target);
      if (path.resolve(String(target)) === path.resolve(source)) {
        snapshotSeen();
        await statGate;
      }
      return result;
    }) as typeof fs.stat);

    const firstBackupPromise = vault.backup(source, 'codex', 'growing-session');
    await snapshotCaptured;
    await fs.appendFile(source, appended);
    releaseStat();

    const firstBackup = await firstBackupPromise;
    expect(await readBackup(firstBackup)).toEqual(initial);

    // A subsequent request sees the larger ISIZE even if filesystem mtimes
    // happen to have the same resolution, and atomically replaces the archive.
    const secondBackup = await vault.backup(source, 'codex', 'growing-session');
    expect(secondBackup).toBe(firstBackup);
    expect(await readBackup(secondBackup)).toEqual(Buffer.concat([initial, appended]));
  });

  it('runs backup work one at a time across sources', async () => {
    const root = await makeTempRoot();
    const vault = new VaultManager(path.join(root, 'vault'));
    const sources = await Promise.all([0, 1, 2].map(async index => {
      const source = path.join(root, `source-${index}.jsonl`);
      await fs.outputFile(source, `{"index":${index}}\n`);
      return source;
    }));

    const internal = vault as unknown as {
      performBackup(request: unknown): Promise<string>;
    };
    const originalBackup = internal.performBackup.bind(vault);
    let active = 0;
    let maximumActive = 0;
    internal.performBackup = async (request: unknown) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      try {
        return await originalBackup(request);
      } finally {
        active--;
      }
    };

    await Promise.all(sources.map((source, index) => vault.backup(source, 'codex', `session-${index}`)));
    expect(maximumActive).toBe(1);
  });

  it('preserves the last valid archive on replacement failure and keeps the queue usable', async () => {
    const root = await makeTempRoot();
    const vault = new VaultManager(path.join(root, 'vault'));
    const source = path.join(root, 'rollout.jsonl');
    await fs.outputFile(source, 'old\n');
    const backupPath = await vault.backup(source, 'codex', 'atomic-session');

    await fs.appendFile(source, 'new\n');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('simulated rename failure'));
    await expect(vault.backup(source, 'codex', 'atomic-session')).rejects.toThrow('simulated rename failure');

    expect((await readBackup(backupPath)).toString()).toBe('old\n');
    const filesAfterFailure = await fs.readdir(path.dirname(backupPath));
    expect(filesAfterFailure.some(file => file.endsWith('.tmp'))).toBe(false);

    await vault.backup(source, 'codex', 'atomic-session');
    expect((await readBackup(backupPath)).toString()).toBe('old\nnew\n');
  });
});
