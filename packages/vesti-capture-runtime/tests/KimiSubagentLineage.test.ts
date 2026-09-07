/**
 * Kimi Code subagent lineage — regression tests for the subagent leak.
 *
 * kimi-code keeps one wire.jsonl per agent under
 *   ~/.kimi-code/sessions/<wdKey>/<sessionId>/agents/<agentId>/wire.jsonl
 * with state.json's agents map naming each sub's parentAgentId. Sub wires
 * sync as standalone sessions, so without lineage they leak into the
 * conversation list/tree as independent top-level dialogues.
 *
 * These tests run the real adapter + SyncEngine + tree pipeline over a
 * fixture home (main + direct child + nested grandchild, mirroring real
 * state.json rosters) and assert the sub wires fold under their parents —
 * regardless of sync order and without relying on the resolveSubagentLinks
 * backstop (the child-side subagentOf link lands resolved at insert time).
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterManager } from '../src/adapters/AdapterManager.js';
import { KimiCodeAdapter } from '../src/adapters/kimi-code/adapter.js';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { SyncEngine } from '../src/sync/SyncEngine.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

const SESSION_DIR_NAME = 'session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MAIN_WS = `kimi-code:${SESSION_DIR_NAME}`;
const AGENT0_WS = `kimi-code:${SESSION_DIR_NAME}--agent-0`;
const AGENT1_WS = `kimi-code:${SESSION_DIR_NAME}--agent-1`;

function wireRows(userText: string, assistantText: string, t0: number): unknown[] {
  return [
    { type: 'metadata', protocol_version: '1.4', created_at: t0 },
    { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: userText }], toolCalls: [], origin: { kind: 'user' } }, time: t0 + 1 },
    { type: 'context.append_loop_event', event: { type: 'content.part', uuid: `p-${t0}`, turnId: '0', step: 1, part: { type: 'text', text: assistantText } }, time: t0 + 2 },
  ];
}

/**
 * Fixture home: main spawns agent-0; agent-0 spawns agent-1 (nested, as in
 * real swarm runs where a sub uses the Agent tool itself).
 */
async function makeKimiHome(): Promise<{ home: string; sessionDir: string }> {
  const home = await makeTempDir('vesti-kimi-lineage-');
  const sessionDir = path.join(home, '.kimi-code', 'sessions', 'wd_lineage_0123456789ab', SESSION_DIR_NAME);
  for (const agent of ['main', 'agent-0', 'agent-1']) {
    await fs.ensureDir(path.join(sessionDir, 'agents', agent));
  }
  await fs.writeJSON(path.join(sessionDir, 'state.json'), {
    createdAt: '2026-07-30T09:00:00.000Z',
    updatedAt: '2026-07-30T09:05:00.000Z',
    title: 'New Session',
    isCustomTitle: false,
    agents: {
      main: { type: 'main', parentAgentId: null },
      'agent-0': { type: 'sub', parentAgentId: 'main', swarmItem: '调研员' },
      'agent-1': { type: 'sub', parentAgentId: 'agent-0', swarmItem: '复核员' },
    },
    workDir: 'C:/work/kimi-lineage',
  });
  const write = (agent: string, rows: unknown[]) =>
    fs.writeFile(path.join(sessionDir, 'agents', agent, 'wire.jsonl'), `${rows.map(r => JSON.stringify(r)).join('\n')}\n`);
  await write('main', wireRows('调研并复核竞品', '好的，派两个子代理。', 1_784_370_960_000));
  await write('agent-0', wireRows('调研竞品', '调研完成，请复核。', 1_784_370_961_000));
  await write('agent-1', wireRows('复核调研结果', '复核通过。', 1_784_370_962_000));
  return { home, sessionDir };
}

async function setup(home: string) {
  const dir = await makeTempDir('vesti-kimi-lineage-db-');
  const db = new DatabaseManager(path.join(dir, 'vesti.db'));
  await db.initialize();
  const adapters = new AdapterManager();
  const adapter = new KimiCodeAdapter();
  adapter.setHomeRoots([{ host: 'native', homeDir: home }]);
  adapters.register(adapter); // override the built-in, real-home adapter
  const engine = new SyncEngine(adapters, db);
  return { db, engine, adapter };
}

