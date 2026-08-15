import { cosineSimilarity } from './VectorSearch.js';

export interface SemanticEdgeVector {
  id: string;
  vector: Float32Array;
}

export interface SemanticEdge {
  source: string;
  target: string;
  weight: number;
}

export interface SemanticEdgePolicy {
  threshold: number;
  neighborsPerNode: number;
  maxEdges: number;
  maxVectors: number;
  /** Pair count between event-loop yields. */
  yieldEvery?: number;
}

export interface SemanticEdgeBuildResult {
  status: 'ready' | 'limit-exceeded';
  edges: SemanticEdge[];
  indexedIds: string[];
  rejectedIds: string[];
}

interface Neighbor {
  id: string;
  weight: number;
}

function compareNeighbors(left: Neighbor, right: Neighbor): number {
  return right.weight - left.weight || left.id.localeCompare(right.id);
}

function validVector(vector: Float32Array, dimensions: number): boolean {
  if (vector.length === 0 || vector.length !== dimensions) return false;
  let norm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return false;
    norm += value * value;
  }
  return norm > 0;
}

function keepNeighbor(list: Neighbor[], candidate: Neighbor, limit: number): void {
  if (limit <= 0) return;
  list.push(candidate);
  list.sort(compareNeighbors);
  if (list.length > limit) list.length = limit;
}

function defaultYield(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Exact, deterministic conversation-to-conversation graph construction.
 * Each node contributes its strongest K qualifying neighbors; the undirected
 * union is then globally capped. No retrieval scores or time decay enter the
 * edge weight.
 */
export async function buildSemanticEdges(
  input: SemanticEdgeVector[],
  policy: SemanticEdgePolicy,
  yieldControl: () => Promise<void> = defaultYield,
): Promise<SemanticEdgeBuildResult> {
  const unique = new Map<string, Float32Array>();
  for (const item of input) {
    if (!unique.has(item.id)) unique.set(item.id, item.vector);
  }

  const dimensionCounts = new Map<number, number>();
  for (const vector of unique.values()) {
    if (vector.length > 0) {
      dimensionCounts.set(vector.length, (dimensionCounts.get(vector.length) ?? 0) + 1);
    }
  }
  const expectedDimensions = [...dimensionCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? 0;
  const vectors: SemanticEdgeVector[] = [];
  const rejectedIds: string[] = [];
  for (const [id, vector] of unique) {
    if (!validVector(vector, expectedDimensions)) rejectedIds.push(id);
    else vectors.push({ id, vector });
  }
  vectors.sort((left, right) => left.id.localeCompare(right.id));
  rejectedIds.sort((left, right) => left.localeCompare(right));

  if (vectors.length > policy.maxVectors) {
    return {
      status: 'limit-exceeded',
      edges: [],
      indexedIds: vectors.map(item => item.id),
      rejectedIds,
    };
  }

  const neighbors = new Map(vectors.map(item => [item.id, [] as Neighbor[]]));
  const yieldEvery = Math.max(1, policy.yieldEvery ?? 4_096);
  let comparisons = 0;
  for (let leftIndex = 0; leftIndex < vectors.length; leftIndex += 1) {
    const left = vectors[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < vectors.length; rightIndex += 1) {
      const right = vectors[rightIndex];
      const weight = Math.max(-1, Math.min(1, cosineSimilarity(left.vector, right.vector)));
      if (weight >= policy.threshold) {
        keepNeighbor(neighbors.get(left.id)!, { id: right.id, weight }, policy.neighborsPerNode);
        keepNeighbor(neighbors.get(right.id)!, { id: left.id, weight }, policy.neighborsPerNode);
      }
      comparisons += 1;
      if (comparisons % yieldEvery === 0) await yieldControl();
    }
  }

  const edgeByPair = new Map<string, SemanticEdge>();
  for (const [sourceId, selected] of neighbors) {
    for (const neighbor of selected) {
      const [source, target] = sourceId < neighbor.id
        ? [sourceId, neighbor.id]
        : [neighbor.id, sourceId];
      const key = JSON.stringify([source, target]);
      const existing = edgeByPair.get(key);
      if (!existing || neighbor.weight > existing.weight) {
        edgeByPair.set(key, { source, target, weight: neighbor.weight });
      }
    }
  }

  const edges = [...edgeByPair.values()]
    .sort((left, right) =>
      right.weight - left.weight
      || left.source.localeCompare(right.source)
      || left.target.localeCompare(right.target))
    .slice(0, Math.max(0, policy.maxEdges));

  return {
    status: 'ready',
    edges,
    indexedIds: vectors.map(item => item.id),
    rejectedIds,
  };
}
