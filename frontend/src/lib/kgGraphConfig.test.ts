import { describe, expect, it } from 'vitest';

import {
  KG_DEGREE_SCALE,
  KG_DEGRADE_THRESHOLDS,
  KG_DIM_OPACITY,
  KG_GRAPH_BEHAVIORS,
  buildKgG6Options,
  computeNodeSize,
  getKGEdgeStyle,
  getKGNodeStyle,
  toKgG6Data,
} from './kgGraphConfig';
import type { GraphPayload } from '../hooks/useScenarioGraph';

// ── Constants ──────────────────────────────────────────────

describe('kgGraphConfig constants', () => {
  it('KG_DEGREE_SCALE has min=30 and max=60', () => {
    expect(KG_DEGREE_SCALE.min).toBe(30);
    expect(KG_DEGREE_SCALE.max).toBe(60);
  });

  it('KG_DEGRADE_THRESHOLDS has mobileNodes=200 and animationLimit=300', () => {
    expect(KG_DEGRADE_THRESHOLDS.mobileNodes).toBe(200);
    expect(KG_DEGRADE_THRESHOLDS.animationLimit).toBe(300);
  });

  it('KG_DIM_OPACITY is 0.2', () => {
    expect(KG_DIM_OPACITY).toBe(0.2);
  });

  it('KG_GRAPH_BEHAVIORS contains exactly drag-canvas, zoom-canvas, click-select', () => {
    expect([...KG_GRAPH_BEHAVIORS]).toEqual(['drag-canvas', 'zoom-canvas', 'click-select']);
  });
});

// ── computeNodeSize ────────────────────────────────────────

describe('computeNodeSize', () => {
  it('returns min (30) for degree 0', () => {
    expect(computeNodeSize(0)).toBe(30);
  });

  it('returns min (30) for negative degree', () => {
    expect(computeNodeSize(-5)).toBe(30);
  });

  it('returns min (30) for NaN', () => {
    expect(computeNodeSize(NaN)).toBe(30);
  });

  it('returns min (30) for Infinity', () => {
    expect(computeNodeSize(Infinity)).toBe(30);
  });

  it('returns max (60) for very large degree', () => {
    expect(computeNodeSize(1000)).toBe(60);
  });

  it('returns degree + min when within range', () => {
    expect(computeNodeSize(10)).toBe(40);
  });

  it('clamps at max for degree that exceeds max - min', () => {
    expect(computeNodeSize(31)).toBe(60);
  });

  it('is monotonically non-decreasing', () => {
    let prev = computeNodeSize(0);
    for (let d = 1; d <= 100; d++) {
      const curr = computeNodeSize(d);
      expect(curr).toBeGreaterThanOrEqual(prev);
      prev = curr;
    }
  });
});

// ── getKGNodeStyle ─────────────────────────────────────────

describe('getKGNodeStyle', () => {
  it('returns different fill for dark and light themes for a known type', () => {
    const dark = getKGNodeStyle('event', 'dark');
    const light = getKGNodeStyle('event', 'light');
    expect(dark.stroke).not.toBe(light.stroke);
  });

  it('falls back to default color for unknown nodeType', () => {
    const style = getKGNodeStyle('unknown_type_xyz', 'dark');
    expect(style.fill).toBe('#888888');
    expect(style.lineWidth).toBe(1.5);
  });

  it('uses NODE_TYPE_COLORS_HEX for known types', () => {
    const style = getKGNodeStyle('event', 'light');
    expect(style.fill).toBe('#4a90d9');
  });
});

// ── getKGEdgeStyle ─────────────────────────────────────────

describe('getKGEdgeStyle', () => {
  it('returns different stroke for dark and light themes', () => {
    const dark = getKGEdgeStyle('dark');
    const light = getKGEdgeStyle('light');
    expect(dark.stroke).not.toBe(light.stroke);
  });

  it('always returns lineWidth 1 and opacity 0.6', () => {
    expect(getKGEdgeStyle('dark').lineWidth).toBe(1);
    expect(getKGEdgeStyle('dark').opacity).toBe(0.6);
    expect(getKGEdgeStyle('light').lineWidth).toBe(1);
    expect(getKGEdgeStyle('light').opacity).toBe(0.6);
  });
});

// ── toKgG6Data ─────────────────────────────────────────────

function makeGraph(nodeCount: number): GraphPayload {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    key: `key${i}`,
    type: i % 2 === 0 ? 'event' : 'claim',
    label: `Node ${i}`,
    round: i,
    payload: null,
  }));
  const edges = nodeCount > 1
    ? [{ id: 'e0', source: 'n0', target: 'n1', type: 'caused', weight: null, label: null }]
    : [];
  return { id: 'graph-1', nodes, edges };
}

