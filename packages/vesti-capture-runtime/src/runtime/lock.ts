import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CAPTURE_DAEMON_PROTOCOL_VERSION } from './types.js';

export interface DaemonLockMetadata {
  token: string;
  pid: number;
  startedAt: number;
  updatedAt: number;
  socketPath: string;
  protocolVersion: number;
}

export interface DaemonLockFileSystem {
  ensureDirectory(directory: string): Promise<void>;
  writeExclusive(filePath: string, contents: string): Promise<void>;
  read(filePath: string): Promise<string>;
  remove(filePath: string): Promise<void>;
  removeIfUnchanged(filePath: string, expectedContents: string): Promise<boolean>;
  touch(filePath: string, at: number): Promise<void>;
}

export interface DaemonLockDependencies {
  fileSystem: DaemonLockFileSystem;
  isProcessAlive(pid: number): boolean;
  now(): number;
  createToken(): string;
  delay(milliseconds: number): Promise<void>;
}

export interface AcquireDaemonLockOptions {
  pid?: number;
  maxRecoveryAttempts?: number;
}

export class CaptureDaemonAlreadyRunningError extends Error {
  constructor(readonly metadata: DaemonLockMetadata | null) {
    super(metadata
      ? `VESTI capture daemon is already running with pid ${metadata.pid}`
      : 'VESTI capture daemon lock is already held');
    this.name = 'CaptureDaemonAlreadyRunningError';
  }
}

export class CaptureDaemonLock {
  private released = false;

  constructor(
    readonly filePath: string,
    private metadataValue: DaemonLockMetadata,
    private readonly dependencies: DaemonLockDependencies,
  ) {}

  get metadata(): DaemonLockMetadata {
    return { ...this.metadataValue };
  }

  async heartbeat(): Promise<void> {
    if (this.released) return;
    const current = await readMetadata(this.filePath, this.dependencies.fileSystem);
    if (!current || current.token !== this.metadataValue.token) {
      throw new Error('VESTI capture daemon lock ownership was lost');
    }
    const now = this.dependencies.now();
    this.metadataValue = { ...this.metadataValue, updatedAt: now };
    // Do not rewrite/truncate the ownership file: another starter can observe
    // a half-written JSON document and mistake a live owner for a stale one.
    // Updating mtime supplies a heartbeat without changing token contents.
    await this.dependencies.fileSystem.touch(this.filePath, now);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      const raw = await readRaw(this.filePath, this.dependencies.fileSystem);
      const current = raw === null ? null : parseMetadata(raw);
      if (raw !== null && current?.token === this.metadataValue.token) {
        await this.dependencies.fileSystem.removeIfUnchanged(this.filePath, raw);
      }
    } catch {
      // Cleanup is best effort. A token check prevents deleting a new owner.
    }
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code);
}

function parseMetadata(raw: string): DaemonLockMetadata | null {
  try {
    const value = JSON.parse(raw) as Partial<DaemonLockMetadata>;
    if (
      typeof value.token !== 'string'
      || typeof value.pid !== 'number'
      || !Number.isSafeInteger(value.pid)
      || value.pid <= 0
      || typeof value.startedAt !== 'number'
      || typeof value.updatedAt !== 'number'
      || typeof value.socketPath !== 'string'
    ) return null;
    return {
      token: value.token,
      pid: value.pid,
      startedAt: value.startedAt,
      updatedAt: value.updatedAt,
      socketPath: value.socketPath,
      protocolVersion: typeof value.protocolVersion === 'number' ? value.protocolVersion : 0,
    };
  } catch {
    return null;
  }
}

