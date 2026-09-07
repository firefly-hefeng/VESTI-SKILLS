/**
 * Fork lineage pure-logic tests (memory v2).
 * Covers: dedup keys, codex rollout overlap detection, ancestor chains and
 * unique-message counting — including multi-level forks and cycle guards.
 */

import { describe, expect, it } from 'vitest';
import {
  buildForkAncestorMap,
  computeUniqueMessageCounts,
  detectForksByMessageOverlap,
  messageDedupKey,
  type ForkCandidateSession,
} from '../src/tree/forks.js';

describe('messageDedupKey', () => {
  it('strips the per-session namespace from codex message ids', () => {
    expect(messageDedupKey('codex', 'sess-1', 'codex-sess-1-message-item-9')).toBe('message-item-9');
    expect(messageDedupKey('codex', 'sess-2', 'codex-sess-2-message-item-9')).toBe('message-item-9');
  });

  it('keeps raw uuids for other platforms (fork copies share them verbatim)', () => {
    expect(messageDedupKey('kimi-code', 'sess-1', 'uuid-abc')).toBe('uuid-abc');
    expect(messageDedupKey('codex', 'other', 'uuid-abc')).toBe('uuid-abc');
  });
});

function codexSession(id: string, rawId: string, startedAt: number, itemIds: string[]): ForkCandidateSession {
  return {
    id,
    rawSessionId: rawId,
    platform: 'codex',
    startedAt,
    messageIds: itemIds.map(item => `codex-${rawId}-message-${item}`),
  };
}

describe('detectForksByMessageOverlap', () => {
  it('marks the later rollout as forked from the earlier one sharing its history', () => {
    const parent = codexSession('codex:p', 'p', 1000, ['a', 'b', 'c', 'd', 'e', 'f']);
    // Fork: 6 copied items + 2 new ones.
    const child = codexSession('codex:c', 'c', 2000, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const unrelated = codexSession('codex:u', 'u', 3000, ['x', 'y', 'z']);

    const edges = detectForksByMessageOverlap([child, unrelated, parent]);
    expect(edges.get('codex:c')).toBe('codex:p');
    expect(edges.has('codex:p')).toBe(false);
    expect(edges.has('codex:u')).toBe(false);
  });

  it('picks the ancestor sharing the most history in a fork chain', () => {
    const root = codexSession('codex:r', 'r', 1000, ['a', 'b', 'c', 'd', 'e', 'f']);
    const mid = codexSession('codex:m', 'm', 2000, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const leaf = codexSession('codex:l', 'l', 3000, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);

    const edges = detectForksByMessageOverlap([root, mid, leaf]);
    expect(edges.get('codex:m')).toBe('codex:r');
    // The leaf shares more with mid (8) than with root (6).
    expect(edges.get('codex:l')).toBe('codex:m');
  });

  it('ignores pairs below the shared-count and ratio thresholds', () => {
    const parent = codexSession('codex:p', 'p', 1000, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    // Only 3 of 8 shared: below minShared and below the 0.5 ratio.
    const weak = codexSession('codex:w', 'w', 2000, ['a', 'b', 'c', 'i', 'j', 'k', 'l', 'm']);
    const edges = detectForksByMessageOverlap([parent, weak]);
    expect(edges.size).toBe(0);
  });

  it('does not mark near-identical twins started at the same time as parentless', () => {
    const a = codexSession('codex:a', 'a', 1000, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const b = codexSession('codex:b', 'b', 1000, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const edges = detectForksByMessageOverlap([a, b]);
    // Same start time: deterministic id order decides the parent, no crash.
    expect(edges.size).toBe(1);
  });
});

describe('buildForkAncestorMap', () => {
  it('walks chains nearest-parent-first and cuts cycles', () => {
    const chains = buildForkAncestorMap([
      { id: 'c', forkedFrom: 'b' },
      { id: 'b', forkedFrom: 'a' },
      { id: 'a', forkedFrom: null },
      { id: 'x', forkedFrom: 'y' },
      { id: 'y', forkedFrom: 'x' }, // cycle
    ]);
    expect(chains.get('c')).toEqual(['b', 'a']);
    expect(chains.get('x')).toEqual(['y']);
    expect(chains.get('y')).toEqual(['x']);
    expect(chains.has('a')).toBe(false);
  });
});

describe('computeUniqueMessageCounts', () => {
  it('counts pre-fork copies once, on the earliest ancestor', () => {
    const counts = computeUniqueMessageCounts([
      {
        id: 'codex:p', rawSessionId: 'p', platform: 'codex',
        messageIds: ['codex-p-message-a', 'codex-p-message-b', 'codex-p-message-c'],
      },
      {
        id: 'codex:c', rawSessionId: 'c', platform: 'codex', forkedFrom: 'codex:p',
        messageIds: ['codex-c-message-a', 'codex-c-message-b', 'codex-c-message-c', 'codex-c-message-d'],
      },
    ]);
    expect(counts.get('codex:p')).toEqual({ unique: 3, duplicated: 0 });
    expect(counts.get('codex:c')).toEqual({ unique: 1, duplicated: 3 });
  });

  it('deduplicates against the whole ancestor chain (root owns the copy)', () => {
    const counts = computeUniqueMessageCounts([
      { id: 'r', rawSessionId: 'r', platform: 'codex', messageIds: ['codex-r-message-a', 'codex-r-message-b'] },
      { id: 'm', rawSessionId: 'm', platform: 'codex', forkedFrom: 'r', messageIds: ['codex-m-message-a', 'codex-m-message-c'] },
      {
        id: 'l', rawSessionId: 'l', platform: 'codex', forkedFrom: 'm',
        messageIds: ['codex-l-message-a', 'codex-l-message-c', 'codex-l-message-new'],
      },
    ]);
    expect(counts.get('m')).toEqual({ unique: 1, duplicated: 1 });
    expect(counts.get('l')).toEqual({ unique: 1, duplicated: 2 });
  });

  it('leaves non-fork sessions untouched', () => {
    const counts = computeUniqueMessageCounts([
      { id: 's', rawSessionId: 's', platform: 'kimi-code', messageIds: ['u1', 'u2'] },
    ]);
    expect(counts.get('s')).toEqual({ unique: 2, duplicated: 0 });
  });
});
