/**
 * Sync Engine v2
 * Orchestrates: detect → parse → convert → store → checkpoint → queued vault backup
 */

import fs from 'fs-extra';
import path from 'path';
import type { AgentPlatform } from '../types/index.js';
import type { SubagentLink } from '../types/unified.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { DatabaseManager } from '../storage/DatabaseManager.js';
import type { VaultManager } from '../storage/VaultManager.js';
import type { ClaudeCodeAdapter } from '../adapters/claude-code/adapter.js';
import { hostFromPath, rewriteSessionIdForHost } from '../platform/PathResolver.js';
import { MessageConverter } from '../storage/MessageConverter.js';
import type { TokenUsageEvent } from '../types/unified.js';
import type { ParsedSession } from '../types/agent.js';

interface CodexChildActivityMeta {
  childThreadId: string;
  parentSourceTurnId: string;
  timestamp: number;
  callId: string;
}

interface CodexChildTaskRunMeta {
  sourceTurnId: string;
  timestamp: number;
}

interface CodexParsedFile {
  filePath: string;
  host: string;
  physicalSourceScope: string;
  size: number;
  mtimeMs: number;
  sessions: ParsedSession[];
}

function metadataRows<T>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object') as T[]
    : [];
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/**
 * Merge every physical Codex rollout that shares one logical session. Child
 * runs are assigned only through explicit activity metadata resolved back to
 * a root task. Unmatched fragments remain stored but intentionally have no
 * task membership.
 */
