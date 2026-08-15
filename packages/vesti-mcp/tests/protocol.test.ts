/**
 * Minimal protocol handshake test: initialize + tools/list + tools/call over
 * the SDK's linked in-memory transports (the same Server instance the stdio
 * CLI serves).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openVestiDb, type VestiDatabase } from '../src/db.js';
import { createVestiMcpServer } from '../src/server.js';
import { createFixtureDb, SESSION_A, type Fixture } from './helpers/fixture.js';

let fixture: Fixture;
let db: VestiDatabase;
let client: Client;

beforeEach(async () => {
  fixture = createFixtureDb();
  db = openVestiDb(fixture.dbPath);
  const server = createVestiMcpServer(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  db.close();
  fixture.cleanup();
});

describe('MCP handshake', () => {
  it('completes initialize and reports the server identity', () => {
    const info = client.getServerVersion();
    expect(info?.name).toBe('vesti-mcp');
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it('advertises the session-start behavior contract in its instructions', () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toContain('vesti_get_project_context');
    expect(instructions).toContain('vesti_get_handoff_context');
    expect(instructions).toContain('vesti_search_files');
    expect(instructions).toMatch(/vesti_search.*vesti_timeline.*vesti_get_turns/s);
    expect(instructions).toMatch(/vesti_memory_search.*vesti_memory_get/s);
  });

  it('lists the context tools plus the three progressive-disclosure layers', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name)).toEqual([
      'vesti_get_project_context',
      'vesti_search',
      'vesti_timeline',
      'vesti_get_turns',
      'vesti_project_brief',
      'vesti_get_handoff_context',
      'vesti_search_files',
      'vesti_memory_search',
      'vesti_memory_get',
    ]);
    for (const tool of tools.slice(1, 4)) {
      expect(tool.description).toMatch(/Layer [123] of 3/);
      expect(tool.inputSchema.type).toBe('object');
    }
    expect(tools[1].inputSchema.required).toContain('query');
    expect(tools[2].inputSchema.required).toContain('session_id');
    expect(tools[3].inputSchema.required).toContain('session_id');
    expect(tools[4].inputSchema.required).toContain('project');
    // The session-start tool takes optional paths (defaults to most recent).
    expect(tools[0].inputSchema.required ?? []).not.toContain('paths');
    // File lookup needs a query; memory space: search needs nothing (browse
    // mode), get requires ids.
    expect(tools[6].inputSchema.required).toContain('query');
    expect(tools[7].inputSchema.required ?? []).toHaveLength(0);
    expect(tools[8].inputSchema.required).toContain('ids');
  });

  it('serves vesti_search → vesti_timeline → vesti_get_turns end to end', async () => {
    const search = await client.callTool({ name: 'vesti_search', arguments: { query: 'transactional migrations' } });
    expect(search.isError).toBeFalsy();
    const searchPayload = JSON.parse((search.content as Array<{ text: string }>)[0].text);
    const sessionId = searchPayload.results[0].session_id;
    expect(sessionId).toBe(SESSION_A);

    const timeline = await client.callTool({ name: 'vesti_timeline', arguments: { session_id: sessionId } });
    const timelinePayload = JSON.parse((timeline.content as Array<{ text: string }>)[0].text);
    expect(timelinePayload.total_turns).toBe(3);

    const turns = await client.callTool({
      name: 'vesti_get_turns',
      arguments: { session_id: sessionId, turn_ids: [1] },
    });
    const turnsPayload = JSON.parse((turns.content as Array<{ text: string }>)[0].text);
    expect(turnsPayload.turns[0].assistant).toContain('transaction');
  });

  it('returns isError for unknown tools and unknown sessions', async () => {
    const unknownTool = await client.callTool({ name: 'vesti_nope', arguments: {} });
    expect(unknownTool.isError).toBe(true);

    const unknownSession = await client.callTool({
      name: 'vesti_timeline',
      arguments: { session_id: 'nope' },
    });
    expect(unknownSession.isError).toBe(true);
    expect((unknownSession.content as Array<{ text: string }>)[0].text).toMatch(/Session not found/);
  });

  it('reports the missing memory space as friendly isError text, not a stack', async () => {
    // The base fixture predates schema v14 — no memory_entries table.
    const result = await client.callTool({ name: 'vesti_memory_search', arguments: { query: 'vesti' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/memory space is not set up/);
  });
});
