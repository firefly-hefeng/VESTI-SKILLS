import fs from 'node:fs';

import { ensureCaptureDaemon } from '@vesti/capture-runtime/client';

import { openVestiDb, resolveDbPath, VestiDbNotFoundError } from './db.js';
import { serveStdio } from './server.js';

type CaptureMode = 'live' | 'stale' | 'disabled';

function captureDisabled(env: NodeJS.ProcessEnv): boolean {
  return /^(?:1|true|yes)$/i.test(env.VESTI_CAPTURE_DISABLED?.trim() ?? '');
}

function captureStartupTimeout(env: NodeJS.ProcessEnv): number {
  const parsed = Number(env.VESTI_CAPTURE_STARTUP_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 120_000;
}

async function prepareCapture(dbPath: string, env: NodeJS.ProcessEnv): Promise<CaptureMode> {
  if (captureDisabled(env)) return 'disabled';
  try {
    await ensureCaptureDaemon({
      dbPath,
      env,
      startupTimeoutMs: captureStartupTimeout(env),
    });
    return 'live';
  } catch (error) {
    // An existing database remains useful when the daemon cannot start. This
    // keeps recall available while making the stale-data condition explicit.
    if (!fs.existsSync(dbPath)) throw error;
    console.error(
      `vesti-mcp: capture unavailable; serving existing memory: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 'stale';
  }
}

async function main(): Promise<void> {
  const dbPath = resolveDbPath(process.env);
  const captureMode = await prepareCapture(dbPath, process.env);
  let db;
  try {
    db = openVestiDb(dbPath);
  } catch (error) {
    if (error instanceof VestiDbNotFoundError) {
      console.error(`vesti-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  await serveStdio(db);
  console.error(`vesti-mcp: serving ${dbPath} (read-only, capture=${captureMode}) on stdio`);
}

main().catch(error => {
  console.error(`vesti-mcp: fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
