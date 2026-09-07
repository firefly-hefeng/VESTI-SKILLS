import { promises as fs } from 'node:fs';
import net from 'node:net';
import {
  CaptureRuntime,
  type CaptureRuntimeOptions,
} from './CaptureRuntime.js';
import {
  acquireDaemonLock,
  type CaptureDaemonLock,
  type DaemonLockDependencies,
} from './lock.js';
import {
  FileRuntimeLogger,
  type RuntimeLogger,
} from './logger.js';
import { resolveRuntimePaths, type RuntimePaths } from './paths.js';
import {
  createNdjsonDecoder,
  encodeNdjson,
  parseCaptureDaemonRequest,
  CaptureProtocolError,
} from './protocol.js';
import {
  CAPTURE_DAEMON_PROTOCOL_VERSION,
  type CaptureDaemonRequest,
  type CaptureDaemonResponse,
  type CaptureDaemonStatus,
  type CaptureRuntimeStatus,
  type CaptureSyncSummary,
} from './types.js';
import {
  dispatchCaptureDaemonRequest,
  type CaptureDaemonCommandController,
} from './dispatch.js';

export interface CaptureRuntimeController {
  start(): Promise<void>;
  close(): Promise<void>;
  syncAll(reason?: string): Promise<CaptureSyncSummary>;
  getStatus(): CaptureRuntimeStatus;
}

export interface CaptureDaemonOptions extends Omit<CaptureRuntimeOptions, 'paths' | 'logger'> {
  paths?: RuntimePaths;
  runtime?: CaptureRuntimeController;
  logger?: RuntimeLogger;
  lockDependencies?: DaemonLockDependencies;
  heartbeatIntervalMs?: number;
  mirrorLogsToStderr?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Single-instance local daemon exposing a small NDJSON IPC protocol. */
export class CaptureDaemon implements CaptureDaemonCommandController {
  readonly paths: RuntimePaths;
  readonly runtime: CaptureRuntimeController;

  private readonly logger: RuntimeLogger;
  private readonly ownedFileLogger: FileRuntimeLogger | null;
  private readonly lockDependencies?: DaemonLockDependencies;
  private readonly heartbeatIntervalMs: number;
  private lock: CaptureDaemonLock | null = null;
  private server: net.Server | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly sockets = new Set<net.Socket>();
  private started = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private runtimeClosePromise: Promise<void> | null = null;
  private stopRequested = false;
  private lockOwnershipLost = false;

