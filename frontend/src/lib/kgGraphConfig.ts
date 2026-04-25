import type { GraphPayload } from '../hooks/useScenarioGraph';
import { NODE_TYPE_COLORS_HEX, resolveG6Tokens } from './graphTokens';

// ── Constants ──────────────────────────────────────────────

export const KG_DEGREE_SCALE = { min: 30, max: 60 } as const;

export const KG_DEGRADE_THRESHOLDS = { mobileNodes: 200, animationLimit: 300 } as const;

export const KG_DIM_OPACITY = 0.2;

export const KG_GRAPH_BEHAVIORS = ['drag-canvas', 'zoom-canvas', 'click-select'] as const;

const DEFAULT_NODE_COLOR = '#888888';

// ── Functions ──────────────────────────────────────────────

export function computeNodeSize(degree: number): number {
  const { min, max } = KG_DEGREE_SCALE;
  if (!Number.isFinite(degree) || degree <= 0) return min;
  return Math.min(Math.max(degree + min, min), max);
}

export function getKGNodeStyle(
  nodeType: string,
  theme: 'dark' | 'light',
): { fill: string; stroke: string; lineWidth: number; textColor: string } {
  const tokens = resolveG6Tokens(theme);
  const fill = NODE_TYPE_COLORS_HEX[nodeType] ?? DEFAULT_NODE_COLOR;
  return {
    fill,
    stroke: tokens.nodeStroke,
    lineWidth: 1.5,
    textColor: tokens.label,
  };
}

export function getKGEdgeStyle(
  theme: 'dark' | 'light',
): { stroke: string; lineWidth: number; opacity: number } {
  const tokens = resolveG6Tokens(theme);
  return {
    stroke: tokens.edgeStroke,
    lineWidth: 1,
    opacity: 0.6,
  };
}

export interface KgG6DataOptions {
  searchTerm?: string;
  typeFilter?: string[];
  isMobile?: boolean;
}

export function toKgG6Data(
  graph: GraphPayload,
  opts?: KgG6DataOptions,
): { nodes: KgG6Node[]; edges: KgG6Edge[]; truncatedFromCount: number | null } {
  const { searchTerm, typeFilter, isMobile } = opts ?? {};

  let nodes = graph.nodes;

  if (typeFilter && typeFilter.length > 0) {
    const allowed = new Set(typeFilter);
    nodes = nodes.filter((n) => allowed.has(n.type));
  }

  if (searchTerm && searchTerm.trim()) {
    const term = searchTerm.trim().toLowerCase();
    nodes = nodes.filter((n) => n.label.toLowerCase().includes(term));
  }

  let truncatedFromCount: number | null = null;
  if (isMobile && nodes.length > KG_DEGRADE_THRESHOLDS.mobileNodes) {
    truncatedFromCount = nodes.length;
    nodes = nodes.slice(0, KG_DEGRADE_THRESHOLDS.mobileNodes);
  }

  const keptIds = new Set(nodes.map((n) => n.id));

  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: 'circle' as const,
      style: {
        labelText: n.label,
        labelPlacement: 'bottom' as const,
      },
      data: { kgType: n.type, kgRound: n.round },
    })),
    edges: graph.edges
      .filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
    truncatedFromCount,
  };
}

export interface KgG6Node {
  id: string;
  type: 'circle';
  style: { labelText: string; labelPlacement: 'bottom' };
  data: { kgType: string; kgRound: number | null };
}

export interface KgG6Edge {
  id: string;
  source: string;
  target: string;
}

export interface BuildKgG6OptionsParams {
  data: { nodes: KgG6Node[]; edges: KgG6Edge[] };
  theme: 'dark' | 'light';
  reducedMotion: boolean;
  minimapContainer?: HTMLDivElement | null;
  enableHover?: boolean;
}

export interface G6GraphOptions {
  data: { nodes: KgG6Node[]; edges: KgG6Edge[] };
  autoFit: 'view';
  autoResize: boolean;
  animation: boolean;
  node: { style: { fill: string; stroke: string; lineWidth: number; labelFill: string; labelFontSize: number } };
  edge: { style: { stroke: string; lineWidth: number; opacity: number } };
  background: string;
  behaviors: string[];
  plugins: unknown[];
}

export function buildKgG6Options(opts: BuildKgG6OptionsParams): G6GraphOptions {
  const tokens = resolveG6Tokens(opts.theme);
  const edgeStyle = getKGEdgeStyle(opts.theme);

  const behaviors: string[] = [...KG_GRAPH_BEHAVIORS];
  if (opts.enableHover) {
    behaviors.push('hover-activate');
  }

  const plugins: unknown[] = [];
  if (opts.minimapContainer) {
    plugins.push({
      type: 'minimap',
      key: 'kg-minimap',
      container: opts.minimapContainer,
      size: [180, 96] as [number, number],
      padding: 8,
      maskStyle: { fill: 'rgba(255,255,255,0.16)', stroke: tokens.nodeStroke },
      containerStyle: {
        width: '100%',
        height: '96px',
        background: tokens.background,
        borderRadius: '4px',
        overflow: 'hidden',
      },
    });
  }

  return {
    data: opts.data,
    autoFit: 'view',
    autoResize: true,
    animation: !opts.reducedMotion,
    node: {
      style: {
        fill: tokens.nodeFill,
        stroke: tokens.nodeStroke,
        lineWidth: 1.5,
        labelFill: tokens.label,
        labelFontSize: 11,
      },
    },
    edge: {
      style: {
        stroke: edgeStyle.stroke,
        lineWidth: edgeStyle.lineWidth,
        opacity: edgeStyle.opacity,
      },
    },
    background: tokens.background,
    behaviors,
    plugins,
  };
}
