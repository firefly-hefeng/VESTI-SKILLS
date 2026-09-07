/**
 * Kimi Code Adapter
 * Detects Kimi Code installation and parses wire.jsonl sessions.
 *
 * Real layout (protocol 1.4, see
 * https://www.kimi.com/code/docs/kimi-code-cli/guides/sessions.html):
 *   ~/.kimi-code/sessions/<workDirKey>/<sessionId>/state.json
 *   ~/.kimi-code/sessions/<workDirKey>/<sessionId>/agents/<agentId>/wire.jsonl
 * Home resolution order: $KIMI_CODE_HOME, <home>/.kimi-code, legacy <home>/.kimi.
 */

import fs from 'fs-extra';
import path from 'path';
import type { AgentAdapter, AgentDetectResult, ParsedSession, SubagentRef } from '../../types/agent.js';
import { nativeHomeRoot, type HomeRoot } from '../../platform/PathResolver.js';
import { KimiCodeParser } from './parser.js';
import type { KimiSessionIndexRow, KimiSessionState, KimiWorkspacesFile } from './types.js';

export class KimiCodeAdapter implements AgentAdapter {
  readonly platform = 'kimi-code' as const;
  readonly name = 'Kimi Code';

  private parser = new KimiCodeParser();
  private homes: HomeRoot[] = [nativeHomeRoot()];

  setHomeRoots(homes: HomeRoot[]): void {
    this.homes = homes;
  }

  /**
   * Candidate Kimi Code home dirs per home root, current name first.
   * $KIMI_CODE_HOME (documented override) is honored for the native home.
   */
  private kimiDirs(): string[] {
    const dirs: string[] = [];
    for (const home of this.homes) {
      if (home.host === 'native' && process.env.KIMI_CODE_HOME) {
        dirs.push(process.env.KIMI_CODE_HOME);
      }
      dirs.push(path.join(home.homeDir, '.kimi-code'));
      dirs.push(path.join(home.homeDir, '.kimi')); // legacy name, kept as fallback probe
    }
    return dirs;
  }

  /** Dirs that actually look like a Kimi Code home (have a sessions/ tree). */
  private async existingKimiDirs(): Promise<string[]> {
    const result: string[] = [];
    for (const dir of this.kimiDirs()) {
      if (await fs.pathExists(path.join(dir, 'sessions'))) result.push(dir);
    }
    return result;
  }

  async detect(): Promise<AgentDetectResult> {
    const kimiDirs = await this.existingKimiDirs();
    if (kimiDirs.length === 0) {
      return { installed: false };
    }

    let sessionCount = 0;
    try {
      sessionCount = (await this.getSessionFiles()).length;
    } catch { /* ignore */ }

    return {
      installed: true,
      installPath: kimiDirs[0],
      sessionCount,
    };
  }

  async parseSession(filePath: string): Promise<ParsedSession> {
    // filePath points at a wire.jsonl. Current layout puts it under
    // <sessionDir>/agents/<agentName>/wire.jsonl; the legacy layout has
    // wire.jsonl directly in <sessionDir>.
    const wireDir = filePath.endsWith('wire.jsonl') ? path.dirname(filePath) : filePath;
    const wireFile = filePath.endsWith('wire.jsonl') ? filePath : path.join(filePath, 'wire.jsonl');
    const agentName = path.basename(wireDir);
    const isAgentLayout = path.basename(path.dirname(wireDir)) === 'agents';
    const sessionDir = isAgentLayout ? path.dirname(path.dirname(wireDir)) : wireDir;
    const sessionDirName = path.basename(sessionDir);

    const state = await this.readSessionState(sessionDir);
    const projectPath = state?.workDir || await this.resolveWorkDir(sessionDirName, sessionDir);

    if (!isAgentLayout) {
      // Legacy <hash>/<uuid>/wire.jsonl — parser handles the whole directory.
      const session = await this.parser.parseSessionDir(sessionDir);
      if (!session.projectPath) session.projectPath = projectPath;
      if (!session.model) session.model = await this.getDefaultModel();
      await this.applyLegacyArchiveMeta(session, sessionDir);
      return session;
    }

    const sessionId = agentName === 'main' ? sessionDirName : `${sessionDirName}--${agentName}`;
    const session = await this.parser.parseWireFile(wireFile, {
      sessionId,
      projectPath,
      agentName,
      meta: this.stateToMeta(state, agentName),
    });

    if (!session.model) session.model = await this.getDefaultModel();

    if (agentName !== 'main') {
      // Child-side lineage: the sub wire's own state.json roster entry names
      // its parent agent, so the link lands resolved at insert time — no
      // dependency on the parent wire being (re-)parsed or on file-path
      // matching. Nested runs (parentAgentId = another agent) mount under
      // that agent's wire session. agentId reuses the parent-side link id.
      const parentAgentId = state?.agents?.[agentName]?.parentAgentId;
      const parentWireId = parentAgentId && parentAgentId !== 'main'
        ? `${sessionDirName}--${parentAgentId}`
        : sessionDirName;
      session.subagentOf = {
        parentSessionId: `kimi-code:${parentWireId}`,
        agentId: agentName,
        agentRole: state?.agents?.[agentName]?.swarmItem,
      };
    }

    // Every agent wire advertises its direct children; SyncEngine links them
    // by file path once the child wire files are synced as standalone
    // sessions (the child-side subagentOf above resolves them regardless).
    session.subagents = await this.discoverSubagents(sessionDir, state, agentName);

    return session;
  }