  constructor(options: CaptureDaemonOptions = {}) {
    this.paths = options.paths ?? resolveRuntimePaths({
      basePath: options.basePath,
      dbPath: options.dbPath,
      env: options.env,
    });
    this.ownedFileLogger = options.logger
      ? null
      : new FileRuntimeLogger(this.paths.logPath, {
          mirrorToStderr: options.mirrorLogsToStderr ?? false,
        });
    this.logger = options.logger ?? this.ownedFileLogger!;
    this.runtime = options.runtime ?? new CaptureRuntime({
      paths: this.paths,
      enabledPlatforms: options.enabledPlatforms,
      wslPollIntervalMs: options.wslPollIntervalMs,
      reconcileIntervalMs: options.reconcileIntervalMs,
      watch: options.watch,
      logger: this.logger,
      factories: options.factories,
    });
    this.lockDependencies = options.lockDependencies;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  }

  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.stopRequested || this.stopPromise) {
      return Promise.reject(new Error('Capture daemon is stopping'));
    }
    const operation = this.startInternal();
    this.startPromise = operation;
    operation.then(
      () => { if (this.startPromise === operation) this.startPromise = null; },
      () => { if (this.startPromise === operation) this.startPromise = null; },
    );
    return operation;
  }

  private async startInternal(): Promise<void> {
    try {
      await this.ownedFileLogger?.initialize();
      this.assertNotStopping();
      this.lock = await acquireDaemonLock(
        this.paths.lockPath,
        this.paths.socketPath,
        undefined,
        this.lockDependencies,
      );
      this.assertNotStopping();
      await this.prepareSocket();
      this.assertNotStopping();
      await this.listen();
      this.assertNotStopping();
      if (process.platform !== 'win32') await fs.chmod(this.paths.socketPath, 0o600);
      this.assertNotStopping();
      this.startHeartbeat();
      this.logger.info('Capture daemon IPC listening', {
        pid: process.pid,
        socketPath: this.paths.socketPath,
      });
      await this.runtime.start();
      this.assertNotStopping();
      this.started = true;
    } catch (error) {
      if (!this.stopRequested) {
        this.logger.error('Capture daemon failed to start', { error });
        await this.cleanupResources(true);
      }
      throw error;
    }
  }

  getStatus(): CaptureDaemonStatus {
    return {
      ...this.runtime.getStatus(),
      protocolVersion: CAPTURE_DAEMON_PROTOCOL_VERSION,
      socketPath: this.paths.socketPath,
      lockPath: this.paths.lockPath,
    };
  }

  async sync(reason = 'ipc'): Promise<CaptureSyncSummary> {
    return this.runtime.syncAll(reason);
  }

  requestShutdown(): void {
    setImmediate(() => {
      void this.stop().catch(error => this.logger.error('Capture daemon shutdown failed', { error }));
    });
  }

  stop(): Promise<void> {
    this.stopRequested = true;
    if (!this.runtimeClosePromise) {
      try {
        this.runtimeClosePromise = this.runtime.close();
      } catch (error) {
        this.runtimeClosePromise = Promise.reject(error);
      }
    }
    if (!this.stopPromise) {
      const starting = this.startPromise;
      const runtimeClosing = this.runtimeClosePromise;
      this.stopPromise = this.stopInternal(starting, runtimeClosing);
    }
    return this.stopPromise;
  }

  private async prepareSocket(): Promise<void> {
    await fs.mkdir(this.paths.runtimePath, { recursive: true });
    if (process.platform !== 'win32') {
      try {
        await fs.unlink(this.paths.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private listen(): Promise<void> {
    this.server = net.createServer(socket => this.acceptSocket(socket));
    return new Promise((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        // Errors after successful startup are logged without crashing Node.
        server.on('error', error => this.logger.error('Capture daemon IPC error', { error }));
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.paths.socketPath);
    });
  }

  private acceptSocket(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', error => this.logger.warn('Capture daemon client socket error', {
      error: errorMessage(error),
    }));

    const writeError = (error: Error, id = 'protocol-error'): void => {
      const code = error instanceof CaptureProtocolError ? error.code : 'INVALID_REQUEST';
      socket.write(encodeNdjson({
        id,
        ok: false,
        error: { code, message: error.message },
      } satisfies CaptureDaemonResponse));
    };
    const decoder = createNdjsonDecoder(value => {
      let request: CaptureDaemonRequest;
      try {
        request = parseCaptureDaemonRequest(value);
      } catch (error) {
        const id = value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
          ? (value as { id: string }).id
          : 'protocol-error';
        writeError(error instanceof Error ? error : new Error(String(error)), id);
        return;
      }
      void dispatchCaptureDaemonRequest(request, this)
        .then(response => socket.write(encodeNdjson(response)))
        .catch(error => writeError(error instanceof Error ? error : new Error(String(error)), request.id));
    }, writeError);
    socket.on('data', chunk => decoder.push(chunk));
    socket.on('end', () => decoder.end());
  }

  private startHeartbeat(): void {
    if (!this.lock || this.heartbeatIntervalMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      const lock = this.lock;
      if (!lock) return;
      void lock.heartbeat().catch(error => {
        if (this.lock !== lock || this.stopRequested) return;
        this.lockOwnershipLost = true;
        this.logger.error('Capture daemon lock heartbeat failed', { error });
        void this.stop().catch(stopError => {
          this.logger.error('Capture daemon safety shutdown failed', { error: stopError });
        });
      });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private async stopInternal(
    starting: Promise<void> | null,
    runtimeClosing: Promise<void>,
  ): Promise<void> {
    this.logger.info('Capture daemon stopping', { pid: process.pid });
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;

    const [startResult, closeResult] = await Promise.allSettled([
      starting ?? Promise.resolve(),
      runtimeClosing,
    ]);
    await this.cleanupResources(false);
    if (closeResult.status === 'rejected') throw closeResult.reason;
    // A shutdown-triggered startup cancellation is expected. An unrelated
    // startup failure has already been logged and its resources cleaned.
    if (startResult.status === 'rejected' && !this.stopRequested) throw startResult.reason;
  }

  private async cleanupResources(closeRuntime: boolean): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const ownedCoordination = this.lock !== null;
    const server = this.server;
    this.server = null;
    if (server) {
      for (const socket of this.sockets) socket.destroy();
      this.sockets.clear();
      if (server.listening) {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
    this.logger.info('Capture daemon IPC stopped', { pid: process.pid });
    try {
      if (closeRuntime) await this.runtime.close();
      this.logger.info('Capture runtime resources stopped', { pid: process.pid });
    } finally {
      if (process.platform !== 'win32' && ownedCoordination && !this.lockOwnershipLost) {
        try {
          await fs.unlink(this.paths.socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.logger.warn('Failed to remove capture daemon socket', { error });
          }
        }
      }
      await this.lock?.release();
      this.lock = null;
      this.started = false;
      this.logger.info('Capture daemon stopped', { pid: process.pid });
      await this.ownedFileLogger?.flush();
    }
  }

  private assertNotStopping(): void {
    if (this.stopRequested) throw new Error('Capture daemon startup was cancelled by shutdown');
  }
}
