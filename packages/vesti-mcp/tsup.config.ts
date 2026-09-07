import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  noExternal: ['@vesti/search-files-core'],
  banner: { js: '#!/usr/bin/env node' },
});
