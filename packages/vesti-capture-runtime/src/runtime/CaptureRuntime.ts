import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AdapterManager } from '../adapters/AdapterManager.js';
import { DatabaseManager } from '../storage/DatabaseManager.js';
import { SyncEngine } from '../sync/SyncEngine.js';
import { VaultManager } from '../storage/VaultManager.js';
import { WslDetector } from '../platform/WslDetector.js';
import { hostFromPath } from '../platform/PathResolver.js';
import type { AgentPlatform } from '../types/index.js';
import type { WslDetection } from '../platform/WslDetector.js';
import type { SyncResult } from '../sync/SyncEngine.js';
import { resolveRuntimePaths, type RuntimePaths } from './paths.js';
import { silentRuntimeLogger, type RuntimeLogger } from './logger.js';
import {
  DEFAULT_CAPTURE_PLATFORMS,
  type CaptureRuntimePlatform,
  type CaptureRuntimeState,
  type CaptureRuntimeStatus,
  type CaptureSourceStatus,
  type CaptureSyncSummary,
} from './types.js';

export interface CaptureRuntimeFactories {
  createDatabase(dbPath: string): DatabaseManager;
  createAdapters(): AdapterManager;
  createVault(vaultPath: string): VaultManager;
  createSyncEngine(adapters: AdapterManager, db: DatabaseManager, vault: VaultManager): SyncEngine;
  createWslDetector(): WslDetector;
}

export interface CaptureRuntimeOptions {
  basePath?: string;
  dbPath?: string;
  paths?: RuntimePaths;
  env?: NodeJS.ProcessEnv;
  enabledPlatforms?: readonly CaptureRuntimePlatform[];
  wslPollIntervalMs?: number;
  reconcileIntervalMs?: number;
  watch?: boolean;
  logger?: RuntimeLogger;
  factories?: Partial<CaptureRuntimeFactories>;
}

const DEFAULT_WSL_POLL_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000;

