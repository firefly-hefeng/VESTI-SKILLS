import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/client.ts',
    'src/daemon-cli.ts',
    'src/injectedBlocks.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  external: [
    'better-sqlite3',
    'chokidar',
    'fs-extra',
    'glob',
  ],
});
