import type { GraphPayload } from '../hooks/useScenarioGraph';
import { KG_NODE_TYPE_FILLS, KG_NODE_TYPE_FILLS_DARK, NODE_ICONS, resolveKGG6Tokens } from './graphTokens';
import type { LayoutOptionsShape } from './g6Layouts';
import { buildParallelEdgeIndex } from './graphTraversal';

// ── Constants ──────────────────────────────────────────────

export const KG_DEGREE_SCALE = { min: 14, max: 28 } as const;

export const KG_DEGRADE_THRESHOLDS = {
  mobileNodes: 200,
  animationLimit: 300,
  edgeLabelLimit: 200,
  nodeLabelLimit: 24,
} as const;

export const KG_DIM_OPACITY = 0.2;

export const KG_GRAPH_BEHAVIORS = ['drag-canvas', 'zoom-canvas'] as const;

/**
 * Mirofish-style node drag behavior. Real-time force re-simulation
 * is supported by G6 v5's `drag-element-force` against `d3-force`
 * and `d3-force-3d` layouts. For non-force layouts (e.g. comboLayout
 * used by KGExplorerView) we downgrade to plain `drag-element` which
 * still allows freeform drag without the elastic snap-back.
 */
export const KG_DRAG_FORCE_BEHAVIOR = {
  type: 'drag-element-force',
  fixed: false,
  cursor: { grab: 'grab', grabbing: 'grabbing' },
} as const satisfies G6BehaviorEntry;

export const KG_DRAG_STATIC_BEHAVIOR = {
  type: 'drag-element',
  cursor: { grab: 'grab', grabbing: 'grabbing' },
} as const satisfies G6BehaviorEntry;

export const DEFAULT_KG_LAYOUT: LayoutOptionsShape = {
  type: 'd3-force',
  preventOverlap: true,
  nodeSize: KG_DEGREE_SCALE.max,
  linkDistance: 95,
  nodeStrength: -230,
  edgeStrength: 0.5,
  collideStrength: 0.9,
  centerStrength: 0.6,
  x: { strength: 0.05 },
  y: { strength: 0.05 },
  alphaDecay: 0.025,
  alphaMin: 0.008,
};

export const NODE_HALO_STROKE = { dark: '#f8fafc', light: '#0f172a' } as const;

export const EDGE_TYPE_LABEL_I18N: Record<string, [string, string]> = {
  caused: ['causal.edge_caused', 'caused'],
  supports: ['causal.edge_supports', 'supports'],
  temporal: ['causal.edge_temporal', 'temporal'],
  rebuts: ['causal.edge_rebuts', 'rebuts'],
  attacks: ['causal.edge_attacks', 'attacks'],
  accepted: ['causal.edge_accepted', 'accepted'],
  unaddressed: ['causal.edge_unaddressed', 'unaddressed'],
  responds_to: ['causal.edge_responds_to', 'responds to'],
  supports_stance: ['causal.edge_supports_stance', 'aligns with'],
  opposes_stance: ['causal.edge_opposes_stance', 'opposes'],
};

export const KG_AGENT_PALETTE = [
  '#b85c4a', '#2d6b6b', '#8b5e83', '#c49a3c', '#5b7b6f',
  '#a65d78', '#3d6e8e', '#7a6b4e', '#6b4e7a', '#c47250',
  '#4e7a6b', '#9b6b4e', '#6e5b8e', '#8e6e3d', '#4e6b8e',
] as const;

export function readAgentId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as { agent_id?: unknown }).agent_id;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export function readAgentName(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as { agent_name?: unknown }).agent_name;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Build a short, scannable label for a KG node.
 * - If payload has agent_name: "AgentName · R{round}"
 * - Otherwise: truncate raw label to 24 chars
 */
