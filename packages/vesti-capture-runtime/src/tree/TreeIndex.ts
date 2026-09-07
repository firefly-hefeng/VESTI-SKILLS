/**
 * Conversation Tree Index
 * Builds the lightweight hierarchy 来源(platform+host) → 项目(project) →
 * 会话(session + digest) from a single SQL read plus in-memory assembly.
 * O(sessions); the result is plain JSON for IPC transfer. Browser-source
 * sessions are not stored in this database — the renderer merges its own
 * "browser" subtree on top of this tree.
 */

import { deriveProjectKey } from '../storage/projectRegistry.js';
import { computeUniqueMessageCounts } from './forks.js';

type Database = import('better-sqlite3').Database;

export interface ConversationTreeSession {
  id: string;
  title: string;
  messageCount: number;
  lastActivityAt: number;
  oneLiner: string | null;
  keyTopics: string[];
  keyFiles: string[];
  decisions: string[];
  /**
   * 'subagent' when the session appears on the child side of subagent_links.
   * Subagents are mounted under their parent session (children array) instead
   * of the project's flat session list; orphans (parent session missing, e.g.
   * the parent file was deleted) fall back to 'main' with orphan: true.
   */
  role: 'main' | 'subagent';
  parentSessionId?: string;
  /**
   * Display label for subagent children: the platform's agent type/slug
   * (Cursor subagentTypeName, Claude agent slug, kimi swarm item) when the
   * link recorded one.
   */
  subagentRole?: string;
  orphan?: boolean;
  /** Direct subagent children count. */
  childCount: number;
  /** messageCount summed over all subagent descendants (excludes own). */
  descendantMessageCount: number;
  /** Subagent children, newest activity first; only present when non-empty. */
  children?: ConversationTreeSession[];
  /**
   * Fork lineage (memory v2): work_sessions.id of the parent session this one
   * was forked from. Fork sessions stay fully visible (they are independent
   * work) — the badge only explains the shared pre-fork history.
   */
  forkedFrom?: string | null;
  /**
   * Message counts with fork duplication removed: `duplicatedMessageCount`
   * messages also exist on an ancestor of the fork chain and are counted
   * once, on the earliest copy. Absent for non-fork sessions.
   */
  uniqueMessageCount?: number;
  duplicatedMessageCount?: number;
}

export interface ConversationTreeProject {
  projectKey: string;
  label: string;
  pathOrDomain: string;
  sessions: ConversationTreeSession[];
}

export interface ConversationTreeSource {
  platform: string;
  host: string;
  projects: ConversationTreeProject[];
}

export interface ConversationTree {
  generatedAt: string;
  sources: ConversationTreeSource[];
}

