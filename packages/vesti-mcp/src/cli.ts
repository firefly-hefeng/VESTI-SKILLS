import { openVestiDb, resolveDbPath, VestiDbNotFoundError } from './db.js';
import { serveStdio } from './server.js';

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
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
  console.error(`vesti-mcp: serving ${dbPath} (read-only) on stdio`);
}

main().catch(error => {
  console.error(`vesti-mcp: fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
