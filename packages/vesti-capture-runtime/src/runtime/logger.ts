import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface RuntimeLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export const silentRuntimeLogger: RuntimeLogger = {
  info() {},
  warn() {},
  error() {},
};

export interface FileRuntimeLoggerOptions {
  maxBytes?: number;
  mirrorToStderr?: boolean;
}

function serializableDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  return Object.fromEntries(Object.entries(details).map(([key, value]) => {
    if (value instanceof Error) {
      return [key, { name: value.name, message: value.message, stack: value.stack }];
    }
    return [key, value];
  }));
}

/** A bounded newline-delimited JSON log suitable for detached operation. */
export class FileRuntimeLogger implements RuntimeLogger {
  private queue: Promise<void> = Promise.resolve();
  private readonly maxBytes: number;
  private readonly mirrorToStderr: boolean;

  constructor(readonly filePath: string, options: FileRuntimeLoggerOptions = {}) {
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    this.mirrorToStderr = options.mirrorToStderr ?? false;
  }

  async initialize(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
    await this.rotateIfNeeded();
    const handle = await fs.open(this.filePath, 'a', 0o600);
    await handle.close();
    if (process.platform !== 'win32') await fs.chmod(this.filePath, 0o600);
  }

  info(message: string, details?: Record<string, unknown>): void {
    this.append('info', message, details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.append('warn', message, details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.append('error', message, details);
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private append(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void {
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...serializableDetails(details),
    });
    if (this.mirrorToStderr) process.stderr.write(`${entry}\n`);
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        await fs.appendFile(this.filePath, `${entry}\n`, { encoding: 'utf8', mode: 0o600 });
        await this.rotateIfNeeded();
      });
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size < this.maxBytes) return;
      const rotatedPath = `${this.filePath}.1`;
      await fs.rm(rotatedPath, { force: true });
      await fs.rename(this.filePath, rotatedPath);
      if (process.platform !== 'win32') await fs.chmod(rotatedPath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
