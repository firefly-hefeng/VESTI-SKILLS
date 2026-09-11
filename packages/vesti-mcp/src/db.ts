/**
 * Access to the VESTI capture database.
 *
 * Port note: the upstream app uses the built-in `node:sqlite` driver
 * (node >= 23.4). This standalone build pins better-sqlite3 (^12) instead
 * so it runs on the package's declared floor (node >= 22.12) without
 * experimental flags. It exposes the synchronous prepare/get/all interface
 * used by this read-only package; the supported query subset is covered by
 * the MCP test suite.
 *
 * The connection is switched to SQLite query-only mode immediately after it
 * opens. Capture/runtime code owns all mutations, including access accounting.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

export type VestiDatabase = Database.Database;

export function defaultDbPath(): string {
  return path.join(os.homedir(), '.vesti', 'db', 'vesti.db');
}

/** VESTI_DB_PATH wins, then VESTI_HOME, then `~/.vesti/db/vesti.db`. */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VESTI_DB_PATH?.trim();
  if (override) return path.resolve(override);
  const dataHome = env.VESTI_HOME?.trim() || env.VESTI_DATA_DIR?.trim();
  return dataHome
    ? path.resolve(dataHome, 'db', 'vesti.db')
    : defaultDbPath();
}

export class VestiDbNotFoundError extends Error {
  constructor(dbPath: string) {
    super(
      `VESTI database not found at ${dbPath}.\n` +
        'Build the VESTI-SKILLS repository and run `node packages/vesti-memory/dist/cli.js setup` to start standalone capture; ' +
        'you can also point VESTI_DB_PATH at an existing vesti.db.',
    );
    this.name = 'VestiDbNotFoundError';
  }
}

/**
 * Open the database. Throws VestiDbNotFoundError when the file is missing so
 * the CLI can print actionable guidance instead of a stack trace. See the
 * returned connection is guarded by SQLite query_only mode.
 */
export function openVestiDb(dbPath: string): VestiDatabase {
  if (!fs.existsSync(dbPath)) throw new VestiDbNotFoundError(dbPath);
  const db = new Database(dbPath);
  db.pragma('query_only = ON');
  return db;
}
