import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Isolate native SQLite instances across processes. Worker-thread teardown
    // can crash on Windows even after every assertion has passed.
    pool: 'forks',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
