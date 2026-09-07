# @vesti/capture-runtime

Electron-free Node.js VESTI capture runtime. It captures local sessions without the VESTI
desktop application and exposes a single-writer daemon for MCP clients.

## What it runs

- Codex, Cursor, Kimi Code, Claude Code, Qoder (`coder`) and WorkBuddy
- readable legacy Trae `state.vscdb` stores; newer encrypted
  `ModularData/ai-agent/database.db` is deliberately not parsed
- an initial incremental reconciliation before the daemon becomes ready
- native filesystem watching through chokidar
- WSL polling every 60 seconds
- a full reconciliation every five minutes to recover missed filesystem events
- one standalone SQLite writer per target database, protected by an ownership
  lock and local IPC
- raw transcript backup in the configured Vault path where the source adapter permits it

The default data layout remains compatible with the desktop application:

```text
~/.vesti/
  db/vesti.db
  vault/
  logs/capture-daemon.log
  runtime/capture-<db-hash>/capture-daemon.lock
```

Set `VESTI_HOME` to change the data layout. `VESTI_DB_PATH` always overrides
the database file, including when `VESTI_HOME` is also set. Lock and IPC
identity are derived from the normalized database path, so different data-root
hints cannot create two standalone writers for the same SQLite file.

## Daemon

The following binary is available when `@vesti/capture-runtime` itself is
installed globally (normal users should use `vesti setup`):

```bash
vesti-captured --foreground
vesti-captured --data-dir /custom/vesti
```

The daemon uses a Windows named pipe or Unix domain socket. Its newline-delimited
JSON protocol supports `ping`, `status`, `sync` and `shutdown`. File and runtime
logs go to the configured `logs/capture-daemon.log`; foreground diagnostics use stderr.

## Lightweight MCP client

The `@vesti/capture-runtime/client` entry does not load SQLite or capture
adapters, so an MCP stdio process can safely use it during startup:

```ts
import {
  ensureCaptureDaemon,
  getCaptureDaemonStatus,
  requestCaptureDaemon,
} from '@vesti/capture-runtime/client';

// Resolves only after schema creation and the initial sync are complete.
const status = await ensureCaptureDaemon();
await requestCaptureDaemon({ command: 'sync', reason: 'mcp-request' });
console.error((await getCaptureDaemonStatus()).state);
```

`ensureCaptureDaemon` first probes the common socket, starts a detached daemon
only when necessary, and tolerates concurrent clients racing to launch it.

The runtime reads local conversation records and writes normalized content,
allowed source backups and logs to the configured VESTI directory. Protect it
as sensitive local data. Until the desktop app's legacy capture process adopts
this daemon or lock protocol, do not run both writers against one database.