  /**
   * Map state.json into session.meta. The title feeds the converter's
   * first_prompt fallback only — real user prompts win the title chain.
   */
  private stateToMeta(state: KimiSessionState | null, agentName: string): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    if (!state) return meta;
    if (state.title && state.title !== 'New Session') {
      // Title chain (memory v2): an explicit state.json title outranks the
      // first-user-message fallback, so it travels its own meta key.
      meta.session_title = state.title;
      meta.first_prompt = state.title;
    } else if (state.lastPrompt) meta.first_prompt = state.lastPrompt;
    if (state.isCustomTitle) meta.custom_title = true;
    // Fork lineage: state.json forkedFrom names the parent session directory.
    // Only meaningful for the main wire; subagents inherit the session dir.
    const forkedFrom = typeof state.forkedFrom === 'string'
      ? state.forkedFrom
      : state.forkedFrom?.sessionId;
    if (agentName === 'main' && forkedFrom) meta.forked_from = forkedFrom;
    const agentInfo = state.agents?.[agentName];
    if (agentInfo?.type) meta.agent_type = agentInfo.type;
    if (agentInfo?.swarmItem) meta.swarm_item = agentInfo.swarmItem;
    if (agentInfo?.parentAgentId) meta.parent_agent_id = agentInfo.parentAgentId;
    return meta;
  }

  /**
   * Subagent refs for one agent wire. state.json's agents map is
   * authoritative: each agent claims exactly its direct children
   * (parentAgentId === agentName), so nested runs mount under the agent that
   * spawned them instead of all flattening under main. Without a roster the
   * agents/ directory listing is the fallback (main claims everything, the
   * legacy behavior — nesting is unknowable then).
   */
  private async discoverSubagents(sessionDir: string, state: KimiSessionState | null, agentName: string): Promise<SubagentRef[]> {
    const agentsDir = path.join(sessionDir, 'agents');
    const refs: SubagentRef[] = [];
    const seen = new Set<string>();

    const push = (agentId: string, slug?: string) => {
      if (agentId === agentName || seen.has(agentId)) return;
      const wirePath = path.join(agentsDir, agentId, 'wire.jsonl');
      if (!fs.existsSync(wirePath)) return;
      seen.add(agentId);
      refs.push({ agentId, slug, filePath: wirePath });
    };

    const roster = state?.agents;
    if (roster && Object.keys(roster).length > 0) {
      for (const [agentId, info] of Object.entries(roster)) {
        const parent = info?.parentAgentId ?? 'main';
        if (parent === agentName) push(agentId, info?.swarmItem);
      }
      return refs;
    }

    if (agentName !== 'main') return refs;
    try {
      if (await fs.pathExists(agentsDir)) {
        for (const entry of await fs.readdir(agentsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) push(entry.name);
        }
      }
    } catch { /* ignore */ }

    return refs;
  }

  private async readSessionState(sessionDir: string): Promise<KimiSessionState | null> {
    try {
      const stateFile = path.join(sessionDir, 'state.json');
      if (!await fs.pathExists(stateFile)) return null;
      const raw = await fs.readFile(stateFile, 'utf-8');
      if (!raw.trim()) return null;
      return JSON.parse(raw) as KimiSessionState;
    } catch {
      return null;
    }
  }

  /**
   * Work-dir fallback chain when state.json is absent: session_index.jsonl
   * (per-session mapping), then workspaces.json (per-workDirKey mapping).
   */
  private async resolveWorkDir(sessionDirName: string, sessionDir: string): Promise<string> {
    for (const kimiDir of await this.existingKimiDirs()) {
      // session_index.jsonl: {sessionId, sessionDir, workDir} per line
      try {
        const indexFile = path.join(kimiDir, 'session_index.jsonl');
        if (await fs.pathExists(indexFile)) {
          const raw = await fs.readFile(indexFile, 'utf-8');
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            const row = JSON.parse(line) as KimiSessionIndexRow;
            if (row.sessionId === sessionDirName && row.workDir) return row.workDir;
          }
        }
      } catch { /* try next */ }

      // workspaces.json: keyed by the <workDirKey> parent directory name
      try {
        const wsFile = path.join(kimiDir, 'workspaces.json');
        const wdKey = path.basename(path.dirname(sessionDir));
        if (await fs.pathExists(wsFile)) {
          const ws = await fs.readJSON(wsFile) as KimiWorkspacesFile;
          const root = ws.workspaces?.[wdKey]?.root;
          if (root) return root;
        }
      } catch { /* try next */ }
    }
    return '';
  }

  private async applyLegacyArchiveMeta(session: ParsedSession, sessionDir: string): Promise<void> {
    const metaFile = path.join(sessionDir, 'metadata.json');
    if (!await fs.pathExists(metaFile)) return;
    try {
      const raw = await fs.readFile(metaFile, 'utf-8');
      if (!raw.trim()) return;
      const meta = JSON.parse(raw);
      if (meta.archived) {
        if (!session.meta) session.meta = {};
        session.meta.archived = true;
        if (meta.archived_at) session.meta.archived_at = meta.archived_at;
      }
    } catch { /* ignore */ }
  }

  /**
   * Read default model from the first available config.toml
   */
  private async getDefaultModel(): Promise<string | undefined> {
    for (const kimiDir of this.kimiDirs()) {
      try {
        const configPath = path.join(kimiDir, 'config.toml');
        if (!await fs.pathExists(configPath)) continue;
        const content = await fs.readFile(configPath, 'utf-8');
        const match = content.match(/default_model\s*=\s*"([^"]+)"/);
        if (match) return match[1];
      } catch {
        // try the next dir
      }
    }
    return undefined;
  }

  async getSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const kimiDir of await this.existingKimiDirs()) {
      const sessionsDir = path.join(kimiDir, 'sessions');
      let workDirKeys: string[] = [];
      try {
        workDirKeys = await fs.readdir(sessionsDir);
      } catch { continue; }

      for (const wdKey of workDirKeys) {
        const wdDir = path.join(sessionsDir, wdKey);
        const wdStat = await fs.stat(wdDir).catch(() => null);
        if (!wdStat?.isDirectory()) continue;

        for (const sessionDirName of await fs.readdir(wdDir)) {
          const sessionDir = path.join(wdDir, sessionDirName);
          const sessionStat = await fs.stat(sessionDir).catch(() => null);
          if (!sessionStat?.isDirectory()) continue;

          const agentsDir = path.join(sessionDir, 'agents');
          if (await fs.pathExists(agentsDir)) {
            // Current layout: one wire.jsonl per agent (main + subagents)
            for (const agentEntry of await fs.readdir(agentsDir, { withFileTypes: true })) {
              if (!agentEntry.isDirectory()) continue;
              const wireFile = path.join(agentsDir, agentEntry.name, 'wire.jsonl');
              if (await fs.pathExists(wireFile)) files.push(wireFile);
            }
          } else {
            // Legacy layout: wire.jsonl directly in the session directory
            const wireFile = path.join(sessionDir, 'wire.jsonl');
            if (await fs.pathExists(wireFile)) files.push(wireFile);
          }
        }
      }
    }

    return files;
  }

  getWatchPatterns(): string[] {
    return this.kimiDirs().flatMap(kimiDir => [
      path.join(kimiDir, 'sessions', '*', '*', 'agents', '*', 'wire.jsonl'),
      path.join(kimiDir, 'sessions', '*', '*', 'wire.jsonl'),
    ]);
  }
}