describe('kimi-code subagent lineage (leak regression)', () => {
  it('marks sub wires with child-side lineage, nested via parentAgentId', async () => {
    const { home, sessionDir } = await makeKimiHome();
    const { adapter, db } = await setup(home);
    try {
      const agent1 = await adapter.parseSession(path.join(sessionDir, 'agents', 'agent-1', 'wire.jsonl'));
      expect(agent1.subagentOf).toEqual({
        parentSessionId: AGENT0_WS,
        agentId: 'agent-1',
        agentRole: '复核员',
      });

      // Nested agents are claimed by their own parent, not flattened under main.
      const main = await adapter.parseSession(path.join(sessionDir, 'agents', 'main', 'wire.jsonl'));
      expect(main.subagents.map(s => s.agentId)).toEqual(['agent-0']);
      const agent0 = await adapter.parseSession(path.join(sessionDir, 'agents', 'agent-0', 'wire.jsonl'));
      expect(agent0.subagents.map(s => s.agentId)).toEqual(['agent-1']);
    } finally {
      await db.close();
    }
  });

  it('folds sub wires under their parents in the conversation tree', async () => {
    const { home } = await makeKimiHome();
    const { db, engine, adapter } = await setup(home);
    try {
      const files = await adapter.getSessionFiles();
      expect(files).toHaveLength(3);
      // Every real sync path ends with a resolveSubagentLinks() pass.
      await engine.syncPlatform('kimi-code', files);
      await engine.resolveSubagentLinks();

      expect(db.getUnresolvedSubagentLinks()).toHaveLength(0);
      // Parent-side and child-side inserts dedup to one row per (parent, child).
      expect(db.getSubagentLinks(MAIN_WS)).toHaveLength(1);
      expect(db.getSubagentLinks(MAIN_WS)[0]).toMatchObject({ childSessionId: AGENT0_WS, slug: '调研员' });
      expect(db.getSubagentLinks(AGENT0_WS)).toHaveLength(1);
      expect(db.getSubagentLinks(AGENT0_WS)[0]).toMatchObject({ childSessionId: AGENT1_WS, slug: '复核员' });

      const tree = db.buildConversationTree();
      const source = tree.sources.find(s => s.platform === 'kimi-code');
      const project = source?.projects[0];
      // The leak assertion: only the main session stays top-level.
      expect(project?.sessions.map(s => s.id)).toEqual([MAIN_WS]);
      const mainNode = project!.sessions[0];
      expect(mainNode.childCount).toBe(1);
      const child = mainNode.children?.[0];
      expect(child).toMatchObject({ id: AGENT0_WS, role: 'subagent', subagentRole: '调研员' });
      const grandchild = child?.children?.[0];
      expect(grandchild).toMatchObject({ id: AGENT1_WS, role: 'subagent', subagentRole: '复核员' });
      // Aggregates roll the whole subtree up to the main session.
      expect(mainNode.descendantMessageCount).toBe((child?.messageCount ?? 0) + (grandchild?.messageCount ?? 0));
    } finally {
      await db.close();
    }
  });

  it('folds regardless of sync order (child wire synced before the parent)', async () => {
    const { home, sessionDir } = await makeKimiHome();
    const { db, engine } = await setup(home);
    try {
      // Watch-route shape: the sub wire's file event lands first. The link
      // cannot be written yet (FK: parent session missing) — it is deferred
      // and the file is left un-synced so a later round retries it.
      const agent0Wire = path.join(sessionDir, 'agents', 'agent-0', 'wire.jsonl');
      await engine.syncFile('kimi-code', agent0Wire);
      expect(db.getSubagentLinks(MAIN_WS)).toHaveLength(0);
      expect(db.getSyncState(agent0Wire)).toBeNull();
      // …but the child conversation itself is stored either way.
      expect(db.getWorkSession(AGENT0_WS)).not.toBeNull();

      await engine.syncFile('kimi-code', path.join(sessionDir, 'agents', 'agent-1', 'wire.jsonl'));
      await engine.syncFile('kimi-code', path.join(sessionDir, 'agents', 'main', 'wire.jsonl'));
      await engine.resolveSubagentLinks();

      expect(db.getUnresolvedSubagentLinks()).toHaveLength(0);
      const links = db.getSubagentLinks(MAIN_WS);
      expect(links).toHaveLength(1);
      expect(links[0].childSessionId).toBe(AGENT0_WS);
      expect(db.getSubagentLinks(AGENT0_WS)[0].childSessionId).toBe(AGENT1_WS);

      const tree = db.buildConversationTree();
      const project = tree.sources.find(s => s.platform === 'kimi-code')?.projects[0];
      expect(project?.sessions.map(s => s.id)).toEqual([MAIN_WS]);
      expect(project?.sessions[0].children?.[0].children?.[0].id).toBe(AGENT1_WS);
    } finally {
      await db.close();
    }
  });

  it('still resolves legacy parent-side links via the resolveSubagentLinks backstop', async () => {
    const { home, sessionDir } = await makeKimiHome();
    const { db, engine, adapter } = await setup(home);
    try {
      const files = await adapter.getSessionFiles();
      await engine.syncPlatform('kimi-code', files);
      // Simulate pre-fix rows (child ids never resolved): keep only the
      // parent-side file path, as rows created by the old flow had.
      const raw = (db as unknown as { getDb(): import('better-sqlite3').Database }).getDb();
      const strip = raw.prepare('UPDATE subagent_links SET child_session_id = NULL, file_path = ? WHERE id = ?');
      strip.run(path.join(sessionDir, 'agents', 'agent-0', 'wire.jsonl'), `${MAIN_WS}:agent-0`);
      strip.run(path.join(sessionDir, 'agents', 'agent-1', 'wire.jsonl'), `${AGENT0_WS}:agent-1`);
      expect(db.getUnresolvedSubagentLinks()).toHaveLength(2);

      await engine.resolveSubagentLinks();

      expect(db.getUnresolvedSubagentLinks()).toHaveLength(0);
      expect(db.getSubagentLinks(MAIN_WS)[0].childSessionId).toBe(AGENT0_WS);
      expect(db.getSubagentLinks(AGENT0_WS)[0].childSessionId).toBe(AGENT1_WS);
    } finally {
      await db.close();
    }
  });
});