export function buildKgNodeLabel(
  rawLabel: string,
  round: number | null,
  payload: unknown,
): string {
  const agentName = readAgentName(payload);
  if (agentName) {
    const roundSuffix = round != null ? ` · R${round}` : '';
    return `${agentName}${roundSuffix}`;
  }
  if (rawLabel.length > 24) return `${rawLabel.slice(0, 24)}…`;
  return rawLabel;
}

export function hashStringToIndex(str: string, mod: number): number {
  if (mod <= 0) return 0;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return ((hash % mod) + mod) % mod;
}

const DEFAULT_NODE_COLOR = '#888888';

// ── Functions ──────────────────────────────────────────────

export function computeNodeSize(degree: number): number {
  const { min, max } = KG_DEGREE_SCALE;
  if (!Number.isFinite(degree) || degree <= 0) return min;
  return Math.min(Math.max(degree + min, min), max);
}

/**
 * KG editorial design intent (codex review W-3):
 * - Surface tokens (background, border, hover halo, drag ghost, edge stroke)
 *   come from `KG_G6_TOKENS_LIGHT/DARK` (cream + magenta editorial palette).
 * - Node *fill* deliberately keeps the per-type semantic palette
 *   (`NODE_TYPE_COLORS_HEX`) so users can identify event / intervention /
 *   verdict / claim / evidence / rebuttal / counter at a glance — the same
 *   convention used by CausalReviewView, ArgumentMap and NodeDetailPanel.
 *   KG editorial tokens control the surface; type color controls the
 *   semantics. Both layers intentionally coexist.
 */
export function getKGNodeStyle(
  nodeType: string,
  theme: 'dark' | 'light',
): { fill: string; stroke: string; lineWidth: number; textColor: string } {
  const tokens = resolveKGG6Tokens(theme);
  const fills = theme === 'dark' ? KG_NODE_TYPE_FILLS_DARK : KG_NODE_TYPE_FILLS;
  const fill = fills[nodeType] ?? DEFAULT_NODE_COLOR;
  return {
    fill,
    stroke: NODE_HALO_STROKE[theme],
    lineWidth: 2.5,
    textColor: tokens.label,
  };
}

export function getKGNodeHoverStyle(
  _nodeType: string,
  theme: 'dark' | 'light',
): { stroke: string; lineWidth: number } {
  const tokens = resolveKGG6Tokens(theme);
  return {
    stroke: tokens.hoverStroke,
    lineWidth: 3.5,
  };
}

export function getKGEdgeStyle(
  theme: 'dark' | 'light',
): { stroke: string; lineWidth: number; opacity: number } {
  const tokens = resolveKGG6Tokens(theme);
  return {
    stroke: tokens.edgeStroke,
    lineWidth: 1.6,
    opacity: 0.82,
  };
}

export interface KgG6DataOptions {
  searchTerm?: string;
  typeFilter?: string[];
  isMobile?: boolean;
  theme?: 'dark' | 'light';
  t?: (key: string, fallback: string) => string;
}