describe('toKgG6Data', () => {
  it('maps all nodes and edges without options', () => {
    const graph = makeGraph(3);
    const result = toKgG6Data(graph);
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(1);
    expect(result.nodes[0].type).toBe('circle');
    expect(result.nodes[0].data.kgType).toBe('event');
  });

  it('filters by searchTerm (case-insensitive)', () => {
    const graph = makeGraph(5);
    const result = toKgG6Data(graph, { searchTerm: 'node 2' });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('n2');
  });

  it('trims searchTerm and ignores empty', () => {
    const graph = makeGraph(3);
    const result = toKgG6Data(graph, { searchTerm: '   ' });
    expect(result.nodes).toHaveLength(3);
  });

  it('filters by typeFilter', () => {
    const graph = makeGraph(4);
    const result = toKgG6Data(graph, { typeFilter: ['event'] });
    expect(result.nodes.every((n) => n.data.kgType === 'event')).toBe(true);
  });

  it('returns all nodes when typeFilter is empty array', () => {
    const graph = makeGraph(4);
    const result = toKgG6Data(graph, { typeFilter: [] });
    expect(result.nodes).toHaveLength(4);
  });

  it('truncates nodes for mobile when count exceeds mobileNodes threshold', () => {
    const graph = makeGraph(250);
    const result = toKgG6Data(graph, { isMobile: true });
    expect(result.nodes).toHaveLength(KG_DEGRADE_THRESHOLDS.mobileNodes);
  });

  it('does not truncate for mobile when count is within threshold', () => {
    const graph = makeGraph(100);
    const result = toKgG6Data(graph, { isMobile: true });
    expect(result.nodes).toHaveLength(100);
  });

  it('does not truncate for desktop even with many nodes', () => {
    const graph = makeGraph(250);
    const result = toKgG6Data(graph, { isMobile: false });
    expect(result.nodes).toHaveLength(250);
  });

  it('prunes edges whose endpoints were filtered out', () => {
    const graph: GraphPayload = {
      id: 'g1',
      nodes: [
        { id: 'a', key: 'a', type: 'event', label: 'Alpha', round: 1, payload: null },
        { id: 'b', key: 'b', type: 'claim', label: 'Beta', round: 2, payload: null },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', type: 'caused', weight: null, label: null }],
    };
    const result = toKgG6Data(graph, { typeFilter: ['event'] });
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  it('applies filters in order: typeFilter -> searchTerm -> mobile truncate', () => {
    const graph = makeGraph(250);
    const result = toKgG6Data(graph, { isMobile: true, typeFilter: ['event'], searchTerm: 'Node 0' });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('n0');
  });

  it('reports truncatedFromCount when mobile truncation activates', () => {
    const graph = makeGraph(250);
    const result = toKgG6Data(graph, { isMobile: true });
    expect(result.truncatedFromCount).toBe(250);
  });

  it('reports null truncatedFromCount when no truncation occurs (desktop)', () => {
    const graph = makeGraph(250);
    const result = toKgG6Data(graph, { isMobile: false });
    expect(result.truncatedFromCount).toBeNull();
  });

  it('reports null truncatedFromCount when mobile but below threshold', () => {
    const graph = makeGraph(100);
    const result = toKgG6Data(graph, { isMobile: true });
    expect(result.truncatedFromCount).toBeNull();
  });

  it('reports post-filter count, not raw graph count, in truncatedFromCount', () => {
    const graph = makeGraph(500);
    const result = toKgG6Data(graph, { isMobile: true, typeFilter: ['event'] });
    // makeGraph alternates types; filtered events should be roughly half (250),
    // which still exceeds the 200 cap, so truncatedFromCount reflects post-filter size.
    expect(result.truncatedFromCount).toBe(250);
    expect(result.nodes).toHaveLength(KG_DEGRADE_THRESHOLDS.mobileNodes);
  });
});

// ── buildKgG6Options ───────────────────────────────────────

describe('buildKgG6Options', () => {
  const baseData = { nodes: [], edges: [] };

  it('disables animation when reducedMotion is true', () => {
    const opts = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: true });
    expect(opts.animation).toBe(false);
  });

  it('enables animation when reducedMotion is false', () => {
    const opts = buildKgG6Options({ data: baseData, theme: 'light', reducedMotion: false });
    expect(opts.animation).toBe(true);
  });

  it('includes minimap plugin when minimapContainer is provided', () => {
    const container = document.createElement('div');
    const opts = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: false, minimapContainer: container });
    expect(opts.plugins).toHaveLength(1);
    expect((opts.plugins[0] as { type: string }).type).toBe('minimap');
  });

  it('has empty plugins when minimapContainer is null', () => {
    const opts = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: false, minimapContainer: null });
    expect(opts.plugins).toHaveLength(0);
  });

  it('includes hover-activate behavior when enableHover is true', () => {
    const opts = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: false, enableHover: true });
    expect(opts.behaviors).toContain('hover-activate');
  });

  it('does not include hover-activate when enableHover is false', () => {
    const opts = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: false, enableHover: false });
    expect(opts.behaviors).not.toContain('hover-activate');
  });

  it('uses different background for dark vs light', () => {
    const dark = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: false });
    const light = buildKgG6Options({ data: baseData, theme: 'light', reducedMotion: false });
    expect(dark.background).not.toBe(light.background);
  });

  it('always includes autoFit and autoResize', () => {
    const opts = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: false });
    expect(opts.autoFit).toBe('view');
    expect(opts.autoResize).toBe(true);
  });
});