export function mergeCodexLogicalSession(sessions: ParsedSession[]): ParsedSession | undefined {
  const visible = sessions.filter(session => session.meta?.capture_usage_only !== true);
  if (visible.length === 0) return undefined;

  const roots = visible
    .filter(session => session.meta?.capture_append_only !== true)
    .sort((left, right) => Number(left.meta?.archived === true) - Number(right.meta?.archived === true));
  const basis = roots[0] ?? visible[0];
  let resolvedActivities = dedupeBy(
    roots.flatMap(session => metadataRows<CodexChildActivityMeta>(session.meta?.codex_child_activities))
      .sort((left, right) => left.timestamp - right.timestamp),
    activity => activity.callId,
  );

  // Resolve the rollout graph level by level. A child can launch or reuse a
  // grandchild using its own task id, so that activity must first be rewritten
  // to the already-resolved root task before the grandchild can be mapped.
  const parentByChildTurnForSession = new Map<ParsedSession, Map<string, string>>();
  const pendingChildren = new Set(
    visible.filter(session => session.meta?.capture_append_only === true),
  );
  let madeProgress = true;
  while (madeProgress) {
    madeProgress = false;
    for (const session of [...pendingChildren]) {
      const rolloutId = typeof session.meta?.codex_rollout_id === 'string'
        ? session.meta.codex_rollout_id
        : '';
      const parentActivities = resolvedActivities
        .filter(activity => activity.childThreadId === rolloutId)
        .sort((left, right) => left.timestamp - right.timestamp);
      const runs = metadataRows<CodexChildTaskRunMeta>(session.meta?.codex_child_task_runs)
        .sort((left, right) => left.timestamp - right.timestamp);
      if (parentActivities.length === 0 || runs.length === 0) continue;

      const parentByChildTurn = new Map<string, string>();
      for (let index = 0; index < Math.min(runs.length, parentActivities.length); index += 1) {
        parentByChildTurn.set(runs[index].sourceTurnId, parentActivities[index].parentSourceTurnId);
      }
      if (parentByChildTurn.size === 0) continue;

      parentByChildTurnForSession.set(session, parentByChildTurn);
      pendingChildren.delete(session);
      madeProgress = true;

      const nestedActivities = metadataRows<CodexChildActivityMeta>(session.meta?.codex_child_activities)
        .flatMap(activity => {
          const rootSourceTurnId = parentByChildTurn.get(activity.parentSourceTurnId);
          return rootSourceTurnId
            ? [{ ...activity, parentSourceTurnId: rootSourceTurnId }]
            : [];
        });
      resolvedActivities = dedupeBy(
        [...resolvedActivities, ...nestedActivities]
          .sort((left, right) => left.timestamp - right.timestamp),
        activity => activity.callId,
      );
    }
  }

  const messages = visible.flatMap(session => {
    if (session.meta?.capture_append_only !== true) return session.messages;
    const parentByChildTurn = parentByChildTurnForSession.get(session);
    return session.messages.map(message => {
      const parentSourceTurnId = message.sourceTurnId
        ? parentByChildTurn?.get(message.sourceTurnId)
        : undefined;
      if (!parentSourceTurnId) return message;
      return {
        ...message,
        sourceTurnId: parentSourceTurnId,
        // A child agent's final is process material for the parent task. The
        // root agent's own final remains the visible answer; when it is absent,
        // the projection falls back to the last process text.
        assistantPhase: message.role === 'assistant' && message.contentText
          ? 'commentary'
          : message.assistantPhase,
      };
    });
  });

  const contextCompactions = dedupeBy(
    visible.flatMap(session => session.contextCompactions ?? [])
      .sort((left, right) => left.compactedAt - right.compactedAt),
    compaction => `${compaction.compactedAt}:${compaction.summary ?? ''}`,
  ).map((compaction, index) => ({ ...compaction, sequence: index + 1 }));
  const models = new Set<string>();
  for (const session of visible) {
    for (const model of session.tokenUsage.models) models.add(model);
  }
  const endTimes = visible.flatMap(session => session.endTime === undefined ? [] : [session.endTime]);

  return {
    ...basis,
    messages: dedupeBy(
      messages.sort((left, right) => left.timestamp - right.timestamp),
      message => message.uuid,
    ),
    toolExecutions: dedupeBy(
      visible.flatMap(session => session.toolExecutions).sort((left, right) => left.timestamp - right.timestamp),
      execution => execution.id,
    ),
    subagents: dedupeBy(
      visible.flatMap(session => session.subagents),
      subagent => `${subagent.agentId}:${subagent.filePath}`,
    ),
    tokenUsage: {
      totalInputTokens: visible.reduce((sum, session) => sum + session.tokenUsage.totalInputTokens, 0),
      totalOutputTokens: visible.reduce((sum, session) => sum + session.tokenUsage.totalOutputTokens, 0),
      totalCacheCreationTokens: visible.reduce((sum, session) => sum + session.tokenUsage.totalCacheCreationTokens, 0),
      totalCacheReadTokens: visible.reduce((sum, session) => sum + session.tokenUsage.totalCacheReadTokens, 0),
      models,
    },
    tokenUsageEvents: visible.flatMap(session => session.tokenUsageEvents ?? []),
    startTime: Math.min(...visible.map(session => session.startTime)),
    endTime: endTimes.length ? Math.max(...endTimes) : undefined,
    contextCompactions: contextCompactions.length ? contextCompactions : undefined,
    sourceFileKey: undefined,
    meta: {
      ...basis.meta,
      capture_append_only: undefined,
      capture_strict_native_turns: true,
      codex_merged_rollout_count: visible.length,
    },
    warnings: dedupeBy(visible.flatMap(session => session.warnings ?? []), warning => warning),
  };
}

/** Stable replacement key for one physical sync candidate. */
export function sourceFileKey(platform: AgentPlatform, filePath: string, host: string): string {
  let normalized = path.resolve(filePath).replace(/\\/g, '/');
  if (process.platform === 'win32' && host === 'native') normalized = normalized.toLowerCase();
  return `${platform}:${host}:${normalized}`;
}

export interface SyncResult {
  platform: AgentPlatform;
  sessionsProcessed: number;
  messagesStored: number;
  toolExecutionsStored: number;
  turnsStored: number;
  errors: string[];
}

export interface SyncFileResult {
  sessions: number;
  messages: number;
  toolExecutions: number;
  turns: number;
}

