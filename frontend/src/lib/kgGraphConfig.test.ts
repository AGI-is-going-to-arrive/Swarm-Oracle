import { describe, expect, it } from 'vitest';

import {
  KG_DEGREE_SCALE,
  KG_DEGRADE_THRESHOLDS,
  KG_DIM_OPACITY,
  KG_GRAPH_BEHAVIORS,
  KG_DRAG_FORCE_BEHAVIOR,
  KG_DRAG_STATIC_BEHAVIOR,
  DEFAULT_KG_LAYOUT,
  NODE_HALO_STROKE,
  EDGE_TYPE_LABEL_I18N,
  buildKgG6Options,
  computeNodeSize,
  getKGEdgeStyle,
  getKGNodeStyle,
  getKGNodeHoverStyle,
  toKgG6Data,
} from './kgGraphConfig';
import { KG_G6_TOKENS_LIGHT, KG_G6_TOKENS_DARK, resolveKGG6Tokens } from './graphTokens';
import type { GraphPayload } from '../hooks/useScenarioGraph';

// ── Constants ──────────────────────────────────────────────

describe('kgGraphConfig constants', () => {
  it('KG_DEGREE_SCALE has min=14 and max=28 (mirofish-aligned compact node sizes)', () => {
    expect(KG_DEGREE_SCALE.min).toBe(14);
    expect(KG_DEGREE_SCALE.max).toBe(28);
  });

  it('KG_DEGRADE_THRESHOLDS has mobileNodes=200 and animationLimit=300', () => {
    expect(KG_DEGRADE_THRESHOLDS.mobileNodes).toBe(200);
    expect(KG_DEGRADE_THRESHOLDS.animationLimit).toBe(300);
  });

  it('KG_DIM_OPACITY is 0.2', () => {
    expect(KG_DIM_OPACITY).toBe(0.2);
  });

  it('KG_GRAPH_BEHAVIORS contains only canvas navigation defaults', () => {
    expect([...KG_GRAPH_BEHAVIORS]).toEqual(['drag-canvas', 'zoom-canvas']);
  });
});

// ── computeNodeSize ────────────────────────────────────────

describe('computeNodeSize', () => {
  it('returns min (14) for degree 0', () => {
    expect(computeNodeSize(0)).toBe(14);
  });

  it('returns min (14) for negative degree', () => {
    expect(computeNodeSize(-5)).toBe(14);
  });

  it('returns min (14) for NaN', () => {
    expect(computeNodeSize(NaN)).toBe(14);
  });

  it('returns min (14) for Infinity', () => {
    expect(computeNodeSize(Infinity)).toBe(14);
  });

  it('returns max (28) for very large degree', () => {
    expect(computeNodeSize(1000)).toBe(28);
  });

  it('returns degree + min when within range', () => {
    expect(computeNodeSize(10)).toBe(24);
  });

  it('clamps at max for degree that exceeds max - min', () => {
    expect(computeNodeSize(31)).toBe(28);
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
    expect(style.lineWidth).toBe(2.5);
  });

  it('uses KG_NODE_TYPE_FILLS for known types', () => {
    const style = getKGNodeStyle('event', 'light');
    expect(style.fill).toBe('#2563eb'); // KG_NODE_TYPE_FILLS.event
  });

  it('uses KG_NODE_TYPE_FILLS_DARK for known types in dark theme', () => {
    const style = getKGNodeStyle('event', 'dark');
    expect(style.fill).toBe('#60a5fa'); // KG_NODE_TYPE_FILLS_DARK.event
  });
});

// ── getKGEdgeStyle ─────────────────────────────────────────

