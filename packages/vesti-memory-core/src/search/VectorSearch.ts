/**
 * Vector Search
 * Brute-force cosine similarity over Float32Array embeddings, plus
 * Buffer <-> Float32Array (little-endian) serialization for SQLite BLOB
 * storage. Pure functions with no database access; callers decide where
 * vectors are stored and how candidates are loaded.
 */

export interface VectorCandidate {
  id: string;
  vector: Float32Array;
}

export interface VectorMatch {
  id: string;
  score: number;
}

/** Serialize a Float32Array to a little-endian Buffer for BLOB storage. */
export function serializeVector(vector: Float32Array): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) {
    buffer.writeFloatLE(vector[i], i * 4);
  }
  return buffer;
}

/** Inverse of serializeVector. Throws on buffers not aligned to 4 bytes. */
export function deserializeVector(buffer: Buffer): Float32Array {
  if (buffer.byteLength % 4 !== 0) {
    throw new Error(`Invalid vector blob: ${buffer.byteLength} bytes is not a multiple of 4`);
  }
  const vector = new Float32Array(buffer.byteLength / 4);
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = buffer.readFloatLE(i * 4);
  }
  return vector;
}

/** Cosine similarity in [-1, 1]; zero-norm vectors score 0. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Rank candidates against the query vector by cosine similarity.
 * Returns at most topK matches, highest score first; ties break by id for
 * deterministic output.
 */
export function searchByVector(
  query: Float32Array,
  candidates: VectorCandidate[],
  topK: number,
): VectorMatch[] {
  if (topK <= 0 || candidates.length === 0) return [];
  return candidates
    .map(candidate => ({
      id: candidate.id,
      score: cosineSimilarity(query, candidate.vector),
    }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, topK);
}