export interface SyncFileOptions {
  /** Parse even when the canonical source's size/mtime checkpoint is unchanged. */
  force?: boolean;
}

export class SyncEngine {
  private vault?: VaultManager;
  private codexSyncQueue: Promise<void> = Promise.resolve();
  /**
   * Child-side links whose parent session was not stored yet (FK on
   * parent_session_id rejected them). Retried at the top of every
   * resolveSubagentLinks() call — each sync path runs one after storing
   * sessions, so a child-first event order still lands its link in the same
   * sync round.
   */
  private pendingSubagentLinks = new Map<string, SubagentLink>();

  constructor(
    private adapters: AdapterManager,
    private db: DatabaseManager,
    vault?: VaultManager,
  ) {
    this.vault = vault;
  }

  /**
   * Full sync: scan all session files and import new data
   */
  async syncAll(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const allFiles = await this.adapters.getAllSessionFiles();

    // Group by platform
    const byPlatform = new Map<AgentPlatform, string[]>();
    for (const { platform, filePath } of allFiles) {
      if (!byPlatform.has(platform)) byPlatform.set(platform, []);
      byPlatform.get(platform)!.push(filePath);
    }

    for (const [platform, files] of byPlatform) {
      const result = await this.syncPlatform(platform, files);
      results.push(result);
    }

    // Resolve subagent links after all sessions are synced
    await this.resolveSubagentLinks();
    // Fork lineage (memory v2): codex rollouts copy the parent's history into
    // the child, so forks are detected post-sync by message-id overlap.
    try {
      this.db.refreshForkLineage();
    } catch { /* lineage detection must never break the sync */ }

    return results;
  }

