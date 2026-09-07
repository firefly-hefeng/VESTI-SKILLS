import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface RuntimePaths {
  basePath: string;
  configPath: string;
  dbPath: string;
  vaultPath: string;
  logsPath: string;
  runtimePath: string;
  lockPath: string;
  socketPath: string;
  logPath: string;
}

export interface ResolveRuntimePathsOptions {
  /** Overrides the data-directory setting, but never an explicit database. */
  basePath?: string;
  /** Optional explicit database file. It always wins over directory defaults. */
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  tempDir?: string;
}

function inferBasePathFromDatabase(dbPath: string, pathApi: typeof path.win32): string {
  const databaseDirectory = pathApi.dirname(dbPath);
  return pathApi.basename(databaseDirectory).toLowerCase() === 'db'
    ? pathApi.dirname(databaseDirectory)
    : databaseDirectory;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve user-facing storage from the configured data directory, while
 * deriving all single-writer coordination paths from the normalized database
 * path. Two processes targeting the same database therefore contend on the
 * same lock and socket even when they use different VESTI_HOME values.
 */
export function resolveRuntimePaths(options: ResolveRuntimePathsOptions = {}): RuntimePaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const explicitBase = nonEmpty(options.basePath)
    ?? nonEmpty(env.VESTI_HOME)
    ?? nonEmpty(env.VESTI_DATA_DIR);
  const databaseOverride = nonEmpty(options.dbPath) ?? nonEmpty(env.VESTI_DB_PATH);
  const baseCandidate = explicitBase
    ?? (databaseOverride ? inferBasePathFromDatabase(databaseOverride, pathApi) : undefined)
    ?? pathApi.join(options.homeDir ?? os.homedir(), '.vesti');
  const basePath = pathApi.resolve(baseCandidate);
  const dbPath = pathApi.resolve(databaseOverride ?? pathApi.join(basePath, 'db', 'vesti.db'));
  const logsPath = pathApi.join(basePath, 'logs');
  const normalizedDatabaseIdentity = platform === 'win32' ? dbPath.toLowerCase() : dbPath;
  const identity = createHash('sha256')
    .update(normalizedDatabaseIdentity)
    .digest('hex')
    .slice(0, 16);
  const runtimePath = pathApi.join(
    inferBasePathFromDatabase(dbPath, pathApi),
    'runtime',
    `capture-${identity}`,
  );

  let socketPath: string;
  if (platform === 'win32') {
    socketPath = `\\\\.\\pipe\\vesti-capture-${identity}`;
  } else {
    const localSocket = pathApi.join(runtimePath, 'capture-daemon.sock');
    // Most Unix kernels cap sockaddr_un paths at roughly 104-108 bytes.
    socketPath = Buffer.byteLength(localSocket) <= 90
      ? localSocket
      : pathApi.join(options.tempDir ?? os.tmpdir(), `vesti-capture-${identity}.sock`);
  }

  return {
    basePath,
    configPath: pathApi.join(basePath, 'config', 'vesti.json'),
    dbPath,
    vaultPath: pathApi.join(basePath, 'vault'),
    logsPath,
    runtimePath,
    lockPath: pathApi.join(runtimePath, 'capture-daemon.lock'),
    socketPath,
    logPath: pathApi.join(logsPath, 'capture-daemon.log'),
  };
}
