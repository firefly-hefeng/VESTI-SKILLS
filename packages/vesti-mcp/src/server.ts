/**
 * MCP server wiring. Uses the official @modelcontextprotocol/sdk low-level
 * Server with hand-written JSON Schemas (no zod dependency); the protocol
 * surface we need is just tools/list + tools/call.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { VestiDatabase } from './db.js';
import { vestiSearchFiles } from './files.js';
import { vestiMemoryGet, vestiMemorySearch } from './memory.js';
import { vestiGetHandoffContext, vestiGetProjectContext } from './projectContext.js';
import { vestiGetTurns, vestiProjectBrief, vestiSearch, vestiTimeline } from './tools.js';

/**
 * Behavior contract for every agent that connects. Sent in the MCP
 * initialize result; kept short and imperative so it survives system-prompt
 * competition.
 */
const SERVER_INSTRUCTIONS = [
  'VESTI exposes this machine’s captured AI-coding sessions (kimi-code, claude code, codex, cursor — all platforms, read-only).',
  'SESSION START: when your working directory may be a tracked project, call vesti_get_project_context with your cwd as paths[0] BEFORE asking the user for background — it returns the project’s state card, maintained brief, recent sessions, open questions and active-file timeline in one call. If it reports no match, proceed without VESTI.',
  'MERGE / CROSS-PROJECT WORK: pass every involved project path to vesti_get_project_context at once — besides per-project packs it returns cross-project links (shared files, shared topics, overlapping work windows).',
  'HANDOFF to another agent or session: call vesti_get_handoff_context, then assemble the handoff from its file anchors, open questions and verify-first hints; the receiving side must re-verify before trusting it.',
  'HISTORY DETAILS: vesti_search (keywords) → vesti_timeline (pick turns) → vesti_get_turns (only those turns). Never call vesti_get_turns without narrowing first — it is the expensive layer. confidence:"low" search hits are leads, not facts.',
  'FILE LOOKUP: when the user asks to fill/update a document from memory (e.g. "帮我填写这个 BP"), call vesti_search_files with the topic — it returns the local file paths past work touched (with the projects and sessions behind them). Read those files with your own filesystem tools; pair with vesti_memory_search for the distilled facts.',
  'MEMORY SPACE (long-term memory about the user and their work): vesti_memory_search (keywords, or no query to browse newest) → vesti_memory_get (full documents by id). Kinds: deposit = the user’s long-term deposit documents (profile, project state, writing style); dream = durable facts about the user themself (preferences, goals, emotions) extracted by the dream pass; dream-log = per-run logs of that memory-consolidation pass.',
  'vesti_project_brief(project) fuzzy-matches a project name when you do not know its path.',
].join('\n');

const SEARCH_DESCRIPTION = [
  'Layer 1 of 3 — search VESTI’s memory of past AI-coding sessions (claude code, codex, kimi-code, …).',
  'Returns up to topK session index entries (~100 tokens each): session_id, title, platform, project, time, digest one-liner, key topics, and a hit snippet.',
  'WORKFLOW: (1) call vesti_search with a few keywords; (2) call vesti_timeline on the most promising session_id to see its turn outline; (3) call vesti_get_turns only for the turns you actually need.',
  'Do NOT guess session ids — they come from this tool.',
].join(' ');

const TIMELINE_DESCRIPTION = [
  'Layer 2 of 3 — turn-level outline of one session found via vesti_search.',
  'Returns each turn’s sequence number, timestamp, a one-line user-intent summary, tool-call count and token usage, so you can locate the exact passage worth reading.',
  'When the session spawned subagents, a subagents list (child session_id, role, one-liner) is included — drill into a child line by calling vesti_timeline with its session_id.',
  'Pass around_turn to center a ±window view on a specific turn instead of the whole session.',
  'Then call vesti_get_turns with the turn seq numbers you selected.',
].join(' ');

const GET_TURNS_DESCRIPTION = [
  'Layer 3 of 3 — full message content for specific turns of a session (user input, assistant replies, tool-call summaries).',
  'Select turns by turn_ids (sequence numbers from vesti_timeline) or an inclusive {from,to} range. Output is capped at max_chars; when the cap is hit the response sets truncated=true and you should narrow the selection.',
  'This is the expensive layer — only fetch the turns vesti_timeline pointed to.',
].join(' ');

const PROJECT_BRIEF_DESCRIPTION = [
  'Project-level memory — the L0 "current state card" (deterministic: one-liner, most-active files of the last 30 days, open questions, session count) plus the L2 LLM-maintained project brief (current state, architecture & key files, decision log, open questions) for one project.',
  'The project argument is fuzzy-matched against known project names/keys, so a shorthand like "vesti" works.',
  'Use this when you start working in a project and want its current state without searching individual sessions first.',
].join(' ');

