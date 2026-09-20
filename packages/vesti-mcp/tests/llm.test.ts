import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LlmClient, loadLlmConfig } from '../src/llm.js';
import { createVestiMcpServer } from '../src/server.js';
import { openVestiDb } from '../src/db.js';
import { createFixtureDb, SESSION_A } from './helpers/fixture.js';

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'vesti-llm-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

it('is opt-in, loads file settings and lets environment override them', () => {
  expect(loadLlmConfig({}, home)).toBeNull();
  fs.mkdirSync(path.join(home, '.vesti/config'), { recursive: true });
  fs.writeFileSync(path.join(home, '.vesti/config/llm.json'), JSON.stringify({ baseUrl: 'http://localhost:1234/v1/', model: 'local', apiKey: 'file-key' }));
  expect(loadLlmConfig({ VESTI_LLM_MODEL: 'override', VESTI_LLM_API_KEY: '' }, home)).toEqual({ baseUrl: 'http://localhost:1234/v1', model: 'override', timeoutMs: 30000, maxTokens: 1500 });
  expect(loadLlmConfig({ VESTI_LLM_ENABLED: 'false' }, home)).toBeNull();
});

it('rejects incomplete, malformed and unsafe configuration without leaking secrets', () => {
  expect(() => loadLlmConfig({ VESTI_LLM_MODEL: 'model' }, home)).toThrow(/baseUrl and model/);
  expect(() => loadLlmConfig({ VESTI_LLM_CONFIG: path.join(home, 'missing') }, home)).toThrow(/configuration/);
  for (const baseUrl of ['file:///tmp/model', 'https://user:secret@example.test', 'https://example.test?key=secret']) {
    expect(() => loadLlmConfig({ VESTI_LLM_BASE_URL: baseUrl, VESTI_LLM_MODEL: 'model' }, home)).toThrow(/HTTP\(S\)/);
  }
  expect(() => loadLlmConfig({ VESTI_LLM_BASE_URL: 'http://localhost/v1', VESTI_LLM_MODEL: 'm', VESTI_LLM_TIMEOUT_MS: 'NaN' }, home)).toThrow(/timeoutMs/);
});

const config = { baseUrl: 'https://example.test/v1', model: 'model', apiKey: 'secret-key', maxTokens: 100, timeoutMs: 1000 };

it('does not expose provider error bodies or transport secrets', async () => {
  const llm = new LlmClient(config, vi.fn(async () => new Response('secret-key', { status: 401 })) as typeof fetch);
  await expect(llm.complete('system', 'user')).rejects.toThrow('VESTI LLM HTTP 401');
  const broken = new LlmClient(config, vi.fn(async () => { throw new Error('secret-key'); }) as typeof fetch);
  await expect(broken.complete('system', 'user')).rejects.toThrow('VESTI LLM request failed.');
});

it('rejects malformed, empty and oversized provider responses', async () => {
  for (const response of ['not-json', '{}', JSON.stringify({ choices: [{ message: { content: ' ' } }] }), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    const llm = new LlmClient(config, vi.fn(async () => new Response(response)) as typeof fetch);
    await expect(llm.complete('s', 'u')).rejects.toThrow(/VESTI LLM/);
  }
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

it('calls a custom HTTP API through MCP with selected evidence and preserves local retrieval on failure', async () => {
  let fail = false;
  const received: { url?: string; auth?: string; body: any }[] = [];
  const http = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(fail ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(fail ? { error: 'private upstream detail' } : { choices: [{ message: { content: 'Transaction decision [turn 1]' } }] }));
  });
  const baseUrl = await listen(http);
  const fixture = createFixtureDb();
  const db = openVestiDb(fixture.dbPath);
  const server = createVestiMcpServer(db, { llm: new LlmClient({ ...config, baseUrl }) });
  const client = new Client({ name: 'llm-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    const list = await client.listTools();
    expect(list.tools.find(tool => tool.name === 'vesti_summarize')?.annotations?.openWorldHint).toBe(true);
    const args = { session_id: SESSION_A, turn_ids: [1], question: 'What was decided?' };
    const result = await client.callTool({ name: 'vesti_summarize', arguments: args });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as { text: string }[])[0].text);
    expect(payload.source.turn_ids).toEqual([1]);
    expect(payload.summary).toContain('[turn 1]');
    expect(received[0].url).toBe('/v1/chat/completions');
    expect(received[0].auth).toBe('Bearer secret-key');
    expect(received[0].body.model).toBe('model');
    const evidence = JSON.parse(received[0].body.messages[1].content).evidence;
    expect(evidence.turns.map((turn: { seq: number }) => turn.seq)).toEqual([1]);
    expect(evidence.turns[0].assistant).toContain('transaction');
    const invalid = await client.callTool({ name: 'vesti_summarize', arguments: { ...args, turn_ids: [] } });
    expect(invalid.isError).toBe(true);
    expect(received).toHaveLength(1);
    fail = true;
    expect((await client.callTool({ name: 'vesti_summarize', arguments: args })).isError).toBe(true);
    expect((await client.callTool({ name: 'vesti_search', arguments: { query: 'transactional migrations' } })).isError).toBeFalsy();
  } finally {
    await client.close(); await server.close(); db.close(); fixture.cleanup();
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});

it('times out while awaiting the response body and supports caller cancellation', async () => {
  const http = createServer((_req, res) => { res.writeHead(200); res.write('{'); });
  const baseUrl = await listen(http);
  try {
    const llm = new LlmClient({ ...config, baseUrl, timeoutMs: 50 });
    await expect(llm.complete('s', 'u')).rejects.toThrow(/timed out/);
    await expect(llm.complete('s', 'u', AbortSignal.abort())).rejects.toThrow(/cancelled/);
  } finally {
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
