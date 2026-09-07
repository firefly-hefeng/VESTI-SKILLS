import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRuntimeLogger } from '../src/runtime/logger.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

describe('FileRuntimeLogger permissions', () => {
  it.skipIf(process.platform === 'win32')('restricts an existing Unix log directory and file', async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-logger-'));
    temporaryDirectories.push(basePath);
    const logsPath = path.join(basePath, 'logs');
    const logPath = path.join(logsPath, 'capture-daemon.log');
    await fs.mkdir(logsPath, { mode: 0o777 });
    await fs.writeFile(logPath, 'old\n', { mode: 0o666 });
    await fs.chmod(logsPath, 0o777);
    await fs.chmod(logPath, 0o666);

    const logger = new FileRuntimeLogger(logPath);
    await logger.initialize();
    logger.info('secured');
    await logger.flush();

    expect((await fs.stat(logsPath)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(logPath)).mode & 0o777).toBe(0o600);
  });
});
