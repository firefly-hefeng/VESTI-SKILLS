import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';

const dbPath = process.env.VESTI_DB_PATH?.trim();
const mcpEntry = process.env.VESTI_MCP_ENTRY?.trim();
const serverInstructions = process.env.VESTI_MCP_SERVER_INSTRUCTIONS?.trim();

if (!dbPath) throw new Error('VESTI_DB_PATH is required');
if (!mcpEntry) throw new Error('VESTI_MCP_ENTRY is required');
if (!serverInstructions) throw new Error('VESTI_MCP_SERVER_INSTRUCTIONS is required');

const { createVestiMcpServer, openVestiDb } = await import(pathToFileURL(mcpEntry).href);
const db = openVestiDb(dbPath);
const server = createVestiMcpServer(db, { serverInstructions });
const transport = new StdioServerTransport();

let closed = false;
const close = async () => {
  if (closed) return;
  closed = true;
  try {
    await server.close();
  } finally {
    db.close();
  }
};

process.once('SIGINT', () => void close().finally(() => process.exit(0)));
process.once('SIGTERM', () => void close().finally(() => process.exit(0)));
process.once('exit', () => {
  if (!closed) db.close();
});

await server.connect(transport);
console.error(`vesti-agent-benchmark: serving ${dbPath} (read-only) on stdio`);
