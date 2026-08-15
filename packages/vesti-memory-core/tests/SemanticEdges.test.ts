import { describe, expect, it } from 'vitest';
import { buildSemanticEdges } from '../src/search/SemanticEdges.js';

const BASE_POLICY = {
  threshold: 0.4,
  neighborsPerNode: 6,
  maxEdges: 900,
  maxVectors: 2_000,
  yieldEvery: Number.MAX_SAFE_INTEGER,
};

describe('buildSemanticEdges', () => {
  it('keeps raw cosine edges above the threshold and normalizes endpoints', async () => {
    const result = await buildSemanticEdges([
      { id: 'b', vector: new Float32Array([1, 0]) },
      { id: 'a', vector: new Float32Array([1, 0]) },
      { id: 'c', vector: new Float32Array([0, 1]) },
    ], BASE_POLICY);

    expect(result.status).toBe('ready');
    expect(result.edges).toEqual([{ source: 'a', target: 'b', weight: 1 }]);
  });

  it('forms the undirected union of each node top-K selection', async () => {
    const result = await buildSemanticEdges([
      { id: 'a', vector: new Float32Array([1, 0]) },
      { id: 'b', vector: new Float32Array([0.99, 0.1]) },
      { id: 'c', vector: new Float32Array([0.8, 0.6]) },
    ], { ...BASE_POLICY, neighborsPerNode: 1 });

    expect(result.edges.map(edge => [edge.source, edge.target])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ]);
  });

  it('uses ids as deterministic tie breakers and applies the global cap', async () => {
    const result = await buildSemanticEdges([
      { id: 'c', vector: new Float32Array([1, 0]) },
      { id: 'b', vector: new Float32Array([1, 0]) },
      { id: 'a', vector: new Float32Array([1, 0]) },
    ], { ...BASE_POLICY, neighborsPerNode: 1, maxEdges: 1 });

    expect(result.edges).toEqual([{ source: 'a', target: 'b', weight: 1 }]);
  });

  it('rejects corrupt and dimension-mismatched vectors', async () => {
    const result = await buildSemanticEdges([
      { id: 'good', vector: new Float32Array([1, 0]) },
      { id: 'zero', vector: new Float32Array([0, 0]) },
      { id: 'nan', vector: new Float32Array([Number.NaN, 1]) },
      { id: 'wrong', vector: new Float32Array([1]) },
    ], BASE_POLICY);

    expect(result.indexedIds).toEqual(['good']);
    expect(result.rejectedIds).toEqual(['nan', 'wrong', 'zero']);
  });

  it('uses the dominant dimension when the first row is corrupt', async () => {
    const result = await buildSemanticEdges([
      { id: 'corrupt-first', vector: new Float32Array([1, 0, 0]) },
      { id: 'good-a', vector: new Float32Array([1, 0]) },
      { id: 'good-b', vector: new Float32Array([0.9, 0.1]) },
    ], BASE_POLICY);

    expect(result.indexedIds).toEqual(['good-a', 'good-b']);
    expect(result.rejectedIds).toEqual(['corrupt-first']);
    expect(result.edges).toHaveLength(1);
  });

  it('refuses exact construction above the vector safety limit', async () => {
    const vectors = Array.from({ length: 2_001 }, (_, index) => ({
      id: String(index),
      vector: new Float32Array([1]),
    }));
    const result = await buildSemanticEdges(vectors, BASE_POLICY);

    expect(result.status).toBe('limit-exceeded');
    expect(result.edges).toEqual([]);
    expect(result.indexedIds).toHaveLength(2_001);
  });
});