interface SessionRow {
  id: string;
  platform: string;
  host: string;
  project_path: string;
  git_remote: string | null;
  title: string;
  message_count: number;
  last_activity_at: number;
  one_liner: string | null;
  key_topics: string | null;
  key_files: string | null;
  decisions: string | null;
  forked_from: string | null;
  raw_session_id: string;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Read work_sessions LEFT JOIN session_digests once and assemble the tree.
 * Project keys are re-derived per session with the same pure function the
 * sync pipeline uses, so sessions appear even when their digest or registry
 * row is missing; registry labels enrich the nodes when present.
 *
 * Subagent mounting (A1): sessions on the child side of subagent_links are
 * mounted under their parent session inside the same source/project, so the
 * project session list holds main sessions only and parents carry
 * childCount / descendantMessageCount aggregates. A subagent whose parent is
 * missing (or whose ancestry cycles) falls back to a main node with
 * orphan: true.
 */
export function buildConversationTree(db: Database): ConversationTree {
  const sessions = db.prepare(`
    SELECT ws.id, ws.platform, ws.host, ws.project_path, ws.git_remote,
           ws.title, ws.message_count, ws.last_activity_at,
           ws.forked_from, ws.session_id AS raw_session_id,
           sd.one_liner, sd.key_topics, sd.key_files, sd.decisions
    FROM work_sessions ws
    LEFT JOIN session_digests sd ON sd.session_id = ws.id
    WHERE ws.session_type = 'conversation'
    ORDER BY ws.last_activity_at DESC
  `).all() as SessionRow[];

  // child session id → parent session id (first link wins; duplicates are
  // not expected but must not double-mount a child).
  const parentByChild = new Map<string, string>();
  const roleByChild = new Map<string, string>();
  for (const row of db.prepare(`
    SELECT parent_session_id, child_session_id, agent_role, slug FROM subagent_links
    WHERE child_session_id IS NOT NULL
  `).all() as Array<{ parent_session_id: string; child_session_id: string; agent_role: string | null; slug: string | null }>) {
    if (!parentByChild.has(row.child_session_id)) {
      parentByChild.set(row.child_session_id, row.parent_session_id);
      const role = row.agent_role ?? row.slug;
      if (role) roleByChild.set(row.child_session_id, role);
    }
  }

  const registry = new Map<string, { label: string; pathOrDomain: string }>();
  for (const row of db.prepare('SELECT project_key, label, path_or_domain FROM project_registry').all() as Array<{
    project_key: string;
    label: string | null;
    path_or_domain: string | null;
  }>) {
    registry.set(row.project_key, { label: row.label ?? 'unknown', pathOrDomain: row.path_or_domain ?? '' });
  }

  // Pass 1: create every session node and remember its source/project key so
  // subagents can be mounted under parents living in the same bucket.
  interface PendingNode {
    node: ConversationTreeSession;
    sourceKey: string;
    projectKey: string;
  }
  const pending = new Map<string, PendingNode>();
  const sourceMeta = new Map<string, { platform: string; host: string }>();
  for (const row of sessions) {
    const host = row.host || 'native';
    const sourceKey = `${row.platform}|${host}`;
    sourceMeta.set(sourceKey, { platform: row.platform, host });
    const projectKey = deriveProjectKey({
      platform: row.platform,
      host,
      projectPath: row.project_path,
      gitRemote: row.git_remote ?? undefined,
    });
    const parentSessionId = parentByChild.get(row.id);
    pending.set(row.id, {
      node: {
        id: row.id,
        title: row.title,
        messageCount: row.message_count,
        lastActivityAt: row.last_activity_at,
        oneLiner: row.one_liner,
        keyTopics: parseJsonArray(row.key_topics),
        keyFiles: parseJsonArray(row.key_files),
        decisions: parseJsonArray(row.decisions),
        role: parentSessionId ? 'subagent' : 'main',
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(parentSessionId && roleByChild.has(row.id)
          ? { subagentRole: roleByChild.get(row.id) }
          : {}),
        childCount: 0,
        descendantMessageCount: 0,
        ...(row.forked_from ? { forkedFrom: row.forked_from } : {}),
      },
      sourceKey,
      projectKey,
    });
  }

  // Fork dedup (memory v2): sessions with a forked_from lineage carry
  // unique/duplicated message counts so pre-fork copies are counted once, on
  // the earliest ancestor. Only sessions on a fork chain need their message
  // ids loaded — everything else keeps its raw count.
  const forkedRows = sessions.filter(row => row.forked_from);
  if (forkedRows.length > 0) {
    const parentOf = new Map(forkedRows.map(row => [row.id, row.forked_from as string]));
    const involved = new Set<string>();
    for (const row of forkedRows) {
      involved.add(row.id);
      let cursor = parentOf.get(row.id);
      const seen = new Set<string>([row.id]);
      while (cursor && !seen.has(cursor)) {
        involved.add(cursor);
        seen.add(cursor);
        cursor = parentOf.get(cursor);
      }
    }
    const msgStmt = db.prepare('SELECT id FROM messages WHERE session_id = ?');
    const metaById = new Map(sessions.map(row => [row.id, row]));
    const countInput = [...involved].map(id => {
      const meta = metaById.get(id);
      return {
        id,
        rawSessionId: meta?.raw_session_id ?? '',
        platform: meta?.platform ?? '',
        messageIds: (msgStmt.all(id) as Array<{ id: string }>).map(message => message.id),
        forkedFrom: parentOf.get(id) ?? null,
      };
    });
    const uniqueCounts = computeUniqueMessageCounts(countInput);
    for (const row of forkedRows) {
      const counts = uniqueCounts.get(row.id);
      const node = pending.get(row.id)?.node;
      if (counts && node) {
        node.uniqueMessageCount = counts.unique;
        node.duplicatedMessageCount = counts.duplicated;
      }
    }
  }

  // A mount is valid only when the parent exists, lives in the same
  // source/project, and the child's ancestry does not cycle back to itself.
  // The ancestry walk uses the immutable link map (not node fields) so the
  // verdict does not depend on iteration order.
  function mountParentFor(childId: string): ConversationTreeSession | null {
    const child = pending.get(childId);
    const parentId = child?.node.parentSessionId;
    if (!child || !parentId) return null;
    const parent = pending.get(parentId);
    if (!parent) return null;
    if (parent.sourceKey !== child.sourceKey || parent.projectKey !== child.projectKey) return null;
    const seen = new Set<string>([childId]);
    let cursor: string | undefined = parentId;
    while (cursor) {
      if (seen.has(cursor)) return null;
      seen.add(cursor);
      cursor = parentByChild.get(cursor);
    }
    return parent.node;
  }

  const roots: PendingNode[] = [];
  for (const [id, entry] of pending) {
    if (entry.node.role !== 'subagent') {
      roots.push(entry);
      continue;
    }
    const parent = mountParentFor(id);
    if (!parent) {
      // Orphan: parent file deleted / cross-project link / cycle — degrade to
      // a standalone main node so the session stays visible and countable.
      entry.node.role = 'main';
      entry.node.orphan = true;
      delete entry.node.parentSessionId;
      roots.push(entry);
      continue;
    }
    (parent.children ??= []).push(entry.node);
  }

  // Aggregates: direct child count + messages summed over all descendants.
  function fillAggregates(node: ConversationTreeSession, ancestors: Set<string>): number {
    if (!node.children?.length || ancestors.has(node.id)) return 0;
    ancestors.add(node.id);
    let total = 0;
    for (const child of node.children) {
      total += child.messageCount + fillAggregates(child, ancestors);
    }
    ancestors.delete(node.id);
    node.childCount = node.children.length;
    node.descendantMessageCount = total;
    node.children.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return total;
  }
  for (const entry of roots) fillAggregates(entry.node, new Set());

  // Pass 2: bucket main sessions into sources/projects (rows are already
  // ordered by last_activity_at DESC, so roots keep that order).
  const sources = new Map<string, ConversationTreeSource>();
  for (const entry of roots) {
    const meta = sourceMeta.get(entry.sourceKey)!;
    let source = sources.get(entry.sourceKey);
    if (!source) {
      source = { platform: meta.platform, host: meta.host, projects: [] };
      sources.set(entry.sourceKey, source);
    }

    let project = source.projects.find(candidate => candidate.projectKey === entry.projectKey);
    if (!project) {
      const registryEntry = registry.get(entry.projectKey);
      project = {
        projectKey: entry.projectKey,
        label: registryEntry?.label ?? 'unknown',
        pathOrDomain: registryEntry?.pathOrDomain ?? '',
        sessions: [],
      };
      source.projects.push(project);
    }

    project.sessions.push(entry.node);
  }

  return {
    generatedAt: new Date().toISOString(),
    sources: [...sources.values()],
  };
}