describe('getKGEdgeStyle', () => {
  it('returns different stroke for dark and light themes', () => {
    const dark = getKGEdgeStyle('dark');
    const light = getKGEdgeStyle('light');
    expect(dark.stroke).not.toBe(light.stroke);
  });

  it('always returns lineWidth 1.6 and opacity 0.82', () => {
    expect(getKGEdgeStyle('dark').lineWidth).toBe(1.6);
    expect(getKGEdgeStyle('dark').opacity).toBe(0.82);
    expect(getKGEdgeStyle('light').lineWidth).toBe(1.6);
    expect(getKGEdgeStyle('light').opacity).toBe(0.82);
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
    expect(result.nodes[0].data.iconText).toBe('MessageSquare');
  });

  it('filters by searchTerm (case-insensitive)', () => {
    const graph = makeGraph(5);
    const result = toKgG6Data(graph, { searchTerm: 'node 2' });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('n2');
  });

  it('matches searchTerm against node id and key as well as label', () => {
    const graph: GraphPayload = {
      id: 'g1',
      nodes: [
        { id: 'event-actual-id', key: 'opaque-key', type: 'event', label: 'Alpha', round: 1, payload: null },
        { id: 'other', key: 'key-actual-hit', type: 'claim', label: 'Beta', round: 2, payload: null },
      ],
      edges: [],
    };

    expect(toKgG6Data(graph, { searchTerm: 'actual-id' }).nodes.map((n) => n.id)).toEqual(['event-actual-id']);
    expect(toKgG6Data(graph, { searchTerm: 'actual-hit' }).nodes.map((n) => n.id)).toEqual(['other']);
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

  it('calculates parallel edge offsets correctly', () => {
    const graph: GraphPayload = {
      id: 'g1',
      nodes: [
        { id: 'n1', key: 'k1', type: 'event', label: 'A', round: 1, payload: null },
        { id: 'n2', key: 'k2', type: 'event', label: 'B', round: 1, payload: null },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', type: 'caused', weight: null, label: null },
        { id: 'e2', source: 'n2', target: 'n1', type: 'rebuts', weight: null, label: null },
      ],
    };
    const result = toKgG6Data(graph);
    expect(result.edges).toHaveLength(2);
    expect(result.edges[0].style?.curveOffset).toBeDefined();
    expect(result.edges[0].style?.endArrow).toBe(false);
    expect(result.edges[1].style?.curveOffset).toBeDefined();
    expect(result.edges[1].style?.endArrow).toBe(false);
  });

  it('calculates self loops count for nodes', () => {
    const graph: GraphPayload = {
      id: 'g1',
      nodes: [
        { id: 'n1', key: 'k1', type: 'event', label: 'A', round: 1, payload: null },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n1', type: 'caused', weight: null, label: null },
        { id: 'e2', source: 'n1', target: 'n1', type: 'caused', weight: null, label: null },
      ],
    };
    const result = toKgG6Data(graph);
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(2);
    expect(result.nodes[0].data.selfLoopCount).toBe(2);
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
    expect(opts.behaviors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'hover-activate',
        degree: 1,
        direction: 'both',
        state: 'active',
        inactiveState: 'inactive',
        animation: false,
      }),
    ]));
  });

  it('does not include hover-activate when enableHover is false', () => {
    const opts = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: false, enableHover: false });
    expect(opts.behaviors.some((b) => typeof b === 'object' && b !== null && b.type === 'hover-activate')).toBe(false);
  });

  it('uses different background for dark vs light', () => {
    const dark = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: false });
    const light = buildKgG6Options({ data: baseData, theme: 'light', reducedMotion: false });
    expect(dark.background).not.toBe(light.background);
  });

  it('always includes autoFit and autoResize', () => {
    const opts = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: false });
    expect(['view', 'center']).toContain(opts.autoFit);
    expect(opts.autoResize).toBe(true);
  });

  it('falls back to d3-force layout with capped simulation when no layout is provided', () => {
    const opts = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: false });
    expect(opts.layout).toMatchObject({
      type: 'd3-force',
      preventOverlap: true,
      nodeSize: KG_DEGREE_SCALE.max,
    });
    expect(opts.layout).toHaveProperty('linkDistance');
    expect(opts.layout).toHaveProperty('alphaDecay');
    expect(opts.layout).toHaveProperty('alphaMin');
  });

  it('uses caller-supplied layout when provided', () => {
    const opts = buildKgG6Options({
      data: baseData,
      theme: 'dark',
      reducedMotion: false,
      layout: { type: 'combo-combined', preventOverlap: true, nodeSize: 24, spacing: 8 },
    });
    expect(opts.layout).toEqual({
      type: 'combo-combined',
      preventOverlap: true,
      nodeSize: 24,
      spacing: 8,
    });
  });

  it('sets global edge.type to cubic and endArrow to true', () => {
    const opts = buildKgG6Options({ data: baseData, theme: 'dark', reducedMotion: false });
    expect(opts.edge.type).toBe('cubic');
    expect(opts.edge.style.endArrow).toBe(true);
  });
});

