import { describe, expect, it } from 'vitest';
import {
  acquireDaemonLock,
  CaptureDaemonAlreadyRunningError,
  type DaemonLockDependencies,
  type DaemonLockFileSystem,
  type DaemonLockMetadata,
} from '../src/runtime/lock.js';

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

class MemoryLockFileSystem implements DaemonLockFileSystem {
  readonly files = new Map<string, string>();
  removeIfUnchangedCalls = 0;
  touched: Array<{ filePath: string; at: number }> = [];
  onWriteExclusive?: (filePath: string, contents: string) => void | Promise<void>;

  async ensureDirectory(): Promise<void> {}

  async writeExclusive(filePath: string, contents: string): Promise<void> {
    await this.onWriteExclusive?.(filePath, contents);
    if (this.files.has(filePath)) throw fsError('EEXIST');
    this.files.set(filePath, contents);
  }

  async read(filePath: string): Promise<string> {
    const value = this.files.get(filePath);
    if (value === undefined) throw fsError('ENOENT');
    return value;
  }

  async remove(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }

  async removeIfUnchanged(filePath: string, expectedContents: string): Promise<boolean> {
    this.removeIfUnchangedCalls += 1;
    if (this.files.get(filePath) !== expectedContents) return false;
    this.files.delete(filePath);
    return true;
  }

  async touch(filePath: string, at: number): Promise<void> {
    if (!this.files.has(filePath)) throw fsError('ENOENT');
    this.touched.push({ filePath, at });
  }
}

function lockRaw(pid: number, token: string, socketPath = 'pipe'): string {
  const metadata: DaemonLockMetadata = {
    token,
    pid,
    startedAt: 1,
    updatedAt: 1,
    socketPath,
    protocolVersion: 1,
  };
  return `${JSON.stringify(metadata)}\n`;
}

function dependencies(
  fileSystem: MemoryLockFileSystem,
  options: {
    alive?: Set<number>;
    tokenPrefix?: string;
    delay?: () => Promise<void>;
  } = {},
): DaemonLockDependencies {
  let token = 0;
  const alive = options.alive ?? new Set<number>();
  return {
    fileSystem,
    isProcessAlive: pid => alive.has(pid),
    now: () => 100 + token,
    createToken: () => `${options.tokenPrefix ?? 'token'}-${++token}`,
    delay: options.delay ?? (async () => Promise.resolve()),
  };
}

describe('capture daemon lock', () => {
  it('acquires, heartbeats without rewriting JSON, and releases its own token', async () => {
    const fileSystem = new MemoryLockFileSystem();
    const lock = await acquireDaemonLock('daemon.lock', 'pipe', { pid: 10 }, dependencies(fileSystem));
    const before = fileSystem.files.get('daemon.lock');
    await lock.heartbeat();
    expect(fileSystem.files.get('daemon.lock')).toBe(before);
    expect(fileSystem.touched).toHaveLength(1);
    await lock.release();
    expect(fileSystem.files.has('daemon.lock')).toBe(false);
  });

  it('never displaces a live owner', async () => {
    const fileSystem = new MemoryLockFileSystem();
    fileSystem.files.set('daemon.lock', lockRaw(7, 'live'));
    await expect(acquireDaemonLock(
      'daemon.lock',
      'pipe',
      { pid: 10 },
      dependencies(fileSystem, { alive: new Set([7]) }),
    )).rejects.toBeInstanceOf(CaptureDaemonAlreadyRunningError);
    expect(fileSystem.files.get('daemon.lock')).toBe(lockRaw(7, 'live'));
  });

  it('recovers a stable lock owned by a dead process', async () => {
    const fileSystem = new MemoryLockFileSystem();
    fileSystem.files.set('daemon.lock', lockRaw(7, 'dead'));
    const lock = await acquireDaemonLock(
      'daemon.lock',
      'pipe',
      { pid: 10 },
      dependencies(fileSystem),
    );
    expect(JSON.parse(fileSystem.files.get('daemon.lock')!)).toMatchObject({ pid: 10 });
    await lock.release();
  });

  it('does not remove temporarily incomplete JSON that becomes a live lock', async () => {
    const fileSystem = new MemoryLockFileSystem();
    fileSystem.files.set('daemon.lock', '{');
    let repaired = false;
    const deps = dependencies(fileSystem, {
      alive: new Set([77]),
      delay: async () => {
        if (!repaired) {
          repaired = true;
          fileSystem.files.set('daemon.lock', lockRaw(77, 'now-complete'));
        }
      },
    });
    await expect(acquireDaemonLock('daemon.lock', 'pipe', { pid: 10 }, deps))
      .rejects.toBeInstanceOf(CaptureDaemonAlreadyRunningError);
    expect(JSON.parse(fileSystem.files.get('daemon.lock')!)).toMatchObject({ pid: 77 });
    expect(fileSystem.removeIfUnchangedCalls).toBe(0);
  });

  it('rechecks the ownership token after winning stale-recovery arbitration', async () => {
    const fileSystem = new MemoryLockFileSystem();
    fileSystem.files.set('daemon.lock', lockRaw(7, 'observed-dead'));
    fileSystem.onWriteExclusive = filePath => {
      if (filePath === 'daemon.lock.recovery') {
        // Models another starter replacing the stale lock after our first
        // read but before our recovery guard is acquired.
        fileSystem.files.set('daemon.lock', lockRaw(77, 'new-live-owner'));
      }
    };
    await expect(acquireDaemonLock(
      'daemon.lock',
      'pipe',
      { pid: 10 },
      dependencies(fileSystem, { alive: new Set([77]) }),
    )).rejects.toBeInstanceOf(CaptureDaemonAlreadyRunningError);
    expect(fileSystem.files.get('daemon.lock')).toBe(lockRaw(77, 'new-live-owner'));
  });

  it('allows only one winner when two starters recover the same stale lock', async () => {
    const fileSystem = new MemoryLockFileSystem();
    fileSystem.files.set('daemon.lock', lockRaw(9, 'stale'));
    const alive = new Set([101, 102]);
    const results = await Promise.allSettled([
      acquireDaemonLock(
        'daemon.lock',
        'pipe',
        { pid: 101 },
        dependencies(fileSystem, { alive, tokenPrefix: 'a' }),
      ),
      acquireDaemonLock(
        'daemon.lock',
        'pipe',
        { pid: 102 },
        dependencies(fileSystem, { alive, tokenPrefix: 'b' }),
      ),
    ]);
    const winners = results.filter(result => result.status === 'fulfilled');
    const losers = results.filter(result => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason)
      .toBeInstanceOf(CaptureDaemonAlreadyRunningError);
    const stored = JSON.parse(fileSystem.files.get('daemon.lock')!) as DaemonLockMetadata;
    expect([101, 102]).toContain(stored.pid);
    await (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireDaemonLock>>>).value.release();
  });
});
