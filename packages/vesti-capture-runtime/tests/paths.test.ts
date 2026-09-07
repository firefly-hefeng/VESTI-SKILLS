import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRuntimePaths } from '../src/runtime/paths.js';

describe('resolveRuntimePaths', () => {
  it('uses a conventional .vesti directory by default', () => {
    const paths = resolveRuntimePaths({
      platform: 'linux',
      homeDir: '/home/alice',
      env: {},
    });
    expect(paths.basePath).toBe('/home/alice/.vesti');
    expect(paths.dbPath).toBe('/home/alice/.vesti/db/vesti.db');
    expect(paths.runtimePath).toMatch(/^\/home\/alice\/\.vesti\/runtime\/capture-[a-f0-9]{16}$/);
    expect(paths.socketPath).toBe(`${paths.runtimePath}/capture-daemon.sock`);
  });

  it('always lets VESTI_DB_PATH override the database derived from VESTI_HOME', () => {
    const paths = resolveRuntimePaths({
      platform: 'win32',
      env: {
        VESTI_HOME: 'C:\\memory-home',
        VESTI_DB_PATH: 'D:\\isolated\\db\\other.db',
      },
    });
    expect(paths.basePath).toBe(path.win32.resolve('C:\\memory-home'));
    expect(paths.dbPath).toBe(path.win32.resolve('D:\\isolated\\db\\other.db'));
    expect(paths.logsPath).toBe(path.win32.resolve('C:\\memory-home\\logs'));
    expect(paths.runtimePath).toMatch(/^D:\\isolated\\runtime\\capture-[a-f0-9]{16}$/i);
  });

  it('infers the shared data root when only VESTI_DB_PATH is set', () => {
    const paths = resolveRuntimePaths({
      platform: 'win32',
      env: { VESTI_DB_PATH: 'D:\\isolated\\db\\test.db' },
    });
    expect(paths.basePath).toBe(path.win32.resolve('D:\\isolated'));
    expect(paths.dbPath).toBe(path.win32.resolve('D:\\isolated\\db\\test.db'));
  });

  it('creates stable and database-specific Windows coordination paths', () => {
    const first = resolveRuntimePaths({
      platform: 'win32',
      basePath: 'C:\\one',
      dbPath: 'D:\\shared\\db\\vesti.db',
      env: {},
    });
    const same = resolveRuntimePaths({
      platform: 'win32',
      basePath: 'E:\\another-home',
      dbPath: 'd:\\SHARED\\DB\\VESTI.DB',
      env: {},
    });
    const other = resolveRuntimePaths({
      platform: 'win32',
      basePath: 'C:\\one',
      dbPath: 'D:\\shared\\db\\other.db',
      env: {},
    });
    expect(first.socketPath).toMatch(/^\\\\\.\\pipe\\vesti-capture-[a-f0-9]{16}$/);
    expect(first.socketPath).toBe(same.socketPath);
    expect(first.lockPath.toLowerCase()).toBe(same.lockPath.toLowerCase());
    expect(first.socketPath).not.toBe(other.socketPath);
    expect(first.lockPath).not.toBe(other.lockPath);
  });

  it('coordinates through one lock and socket for the same Unix database across homes', () => {
    const first = resolveRuntimePaths({
      platform: 'linux',
      basePath: '/srv/vesti-one',
      dbPath: '/data/shared/vesti.db',
      env: {},
    });
    const second = resolveRuntimePaths({
      platform: 'linux',
      basePath: '/srv/vesti-two',
      dbPath: '/data/shared/./vesti.db',
      env: {},
    });
    expect(first.lockPath).toBe(second.lockPath);
    expect(first.socketPath).toBe(second.socketPath);
    expect(first.logsPath).not.toBe(second.logsPath);
    expect(first.vaultPath).not.toBe(second.vaultPath);
  });

  it('falls back to a short temp socket for a deep Unix data path', () => {
    const paths = resolveRuntimePaths({
      platform: 'linux',
      basePath: `/home/alice/${'deep/'.repeat(30)}.vesti`,
      tempDir: '/tmp',
      env: {},
    });
    expect(paths.socketPath).toMatch(/^\/tmp\/vesti-capture-[a-f0-9]{16}\.sock$/);
  });
});