// ── F1: NODE_HALO_STROKE + hover style ────────────────────

describe('getKGNodeStyle halo stroke', () => {
  it('returns NODE_HALO_STROKE[dark] (#f8fafc) for dark theme with lineWidth 2.5', () => {
    const style = getKGNodeStyle('event', 'dark');
    expect(style.stroke).toBe(NODE_HALO_STROKE.dark);
    expect(style.stroke).toBe('#f8fafc');
    expect(style.lineWidth).toBe(2.5);
  });

  it('returns NODE_HALO_STROKE[light] (#0f172a) for light theme with lineWidth 2.5', () => {
    const style = getKGNodeStyle('event', 'light');
    expect(style.stroke).toBe(NODE_HALO_STROKE.light);
    expect(style.stroke).toBe('#0f172a');
    expect(style.lineWidth).toBe(2.5);
  });
});

describe('getKGNodeHoverStyle', () => {
  it('returns lineWidth 3.5 and hover stroke from KG editorial tokens', () => {
    const hoverDark = getKGNodeHoverStyle('event', 'dark');
    expect(hoverDark.lineWidth).toBe(3.5);
    expect(hoverDark.stroke).toBe(KG_G6_TOKENS_DARK.hoverStroke);
    expect(hoverDark.stroke).toBe('#4a9d6f');

    const hoverLight = getKGNodeHoverStyle('event', 'light');
    expect(hoverLight.lineWidth).toBe(3.5);
    expect(hoverLight.stroke).toBe(KG_G6_TOKENS_LIGHT.hoverStroke);
    expect(hoverLight.stroke).toBe('#2F6F4F');
  });
});

// ── Fix-W1: layout constants ──────────────────────────────

describe('DEFAULT_KG_LAYOUT d3-force parameters', () => {
  it('uses d3-force type with repulsive nodeStrength and link distance', () => {
    expect(DEFAULT_KG_LAYOUT.type).toBe('d3-force');
    expect(DEFAULT_KG_LAYOUT.preventOverlap).toBe(true);
    expect(DEFAULT_KG_LAYOUT.linkDistance).toBeGreaterThanOrEqual(40);
    expect(DEFAULT_KG_LAYOUT.nodeStrength).toBeLessThanOrEqual(-100);
    expect(DEFAULT_KG_LAYOUT.collideStrength).toBeGreaterThan(0.5);
    expect(DEFAULT_KG_LAYOUT.centerStrength).toBeGreaterThan(0);
  });
});

// ── Fix-W2: edgeLabelLimit ────────────────────────────────

describe('KG_DEGRADE_THRESHOLDS edgeLabelLimit', () => {
  it('has edgeLabelLimit=200 and nodeLabelLimit=24', () => {
    expect(KG_DEGRADE_THRESHOLDS.edgeLabelLimit).toBe(200);
    expect(KG_DEGRADE_THRESHOLDS.nodeLabelLimit).toBe(24);
  });
});

// ── Add-S1: EDGE_TYPE_LABEL_I18N ──────────────────────────