export function toKgG6Data(
  graph: GraphPayload,
  opts?: KgG6DataOptions,
): { nodes: KgG6Node[]; edges: KgG6Edge[]; truncatedFromCount: number | null } {
  const { searchTerm, typeFilter, isMobile, theme, t } = opts ?? {};

  let nodes = graph.nodes;

  if (typeFilter && typeFilter.length > 0) {
    const allowed = new Set(typeFilter);
    nodes = nodes.filter((n) => allowed.has(n.type));
  }

  if (searchTerm && searchTerm.trim()) {
    const term = searchTerm.trim().toLowerCase();
    nodes = nodes.filter((n) =>
      [n.id, n.key, n.label].some((value) =>
        typeof value === 'string' && value.toLowerCase().includes(term),
      ),
    );
  }

  let truncatedFromCount: number | null = null;
  if (isMobile && nodes.length > KG_DEGRADE_THRESHOLDS.mobileNodes) {
    truncatedFromCount = nodes.length;
    nodes = nodes.slice(0, KG_DEGRADE_THRESHOLDS.mobileNodes);
  }

  const keptIds = new Set(nodes.map((n) => n.id));

  const filteredEdges = graph.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
  const parallelOffsets = buildParallelEdgeIndex(filteredEdges);
  const selfLoopCounts = new Map<string, number>();

  filteredEdges.forEach((e) => {
    if (e.source === e.target) {
      selfLoopCounts.set(e.source, (selfLoopCounts.get(e.source) || 0) + 1);
    }
  });

  return {
    nodes: nodes.map((n) => {
      const agentId = readAgentId(n.payload);
      const fills = theme === 'dark' ? KG_NODE_TYPE_FILLS_DARK : KG_NODE_TYPE_FILLS;
      const typeFill = fills[n.type] ?? fills.event ?? '#2563eb';
      const agentHue = agentId ? hashStringToIndex(agentId, KG_AGENT_PALETTE.length) : 0;
      const agentStroke = agentId ? KG_AGENT_PALETTE[agentHue] : typeFill;
      const iconText = NODE_ICONS[n.type] ?? 'Circle';
      return {
        id: n.id,
        type: 'circle' as const,
        style: {
          fill: typeFill,
          stroke: agentStroke,
          lineWidth: 2.5,
          labelText: buildKgNodeLabel(n.label, n.round, n.payload),
          labelPlacement: 'bottom' as const,
        },
        data: { kgType: n.type, kgRound: n.round, agentId, iconText, selfLoopCount: selfLoopCounts.get(n.id) || 0 },
      };
    }),
    edges: filteredEdges
      .map((e) => {
        const i18nEntry = EDGE_TYPE_LABEL_I18N[e.type];
        const labelText = i18nEntry
          ? (t ? t(i18nEntry[0], i18nEntry[1]) : i18nEntry[1])
          : e.type;
        const resolvedTheme = theme ?? 'dark';
        const tokens = resolveKGG6Tokens(resolvedTheme);

        const offset = parallelOffsets.get(e.id);
        const hasOffset = offset !== undefined && offset !== 0;

        return {
          id: e.id,
          source: e.source,
          target: e.target,
          style: {
            labelText,
            labelBackground: true,
            labelBackgroundFill: tokens.edgeLabelBg,
            labelBackgroundRadius: 3,
            labelFontSize: 10,
            labelFill: tokens.edgeLabelFg,
            ...(hasOffset ? { curveOffset: offset, endArrow: false } : {}),
          },
        };
      }),
    truncatedFromCount,
  };
}

export interface KgG6Node {
  id: string;
  type: 'circle';
  style: { fill: string; stroke: string; lineWidth: number; labelText?: string; labelPlacement: 'bottom' };
  data: { kgType: string; kgRound: number | null; agentId: string | null; iconText?: string; selfLoopCount?: number };
}

export interface KgG6Edge {
  id: string;
  source: string;
  target: string;
  style?: {
    labelText?: string;
    labelBackground?: boolean;
    labelBackgroundFill?: string;
    labelBackgroundRadius?: number;
    labelFontSize?: number;
    labelFill?: string;
    opacity?: number;
    curveOffset?: number;
    endArrow?: boolean;
  };
}

export interface BuildKgG6OptionsParams {
  data: { nodes: KgG6Node[]; edges: KgG6Edge[] };
  theme: 'dark' | 'light';
  reducedMotion: boolean;
  minimapContainer?: HTMLDivElement | null;
  enableHover?: boolean;
  /**
   * Layout override. When omitted, falls back to {@link DEFAULT_KG_LAYOUT}
   * (force-directed, safe for KG payloads without combo grouping).
   * KGExplorerView passes `comboLayout()` to keep its existing combo
   * containment behavior.
   */
  layout?: LayoutOptionsShape;
}

/**
 * Behavior entry: either a bare G6 behavior name or an options object
 * (e.g. drag-element-force with `fixed: false`).
 */
export type G6BehaviorEntry = string | { type: string; [key: string]: unknown };

