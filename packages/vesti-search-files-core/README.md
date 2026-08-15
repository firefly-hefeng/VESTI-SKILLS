# @vesti/search-files-core

Repository-independent core for `vesti_search_files`.

The package accepts a synchronous `FileSearchDataSource` supplied by the data
owner and returns ranked historical file evidence. It contains path extraction,
query tokenization, evidence aggregation and ranking, but no SQLite, filesystem,
network, Electron or MCP dependencies.

The package is ESM-only and requires Node.js 22.12 or newer.

```ts
import { searchFiles, type FileSearchDataSource } from '@vesti/search-files-core';

const result = searchFiles(dataSource, {
  query: 'OAuth callback in vesti-app',
  project: 'vesti-app',
  topK: 10,
});
```

`project` accepts an exact project path or an unambiguous project
name/alias. The optional `sessionRecallLimit` (default 12, maximum 30) and
`includeTrace` fields exist for controlled evaluation and diagnostics.
Production MCP responses omit internal traces unless the embedding application
explicitly consumes them out of band.

Returned paths describe files touched by captured historical sessions. Consumers
must scope them to the intended project, verify that they still exist, and read
their current content with their own filesystem tools.

## Development

```bash
corepack pnpm install
corepack pnpm --filter @vesti/search-files-core typecheck
corepack pnpm --filter @vesti/search-files-core test
corepack pnpm --filter @vesti/search-files-core build
```
