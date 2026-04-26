/**
 * P6 Phase 2 — ArgumentMap DAG editorial unit tests
 * Pure function tests to avoid OOM from full-component rendering.
 */
import { describe, expect, it } from 'vitest';
import { traceArgumentPath, PERF_ANIMATION_LIMIT } from './ArgumentMap';
import type { Edge } from '@xyflow/react';

describe('P6 Phase 2 DAG editorial (unit)', () => {
  const edges: Edge[] = [
    { id: 'e1', source: 'n1', target: 'n2', type: 'default' },
    { id: 'e2', source: 'n2', target: 'n3', type: 'default' },
  ];

  it('PERF_ANIMATION_LIMIT is 150', () => {
    expect(PERF_ANIMATION_LIMIT).toBe(150);
  });

  it('traceArgumentPath traces ancestors and descendants recursively', () => {
    const result = traceArgumentPath('n2', edges);
    expect(result.has('n1')).toBe(true);
    expect(result.has('n2')).toBe(true);
    expect(result.has('n3')).toBe(true);
    expect(result.has('e1')).toBe(true);
    expect(result.has('e2')).toBe(true);
  });

  it('traceArgumentPath does not include isolated nodes', () => {
    const result = traceArgumentPath('n2', edges);
    expect(result.has('n4')).toBe(false);
  });

  it('traceArgumentPath handles leaf node (only ancestors)', () => {
    const result = traceArgumentPath('n3', edges);
    expect(result.has('n1')).toBe(true);
    expect(result.has('n2')).toBe(true);
    expect(result.has('n3')).toBe(true);
    expect(result.has('e1')).toBe(true);
    expect(result.has('e2')).toBe(true);
  });

  it('traceArgumentPath handles root node (only descendants)', () => {
    const result = traceArgumentPath('n1', edges);
    expect(result.has('n1')).toBe(true);
    expect(result.has('n2')).toBe(true);
    expect(result.has('n3')).toBe(true);
  });

  it('traceArgumentPath returns only self for disconnected node', () => {
    const result = traceArgumentPath('isolated', edges);
    expect(result.has('isolated')).toBe(true);
    expect(result.size).toBe(1);
  });
});