const PROJECT_CONTEXT_DESCRIPTION = [
  'Automatic context pack for starting work in a project — call this FIRST when a session begins in a tracked project (pass your cwd as paths[0]) instead of asking the user to repeat background.',
  'Per project path it returns: the L0 state card (one-liner, active files, open questions), the L2 maintained brief, the recent session list (title/time/one-liner), merged open questions and the deterministic active-file timeline.',
  'Pass SEVERAL paths at once for merge / cross-project work: the response then adds a cross_project section with shared files, shared topics and overlapping work windows between the projects.',
  'Omit paths to default to the most recently active project. Paths are normalized (Windows/POSIX, case of drive letter); unmatched paths come back in unmatched_paths with the known project list in hints.',
  'After this pack, use vesti_search → vesti_timeline → vesti_get_turns only for the details still missing.',
].join(' ');

const HANDOFF_CONTEXT_DESCRIPTION = [
  'Lightweight handoff material aligned with the VESTI relay v2 schema — call before handing work to another agent/session or before /compact.',
  'Returns the project context block plus recent_user_messages (newest user intents across the project’s sessions), file_anchors (deterministic active-file timeline) and verify_first seeds (open questions to re-confirm, last failing steps to re-run) — every entry grounded in stored data, nothing invented.',
  'Resolve the project by session_id (its project), path, or neither (most recently active project).',
  'Then assemble the handoff yourself following the relay v2 shape (goal / state / files / decisions / verification / verifyFirst / handoffPrompt); heavy transcript compression is the VESTI app relay pipeline’s job, not this tool’s.',
].join(' ');

const MEMORY_SEARCH_DESCRIPTION = [
  'Memory-space layer 1 of 2 — search VESTI’s long-term memory entries: deposit documents (kind "deposit"), durable facts about the user (kind "dream"), dream-run logs (kind "dream-log") and free notes (kind "note").',
  'With a query: FTS over title/content/tags, returning up to limit index entries — id, kind, title, summary, entry_date, tags, updated_at and a ~160-char snippet.',
  'Without a query: browse mode, newest entries first (updated_at DESC). kind and entry_date (YYYY-MM-DD) filter either mode.',
  'Only active entries by default; pass include_archived for archived ones. Then call vesti_memory_get with the ids you actually want to read in full.',
].join(' ');

const MEMORY_GET_DESCRIPTION = [
  'Memory-space layer 2 of 2 — full memory documents by id (ids come from vesti_memory_search).',
  'Returns complete content_markdown, parsed source_session_ids and tags, the version chain (version, prev_id) and timestamps for up to 10 ids; unknown or filtered-out ids come back in missing.',
].join(' ');

const SEARCH_FILES_DESCRIPTION = [
  'File-level memory — which local files past work about a topic lives in ("where is the BP / 创投 material?").',
  'Two evidence channels: the file path itself contains the keyword (matched_via "name"), or sessions recalled by the keyword touched the file (matched_via "session-content", from digest key_files + tool-call inputs).',
  'Returns path, projects, up to 5 backing sessions, touch count and last_touched per file. Read the files with your own filesystem tools; drill into a backing session with vesti_timeline → vesti_get_turns when you need the surrounding context.',
].join(' ');

