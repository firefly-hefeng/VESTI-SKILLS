/**
 * VectorSearch Tests
 */

import { describe, it, expect } from 'vitest';
import {
  serializeVector,
  deserializeVector,
  cosineSimilarity,
  searchByVector,
} from '../src/search/VectorSearch.js';

describe('serializeVector / deserializeVector', () => {
  it('round-trips a Float32Array through a Buffer', () => {
    const original = new Float32Array([0, 1, -1, 3.14159, 1e-7, 12345.678]);
    const restored = deserializeVector(serializeVector(original));
    expect(restored).toBeInstanceOf(Float32Array);
    expect(Array.from(restored)).toEqual(Array.from(original));
  });

  it('round-trips an empty vector', () => {
    const restored = deserializeVector(serializeVector(new Float32Array(0)));
    expect(restored.length).toBe(0);
  });

  it('produces 4 bytes per element', () => {
    expect(serializeVector(new Float32Array(3)).byteLength).toBe(12);
  });

  it('rejects buffers not aligned to 4 bytes', () => {
    expect(() => deserializeVector(Buffer.alloc(6))).toThrow(/multiple of 4/);
  });
});

describe('cosineSimilarity', () => {
  it('scores identical vectors as 1', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it('scores orthogonal vectors as 0', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
  });

  it('scores opposite vectors as -1', () => {
    expect(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([-1, -1]))).toBeCloseTo(-1, 6);
  });

  it('is scale-invariant', () => {
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([10, 20]))).toBeCloseTo(1, 6);
  });

  it('returns 0 when either vector has zero norm', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 2]))).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity(new Float32Array(2), new Float32Array(3))).toThrow(/dimension mismatch/);
  });
});

describe('searchByVector', () => {
  const candidates = [
    { id: 'aligned', vector: new Float32Array([1, 0, 0]) },
    { id: 'orthogonal', vector: new Float32Array([0, 1, 0]) },
    { id: 'opposite', vector: new Float32Array([-1, 0, 0]) },
    { id: 'close', vector: new Float32Array([1, 0.1, 0]) },
  ];
  const query = new Float32Array([1, 0, 0]);

  it('ranks candidates by descending similarity', () => {
    const matches = searchByVector(query, candidates, 4);
    expect(matches.map(m => m.id)).toEqual(['aligned', 'close', 'orthogonal', 'opposite']);
    expect(matches[0].score).toBeCloseTo(1, 6);
    expect(matches[3].score).toBeCloseTo(-1, 6);
  });

  it('limits results to topK', () => {
    const matches = searchByVector(query, candidates, 2);
    expect(matches.map(m => m.id)).toEqual(['aligned', 'close']);
  });

  it('returns all candidates when topK exceeds the candidate count', () => {
    expect(searchByVector(query, candidates, 100)).toHaveLength(4);
  });

  it('returns empty for empty candidates or non-positive topK', () => {
    expect(searchByVector(query, [], 5)).toEqual([]);
    expect(searchByVector(query, candidates, 0)).toEqual([]);
  });
});
