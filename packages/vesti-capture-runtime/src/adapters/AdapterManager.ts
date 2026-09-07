/**
 * Adapter Manager
 * Registry + file watching for all agent adapters
 */

import { EventEmitter } from 'events';
import chokidar, { type FSWatcher } from 'chokidar';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../types/agent.js';
import type { AgentPlatform } from '../types/index.js';
import { nativeHomeRoot, type HomeRoot, wslHostTag } from '../platform/PathResolver.js';
import { AiderAdapter } from './aider/adapter.js';
import { ClaudeCodeAdapter } from './claude-code/adapter.js';
import { CoderAdapter } from './coder/adapter.js';
import { CodexAdapter } from './codex/adapter.js';
import { CursorAdapter } from './cursor/adapter.js';
import { KimiCodeAdapter } from './kimi-code/adapter.js';
import { TraeAdapter } from './trae/adapter.js';
import { WorkBuddyAdapter } from './workbuddy/adapter.js';

interface WatchState {
  watcher: FSWatcher;
  platform: AgentPlatform;
}

export interface AdapterWatchEvent {
  /** Actual path reported by chokidar. */
  sourcePath: string;
  /** Canonical session source handed to SyncEngine. */
  filePath: string;
  /** Bypass the canonical file's unchanged-size/mtime checkpoint. */
  force: boolean;
}

export function normalizeAdapterWatchEvent(
  platform: AgentPlatform,
  sourcePath: string,
): AdapterWatchEvent {
  const isTraeSidecar = platform === 'trae'
    && /(?:^|[\\/])state\.vscdb-(?:wal|shm)$/i.test(sourcePath);
  return {
    sourcePath,
    filePath: isTraeSidecar ? sourcePath.replace(/-(?:wal|shm)$/i, '') : sourcePath,
    force: isTraeSidecar,
  };
}

export class AdapterManager extends EventEmitter {
  private adapters = new Map<AgentPlatform, AgentAdapter>();
  private watchers = new Map<AgentPlatform, WatchState>();
  private watchPlan: Promise<void> = Promise.resolve();

  constructor() {
    super();
    // Register built-in adapters
    this.register(new AiderAdapter());
    this.register(new ClaudeCodeAdapter());
    this.register(new CoderAdapter());
    this.register(new CodexAdapter());
    this.register(new CursorAdapter());
    this.register(new KimiCodeAdapter());
    this.register(new TraeAdapter());
    this.register(new WorkBuddyAdapter());
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  getAdapter(platform: AgentPlatform): AgentAdapter | undefined {
    return this.adapters.get(platform);
  }

  /**
   * Push WSL homes discovered by WslDetector into every adapter that
   * supports multi-root capture. The native home always stays first.
   */
  setWslHomes(wslHomes: Array<{ distro: string; user: string; homeUnc: string }>): void {
    const homes: HomeRoot[] = [
      nativeHomeRoot(),
      ...wslHomes.map(home => ({ host: wslHostTag(home.distro, home.user), homeDir: home.homeUnc })),
    ];
    for (const adapter of this.adapters.values()) {
      adapter.setHomeRoots?.(homes);
    }
  }

  /**
   * Detect all installed agent platforms
   */
  async detectAll(): Promise<Map<AgentPlatform, AgentDetectResult>> {
    const results = new Map<AgentPlatform, AgentDetectResult>();
    for (const [platform, adapter] of this.adapters) {
      results.set(platform, await adapter.detect());
    }
    return results;
  }

  /**
   * Get all session files across all adapters
   */
  async getAllSessionFiles(): Promise<Array<{ platform: AgentPlatform; filePath: string }>> {
    const files: Array<{ platform: AgentPlatform; filePath: string }> = [];
    for (const [platform, adapter] of this.adapters) {
      const detected = await adapter.detect();
      if (detected.installed) {
        const sessionFiles = await adapter.getSessionFiles();
        for (const filePath of sessionFiles) {
          files.push({ platform, filePath });
        }
      }
    }
    return files;
  }

  /**
   * Parse a session file using the appropriate adapter
   */
  async parseSession(platform: AgentPlatform, filePath: string): Promise<ParsedSession> {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`No adapter for platform: ${platform}`);
    return adapter.parseSession(filePath);
  }

