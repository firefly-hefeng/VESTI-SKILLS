# @vesti/mcp

MCP server that exposes a VESTI capture database (`~/.vesti/db/vesti.db`) to
agents over the Model Context Protocol: session recall (`vesti_search`),
single-session outlines (`vesti_timeline`), full turn content
(`vesti_get_turns`), project context and handoff packs
(`vesti_get_project_context`, `vesti_project_brief`,
`vesti_get_handoff_context`), the memory space (`vesti_memory_search`,
`vesti_memory_get`) and the file index (`vesti_search_files`, aggregation core
in `@vesti/search-files-core`).

Strictly read-only except for one statement: `session_digests.access_count + 1`
when a digest is surfaced (L1 access tracking). Older schemas degrade
gracefully — missing tables/columns simply disable the matching channel.

The package is ESM-only and requires Node.js 22.12 or newer.

```bash
vesti-mcp            # serves stdio; VESTI_DB_PATH overrides the default db path
```

```ts
import { openVestiDb, createVestiMcpServer } from '@vesti/mcp';

const db = openVestiDb('~/.vesti/db/vesti.db');
const server = createVestiMcpServer(db);
```

Port note: the upstream app uses the built-in `node:sqlite` driver; this
standalone build pins better-sqlite3 (^12) so it runs on Node 22 LTS without
experimental flags. The used subset (prepare/get/all/run) is
semantics-identical.

## Development

```bash
corepack pnpm install
corepack pnpm --filter @vesti/mcp typecheck
corepack pnpm --filter @vesti/mcp test
corepack pnpm --filter @vesti/mcp build
```
