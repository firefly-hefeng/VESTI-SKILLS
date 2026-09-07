import { describe, expect, it } from 'vitest';

import { daemonLooksReady } from '../src/runtime.js';

describe('daemonLooksReady', () => {
  it('accepts the capture runtime running state after the initial sync', () => {
    expect(daemonLooksReady({ state: 'running', initialSyncComplete: true })).toBe(true);
  });

  it('rejects running state until its initial sync is complete', () => {
    expect(daemonLooksReady({ state: 'running', initialSyncComplete: false })).toBe(false);
    expect(daemonLooksReady({ state: 'running' })).toBe(false);
  });

  it.each([
    null,
    false,
    { state: 'starting', initialSyncComplete: false },
    { state: 'stopped', initialSyncComplete: true },
    { running: false },
    { ready: false },
  ])('rejects a non-ready daemon status: %j', status => {
    expect(daemonLooksReady(status)).toBe(false);
  });

  it.each([
    true,
    { running: true },
    { ready: true },
    { ok: true },
    { alive: true },
    { status: 'running' },
    { status: 'ready' },
  ])('keeps compatibility with ready legacy status: %j', status => {
    expect(daemonLooksReady(status)).toBe(true);
  });
});