  async parseSessions(platform: AgentPlatform, filePath: string): Promise<ParsedSession[]> {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`No adapter for platform: ${platform}`);
    return adapter.parseSessions
      ? adapter.parseSessions(filePath)
      : [await adapter.parseSession(filePath)];
  }

  /**
   * Start watching all installed adapters for file changes
   */
  async startWatching(
    onChange: (platform: AgentPlatform, filePath: string, event: AdapterWatchEvent) => void,
    enabledPlatforms?: ReadonlySet<AgentPlatform>,
    onError?: (platform: AgentPlatform, error: unknown) => void,
  ): Promise<AgentPlatform[]> {
    const plan = this.watchPlan.catch(() => undefined).then(async () => {
      await this.planWatchers(onChange, enabledPlatforms, onError);
    });
    this.watchPlan = plan.then(() => undefined, () => undefined);
    await plan;
    return [...this.watchers.keys()];
  }

  private async planWatchers(
    onChange: (platform: AgentPlatform, filePath: string, event: AdapterWatchEvent) => void,
    enabledPlatforms?: ReadonlySet<AgentPlatform>,
    onError?: (platform: AgentPlatform, error: unknown) => void,
  ): Promise<void> {
    for (const [platform, adapter] of this.adapters) {
      if (enabledPlatforms && !enabledPlatforms.has(platform)) continue;
      if (this.watchers.has(platform)) continue;
      try {
      const detected = await adapter.detect();
      if (!detected.installed) continue;

      // UNC (WSL) roots are excluded: Node fs.watch cannot watch UNC
      // directories (EISDIR), so WSL sources rely on the polling fallback in
      // CaptureService instead of chokidar events.
      const patterns = adapter
        .getWatchPatterns()
        .filter((p) => !p.startsWith('\\\\') && !p.startsWith('//'));
      if (patterns.length === 0) continue;

      const watcher = chokidar.watch(patterns, {
        persistent: true,
        ignoreInitial: true,
        // Subagent files are watched too so subagent_links resolve; they are
        // append-heavy like main transcripts, and awaitWriteFinish already
        // debounces events until writes settle.
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });

      const forward = (sourcePath: string): void => {
        const event = normalizeAdapterWatchEvent(platform, sourcePath);
        onChange(platform, event.filePath, event);
      };
      watcher.on('add', forward);
      watcher.on('change', forward);
      // Main database deletion has no parseable source. Sidecar deletion,
      // however, commonly follows a WAL checkpoint and should re-read the
      // canonical state.vscdb one final time.
      watcher.on('unlink', (sourcePath) => {
        const event = normalizeAdapterWatchEvent(platform, sourcePath);
        if (event.force) onChange(platform, event.filePath, event);
      });
      // A watcher error must never surface as an unhandled rejection — the
      // sync/polling paths remain the source of truth.
      watcher.on('error', error => onError?.(platform, error));

      this.watchers.set(platform, { watcher, platform });
      } catch (error) {
        // Adapter failures are isolated. Reconciliation retries platforms
        // that did not successfully establish a watcher.
        onError?.(platform, error);
      }
    }
  }

  /**
   * Stop all watchers
   */
  async stopWatching(): Promise<void> {
    const stop = this.watchPlan.catch(() => undefined).then(async () => {
      const watchers = [...this.watchers.values()];
      this.watchers.clear();
      const results = await Promise.allSettled(watchers.map(({ watcher }) => watcher.close()));
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, 'Failed to close capture watchers');
    });
    this.watchPlan = stop.then(() => undefined, () => undefined);
    await stop;
  }
}