const defaultFactories: CaptureRuntimeFactories = {
  createDatabase: dbPath => new DatabaseManager(dbPath),
  createAdapters: () => new AdapterManager(),
  createVault: vaultPath => new VaultManager(vaultPath),
  createSyncEngine: (adapters, db, vault) => new SyncEngine(adapters, db, vault),
  createWslDetector: () => new WslDetector(),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptySummary(reason: string, startedAt: number): CaptureSyncSummary {
  return {
    reason,
    startedAt,
    completedAt: startedAt,
    sessions: 0,
    messages: 0,
    tools: 0,
    turns: 0,
    linksResolved: 0,
    errors: [],
  };
}

function addSyncResult(summary: CaptureSyncSummary, result: SyncResult): void {
  summary.sessions += result.sessionsProcessed;
  summary.messages += result.messagesStored;
  summary.tools += result.toolExecutionsStored;
  summary.turns += result.turnsStored;
  summary.errors.push(...result.errors);
}

class CaptureRuntimeClosingError extends Error {
  constructor() {
    super('Capture runtime startup was cancelled by shutdown');
    this.name = 'CaptureRuntimeClosingError';
  }
}

/**
 * Pure-Node capture lifecycle shared by the detached daemon and one-shot
 * tools. All database mutations are serialized through one queue.
 */
export class CaptureRuntime {
  readonly paths: RuntimePaths;
  readonly enabledPlatforms: CaptureRuntimePlatform[];
  readonly wslPollIntervalMs: number;
  readonly reconcileIntervalMs: number;

  private readonly logger: RuntimeLogger;
  private readonly factories: CaptureRuntimeFactories;
  private readonly watchEnabled: boolean;
  private state: CaptureRuntimeState = 'stopped';
  private startedAt: number | null = null;
  private watching = false;
  private syncing = false;
  private initialSyncComplete = false;
  private lastSync: CaptureSyncSummary | null = null;
  private lastError: string | null = null;
  private wslDetection: WslDetection | null = null;
  private wslPollTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closeRequested = false;
  private db: DatabaseManager | null = null;
  private adapters: AdapterManager | null = null;
  private vault: VaultManager | null = null;
  private syncEngine: SyncEngine | null = null;
  private readonly sourceStatuses = new Map<CaptureRuntimePlatform, CaptureSourceStatus>();

  constructor(options: CaptureRuntimeOptions = {}) {
    this.paths = options.paths ?? resolveRuntimePaths({
      basePath: options.basePath,
      dbPath: options.dbPath,
      env: options.env,
    });
    this.enabledPlatforms = [...new Set(
      (options.enabledPlatforms ?? DEFAULT_CAPTURE_PLATFORMS)
        .filter(platform => DEFAULT_CAPTURE_PLATFORMS.includes(platform)),
    )];
    this.wslPollIntervalMs = options.wslPollIntervalMs ?? DEFAULT_WSL_POLL_INTERVAL_MS;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.watchEnabled = options.watch ?? true;
    this.logger = options.logger ?? silentRuntimeLogger;
    this.factories = { ...defaultFactories, ...options.factories };
    for (const platform of DEFAULT_CAPTURE_PLATFORMS) {
      this.sourceStatuses.set(platform, {
        platform,
        enabled: this.enabledPlatforms.includes(platform),
        installed: null,
        sessionFileCount: null,
      });
    }
  }

  start(): Promise<void> {
    if (this.state === 'running') return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.closeRequested || this.closePromise) {
      return Promise.reject(new Error('Cannot start capture runtime while it is stopping'));
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
    this.state = 'starting';
    this.startedAt = Date.now();
    this.lastError = null;
    this.initialSyncComplete = false;

    try {
      await this.ensureDirectories();
      this.assertStartActive();
      this.db = this.factories.createDatabase(this.paths.dbPath);
      await this.db.initialize();
      this.assertStartActive();
      this.adapters = this.factories.createAdapters();
      this.vault = this.factories.createVault(this.paths.vaultPath);
      await this.vault.initialize();
      this.assertStartActive();
      this.syncEngine = this.factories.createSyncEngine(this.adapters, this.db, this.vault);
      await this.refreshWslDetection();
      this.assertStartActive();
      // Arm native watchers before the initial scan so edits made during a
      // long first import are queued instead of falling into a scan/watch gap.
      if (this.watchEnabled) await this.startWatching();
      this.assertStartActive();
      await this.syncAll('initial');
      this.assertStartActive();
      this.initialSyncComplete = true;
      this.startTimers();
      this.state = 'running';
      this.logger.info('Capture runtime ready', {
        pid: process.pid,
        basePath: this.paths.basePath,
        platforms: this.enabledPlatforms,
      });
    } catch (error) {
      const closing = this.closeRequested || error instanceof CaptureRuntimeClosingError;
      if (!closing) {
        this.lastError = errorMessage(error);
        this.logger.error('Capture runtime failed to start', { error });
      }
      await this.cleanupResources();
      this.state = closing ? 'stopped' : 'error';
      throw error;
    }
  }

  async syncAll(reason = 'manual'): Promise<CaptureSyncSummary> {
    if (!this.syncEngine || !this.adapters) {
      throw new Error('Capture runtime is not initialized');
    }
    return this.enqueueWrite(() => this.runFullSync(reason));
  }

  getStatus(): CaptureRuntimeStatus {
    const startedAt = this.startedAt;
    return {
      state: this.state,
      pid: process.pid,
      basePath: this.paths.basePath,
      dbPath: this.paths.dbPath,
      vaultPath: this.paths.vaultPath,
      startedAt,
      uptimeMs: startedAt === null ? 0 : Math.max(0, Date.now() - startedAt),
      watching: this.watching,
      syncing: this.syncing,
      initialSyncComplete: this.initialSyncComplete,
      enabledPlatforms: [...this.enabledPlatforms],
      sources: [...this.sourceStatuses.values()].map(source => ({ ...source })),
      wsl: this.wslDetection
        ? {
            ...this.wslDetection,
            distros: [...this.wslDetection.distros],
            homes: this.wslDetection.homes.map(home => ({ ...home, roots: { ...home.roots } })),
          }
        : null,
      lastSync: this.lastSync
        ? { ...this.lastSync, errors: [...this.lastSync.errors] }
        : null,
      lastError: this.lastError,
      wslPollIntervalMs: this.wslPollIntervalMs,
      reconcileIntervalMs: this.reconcileIntervalMs,
    };
  }

  close(): Promise<void> {
    this.closeRequested = true;
    if (this.closePromise) return this.closePromise;
    const operation = this.closeInternal();
    this.closePromise = operation;
    operation.then(
      () => {
        if (this.closePromise === operation) this.closePromise = null;
        this.closeRequested = false;
      },
      () => {
        if (this.closePromise === operation) this.closePromise = null;
        this.closeRequested = false;
      },
    );
    return operation;
  }

  private async closeInternal(): Promise<void> {
    const starting = this.startPromise;
    const hadResources = this.state !== 'stopped'
      || Boolean(this.db || this.adapters || this.vault || this.syncEngine || starting);
    if (!hadResources) return;
    this.state = 'stopping';
    this.stopTimers();
    await starting?.catch(() => undefined);
    await this.cleanupResources();
    this.state = 'stopped';
    this.logger.info('Capture runtime stopped', { pid: process.pid });
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.paths.basePath, { recursive: true, mode: 0o700 }),
      fs.mkdir(path.dirname(this.paths.dbPath), { recursive: true, mode: 0o700 }),
      fs.mkdir(this.paths.vaultPath, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.paths.logsPath, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.paths.runtimePath, { recursive: true, mode: 0o700 }),
      fs.mkdir(path.join(this.paths.basePath, 'config'), { recursive: true, mode: 0o700 }),
      fs.mkdir(path.join(this.paths.basePath, 'exports'), { recursive: true, mode: 0o700 }),
    ]);
  }

  private async runFullSync(reason: string): Promise<CaptureSyncSummary> {
    const adapters = this.requireAdapters();
    const syncEngine = this.requireSyncEngine();
    const startedAt = Date.now();
    const summary = emptySummary(reason, startedAt);
    this.syncing = true;
    try {
      for (const platform of this.enabledPlatforms) {
        this.assertStartActive();
        const adapter = adapters.getAdapter(platform);
        if (!adapter) {
          this.updateSourceError(platform, 'Adapter is unavailable');
          summary.errors.push(`${platform}: adapter is unavailable`);
          continue;
        }
        try {
          const detected = await adapter.detect();
          this.assertStartActive();
          if (!detected.installed) {
            this.updateSource(platform, false, 0);
            continue;
          }
          const files = await adapter.getSessionFiles();
          this.assertStartActive();
          this.updateSource(platform, true, files.length);
          if (files.length > 0) {
            addSyncResult(summary, await syncEngine.syncPlatform(platform, files, {
              // Reconciliation/manual sync must also see committed WAL rows
              // if a native event was missed or the source is inside WSL.
              force: platform === 'trae',
            }));
            this.assertStartActive();
          }
        } catch (error) {
          if (error instanceof CaptureRuntimeClosingError) throw error;
          const message = errorMessage(error);
          this.updateSourceError(platform, message);
          summary.errors.push(`${platform}: ${message}`);
        }
      }
      this.assertStartActive();
      try {
        summary.linksResolved = await syncEngine.resolveSubagentLinks();
      } catch (error) {
        if (error instanceof CaptureRuntimeClosingError) throw error;
        summary.errors.push(`subagent-links: ${errorMessage(error)}`);
      }
      this.assertStartActive();
      try {
        this.db?.refreshForkLineage();
      } catch (error) {
        summary.errors.push(`fork-lineage: ${errorMessage(error)}`);
      }
    } finally {
      this.syncing = false;
      summary.completedAt = Date.now();
      this.lastSync = summary;
      if (summary.errors.length > 0) {
        this.logger.warn('Capture sync completed with errors', { reason, errors: summary.errors });
      } else {
        this.logger.info('Capture sync completed', {
          reason,
          sessions: summary.sessions,
          messages: summary.messages,
          tools: summary.tools,
          turns: summary.turns,
        });
      }
    }
    return { ...summary, errors: [...summary.errors] };
  }

  private async startWatching(): Promise<void> {
    const adapters = this.requireAdapters();
    const watchedPlatforms = await adapters.startWatching((platform, filePath, event) => {
      if (!this.isEnabled(platform) || this.closeRequested
        || this.state === 'stopping' || this.state === 'stopped') return;
      void this.enqueueWrite(() => this.syncChangedFile(platform, filePath, event.force))
        .catch(error => this.logger.warn('Capture watch update failed', {
          platform,
          filePath,
          error: errorMessage(error),
        }));
    }, new Set<AgentPlatform>(this.enabledPlatforms), (platform, error) => {
      this.logger.warn('Capture watcher unavailable; reconciliation will retry', {
        platform,
        error: errorMessage(error),
      });
    });
    this.watching = watchedPlatforms.length > 0;
  }

  private async syncChangedFile(
    platform: CaptureRuntimePlatform,
    filePath: string,
    force = false,
  ): Promise<void> {
    const startedAt = Date.now();
    const stored = await this.requireSyncEngine().syncFile(platform, filePath, { force });
    if (!stored) return;
    let linksResolved = 0;
    try {
      linksResolved = await this.requireSyncEngine().resolveSubagentLinks();
    } catch (error) {
      this.logger.warn('Subagent link resolution failed after watch update', {
        error: errorMessage(error),
      });
    }
    this.lastSync = {
      reason: `watch:${platform}`,
      startedAt,
      completedAt: Date.now(),
      sessions: stored.sessions,
      messages: stored.messages,
      tools: stored.toolExecutions,
      turns: stored.turns,
      linksResolved,
      errors: [],
    };
    this.logger.info('Captured changed session file', {
      platform,
      filePath,
      messages: stored.messages,
    });
  }

  private startTimers(): void {
    if (this.wslPollIntervalMs > 0) {
      this.wslPollTimer = setInterval(() => {
        if (this.state !== 'running') return;
        void this.enqueueWrite(() => this.pollWslOnce())
          .catch(error => this.logger.warn('WSL capture poll failed', { error: errorMessage(error) }));
      }, this.wslPollIntervalMs);
      this.wslPollTimer.unref();
    }
    if (this.reconcileIntervalMs > 0) {
      this.reconcileTimer = setInterval(() => {
        if (this.state !== 'running') return;
        void this.reconcile().catch(error => this.logger.warn('Capture reconciliation failed', {
          error: errorMessage(error),
        }));
      }, this.reconcileIntervalMs);
      this.reconcileTimer.unref();
    }
  }

  private stopTimers(): void {
    if (this.wslPollTimer) clearInterval(this.wslPollTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.wslPollTimer = null;
    this.reconcileTimer = null;
  }

  private async reconcile(): Promise<void> {
    await this.refreshWslDetection();
    this.assertStartActive();
    if (this.watchEnabled) await this.startWatching();
    this.assertStartActive();
    await this.syncAll('reconcile');
  }

  private async refreshWslDetection(): Promise<void> {
    try {
      const detection = await this.factories.createWslDetector().detect();
      this.wslDetection = detection;
      this.adapters?.setWslHomes(
        detection.homes
          .filter(home => Object.keys(home.roots).length > 0)
          .map(home => ({ distro: home.distro, user: home.user, homeUnc: home.homeUnc })),
      );
    } catch (error) {
      this.logger.warn('WSL detection failed; native capture remains active', {
        error: errorMessage(error),
      });
    }
  }

  private async pollWslOnce(): Promise<void> {
    if (!this.wslDetection?.homes.some(home => Object.keys(home.roots).length > 0)) return;
    const startedAt = Date.now();
    const summary = emptySummary('wsl-poll', startedAt);
    const syncEngine = this.requireSyncEngine();
    for (const platform of this.enabledPlatforms) {
      this.assertStartActive();
      const adapter = this.requireAdapters().getAdapter(platform);
      if (!adapter) continue;
      try {
        const files = (await adapter.getSessionFiles())
          .filter(filePath => hostFromPath(filePath) !== 'native');
        for (const filePath of files) {
          const stored = await syncEngine.syncFile(platform, filePath, {
            force: platform === 'trae',
          });
          if (!stored) continue;
          summary.sessions += stored.sessions;
          summary.messages += stored.messages;
          summary.tools += stored.toolExecutions;
          summary.turns += stored.turns;
        }
      } catch (error) {
        summary.errors.push(`${platform}: ${errorMessage(error)}`);
      }
    }
    if (summary.sessions > 0 || summary.messages > 0 || summary.tools > 0) {
      try {
        summary.linksResolved = await syncEngine.resolveSubagentLinks();
      } catch (error) {
        summary.errors.push(`subagent-links: ${errorMessage(error)}`);
      }
      summary.completedAt = Date.now();
      this.lastSync = summary;
      this.logger.info('WSL capture poll stored changes', {
        sessions: summary.sessions,
        messages: summary.messages,
      });
    }
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.catch(() => undefined).then(operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async cleanupResources(): Promise<void> {
    this.stopTimers();
    if (this.adapters) {
      try {
        await this.adapters.stopWatching();
      } catch (error) {
        this.logger.warn('Failed to stop one or more capture watchers', { error: errorMessage(error) });
      }
    }
    this.watching = false;
    await this.writeQueue.catch(() => undefined);
    if (this.vault) {
      try {
        await this.vault.waitForIdle();
      } catch (error) {
        this.logger.warn('Failed while draining capture vault backups', { error: errorMessage(error) });
      }
    }
    if (this.db) {
      try {
        await this.db.close();
      } catch (error) {
        this.logger.warn('Failed to close capture database', { error: errorMessage(error) });
      }
    }
    this.syncEngine = null;
    this.vault = null;
    this.adapters = null;
    this.db = null;
  }

  private assertStartActive(): void {
    if (this.closeRequested || this.state === 'stopping' || this.state === 'stopped') {
      throw new CaptureRuntimeClosingError();
    }
  }

  private updateSource(platform: CaptureRuntimePlatform, installed: boolean, fileCount: number): void {
    this.sourceStatuses.set(platform, {
      platform,
      enabled: true,
      installed,
      sessionFileCount: fileCount,
    });
  }

  private updateSourceError(platform: CaptureRuntimePlatform, message: string): void {
    const previous = this.sourceStatuses.get(platform);
    this.sourceStatuses.set(platform, {
      platform,
      enabled: true,
      installed: previous?.installed ?? null,
      sessionFileCount: previous?.sessionFileCount ?? null,
      lastError: message,
    });
  }

  private isEnabled(platform: AgentPlatform): platform is CaptureRuntimePlatform {
    return this.enabledPlatforms.includes(platform as CaptureRuntimePlatform);
  }

  private requireAdapters(): AdapterManager {
    if (!this.adapters) throw new Error('Capture adapters are not initialized');
    return this.adapters;
  }

  private requireSyncEngine(): SyncEngine {
    if (!this.syncEngine) throw new Error('Capture sync engine is not initialized');
    return this.syncEngine;
  }
}
