/**
 * Vault Manager
 * Backs up raw JSONL files to ~/.vesti/vault/ with gzip compression
 * Provides recovery mechanism for agent reinstalls
 */

import fs from 'fs-extra';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { open } from 'node:fs/promises';

interface BackupRequest {
  filePath: string;
  platform: string;
  sessionId?: string;
  host?: string;
}

export class VaultManager {
  private vaultPath: string;
  /**
   * Raw-session compression is deliberately serialized. Several watched
   * rollout files can change together (and Codex forks can even resolve to
   * the same logical session), so running levelled gzip streams in parallel
   * used to starve the capture path.
   */
  private backupTail: Promise<void> = Promise.resolve();

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  async initialize(): Promise<void> {
    await fs.ensureDir(this.vaultPath);
  }

  /**
   * Backup a raw session file to the vault. WSL sources get an extra
   * wsl-<distro> subdirectory so identical file names from different
   * distros (or from the native host) never overwrite each other.
   */
  async backup(filePath: string, platform: string, sessionId?: string, host?: string): Promise<string> {
    const request: BackupRequest = { filePath, platform, sessionId, host };
    // Chaining both the fulfilled and rejected branches means one failed
    // archive never poisons the global queue.
    const task = this.backupTail.then(
      () => this.performBackup(request),
      () => this.performBackup(request),
    );
    this.backupTail = task.then(() => undefined, () => undefined);
    return task;
  }

  /** Resolve after all backups queued so far have completed. */
  async waitForIdle(): Promise<void> {
    await this.backupTail;
  }

  private destinationPath(request: BackupRequest): string {
    const platformDir = request.host && request.host !== 'native'
      ? path.join(this.vaultPath, request.platform, 'raw', request.host.replace(/[:\\/]/g, '-'))
      : path.join(this.vaultPath, request.platform, 'raw');
    const sourcePath = path.resolve(request.filePath);
    const normalizedSource = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath;
    const sourceHash = createHash('sha256').update(normalizedSource).digest('hex').slice(0, 12);
    const fallback = path.basename(request.filePath).replace(/\.jsonl$/i, '');
    const label = (request.sessionId || fallback || 'session')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'session';
    return path.join(platformDir, `${label}-${sourceHash}.jsonl.gz`);
  }

  private async isCurrentSnapshot(
    filePath: string,
    destPath: string,
    sourceSnapshot?: { mtimeMs: number; size: number },
  ): Promise<boolean> {
    if (!await fs.pathExists(destPath)) return false;
    const [source, destination] = await Promise.all([
      sourceSnapshot ?? fs.stat(filePath),
      fs.stat(destPath),
    ]);
    if (destination.size < 4 || destination.mtimeMs < source.mtimeMs) return false;

    // The final four bytes of a gzip member contain the uncompressed size
    // modulo 2^32. Comparing it as well as mtime avoids missing an append on
    // filesystems whose timestamp resolution is coarser than the watcher.
    const trailer = Buffer.allocUnsafe(4);
    const handle = await open(destPath, 'r');
    try {
      const { bytesRead } = await handle.read(trailer, 0, trailer.length, destination.size - trailer.length);
      return bytesRead === trailer.length
        && trailer.readUInt32LE(0) === source.size % 0x1_0000_0000;
    } finally {
      await handle.close();
    }
  }

  private async performBackup(request: BackupRequest): Promise<string> {
    const destPath = this.destinationPath(request);
    await fs.ensureDir(path.dirname(destPath));

    // Capture size and mtime once. The explicit read-stream end prevents a
    // continuously appended JSONL from extending this compression forever.
    const snapshot = await fs.stat(request.filePath);
    if (snapshot.size === 0) return destPath;
    if (await this.isCurrentSnapshot(request.filePath, destPath, snapshot)) return destPath;

    const tempPath = `${destPath}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await pipeline(
        createReadStream(request.filePath, { start: 0, end: snapshot.size - 1 }),
        // Fast compression keeps archival work from competing with capture.
        createGzip({ level: 3 }),
        createWriteStream(tempPath, { flags: 'wx' }),
      );
      // Stamp the bounded snapshot's source time before the atomic rename.
      // If the source grew while gzip was running, its newer mtime will force
      // a follow-up backup instead of treating this older snapshot as current.
      await fs.utimes(tempPath, snapshot.atime, snapshot.mtime);
      await fs.rename(tempPath, destPath);
      return destPath;
    } finally {
      // rename removes the temp path on success; on any failure it must not
      // linger and must never replace the last known-good archive.
      await fs.remove(tempPath).catch(() => undefined);
    }
  }

  /**
   * Backup all session files for a platform
   */
  async backupAll(files: string[], platform: string): Promise<{ backed: number; skipped: number; errors: number }> {
    let backed = 0, skipped = 0, errors = 0;

    for (const file of files) {
      try {
        const request: BackupRequest = { filePath: file, platform };
        const destPath = this.destinationPath(request);
        if (await this.isCurrentSnapshot(file, destPath)) {
          skipped++;
          continue;
        }

        await this.backup(file, platform);
        backed++;
      } catch {
        errors++;
      }
    }

    return { backed, skipped, errors };
  }

  /**
   * Restore a file from vault
   */
  async restore(vaultFile: string, destPath: string): Promise<void> {
    await fs.ensureDir(path.dirname(destPath));
    const gunzip = createGunzip();
    const source = createReadStream(vaultFile);
    const dest = createWriteStream(destPath);
    await pipeline(source, gunzip, dest);
  }

  /**
   * List all backed up files for a platform
   */
  async listBackups(platform: string): Promise<Array<{ file: string; size: number; modified: number }>> {
    const dir = path.join(this.vaultPath, platform, 'raw');
    if (!await fs.pathExists(dir)) return [];

    const files = await fs.readdir(dir);
    const results: Array<{ file: string; size: number; modified: number }> = [];

    for (const file of files) {
      if (!file.endsWith('.gz')) continue;
      const stat = await fs.stat(path.join(dir, file));
      results.push({
        file: path.join(dir, file),
        size: stat.size,
        modified: stat.mtimeMs,
      });
    }

    return results.sort((a, b) => b.modified - a.modified);
  }

  /**
   * Get vault storage statistics
   */
  async getStats(): Promise<{ totalFiles: number; totalSize: number; platforms: Record<string, number> }> {
    let totalFiles = 0;
    let totalSize = 0;
    const platforms: Record<string, number> = {};

    if (!await fs.pathExists(this.vaultPath)) {
      return { totalFiles, totalSize, platforms };
    }

    const entries = await fs.readdir(this.vaultPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rawDir = path.join(this.vaultPath, entry.name, 'raw');
      if (!await fs.pathExists(rawDir)) continue;

      const files = await fs.readdir(rawDir);
      let platformSize = 0;
      for (const file of files) {
        const stat = await fs.stat(path.join(rawDir, file));
        platformSize += stat.size;
        totalFiles++;
      }
      totalSize += platformSize;
      platforms[entry.name] = files.length;
    }

    return { totalFiles, totalSize, platforms };
  }
}
