/**
 * Access to the VESTI capture database.
 *
 * Port note: the upstream app uses the built-in `node:sqlite` driver
 * (node >= 23.4). This standalone build pins better-sqlite3 (^12) instead
 * so it runs on the package's declared floor (node >= 22.12) without
 * experimental flags. The subset used here — prepare/get/all/run — has
 * identical semantics.
 *
 * Write policy: the database is opened read-write, but the ONLY write this
 * server ever issues is `session_digests.access_count + 1` when vesti_search
 * surfaces a digest (memory v2 L1 access tracking). Everything else is
 * strictly read-only. If the column is missing (pre-v4 database) the bump is
 * skipped silently.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

export type VestiDatabase = Database.Database;

export function defaultDbPath(): string {
  return path.join(os.homedir(), '.vesti', 'db', 'vesti.db');
}

/** VESTI_DB_PATH wins; otherwise the default `~/.vesti/db/vesti.db`. */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VESTI_DB_PATH?.trim();
  return override ? path.resolve(override) : defaultDbPath();
}

export class VestiDbNotFoundError extends Error {
  constructor(dbPath: string) {
    super(
      `VESTI database not found at ${dbPath}.\n` +
        'Run the VESTI desktop app (or CLI capture) first so it can collect sessions, ' +
        'or point VESTI_DB_PATH at an existing vesti.db.',
    );
    this.name = 'VestiDbNotFoundError';
  }
}

/**
 * Open the database. Throws VestiDbNotFoundError when the file is missing so
 * the CLI can print actionable guidance instead of a stack trace. See the
 * file-header comment for the (single-statement) write policy.
 */
export function openVestiDb(dbPath: string): VestiDatabase {
  if (!fs.existsSync(dbPath)) throw new VestiDbNotFoundError(dbPath);
  return new Database(dbPath);
}