async function readMetadata(
  filePath: string,
  fileSystem: DaemonLockFileSystem,
): Promise<DaemonLockMetadata | null> {
  try {
    return parseMetadata(await fileSystem.read(filePath));
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function readRaw(
  filePath: string,
  fileSystem: DaemonLockFileSystem,
): Promise<string | null> {
  try {
    return await fileSystem.read(filePath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

export const nodeDaemonLockFileSystem: DaemonLockFileSystem = {
  async ensureDirectory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
  },
  async writeExclusive(filePath, contents) {
    const handle = await fs.open(filePath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async read(filePath) {
    return fs.readFile(filePath, 'utf8');
  },
  async remove(filePath) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  },
  async removeIfUnchanged(filePath, expectedContents) {
    try {
      if (await fs.readFile(filePath, 'utf8') !== expectedContents) return false;
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    }
  },
  async touch(filePath, at) {
    const timestamp = new Date(at);
    await fs.utimes(filePath, timestamp, timestamp);
  },
};

export const defaultDaemonLockDependencies: DaemonLockDependencies = {
  fileSystem: nodeDaemonLockFileSystem,
  isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  now: () => Date.now(),
  createToken: () => randomUUID(),
  delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};

/**
 * Atomically acquire the daemon's single-writer lock. An invalid lock file or
 * a lock owned by a dead pid is removed and retried; a live owner is never
 * displaced, even when its heartbeat is old (sleep/hibernation is valid).
 */
export async function acquireDaemonLock(
  lockPath: string,
  socketPath: string,
  options: AcquireDaemonLockOptions = {},
  dependencies: DaemonLockDependencies = defaultDaemonLockDependencies,
): Promise<CaptureDaemonLock> {
  await dependencies.fileSystem.ensureDirectory(path.dirname(lockPath));
  const pid = options.pid ?? process.pid;
  const maxRecoveryAttempts = options.maxRecoveryAttempts ?? 8;
  const recoveryPath = `${lockPath}.recovery`;

  for (let attempt = 0; attempt <= maxRecoveryAttempts; attempt += 1) {
    const now = dependencies.now();
    const metadata: DaemonLockMetadata = {
      token: dependencies.createToken(),
      pid,
      startedAt: now,
      updatedAt: now,
      socketPath,
      protocolVersion: CAPTURE_DAEMON_PROTOCOL_VERSION,
    };
    try {
      await dependencies.fileSystem.writeExclusive(lockPath, `${JSON.stringify(metadata)}\n`);
      return new CaptureDaemonLock(lockPath, metadata, dependencies);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      let observedRaw = await readRaw(lockPath, dependencies.fileSystem);
      if (observedRaw === null) continue;
      let existing = parseMetadata(observedRaw);
      if (existing && dependencies.isProcessAlive(existing.pid)) {
        throw new CaptureDaemonAlreadyRunningError(existing);
      }

      // A newly-created lock or a former direct-write heartbeat can be seen
      // before its JSON is complete. Require invalid content to remain byte-
      // identical across a short grace period before considering recovery.
      if (!existing) {
        await dependencies.delay(20);
        const confirmedRaw = await readRaw(lockPath, dependencies.fileSystem);
        if (confirmedRaw === null) continue;
        if (confirmedRaw !== observedRaw) {
          observedRaw = confirmedRaw;
          existing = parseMetadata(confirmedRaw);
          if (existing && dependencies.isProcessAlive(existing.pid)) {
            throw new CaptureDaemonAlreadyRunningError(existing);
          }
          if (!existing) continue;
        }
      }

      const recoveryStartedAt = dependencies.now();
      const recoveryMetadata: DaemonLockMetadata = {
        token: dependencies.createToken(),
        pid,
        startedAt: recoveryStartedAt,
        updatedAt: recoveryStartedAt,
        socketPath,
        protocolVersion: CAPTURE_DAEMON_PROTOCOL_VERSION,
      };
      const recoveryRaw = `${JSON.stringify(recoveryMetadata)}\n`;
      try {
        await dependencies.fileSystem.writeExclusive(recoveryPath, recoveryRaw);
      } catch (recoveryError) {
        if (!isNodeError(recoveryError, 'EEXIST')) throw recoveryError;
        let competingRaw = await readRaw(recoveryPath, dependencies.fileSystem);
        let competing = competingRaw === null ? null : parseMetadata(competingRaw);
        if (competingRaw !== null && !competing) {
          await dependencies.delay(20);
          const confirmedRaw = await readRaw(recoveryPath, dependencies.fileSystem);
          if (confirmedRaw !== competingRaw) {
            competingRaw = confirmedRaw;
            competing = confirmedRaw === null ? null : parseMetadata(confirmedRaw);
          }
        }
        if (
          competingRaw !== null
          && (!competing || !dependencies.isProcessAlive(competing.pid))
        ) {
          await dependencies.fileSystem.removeIfUnchanged(recoveryPath, competingRaw);
        }
        if (attempt >= maxRecoveryAttempts) throw new CaptureDaemonAlreadyRunningError(existing);
        await dependencies.delay(20);
        continue;
      }

      try {
        const currentRaw = await readRaw(lockPath, dependencies.fileSystem);
        if (currentRaw === null) {
          try {
            await dependencies.fileSystem.writeExclusive(lockPath, `${JSON.stringify(metadata)}\n`);
            return new CaptureDaemonLock(lockPath, metadata, dependencies);
          } catch (writeError) {
            if (!isNodeError(writeError, 'EEXIST')) throw writeError;
            continue;
          }
        }
        const current = parseMetadata(currentRaw);
        if (current && dependencies.isProcessAlive(current.pid)) {
          throw new CaptureDaemonAlreadyRunningError(current);
        }
        const sameOwner = existing
          ? current?.token === existing.token
          : currentRaw === observedRaw;
        if (!sameOwner) continue;
        if (!current) {
          await dependencies.delay(20);
          const stableRaw = await readRaw(lockPath, dependencies.fileSystem);
          if (stableRaw !== currentRaw) continue;
        }
        if (!(await dependencies.fileSystem.removeIfUnchanged(lockPath, currentRaw))) continue;
        try {
          await dependencies.fileSystem.writeExclusive(lockPath, `${JSON.stringify(metadata)}\n`);
          return new CaptureDaemonLock(lockPath, metadata, dependencies);
        } catch (writeError) {
          if (!isNodeError(writeError, 'EEXIST')) throw writeError;
        }
      } finally {
        await dependencies.fileSystem.removeIfUnchanged(recoveryPath, recoveryRaw);
      }
      if (attempt >= maxRecoveryAttempts) throw new CaptureDaemonAlreadyRunningError(existing);
    }
  }

  throw new CaptureDaemonAlreadyRunningError(null);
}