describe('EDGE_TYPE_LABEL_I18N', () => {
  it('contains exactly 10 edge type keys', () => {
    const keys = Object.keys(EDGE_TYPE_LABEL_I18N);
    expect(keys).toHaveLength(10);
    expect(keys).toEqual(expect.arrayContaining([
      'caused', 'supports', 'temporal', 'rebuts', 'attacks', 'accepted', 'unaddressed',
      'responds_to', 'supports_stance', 'opposes_stance',
    ]));
  });

  it('each entry is a [i18nKey, fallback] tuple', () => {
    for (const [, tuple] of Object.entries(EDGE_TYPE_LABEL_I18N)) {
      expect(tuple).toHaveLength(2);
      expect(tuple[0]).toContain('causal.edge_');
      expect(typeof tuple[1]).toBe('string');
    }
  });
});

// ── toKgG6Data edge label injection ───────────────────────

describe('toKgG6Data edge labels', () => {
  it('injects labelText, labelBackground=true, labelBackgroundRadius=3 on each edge', () => {
    const graph = makeGraph(3);
    const result = toKgG6Data(graph);
    expect(result.edges).toHaveLength(1);
    const edgeStyle = result.edges[0].style!;
    expect(edgeStyle.labelText).toBe('caused');
    expect(edgeStyle.labelBackground).toBe(true);
    expect(edgeStyle.labelBackgroundRadius).toBe(3);
  });

  it('uses t() function for labelText when provided', () => {
    const graph = makeGraph(3);
    const mockT = (key: string, fallback: string) => key === 'causal.edge_caused' ? '导致' : fallback;
    const result = toKgG6Data(graph, { t: mockT });
    expect(result.edges[0].style!.labelText).toBe('导致');
  });

  it('uses fallback for unknown edge types without t()', () => {
    const graph: GraphPayload = {
      id: 'g1',
      nodes: [
        { id: 'a', key: 'a', type: 'event', label: 'A', round: 0, payload: null },
        { id: 'b', key: 'b', type: 'event', label: 'B', round: 1, payload: null },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b', type: 'unknown_edge_type', weight: null, label: null }],
    };
    const result = toKgG6Data(graph);
    expect(result.edges[0].style!.labelText).toBe('unknown_edge_type');
  });

  it('applies light theme edge label colors from KG editorial tokens', () => {
    const graph = makeGraph(3);
    const result = toKgG6Data(graph, { theme: 'light' });
    const edgeStyle = result.edges[0].style!;
    expect(edgeStyle.labelBackgroundFill).toBe(KG_G6_TOKENS_LIGHT.edgeLabelBg);
    expect(edgeStyle.labelBackgroundFill).toBe('rgba(252,252,250,0.95)');
    expect(edgeStyle.labelFill).toBe(KG_G6_TOKENS_LIGHT.edgeLabelFg);
    expect(edgeStyle.labelFill).toBe('#58554f');
  });

  it('applies dark theme edge label colors by default', () => {
    const graph = makeGraph(3);
    const result = toKgG6Data(graph);
    const edgeStyle = result.edges[0].style!;
    expect(edgeStyle.labelBackgroundFill).toBe(KG_G6_TOKENS_DARK.edgeLabelBg);
    expect(edgeStyle.labelBackgroundFill).toBe('rgba(24,22,17,0.85)');
    expect(edgeStyle.labelFill).toBe(KG_G6_TOKENS_DARK.edgeLabelFg);
    expect(edgeStyle.labelFill).toBe('#928f88');
  });
});

// ── KG Editorial Token Resolution ─────────────────────────

describe('resolveKGG6Tokens', () => {
  it('resolves light theme to cream surface + magenta brand', () => {
    const tokens = resolveKGG6Tokens('light');
    expect(tokens.background).toBe('#fcfcfa');         // project --bg-surface
    expect(tokens.nodeStroke).toBe('#c61583');         // project --color-primary
    expect(tokens.brandRing).toBe('#D27050');
    expect(tokens.label).toBe('#181611');              // project --text-primary
  });

  it('resolves dark theme to dark editorial mirror', () => {
    const tokens = resolveKGG6Tokens('dark');
    expect(tokens.background).toBe('#181611');
    expect(tokens.nodeStroke).toBe('#db589e');
    expect(tokens.brandRing).toBe('#D27050');
  });

  it('exposes edgeStrokeSubtle and dragGhost translucent tokens', () => {
    const lightTokens = resolveKGG6Tokens('light');
    expect(lightTokens.edgeStrokeSubtle).toMatch(/rgba\(/);
    expect(lightTokens.dragGhost).toMatch(/rgba\(198,\s*21,\s*131/);
  });
});

// ── Drag-Element-Force Behavior (Mirofish) ────────────────

describe('KG_DRAG_FORCE_BEHAVIOR', () => {
  it('uses drag-element-force with fixed=false for elastic snap-back', () => {
    expect(KG_DRAG_FORCE_BEHAVIOR.type).toBe('drag-element-force');
    expect(KG_DRAG_FORCE_BEHAVIOR.fixed).toBe(false);
  });

  it('configures grab/grabbing cursors during drag', () => {
    expect(KG_DRAG_FORCE_BEHAVIOR.cursor.grab).toBe('grab');
    expect(KG_DRAG_FORCE_BEHAVIOR.cursor.grabbing).toBe('grabbing');
  });
});

describe('KG_DRAG_STATIC_BEHAVIOR (non-force layout fallback)', () => {
  it('uses plain drag-element for combo / non-force layouts', () => {
    expect(KG_DRAG_STATIC_BEHAVIOR.type).toBe('drag-element');
  });

  it('still configures grab/grabbing cursors', () => {
    expect(KG_DRAG_STATIC_BEHAVIOR.cursor.grab).toBe('grab');
    expect(KG_DRAG_STATIC_BEHAVIOR.cursor.grabbing).toBe('grabbing');
  });
});

describe('buildKgG6Options drag behavior injection', () => {
  const baseDragData = { nodes: [], edges: [] };

  function findBehaviorByType(
    behaviors: ReadonlyArray<unknown>,
    type: string,
  ): Record<string, unknown> | undefined {
    return behaviors.find(
      (b): b is Record<string, unknown> =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === type,
    ) as Record<string, unknown> | undefined;
  }

  it('injects drag-element-force behavior when layout is d3-force (default)', () => {
    const opts = buildKgG6Options({ data: baseDragData, theme: 'light', reducedMotion: false });
    const dragEntry = findBehaviorByType(opts.behaviors, 'drag-element-force');
    expect(dragEntry).toBeDefined();
    expect(dragEntry!.fixed).toBe(false);
    expect(dragEntry!.cursor).toEqual({ grab: 'grab', grabbing: 'grabbing' });
  });

  it('downgrades to plain drag-element when layout is non-force (e.g. comboLayout)', () => {
    const opts = buildKgG6Options({
      data: baseDragData,
      theme: 'light',
      reducedMotion: false,
      layout: { type: 'combo-combined', preventOverlap: true, nodeSize: 24, spacing: 8 },
    });
    const forceEntry = findBehaviorByType(opts.behaviors, 'drag-element-force');
    const staticEntry = findBehaviorByType(opts.behaviors, 'drag-element');
    expect(forceEntry).toBeUndefined();
    expect(staticEntry).toBeDefined();
    const staticCursor = staticEntry!.cursor as { grab: string };
    expect(staticCursor.grab).toBe('grab');
  });

  it('also injects drag-element-force when layout is d3-force-3d (G6 v5 supports both force variants)', () => {
    const opts = buildKgG6Options({
      data: baseDragData,
      theme: 'light',
      reducedMotion: false,
      layout: { type: 'd3-force-3d', preventOverlap: true, nodeSize: 24, linkDistance: 50 },
    });
    const dragEntry = findBehaviorByType(opts.behaviors, 'drag-element-force');
    const staticEntry = findBehaviorByType(opts.behaviors, 'drag-element');
    expect(dragEntry).toBeDefined();
    expect(dragEntry!.fixed).toBe(false);
    // Static drag-element MUST NOT also be present when d3-force-3d gets the elastic variant
    expect(staticEntry).toBeUndefined();
  });

  it('preserves base canvas behaviors before drag-element* without click-select state locking', () => {
    const opts = buildKgG6Options({ data: baseDragData, theme: 'light', reducedMotion: false });
    expect(opts.behaviors).toContain('drag-canvas');
    expect(opts.behaviors).toContain('zoom-canvas');
    expect(opts.behaviors).not.toContain('click-select');
  });

  it('still appends hover-activate after drag behavior when enableHover is true', () => {
    const opts = buildKgG6Options({
      data: baseDragData,
      theme: 'light',
      reducedMotion: false,
      enableHover: true,
    });
    expect(opts.behaviors).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'hover-activate', animation: false }),
    ]));
    // Order matters: drag before hover so click+drag don't compete on the same target
    const indexOfDrag = opts.behaviors.findIndex(
      (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'drag-element-force',
    );
    const indexOfHover = opts.behaviors.findIndex(
      (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'hover-activate',
    );
    expect(indexOfDrag).toBeGreaterThanOrEqual(0);
    expect(indexOfHover).toBeGreaterThan(indexOfDrag);
  });
});

