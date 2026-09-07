import { CaptureDaemon } from './runtime/daemon.js';
import { CaptureDaemonAlreadyRunningError } from './runtime/lock.js';
import { DEFAULT_CAPTURE_PLATFORMS, type CaptureRuntimePlatform } from './runtime/types.js';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface DaemonCliOptions {
  dataDir?: string;
  dbPath?: string;
  wslPollIntervalMs?: number;
  reconcileIntervalMs?: number;
  enabledPlatforms?: CaptureRuntimePlatform[];
  watch: boolean;
  foreground: boolean;
  help: boolean;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInterval(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}

export function parseDaemonCliArgs(args: string[]): DaemonCliOptions {
  const options: DaemonCliOptions = {
    watch: true,
    foreground: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--data-dir') options.dataDir = requiredValue(args, index++, flag);
    else if (flag === '--db-path') options.dbPath = requiredValue(args, index++, flag);
    else if (flag === '--wsl-poll-ms') {
      options.wslPollIntervalMs = positiveInterval(requiredValue(args, index++, flag), flag);
    } else if (flag === '--reconcile-ms') {
      options.reconcileIntervalMs = positiveInterval(requiredValue(args, index++, flag), flag);
    } else if (flag === '--platforms') {
      const requested = requiredValue(args, index++, flag).split(',').map(value => value.trim());
      const invalid = requested.filter(platform => !DEFAULT_CAPTURE_PLATFORMS.includes(platform as CaptureRuntimePlatform));
      if (invalid.length > 0) throw new Error(`Unsupported capture platform(s): ${invalid.join(', ')}`);
      options.enabledPlatforms = [...new Set(requested as CaptureRuntimePlatform[])];
    } else if (flag === '--no-watch') options.watch = false;
    else if (flag === '--foreground') options.foreground = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

function helpText(): string {
  return [
    'Usage: vesti-captured [options]',
    '',
    'Options:',
    '  --data-dir <path>       VESTI data directory (default: VESTI_HOME or ~/.vesti)',
    '  --db-path <path>        Explicit SQLite database path',
    '  --platforms <list>      Comma-separated capture platforms',
    '  --wsl-poll-ms <ms>      WSL polling interval (default: 60000)',
    '  --reconcile-ms <ms>     Full reconciliation interval (default: 300000)',
    '  --no-watch              Disable native filesystem watching',
    '  --foreground            Mirror structured logs to stderr',
    '  -h, --help              Show this help',
    '',
  ].join('\n');
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let cli: DaemonCliOptions;
  try {
    cli = parseDaemonCliArgs(args);
  } catch (error) {
    process.stderr.write(`vesti-captured: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (cli.help) {
    process.stderr.write(helpText());
    return;
  }

  const daemon = new CaptureDaemon({
    basePath: cli.dataDir,
    dbPath: cli.dbPath,
    enabledPlatforms: cli.enabledPlatforms,
    wslPollIntervalMs: cli.wslPollIntervalMs,
    reconcileIntervalMs: cli.reconcileIntervalMs,
    watch: cli.watch,
    mirrorLogsToStderr: cli.foreground,
  });
  let shuttingDown = false;
  const shutdown = async (exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await daemon.stop();
    } catch (error) {
      process.stderr.write(`vesti-captured: shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      exitCode = 1;
    }
    process.exitCode = exitCode;
  };

  process.once('SIGINT', () => void shutdown(0));
  process.once('SIGTERM', () => void shutdown(0));
  if (process.platform === 'win32') process.once('SIGBREAK', () => void shutdown(0));
  process.once('uncaughtException', error => {
    process.stderr.write(`vesti-captured: uncaught exception: ${error.stack ?? error.message}\n`);
    void shutdown(1);
  });
  process.once('unhandledRejection', reason => {
    process.stderr.write(`vesti-captured: unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
    void shutdown(1);
  });

  try {
    await daemon.start();
    if (cli.foreground) {
      process.stderr.write(`vesti-captured: ready on ${daemon.paths.socketPath}\n`);
    }
  } catch (error) {
    if (error instanceof CaptureDaemonAlreadyRunningError) {
      if (cli.foreground) process.stderr.write(`${error.message}\n`);
      process.exitCode = 0;
      return;
    }
    process.stderr.write(`vesti-captured: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export function isDirectExecution(metaUrl = import.meta.url, argvEntry = process.argv[1]): boolean {
  if (!argvEntry) return false;
  const canonical = (filePath: string): string => {
    try {
      return realpathSync(filePath);
    } catch {
      return path.resolve(filePath);
    }
  };
  const current = canonical(fileURLToPath(metaUrl));
  const entry = canonical(argvEntry);
  return process.platform === 'win32'
    ? current.toLowerCase() === entry.toLowerCase()
    : current === entry;
}

if (isDirectExecution()) void main();
