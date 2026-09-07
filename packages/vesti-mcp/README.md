# @vesti/mcp

MCP server that exposes a local VESTI memory database to any MCP-compatible
client. The companion headless runtime captures sessions from Codex, Cursor,
Kimi Code, Claude Code, Qoder and WorkBuddy, plus readable legacy Trae
`state.vscdb` stores. Trae's newer encrypted
`ModularData/ai-agent/database.db` is not supported. Available tools include
session recall (`vesti_search`),
single-session outlines (`vesti_timeline`), full turn content
(`vesti_get_turns`), project context and handoff packs
(`vesti_get_project_context`, `vesti_project_brief`,
`vesti_get_handoff_context`), the memory space (`vesti_memory_search`,
`vesti_memory_get`) and the file index (`vesti_search_files`, aggregation core
in `@vesti/search-files-core`).

Strictly read-only. Capture/runtime code owns database mutations and access
accounting. Older schemas degrade gracefully — missing tables/columns simply
disable the matching channel.

The package is ESM-only and requires Node.js 22.12 or newer. Starting
`vesti-mcp` automatically starts or reconnects to the one standalone capture
daemon for the target database. VESTI App is optional.

For normal installation, use the combined setup package. It installs the
Skill, registers this stdio server and starts capture:

```bash
npm install -g @vesti/memory
vesti setup
```

If `@vesti/mcp` itself is installed globally, its `vesti-mcp` binary serves
stdio and ensures live capture. Installing only `@vesti/memory` exposes the
top-level `vesti` command; setup records the MCP dependency's absolute entry
and does not require `vesti-mcp` to be on the user's PATH.

`VESTI_HOME` controls the base layout for logs, Vault and default storage;
`VESTI_DB_PATH` independently overrides the SQLite file. Set
`VESTI_CAPTURE_DISABLED=1` only when intentionally querying a static database
snapshot.

Project summaries, briefs and long-term memory entries are returned only when
they already exist in the database. Newly captured raw sessions immediately
support full-text search, timelines, selected-turn reads and recorded file
touches; the read-only MCP does not synthesize missing summary layers.

Until the desktop app's legacy capture process is migrated to the standalone
daemon (or the same lock protocol), do not run both writers against one SQLite
file.

```ts
import { createVestiMcpServer, openVestiDb, resolveDbPath } from '@vesti/mcp';

const db = openVestiDb(resolveDbPath());
const server = createVestiMcpServer(db);
```

Port note: the upstream app uses the built-in `node:sqlite` driver; this
standalone build pins better-sqlite3 (^12) so it runs on Node 22 LTS without
experimental flags. VESTI uses their common prepare/get/all/run subset and
verifies the adapter behavior through its test suite.

## Development

```bash
corepack pnpm install
corepack pnpm --filter @vesti/mcp typecheck
corepack pnpm --filter @vesti/mcp test
corepack pnpm --filter @vesti/mcp build
```