describe('buildKgG6Options minimap mask uses subtle KG token', () => {
  it('renders minimap mask stroke with edgeStrokeSubtle (not magenta brand)', () => {
    const container = document.createElement('div');
    const opts = buildKgG6Options({
      data: { nodes: [], edges: [] },
      theme: 'light',
      reducedMotion: false,
      minimapContainer: container,
    });
    const minimap = opts.plugins[0] as { maskStyle: { stroke: string; fill: string } };
    expect(minimap.maskStyle.stroke).toBe(KG_G6_TOKENS_LIGHT.edgeStrokeSubtle);
    expect(minimap.maskStyle.stroke).not.toBe(KG_G6_TOKENS_LIGHT.brandRing);
    // Mask fill should be theme-tinted, not pure white
    expect(minimap.maskStyle.fill).not.toBe('rgba(255,255,255,0.16)');
  });
});

// ── P6: New state styles + animation ─────────────────────

describe('P6 node selected state', () => {
  it('node state config includes selected with halo properties', () => {
    const opts = buildKgG6Options({ data: { nodes: [], edges: [] }, theme: 'dark', reducedMotion: false });
    const selectedState = opts.node.state.selected;
    expect(selectedState).toBeDefined();
    expect(selectedState.style).toMatchObject({
      halo: true,
      haloLineWidth: 18,
      haloStrokeOpacity: 0.34,
      lineWidth: 4,
    });
  });
});

