import { describe, expect, it, vi } from 'vitest';
import { dispatchCaptureDaemonRequest } from '../src/runtime/dispatch.js';
import {
  createNdjsonDecoder,
  encodeNdjson,
  parseCaptureDaemonRequest,
  parseCaptureDaemonResponse,
} from '../src/runtime/protocol.js';
import {
  CAPTURE_DAEMON_PROTOCOL_VERSION,
  type CaptureDaemonStatus,
  type CaptureSyncSummary,
} from '../src/runtime/types.js';

function daemonStatus(overrides: Partial<CaptureDaemonStatus> = {}): CaptureDaemonStatus {
  return {
    protocolVersion: CAPTURE_DAEMON_PROTOCOL_VERSION,
    socketPath: 'socket',
    lockPath: 'lock',
    state: 'running',
    pid: 123,
    basePath: '/tmp/.vesti',
    dbPath: '/tmp/.vesti/db/vesti.db',
    vaultPath: '/tmp/.vesti/vault',
    startedAt: 1,
    uptimeMs: 10,
    watching: true,
    syncing: false,
    initialSyncComplete: true,
    enabledPlatforms: ['codex'],
    sources: [],
    wsl: null,
    lastSync: null,
    lastError: null,
    wslPollIntervalMs: 60_000,
    reconcileIntervalMs: 300_000,
    ...overrides,
  };
}

describe('capture daemon NDJSON protocol', () => {
  it('decodes fragmented and batched messages', () => {
    const values: unknown[] = [];
    const errors: Error[] = [];
    const decoder = createNdjsonDecoder(values.push.bind(values), errors.push.bind(errors));
    decoder.push('{"id":"1","command":"pi');
    decoder.push('ng"}\n{"id":"2","command":"status"}\n');
    expect(errors).toEqual([]);
    expect(values).toEqual([
      { id: '1', command: 'ping' },
      { id: '2', command: 'status' },
    ]);
  });

  it('isolates malformed lines and keeps decoding', () => {
    const values: unknown[] = [];
    const errors: Error[] = [];
    const decoder = createNdjsonDecoder(values.push.bind(values), errors.push.bind(errors));
    decoder.push('{broken}\n{"id":"ok","command":"ping"}\n');
    expect(errors).toHaveLength(1);
    expect(values).toEqual([{ id: 'ok', command: 'ping' }]);
  });

  it('validates requests and response envelopes', () => {
    expect(parseCaptureDaemonRequest({ id: 'x', command: 'sync', reason: 'manual' }))
      .toEqual({ id: 'x', command: 'sync', reason: 'manual' });
    expect(() => parseCaptureDaemonRequest({ id: '', command: 'ping' })).toThrow(/id/);
    const encoded = encodeNdjson({ id: 'x', ok: true, result: { ready: true } });
    expect(parseCaptureDaemonResponse(JSON.parse(encoded))).toEqual({
      id: 'x',
      ok: true,
      result: { ready: true },
    });
  });

  it('does not report ready until initial sync is complete', async () => {
    const controller = {
      getStatus: () => daemonStatus({ state: 'starting', initialSyncComplete: false }),
      sync: vi.fn<[], Promise<CaptureSyncSummary>>(),
      requestShutdown: vi.fn(),
    };
    const response = await dispatchCaptureDaemonRequest({ id: 'p', command: 'ping' }, controller);
    expect(response).toMatchObject({
      ok: true,
      result: { ready: false, state: 'starting' },
    });
    const sync = await dispatchCaptureDaemonRequest({ id: 's', command: 'sync' }, controller);
    expect(sync).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
  });

  it('routes sync and shutdown commands', async () => {
    const summary: CaptureSyncSummary = {
      reason: 'test',
      startedAt: 1,
      completedAt: 2,
      sessions: 1,
      messages: 2,
      tools: 3,
      turns: 1,
      linksResolved: 0,
      errors: [],
    };
    const controller = {
      getStatus: () => daemonStatus(),
      sync: vi.fn(async () => summary),
      requestShutdown: vi.fn(),
    };
    expect(await dispatchCaptureDaemonRequest(
      { id: 's', command: 'sync', reason: 'test' },
      controller,
    )).toEqual({ id: 's', ok: true, result: summary });
    expect(controller.sync).toHaveBeenCalledWith('test');
    expect(await dispatchCaptureDaemonRequest(
      { id: 'q', command: 'shutdown' },
      controller,
    )).toEqual({ id: 'q', ok: true, result: { shuttingDown: true } });
    expect(controller.requestShutdown).toHaveBeenCalledOnce();
  });
});