export interface G6ElementStateStyle {
  style: Record<string, unknown>;
}

export interface G6GraphOptions {
  data: { nodes: KgG6Node[]; edges: KgG6Edge[] };
  autoFit: 'view' | 'center';
  autoResize: boolean;
  animation: boolean;
  layout: LayoutOptionsShape;
  node: {
    style: { labelFill: string; labelFontSize: number };
    state: Record<'active' | 'inactive' | 'selected', G6ElementStateStyle>;
    animation: false | { enter: string };
  };
  edge: {
    type: string;
    style: { stroke: string; lineWidth: number; opacity: number; endArrow: boolean };
    state: Record<'active' | 'inactive' | 'streaming', G6ElementStateStyle>;
  };
  background: string;
  behaviors: G6BehaviorEntry[];
  plugins: unknown[];
}

export function buildKgG6Options(opts: BuildKgG6OptionsParams): G6GraphOptions {
  const tokens = resolveKGG6Tokens(opts.theme);
  const edgeStyle = getKGEdgeStyle(opts.theme);
  const effectiveLayout: LayoutOptionsShape = opts.layout ?? DEFAULT_KG_LAYOUT;

  const behaviors: G6BehaviorEntry[] = [...KG_GRAPH_BEHAVIORS];

  // Mirofish-style node drag: real-time force re-simulation requires
  // a force-based layout (G6 v5 supports both `d3-force` and `d3-force-3d`).
  // Other layouts (e.g. comboLayout in KGExplorerView) fall back to plain
  // drag-element which still allows freeform drag.
  const supportsForceDrag =
    effectiveLayout.type === 'd3-force' || effectiveLayout.type === 'd3-force-3d';
  if (supportsForceDrag) {
    behaviors.push({ ...KG_DRAG_FORCE_BEHAVIOR });
  } else {
    behaviors.push({ ...KG_DRAG_STATIC_BEHAVIOR });
  }

  if (opts.enableHover) {
    behaviors.push({
      type: 'hover-activate',
      degree: 1,
      direction: 'both',
      state: 'active',
      inactiveState: 'inactive',
      animation: false,
    });
  }

  const plugins: unknown[] = [];
  if (opts.minimapContainer) {
    const maskFill = opts.theme === 'dark' ? 'rgba(40,36,30,0.32)' : 'rgba(241,237,229,0.42)';
    plugins.push({
      type: 'minimap',
      key: 'kg-minimap',
      container: opts.minimapContainer,
      size: [180, 96] as [number, number],
      padding: 8,
      maskStyle: { fill: maskFill, stroke: tokens.edgeStrokeSubtle },
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
    layout: opts.layout ?? DEFAULT_KG_LAYOUT,
    node: {
      style: {
        labelFill: tokens.label,
        labelFontSize: 11,
      },
      state: {
        active: { style: { stroke: tokens.hoverStroke, lineWidth: 3.5, opacity: 1 } },
        inactive: { style: { opacity: KG_DIM_OPACITY } },
        selected: { style: { halo: true, haloLineWidth: 18, haloStrokeOpacity: 0.34, lineWidth: 4, stroke: tokens.selectedStroke, haloStroke: tokens.brandRing } },
      },
      animation: opts.reducedMotion ? false : { enter: 'fade' },
    },
    edge: {
      type: 'cubic',
      style: {
        stroke: edgeStyle.stroke,
        lineWidth: edgeStyle.lineWidth,
        opacity: edgeStyle.opacity,
        endArrow: true,
      },
      state: {
        active: { style: { opacity: 1, lineWidth: Math.max(edgeStyle.lineWidth, 1.5) } },
        inactive: { style: { opacity: KG_DIM_OPACITY } },
        streaming: { style: { lineDash: [7, 5], lineWidth: 2, opacity: 0.86 } },
      },
    },
    background: tokens.background,
    behaviors,
    plugins,
  };
}
