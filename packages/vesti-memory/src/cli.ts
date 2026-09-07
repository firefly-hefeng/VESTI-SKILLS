#!/usr/bin/env node

import { runCli } from './index.js';

runCli(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  error => {
    console.error(`vesti: fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