describe('P6 edge streaming state', () => {
  it('edge state config includes streaming with lineDash', () => {
    const opts = buildKgG6Options({ data: { nodes: [], edges: [] }, theme: 'light', reducedMotion: false });
    const streamingState = opts.edge.state.streaming;
    expect(streamingState).toBeDefined();
    expect(streamingState.style).toMatchObject({
      lineDash: [7, 5],
      lineWidth: 2,
      opacity: 0.86,
    });
  });
});

describe('P6 node entrance animation', () => {
  it('node animation is { enter: "fade" } when reducedMotion=false', () => {
    const opts = buildKgG6Options({ data: { nodes: [], edges: [] }, theme: 'dark', reducedMotion: false });
    expect(opts.node.animation).toEqual({ enter: 'fade' });
  });

  it('node animation is false when reducedMotion=true', () => {
    const opts = buildKgG6Options({ data: { nodes: [], edges: [] }, theme: 'dark', reducedMotion: true });
    expect(opts.node.animation).toBe(false);
  });
});

describe('P6 hover-activate regression guard', () => {
  it('hover-activate preserves animation:false (P6 regression guard)', () => {
    const opts = buildKgG6Options({
      data: { nodes: [], edges: [] },
      theme: 'dark',
      reducedMotion: false,
      enableHover: true,
    });
    const hoverBehavior = opts.behaviors.find(
      (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'hover-activate',
    ) as Record<string, unknown> | undefined;
    expect(hoverBehavior).toBeDefined();
    expect(hoverBehavior!.animation).toBe(false);
    expect(hoverBehavior!.degree).toBe(1);
    expect(hoverBehavior!.direction).toBe('both');
    expect(hoverBehavior!.state).toBe('active');
    expect(hoverBehavior!.inactiveState).toBe('inactive');
  });
});

// ── P7 Stage 4: Agent Palette + readAgentId ──��──────────

import { KG_AGENT_PALETTE, readAgentId, hashStringToIndex } from './kgGraphConfig';

describe('readAgentId', () => {
  it('extracts agent_id from a valid payload', () => {
    expect(readAgentId({ agent_id: 'agent-abc' })).toBe('agent-abc');
  });

  it('returns null for null/undefined payload', () => {
    expect(readAgentId(null)).toBeNull();
    expect(readAgentId(undefined)).toBeNull();
  });

  it('returns null for non-object payload', () => {
    expect(readAgentId('string')).toBeNull();
    expect(readAgentId(42)).toBeNull();
  });

  it('returns null for empty or whitespace-only agent_id', () => {
    expect(readAgentId({ agent_id: '' })).toBeNull();
    expect(readAgentId({ agent_id: '   ' })).toBeNull();
  });

  it('returns null when agent_id is not a string', () => {
    expect(readAgentId({ agent_id: 123 })).toBeNull();
    expect(readAgentId({ agent_id: null })).toBeNull();
  });

  it('trims whitespace from agent_id', () => {
    expect(readAgentId({ agent_id: '  agent-x  ' })).toBe('agent-x');
  });
});

describe('hashStringToIndex', () => {
  it('returns a value within [0, mod)', () => {
    for (const str of ['abc', 'def', '你好', '']) {
      const idx = hashStringToIndex(str, 15);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(15);
    }
  });

  it('returns deterministic results', () => {
    expect(hashStringToIndex('agent-1', 15)).toBe(hashStringToIndex('agent-1', 15));
  });

  it('returns 0 when mod is zero or negative', () => {
    expect(hashStringToIndex('test', 0)).toBe(0);
    expect(hashStringToIndex('test', -1)).toBe(0);
  });
});

describe('KG_AGENT_PALETTE', () => {
  it('has 15 colors', () => {
    expect(KG_AGENT_PALETTE).toHaveLength(15);
  });

  it('all entries are hex color strings', () => {
    for (const color of KG_AGENT_PALETTE) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe('toKgG6Data agentId passthrough', () => {
  it('sets agentId from payload.agent_id', () => {
    const graph: GraphPayload = {
      id: 'g1',
      nodes: [{ id: 'n1', key: 'k1', type: 'event', label: 'A', round: 1, payload: { agent_id: 'agent-x' } }],
      edges: [],
    };
    const result = toKgG6Data(graph);
    expect(result.nodes[0].data.agentId).toBe('agent-x');
  });

  it('sets agentId to null for nodes without payload', () => {
    const graph: GraphPayload = {
      id: 'g1',
      nodes: [{ id: 'n1', key: 'k1', type: 'fork', label: 'F', round: 2, payload: null }],
      edges: [],
    };
    const result = toKgG6Data(graph);
    expect(result.nodes[0].data.agentId).toBeNull();
  });
});
