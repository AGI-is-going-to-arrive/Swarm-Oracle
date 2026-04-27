import type { Edge } from '@xyflow/react';

export const PERF_ANIMATION_LIMIT = 150;

export function buildParallelEdgeIndex(
  edges: readonly { id: string; source: string; target: string }[],
): Map<string, number> {
  const groupCount = new Map<string, number>();
  const indexMap = new Map<string, number>();
  for (const e of edges) {
    const pairKey = [e.source, e.target].sort().join('::');
    const count = groupCount.get(pairKey) ?? 0;
    indexMap.set(e.id, count);
    groupCount.set(pairKey, count + 1);
  }
  const result = new Map<string, number>();
  for (const e of edges) {
    const pairKey = [e.source, e.target].sort().join('::');
    const total = groupCount.get(pairKey) ?? 1;
    if (total <= 1) continue;
    const idx = indexMap.get(e.id) ?? 0;
    const offset = (idx - (total - 1) / 2) * 20;
    result.set(e.id, offset);
  }
  return result;
}

export function traceConnectedPath(
  nodeId: string,
  edges: Edge[],
): Set<string> {
  const incoming = new Map<string, Edge[]>();
  const outgoing = new Map<string, Edge[]>();
  for (const e of edges) {
    let list = incoming.get(e.target);
    if (!list) { list = []; incoming.set(e.target, list); }
    list.push(e);
    let list2 = outgoing.get(e.source);
    if (!list2) { list2 = []; outgoing.set(e.source, list2); }
    list2.push(e);
  }

  const connected = new Set<string>([nodeId]);

  const ancestors = [nodeId];
  const visitedUp = new Set<string>([nodeId]);
  let head = 0;
  while (head < ancestors.length) {
    const current = ancestors[head++];
    for (const e of incoming.get(current) ?? []) {
      if (!visitedUp.has(e.source)) {
        visitedUp.add(e.source);
        connected.add(e.source);
        connected.add(e.id);
        ancestors.push(e.source);
      }
    }
  }

  const descendants = [nodeId];
  const visitedDown = new Set<string>([nodeId]);
  let head2 = 0;
  while (head2 < descendants.length) {
    const current = descendants[head2++];
    for (const e of outgoing.get(current) ?? []) {
      if (!visitedDown.has(e.target)) {
        visitedDown.add(e.target);
        connected.add(e.target);
        connected.add(e.id);
        descendants.push(e.target);
      }
    }
  }

  return connected;
}