export function createVestiMcpServer(db: VestiDatabase): Server {
  const server = new Server(
    { name: 'vesti-mcp', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'vesti_get_project_context',
        description: PROJECT_CONTEXT_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Project paths (your cwd first). Several paths = merge/cross-project mode with a cross_project links section. Omit to use the most recently active project.',
            },
            session_limit: {
              type: 'integer',
              description: 'Recent sessions listed per project (default 8, max 25).',
              default: 8,
            },
            brief_chars: {
              type: 'integer',
              description: 'Character budget for each L2 brief (default 4000, min 500; sets brief.truncated when cut).',
              default: 4000,
            },
          },
        },
      },
      {
        name: 'vesti_search',
        description: SEARCH_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Keywords to recall (FTS-matched over all captured sessions).',
            },
            topK: {
              type: 'integer',
              description: 'Max session entries to return (default 8).',
              default: 8,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'vesti_timeline',
        description: TIMELINE_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Session id from vesti_search.',
            },
            around_turn: {
              type: 'integer',
              description: 'Turn sequence number to center the outline on (optional).',
            },
            window: {
              type: 'integer',
              description: 'Turns shown on each side of around_turn (default 10).',
              default: 10,
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'vesti_get_turns',
        description: GET_TURNS_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Session id from vesti_search.',
            },
            turn_ids: {
              type: 'array',
              items: { type: 'integer' },
              description: 'Turn sequence numbers (from vesti_timeline) to fetch.',
            },
            range: {
              type: 'object',
              properties: {
                from: { type: 'integer' },
                to: { type: 'integer' },
              },
              required: ['from', 'to'],
              description: 'Inclusive turn-sequence range; ignored when turn_ids is given.',
            },
            max_chars: {
              type: 'integer',
              description: 'Character budget for the whole response (default 8000, min 500).',
              default: 8000,
            },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'vesti_project_brief',
        description: PROJECT_BRIEF_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            project: {
              type: 'string',
              description: 'Project name or key (fuzzy-matched, e.g. "vesti").',
            },
          },
          required: ['project'],
        },
      },
      {
        name: 'vesti_get_handoff_context',
        description: HANDOFF_CONTEXT_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            session_id: {
              type: 'string',
              description: 'Session whose project should be handed off (wins over path).',
            },
            path: {
              type: 'string',
              description: 'Project path (e.g. your cwd). Omit both to use the most recently active project.',
            },
            user_messages: {
              type: 'integer',
              description: 'Newest user messages to include (default 8, max 20).',
              default: 8,
            },
            session_limit: {
              type: 'integer',
              description: 'Recent sessions listed in the project block (default 8, max 25).',
              default: 8,
            },
          },
        },
      },
      {
        name: 'vesti_search_files',
        description: SEARCH_FILES_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Topic keywords (e.g. "BP 创投") — matched against file paths and the content of sessions that touched files.',
            },
            topK: {
              type: 'integer',
              description: 'Max file entries to return (default 10, max 25).',
              default: 10,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'vesti_memory_search',
        description: MEMORY_SEARCH_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Keywords to match over memory entries (FTS). Omit to browse newest first.',
            },
            kind: {
              type: 'string',
              enum: ['deposit', 'dream', 'dream-log', 'note'],
              description: 'Restrict to one memory kind.',
            },
            entry_date: {
              type: 'string',
              description: 'Restrict to one entry date, YYYY-MM-DD.',
            },
            limit: {
              type: 'integer',
              description: 'Max entries to return (default 10, max 20).',
              default: 10,
            },
            include_archived: {
              type: 'boolean',
              description: 'Include archived entries (default false — active only).',
              default: false,
            },
          },
        },
      },
      {
        name: 'vesti_memory_get',
        description: MEMORY_GET_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            ids: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 10,
              description: 'Memory entry ids from vesti_memory_search (max 10).',
            },
            include_archived: {
              type: 'boolean',
              description: 'Also resolve archived ids (default false — they land in missing).',
              default: false,
            },
          },
          required: ['ids'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    try {
      let payload: unknown;
      switch (name) {
        case 'vesti_get_project_context':
          payload = vestiGetProjectContext(db, (args ?? {}) as Parameters<typeof vestiGetProjectContext>[1]);
          break;
        case 'vesti_search':
          payload = vestiSearch(db, (args ?? {}) as { query: string; topK?: number });
          break;
        case 'vesti_timeline':
          payload = vestiTimeline(db, (args ?? {}) as Parameters<typeof vestiTimeline>[1]);
          break;
        case 'vesti_get_turns':
          payload = vestiGetTurns(db, (args ?? {}) as Parameters<typeof vestiGetTurns>[1]);
          break;
        case 'vesti_project_brief':
          payload = vestiProjectBrief(db, (args ?? {}) as { project: string });
          break;
        case 'vesti_get_handoff_context':
          payload = vestiGetHandoffContext(db, (args ?? {}) as Parameters<typeof vestiGetHandoffContext>[1]);
          break;
        case 'vesti_search_files':
          payload = vestiSearchFiles(db, (args ?? {}) as { query: string; topK?: number });
          break;
        case 'vesti_memory_search':
          payload = vestiMemorySearch(db, (args ?? {}) as Parameters<typeof vestiMemorySearch>[1]);
          break;
        case 'vesti_memory_get':
          payload = vestiMemoryGet(db, (args ?? {}) as Parameters<typeof vestiMemoryGet>[1]);
          break;
        default:
          return {
            isError: true,
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });

  return server;
}

/** Connect the server to stdio; resolves once the transport is up. */
export async function serveStdio(db: VestiDatabase): Promise<Server> {
  const server = createVestiMcpServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
