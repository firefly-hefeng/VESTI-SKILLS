# @vesti/memory

Standalone setup entry for VESTI's local memory runtime. It wires together
three parts without installing or opening the desktop app:

- `@vesti/capture-runtime`: one background writer per target database;
- `@vesti/mcp`: the read-only stdio retrieval server;
- the bundled `vesti-memory` Skill: host-side recall instructions.

The daemon scans existing local session records, watches supported sources for
changes, and keeps `~/.vesti/db/vesti.db` current. Every configured client reads
the same local memory through MCP. The desktop app remains an optional UI.

## Quick start

After the package is published:

```bash
npm install -g @vesti/memory
vesti setup
vesti status
vesti sync
vesti doctor
```

`setup` detects installed clients. To configure one host explicitly:

```bash
vesti setup --host codex
vesti setup --host claude
vesti setup --host kimi-code
vesti setup --host cursor
vesti setup --host all --dry-run
```

`--host` selects which client configuration is changed; it does not narrow
the local conversation sources scanned by the capture daemon. Restart or reload
the configured client after setup so it can discover the new Skill and MCP.

When working from this source repository instead of a published package, build
the workspace and invoke the generated CLI directly:

```bash
corepack pnpm install
corepack pnpm build
node packages/vesti-memory/dist/cli.js setup
```

## What setup changes

`setup` installs the Skill and merges a `vesti` stdio MCP entry into the
selected client's user configuration:

| Client | Skill directory | MCP configuration |
| --- | --- | --- |
| Codex | `~/.agents/skills/vesti-memory` | `~/.codex/config.toml`, `[mcp_servers.vesti]` |
| Claude Code | `~/.claude/skills/vesti-memory` | `~/.claude.json`, `mcpServers.vesti` |
| Kimi Code | `~/.kimi-code/skills/vesti-memory` | `~/.kimi-code/mcp.json`, `mcpServers.vesti` |
| Cursor | `~/.cursor/skills/vesti-memory` | `~/.cursor/mcp.json`, `mcpServers.vesti` |

The operation is idempotent. Existing configuration is backed up before a
change, unrelated keys and MCP servers are preserved, and malformed or
ambiguous configuration is left untouched with manual instructions printed.
Use `--dry-run` to preview changes.

Use a global installation (or a stable source checkout) for `setup`. A
one-shot `npx` cache path is not a durable MCP executable location and the CLI
refuses to persist it.

`setup` starts the daemon for the current login session. It deliberately does
not create an operating-system startup task: launching the configured MCP can
start or reconnect to the same daemon later, and an incremental scan catches
records written while it was stopped.

The runtime reads local conversation records and stores normalized content,
source backups where permitted, and operational logs under `~/.vesti` by
default. Treat that directory as sensitive local data. Trae support currently
covers readable legacy `state.vscdb` stores, not the newer encrypted
`ModularData/ai-agent/database.db`.

Until the desktop app's legacy capture process is migrated to this daemon (or
the same lock protocol), do not run both writers against the same SQLite file.
Use either standalone capture or app capture for a given database.

## Environment overrides

- `VESTI_HOME` or `VESTI_DATA_DIR`: VESTI's local data directory.
- `VESTI_DB_PATH`: explicit SQLite database path.
- `VESTI_MCP_SERVER_PATH`: explicit path to the built `@vesti/mcp` CLI.
- `VESTI_CAPTURE_DISABLED=1`: serve an existing database without starting the
  capture daemon (snapshot/debug mode).
- `VESTI_CAPTURE_STARTUP_TIMEOUT_MS`: MCP wait limit for initial capture setup.
- `KIMI_CODE_HOME`: Kimi Code config, Skill and local-session root override.

When any of `VESTI_HOME`, `VESTI_DB_PATH`, `VESTI_DATA_DIR` or
`KIMI_CODE_HOME` is explicitly set during setup, its absolute path is saved
in the MCP entry so later client launches use the same location.

## Development

```bash
corepack pnpm --filter @vesti/memory typecheck
corepack pnpm --filter @vesti/memory test
corepack pnpm --filter @vesti/memory build
```
