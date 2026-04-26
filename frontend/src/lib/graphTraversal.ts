import type { Edge } from '@xyflow/react';

export function traceConnectedPath(
  nodeId: string,
  edges: Edge[],
): Set<string> {
  const connected = new Set<string>([nodeId]);
  const queue = [nodeId];
  const visited = new Set<string>([nodeId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const e of edges) {
      if (e.target === current && !visited.has(e.source)) {
        visited.add(e.source);
        connected.add(e.source);
        connected.add(e.id);
        queue.push(e.source);
      }
    }
  }
  const queue2 = [nodeId];
  const visited2 = new Set<string>([nodeId]);
  while (queue2.length > 0) {
    const current = queue2.shift()!;
    for (const e of edges) {
      if (e.source === current && !visited2.has(e.target)) {
        visited2.add(e.target);
        connected.add(e.target);
        connected.add(e.id);
        queue2.push(e.target);
      }
    }
  }
  return connected;
}
