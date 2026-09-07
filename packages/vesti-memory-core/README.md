# @vesti/memory-core

VESTI's memory storage, digest pipeline and retrieval core as a standalone
package: the SQLite schema with 15 migrations, the work-session/message store,
the L0–L2 project memory (state card, file timeline, maintained brief), the
memory space (deposit / dream / note entries), the session digest pipeline and
the three-layer recall primitives (FTS5 recall with trigram fallback, vector
search, semantic edges).

Ported from the VESTI desktop app with the Electron shell removed. All
model-touching pieces are injected interfaces — `DigestAgentRunner` (chat LLM)
and `DigestEmbedder` (embeddings) — so the package itself has no network, LLM
SDK or Electron dependency; the only runtime dependency is better-sqlite3.

The package is ESM-only and requires Node.js 22.12 or newer.

```ts
import { DatabaseManager, DigestService } from '@vesti/memory-core';

const manager = new DatabaseManager('~/.vesti/db/vesti.db');
await manager.initialize(); // runs the 15 migrations

manager.upsertWorkSession(session);
manager.insertSessionMessages(messages);

// Digest pipeline: LLM and embedder are injected by the caller.
const digest = new DigestService(manager, myAgentRunner, myEmbedder);
await digest.enqueuePending();

// FTS recall (recency-weighted RRF, trigram-aware, confidence signal).
const hits = manager.recallSessions('transactional migrations', { topK: 8 });
```

Capture/parsing of source transcripts, token-usage accounting, Vault and sync
remain outside this focused storage package. They are available without the
desktop app through the sibling `@vesti/capture-runtime` package.

## Development

```bash
corepack pnpm install
corepack pnpm --filter @vesti/memory-core typecheck
corepack pnpm --filter @vesti/memory-core test
corepack pnpm --filter @vesti/memory-core build
```