  /**
   * Sync a single platform's files
   */
  async syncPlatform(
    platform: AgentPlatform,
    files: string[],
    options: SyncFileOptions = {},
  ): Promise<SyncResult> {
    const result: SyncResult = {
      platform,
      sessionsProcessed: 0,
      messagesStored: 0,
      toolExecutionsStored: 0,
      turnsStored: 0,
      errors: [],
    };

    if (platform === 'codex') {
      const codexErrors: string[] = [];
      try {
        const stored = await this.queueCodexFiles(files, codexErrors);
        if (stored) {
          result.sessionsProcessed += stored.sessions;
          result.messagesStored += stored.messages;
          result.toolExecutionsStored += stored.toolExecutions;
          result.turnsStored += stored.turns;
        }
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
      }
      result.errors.push(...codexErrors);
      return result;
    }

    for (const filePath of [...files].sort((left, right) => left.localeCompare(right))) {
      try {
        const stored = await this.syncFile(platform, filePath, options);
        if (stored) {
          result.sessionsProcessed += stored.sessions;
          result.messagesStored += stored.messages;
          result.toolExecutionsStored += stored.toolExecutions;
          result.turnsStored += stored.turns;
        }
      } catch (err) {
        result.errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  }

  /**
   * Sync a single file, using incremental position tracking
   */
  async syncFile(
    platform: AgentPlatform,
    filePath: string,
    options: SyncFileOptions = {},
  ): Promise<SyncFileResult | null> {
    if (platform === 'codex') {
      const errors: string[] = [];
      const result = await this.queueCodexFiles([filePath], errors);
      if (errors.length > 0) throw new Error(errors.join('\n'));
      return result;
    }
    return this.syncOrdinaryFile(platform, filePath, options);
  }

  private async syncOrdinaryFile(
    platform: AgentPlatform,
    filePath: string,
    options: SyncFileOptions,
  ): Promise<SyncFileResult | null> {
    const syncState = this.db.getSyncState(filePath);
    const parserVersion = this.adapters.getAdapter(platform)?.parserVersion ?? 0;
    const isParserUpgrade = Boolean(syncState && syncState.parserVersion < parserVersion);

    // Skip only when the file is unchanged AND it was last parsed by a
    // parser at least as capable as the current one — an adapter upgrade
    // (new lineage/usage extraction) must re-parse old files.
    const { size, mtimeMs } = await fs.stat(filePath);
    if (
      !options.force &&
      syncState &&
      syncState.lastPosition === size &&
      syncState.lastModified >= mtimeMs &&
      syncState.parserVersion >= parserVersion
    ) {
      return null; // No new data
    }

    const host = hostFromPath(filePath);
    const physicalSourceScope = sourceFileKey(platform, filePath, host);
    const sessions = await this.adapters.parseSessions(platform, filePath);
    if (sessions.length === 0) {
      this.db.replaceTokenUsageEvents(physicalSourceScope, []);
      this.db.setSyncState(filePath, platform, size, mtimeMs, undefined, undefined, parserVersion);
      return null;
    }

    // Source host ('native' or 'wsl:<distro>'), derived from the file path.

    const adapter = this.adapters.getAdapter(platform);

    const totals: SyncFileResult = {
      sessions: 0,
      messages: 0,
      toolExecutions: 0,
      turns: 0,
    };
    let linkDeferred = false;
    const sourceTokenUsageEvents: TokenUsageEvent[] = [];

    for (const session of sessions) {
      // Some agents can report a completed model invocation even when no
      // displayable text message was persisted (for example a tool-only or
      // interrupted turn). Keep those usage events in the time series.
      if (
        !isParserUpgrade
        && session.messages.length === 0
        && (session.tokenUsageEvents?.length ?? 0) === 0
      ) continue;

      // Load supplemental session-meta for Claude Code.
      if (platform === 'claude-code') {
        try {
          const claudeAdapter = adapter as ClaudeCodeAdapter;
          const meta = await claudeAdapter.getSessionMeta(session.sessionId);
          if (meta) session.meta = meta as Record<string, unknown>;
        } catch { /* non-fatal */ }
      }

      // Tag the host and give WSL sessions a distinct id so the same
      // sessionId captured natively and inside WSL never collides in
      // work_sessions. Done after the meta lookup, which keys on the
      // original sessionId.
      session.host = host;
      session.sourceFileKey = physicalSourceScope;
      if (host !== 'native') {
        session.sessionId = rewriteSessionIdForHost(session.sessionId, host);
      }

      const converted = MessageConverter.convertV2(session);
      if (session.meta?.capture_usage_only === true) {
        sourceTokenUsageEvents.push(...converted.tokenUsageEvents);
        continue;
      }
      const previousMessageCount = this.db.getSessionMessageCount(converted.session.id);
      const previousToolCount = this.db.getUnifiedToolExecutions(converted.session.id).length;
      const previousTurnCount = this.db.getTurns(converted.session.id).length;

      if (isParserUpgrade && session.meta?.capture_append_only !== true) {
        this.db.replaceSessionSnapshot(converted);
      } else {
        // Streaming updates use stable IDs and remain monotonic between parser
        // versions; exact deletion is reserved for a known full re-parse.
        this.db.upsertWorkSession(converted.session);
        this.db.insertSessionMessages(converted.messages);
        this.db.insertUnifiedToolExecutions(converted.toolExecutions);
        this.db.insertTurns(converted.turns);
        this.db.insertSystemEvents(converted.systemEvents);
        this.db.insertContextCompactions(converted.contextCompactions);
      }
      sourceTokenUsageEvents.push(...converted.tokenUsageEvents);

      for (const link of converted.subagentLinks) {
        try {
          this.db.insertSubagentLink(link);
        } catch (err) {
          // Child-side lineage (kimi-code sub wire, Cursor background agent)
          // can arrive before the parent session is stored; the FK on
          // parent_session_id rejects the row. Queue it for the next
          // resolveSubagentLinks() run and leave sync_state unset so the
          // file re-parses (and retries) after a restart too.
          if ((err as { code?: string })?.code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') throw err;
          this.pendingSubagentLinks.set(link.id, link);
          linkDeferred = true;
        }
      }

      totals.sessions++;
      totals.messages += Math.max(0, converted.messages.length - previousMessageCount);
      totals.toolExecutions += Math.max(0, converted.toolExecutions.length - previousToolCount);
      totals.turns += Math.max(0, converted.turns.length - previousTurnCount);
    }

    // One physical candidate can yield several logical sessions. Replace its
    // complete event snapshot once so those sessions cannot erase each other.
    this.db.replaceTokenUsageEvents(physicalSourceScope, sourceTokenUsageEvents);

    // Update sync state. Skipped while a subagent link is deferred: the file
    // must re-parse later so the link retries even without a file change.
    const onlySession = sessions.length === 1 ? sessions[0] : undefined;
    if (!linkDeferred) {
      this.db.setSyncState(
        filePath,
        platform,
        size,
        mtimeMs,
        onlySession?.sessionId,
        onlySession ? `${platform}:${onlySession.sessionId}` : undefined,
        parserVersion,
      );
    }

    // Captured data and its checkpoint are durable before archival work starts.
    // VaultManager serializes compression globally; intentionally do not await
    // this promise so a growing JSONL or a failed archive cannot delay capture.
    if (this.vault && adapter?.shouldBackupSource !== false) {
      void this.vault.backup(
        filePath,
        platform,
        onlySession?.sessionId,
        host,
      ).catch(() => undefined);
    }

    return totals.sessions > 0 ? totals : null;
  }

  private queueCodexFiles(files: string[], errors: string[]): Promise<SyncFileResult | null> {
    const run = this.codexSyncQueue
      .catch(() => undefined)
      .then(() => this.syncCodexFiles(files, errors));
    this.codexSyncQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Codex can persist one logical task across a root rollout plus several
   * child rollouts. Rebuild the complete logical session in one transaction
   * whenever any physical member changes or has a stale parser version.
   */
  private async syncCodexFiles(
    requestedFiles: string[],
    errors: string[],
  ): Promise<SyncFileResult | null> {
    const adapter = this.adapters.getAdapter('codex');
    if (!adapter) throw new Error('No adapter for platform: codex');
    const parserVersion = adapter.parserVersion ?? 0;
    const candidatePaths = new Set(requestedFiles);
    const failedPaths = new Set<string>();
    const failedConversationIds = new Set<string>();
    const recordFailure = (filePath: string, error: unknown): void => {
      if (failedPaths.has(filePath)) return;
      failedPaths.add(filePath);
      const conversationId = this.db.getSyncState(filePath)?.conversationId;
      if (conversationId) failedConversationIds.add(conversationId);
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${filePath}: ${message}`);
    };

    // A watcher can report a currently parsed child while its root still has
    // an older parser checkpoint. Pull known siblings into the same decision.
    for (const filePath of requestedFiles) {
      const state = this.db.getSyncState(filePath);
      if (!state?.conversationId) continue;
      for (const sibling of this.db.getSyncFilesForConversation(state.conversationId)) {
        candidatePaths.add(sibling.filePath);
      }
    }

    const stats = new Map<string, { size: number; mtimeMs: number }>();
    const dirtyPaths = new Set<string>();
    for (const filePath of candidatePaths) {
      try {
        if (!(await fs.pathExists(filePath))) {
          // Codex normally moves completed rollouts from sessions/ to
          // archived_sessions/. Retire a checkpoint whose source disappeared;
          // a newly discovered archived path will receive its own checkpoint.
          // Only an unknown requested path is an actual sync error.
          if (this.db.getSyncState(filePath)) this.db.deleteSyncState(filePath);
          else if (requestedFiles.includes(filePath)) {
            recordFailure(filePath, new Error('Codex rollout not found'));
          }
          continue;
        }
        const stat = await fs.stat(filePath);
        const info = { size: stat.size, mtimeMs: stat.mtimeMs };
        stats.set(filePath, info);
        const state = this.db.getSyncState(filePath);
        if (
          !state
          || state.lastPosition !== info.size
          || state.lastModified < info.mtimeMs
          || state.parserVersion < parserVersion
        ) {
          dirtyPaths.add(filePath);
        }
      } catch (error) {
        recordFailure(filePath, error);
      }
    }
    if (dirtyPaths.size === 0) return null;

    const parsedFiles = new Map<string, CodexParsedFile>();
    const parsePhysicalFile = async (filePath: string): Promise<CodexParsedFile | undefined> => {
      if (failedPaths.has(filePath)) return undefined;
      const existing = parsedFiles.get(filePath);
      if (existing) return existing;
      try {
        if (!(await fs.pathExists(filePath))) {
          if (this.db.getSyncState(filePath)) this.db.deleteSyncState(filePath);
          else if (requestedFiles.includes(filePath)) {
            recordFailure(filePath, new Error('Codex rollout not found'));
          }
          return undefined;
        }
        const stat = stats.get(filePath) ?? await fs.stat(filePath);
        stats.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs });
        const host = hostFromPath(filePath);
        const physicalSourceScope = sourceFileKey('codex', filePath, host);
        const sessions = await this.adapters.parseSessions('codex', filePath);
        for (const session of sessions) {
          session.host = host;
          session.sourceFileKey = physicalSourceScope;
          if (host !== 'native') session.sessionId = rewriteSessionIdForHost(session.sessionId, host);
        }
        const parsed: CodexParsedFile = {
          filePath,
          host,
          physicalSourceScope,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sessions,
        };
        parsedFiles.set(filePath, parsed);
        return parsed;
      } catch (error) {
        recordFailure(filePath, error);
        return undefined;
      }
    };

    const affectedConversationIds = new Set<string>();
    for (const filePath of dirtyPaths) {
      const parsed = await parsePhysicalFile(filePath);
      for (const session of parsed?.sessions ?? []) {
        affectedConversationIds.add(`codex:${session.sessionId}`);
      }
    }

    // First import has every requested file dirty. Later updates discover
    // unchanged siblings through sync_state and still reparse the full group.
    for (const conversationId of [...affectedConversationIds]) {
      for (const sibling of this.db.getSyncFilesForConversation(conversationId)) {
        candidatePaths.add(sibling.filePath);
      }
    }
    for (const filePath of candidatePaths) {
      await parsePhysicalFile(filePath);
    }

    const grouped = new Map<string, ParsedSession[]>();
    for (const parsed of parsedFiles.values()) {
      for (const session of parsed.sessions) {
        const conversationId = `codex:${session.sessionId}`;
        if (!affectedConversationIds.has(conversationId)) continue;
        const existing = grouped.get(conversationId);
        if (existing) existing.push(session);
        else grouped.set(conversationId, [session]);
      }
    }

    const totals: SyncFileResult = { sessions: 0, messages: 0, toolExecutions: 0, turns: 0 };
    for (const [conversationId, sessions] of grouped) {
      if (failedConversationIds.has(conversationId)) continue;
      const merged = mergeCodexLogicalSession(sessions);
      if (!merged) continue;
      const converted = MessageConverter.convertV2(merged);
      const previousMessageCount = this.db.getSessionMessageCount(conversationId);
      const previousToolCount = this.db.getUnifiedToolExecutions(conversationId).length;
      const previousTurnCount = this.db.getTurns(conversationId).length;
      this.db.replaceSessionSnapshot(converted);
      for (const link of converted.subagentLinks) this.db.insertSubagentLink(link);

      totals.sessions += 1;
      totals.messages += Math.max(0, converted.messages.length - previousMessageCount);
      totals.toolExecutions += Math.max(0, converted.toolExecutions.length - previousToolCount);
      totals.turns += Math.max(0, converted.turns.length - previousTurnCount);
    }

    // Usage remains physically replaceable even though the visible session is
    // assembled across files. Convert each source separately to retain scope.
    for (const parsed of parsedFiles.values()) {
      const sourceEvents: TokenUsageEvent[] = [];
      for (const session of parsed.sessions) {
        const conversationId = `codex:${session.sessionId}`;
        if (!affectedConversationIds.has(conversationId) || failedConversationIds.has(conversationId)) continue;
        sourceEvents.push(...MessageConverter.convertV2(session).tokenUsageEvents);
      }
      const hasStoredSession = parsed.sessions.some(session =>
        this.db.getWorkSession(`codex:${session.sessionId}`) !== null,
      );
      if (hasStoredSession || sourceEvents.length === 0) {
        this.db.replaceTokenUsageEvents(parsed.physicalSourceScope, sourceEvents);
      }
    }

    for (const parsed of parsedFiles.values()) {
      if (parsed.sessions.some(session => failedConversationIds.has(`codex:${session.sessionId}`))) {
        continue;
      }
      const onlySession = parsed.sessions.length === 1 ? parsed.sessions[0] : undefined;
      this.db.setSyncState(
        parsed.filePath,
        'codex',
        parsed.size,
        parsed.mtimeMs,
        onlySession?.sessionId,
        onlySession ? `codex:${onlySession.sessionId}` : undefined,
        parserVersion,
      );
      if (this.vault && adapter.shouldBackupSource !== false && dirtyPaths.has(parsed.filePath)) {
        void this.vault.backup(
          parsed.filePath,
          'codex',
          onlySession?.sessionId,
          parsed.host,
        ).catch(() => undefined);
      }
    }

    return totals.sessions > 0 ? totals : null;
  }

  /**
   * Resolve unlinked subagent links by matching file_path to sync_state.
   * Link file paths come from parsers (path.join style) while sync_state keys
   * come from enumeration (glob forward-slash style on Windows), so the
   * lookup tries the raw path plus both separator variants.
   *
   * Public because every sync path must run it: link rows are written when
   * the *parent* session syncs, but the child side only resolves once the
   * subagent transcript itself is in sync_state. A transcript that exists on
   * disk but was never synced (e.g. the file watcher excludes subagent dirs)
   * is synced on demand here, so subagents mount into the tree without
   * waiting for the next full scan. Returns the number of links resolved.
   */
  async resolveSubagentLinks(): Promise<number> {
    let resolved = 0;
    // Retry child-side links that arrived before their parent session. A
    // still-missing parent keeps the link queued; any other failure drops
    // it (the parent-side ref + file-path resolution is the backstop).
    for (const [id, link] of this.pendingSubagentLinks) {
      try {
        this.db.insertSubagentLink(link);
        this.pendingSubagentLinks.delete(id);
        resolved += 1;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') {
          this.pendingSubagentLinks.delete(id);
        }
      }
    }
    // Pass 1: resolve from sync_state; collect links whose transcript was
    // never synced. Pass 2: sync those files, then resolve again.
    for (let pass = 0; pass < 2; pass += 1) {
      const unresolved = this.db.getUnresolvedSubagentLinks();
      if (unresolved.length === 0) break;
      const missing: Array<typeof unresolved[number]> = [];
      for (const link of unresolved) {
        if (this.tryResolveLink(link)) resolved += 1;
        else missing.push(link);
      }
      if (pass === 1 || missing.length === 0) break;
      let syncedAny = false;
      for (const link of missing) {
        const platform = link.parentSessionId.split(':')[0] as AgentPlatform;
        try {
          if (!link.filePath || !(await fs.pathExists(link.filePath))) continue;
          const stored = await this.syncFile(platform, link.filePath);
          syncedAny = syncedAny || stored !== null;
        } catch { /* a broken transcript must not block the others */ }
      }
      if (!syncedAny) break;
    }
    return resolved;
  }

  private tryResolveLink(link: { id: string; filePath: string }): boolean {
    const candidates = [
      link.filePath,
      link.filePath.replace(/\\/g, '/'),
      link.filePath.replace(/\//g, path.sep),
    ];
    for (const candidate of candidates) {
      const syncState = this.db.getSyncState(candidate);
      if (syncState?.conversationId) {
        this.db.updateSubagentLinkChild(link.id, syncState.conversationId);
        return true;
      }
    }
    return false;
  }
}
