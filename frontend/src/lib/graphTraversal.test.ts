import { describe, expect, it } from 'vitest';
import { buildParallelEdgeIndex, traceConnectedPath, PERF_ANIMATION_LIMIT } from './graphTraversal';

describe('PERF_ANIMATION_LIMIT', () => {
  it('is 150', () => {
    expect(PERF_ANIMATION_LIMIT).toBe(150);
  });
});

describe('buildParallelEdgeIndex', () => {
  it('returns empty map for single edges between pairs', () => {
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ];
    const result = buildParallelEdgeIndex(edges);
    expect(result.size).toBe(0);
  });

  it('assigns offsets for parallel edges between same pair', () => {
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'a', target: 'b' },
    ];
    const result = buildParallelEdgeIndex(edges);
    expect(result.size).toBe(2);
    const offset1 = result.get('e1')!;
    const offset2 = result.get('e2')!;
    expect(offset1).not.toBe(offset2);
    expect(offset1 + offset2).toBe(0);
  });

  it('treats reversed direction as same pair', () => {
    const edges = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' },
    ];
    const result = buildParallelEdgeIndex(edges);
    expect(result.size).toBe(2);
  });

  it('handles 3 parallel edges with symmetric offsets', () => {
    const edges = [
      { id: 'e1', source: 'x', target: 'y' },
      { id: 'e2', source: 'x', target: 'y' },
      { id: 'e3', source: 'x', target: 'y' },
    ];
    const result = buildParallelEdgeIndex(edges);
    expect(result.size).toBe(3);
    const offsets = [result.get('e1')!, result.get('e2')!, result.get('e3')!];
    expect(offsets[1]).toBe(0);
    expect(offsets[0]).toBe(-offsets[2]);
  });

  it('returns empty map for empty input', () => {
    expect(buildParallelEdgeIndex([]).size).toBe(0);
  });
});

describe('traceConnectedPath', () => {
  it('traces ancestors and descendants from a node', () => {
    const edges = [
      { id: 'e1', source: 'a', target: 'b', data: {} },
      { id: 'e2', source: 'b', target: 'c', data: {} },
      { id: 'e3', source: 'c', target: 'd', data: {} },
    ] as Parameters<typeof traceConnectedPath>[1];
    const connected = traceConnectedPath('b', edges);
    expect(connected.has('a')).toBe(true);
    expect(connected.has('b')).toBe(true);
    expect(connected.has('c')).toBe(true);
    expect(connected.has('d')).toBe(true);
  });

  it('does not include disconnected nodes', () => {
    const edges = [
      { id: 'e1', source: 'a', target: 'b', data: {} },
      { id: 'e2', source: 'c', target: 'd', data: {} },
    ] as Parameters<typeof traceConnectedPath>[1];
    const connected = traceConnectedPath('a', edges);
    expect(connected.has('a')).toBe(true);
    expect(connected.has('b')).toBe(true);
    expect(connected.has('c')).toBe(false);
    expect(connected.has('d')).toBe(false);
  });
});
