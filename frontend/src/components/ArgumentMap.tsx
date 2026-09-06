/* ═══════════════════════════════════════════════════════════
   Phase 3 F6 — Debate Argument Map Panel
   Displays argument units as an interactive DAG using @xyflow/react.
   Upgraded from flat tree to ReactFlow graph (P1-6).
   Phase C: icons, OKLCH cards, edge styling, neighbor highlight,
            tooltips, status filter.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildSessionHeaders } from '../api/client';
import { truncateCodepoints } from '../lib/textUtils';
import useReducedMotion from '../hooks/useReducedMotion';
import useMediaQueryState from '../hooks/useMediaQueryState';
import dagre from 'dagre';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './ArgumentMap.css';
import { ExportPanel } from './ExportPanel';
import { NodeDetailPanel, type NodeDetail } from './NodeDetailPanel';
import GraphNodeCard from './GraphNodeCard';
import AnimatedEdge from './AnimatedEdge';
import { NodeConversationSheet, type NodeConversationOrigin } from './kg/NodeConversationSheet';
import { ArgumentMapMobileList } from './ArgumentMapMobileList';
import { ArgumentMapTour } from './ArgumentMapTour';
import {
  NODE_TYPE_COLORS_HEX,
  STATUS_COLORS_HEX,
  EDGE_STYLES,
  NODE_ICONS,
  TYPE_LABEL_I18N as GRAPH_TYPE_LABEL_I18N,
  STATUS_LABEL_I18N as GRAPH_STATUS_LABEL_I18N,
  isBrightGraphBackground,
  EVIDENCE_TIER_COLORS,
} from '../lib/graphTokens';
import { traceConnectedPath, PERF_ANIMATION_LIMIT } from '../lib/graphTraversal';

// ── Custom node type (stable reference) ────────────────────

const nodeTypes = { graphCard: GraphNodeCard };
const NODE_DETAIL_SHEET_CLEARANCE_PX = 464;

// ── Data Types ──────────────────────────────────────────────

interface ArgumentUnit {
  id: string;
  type: string;
  status: string;
  text: string;
  turn_id: string;
  node_id?: string;
}

interface GraphNodeRaw {
  id: string;
  key: string;
  type: string;
  label: string;
  round: number | null;
  payload: unknown;
}

interface EdgeEvidence {
  confidence_tier: 'low' | 'medium' | 'high' | null;
  source_ref: string | null;
  source_round_number: number | null;
  detail: string | null;
}

interface GraphEdgeRaw {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number | null;
  label: string | null;
  evidence?: EdgeEvidence | null;
}

interface ArgumentMapData {
  snapshot_id: string | null;
  nodes: GraphNodeRaw[];
  edges: GraphEdgeRaw[];
  units: ArgumentUnit[];
  error?: string;
}

// ── B1: Safe adapters ───────────────────────────────────────

function safeParsePayload(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try { const parsed = JSON.parse(v); return typeof parsed === 'object' && parsed && !Array.isArray(parsed) ? parsed : {}; }
    catch { return null; }
  }
  return null;
}

function mapBackendNode(raw: Record<string, unknown>): GraphNodeRaw {
  return {
    id: String(raw.id ?? ''),
    key: String(raw.key ?? raw.node_key ?? ''),
    type: String(raw.type ?? raw.node_type ?? 'unknown'),
    label: String(raw.label ?? ''),
    round: typeof raw.round === 'number' ? raw.round : (typeof raw.round_number === 'number' ? raw.round_number : null),
    payload: safeParsePayload(raw.payload ?? raw.payload_json),
  };
}

function mapBackendEdge(raw: Record<string, unknown>): GraphEdgeRaw {
  let evidence: EdgeEvidence | null = null;
  if (raw.evidence && typeof raw.evidence === 'object' && !Array.isArray(raw.evidence)) {
    const ev = raw.evidence as Record<string, unknown>;
    evidence = {
      confidence_tier: (ev.confidence_tier === 'low' || ev.confidence_tier === 'medium' || ev.confidence_tier === 'high')
        ? ev.confidence_tier : null,
      source_ref: typeof ev.source_ref === 'string' ? ev.source_ref : null,
      source_round_number: typeof ev.source_round_number === 'number' ? ev.source_round_number : null,
      detail: typeof ev.detail === 'string' ? ev.detail : null,
    };
    if (!evidence.confidence_tier && !evidence.source_ref && evidence.source_round_number == null) {
      evidence = null;
    }
  }
  return {
    id: String(raw.id ?? ''),
    source: String(raw.source ?? raw.source_node_id ?? ''),
    target: String(raw.target ?? raw.target_node_id ?? ''),
    type: String(raw.type ?? raw.edge_type ?? ''),
    weight: typeof raw.weight === 'number' ? raw.weight : null,
    label: typeof raw.label === 'string' ? raw.label : null,
    evidence,
  };
}


function mapBackendUnit(raw: Record<string, unknown>): ArgumentUnit {
  return {
    id: String(raw.id ?? ''),
    type: String(raw.type ?? raw.unit_type ?? 'claim'),
    status: String(raw.status ?? 'standing'),
    text: String(raw.text ?? raw.canonical_text ?? ''),
    turn_id: String(raw.turn_id ?? ''),
    node_id: typeof raw.node_id === 'string' ? raw.node_id : undefined,
  };
}

// ── B2: Error tiers ─────────────────────────────────────────

type ErrorTier = 'unauthorized' | 'disabled' | 'not_found' | 'server_error' | 'network' | 'too_large' | 'load_failed' | null;

const ERROR_I18N: Record<string, [string, string]> = {
  unauthorized: ['argument.error.unauthorized', 'No permission'],
  disabled: ['argument.error.disabled', 'Feature not enabled'],
  not_found: ['argument.error.not_found', 'Data not found'],
  server_error: ['argument.error.server', 'Server error'],
  network: ['argument.error.network', 'Network error'],
  too_large: ['argument.error.too_large', 'Too many nodes to display'],
  load_failed: ['argument.error.load_failed', 'Load failed'],
};

// ── Style Constants ─────────────────────────────────────────

const TYPE_LABEL_I18N: Record<string, [string, string]> = {
  claim: GRAPH_TYPE_LABEL_I18N.claim,
  evidence: GRAPH_TYPE_LABEL_I18N.evidence,
  rebuttal: GRAPH_TYPE_LABEL_I18N.rebuttal,
  counter: GRAPH_TYPE_LABEL_I18N.counter,
  verdict: GRAPH_TYPE_LABEL_I18N.verdict,
};

const PERF_TOOLTIP_LIMIT = 150;
const NO_ARROW_TYPES = new Set(['temporal']);
const GRAPH_COMPACT_MEDIA_QUERY = '(max-width: 768px)';

// ── Strength Meter (P1-7) ───────────────────────────────────

interface StrengthMeterProps {
  units: ArgumentUnit[];
  compact?: boolean;
}

const STATUS_ORDER = ['accepted', 'standing', 'unaddressed', 'rebutted', 'rejected'] as const;
const STATUS_LABEL_I18N: Record<string, [string, string]> = {
  standing: GRAPH_STATUS_LABEL_I18N.standing,
  rebutted: GRAPH_STATUS_LABEL_I18N.rebutted,
  unaddressed: GRAPH_STATUS_LABEL_I18N.unaddressed,
  accepted: GRAPH_STATUS_LABEL_I18N.accepted,
  rejected: GRAPH_STATUS_LABEL_I18N.rejected,
};

// Tooltip descriptions for each status (hover/title attribute)
const STATUS_TIP_I18N: Record<string, [string, string]> = {
  accepted: ['argument.status_accepted_tip', 'Accepted by opponent or judge'],
  standing: ['argument.status_standing_tip', 'Standing — this argument holds and has not been rebutted'],
  unaddressed: ['argument.status_unaddressed_tip', 'Unaddressed — not yet engaged'],
  rebutted: ['argument.status_rebutted_tip', 'Rebutted — this argument was countered'],
  rejected: ['argument.status_rejected_tip', 'Rejected by judge'],
};

// Edge types shown in the legend (compact: supports / rebuts / attacks)
const EDGE_LEGEND_KEYS = ['supports', 'rebuts', 'verdict'] as const;
const EDGE_LEGEND_LABEL_I18N: Record<string, [string, string]> = {
  supports: ['argument.legend_edge_supports', 'Supports'],
  rebuts: ['argument.legend_edge_rebuts', 'Rebuts'],
  attacks: ['argument.legend_edge_attacks', 'Attacks'],
  verdict: ['argument.legend_edge_verdict', 'Verdict links'],
};

// localStorage key — track whether user has dismissed the guide
const ARGUMENT_GUIDE_STORAGE_KEY = 'swarm.argumentMap.guideOpen';

function useCompactGraphViewport() {
  return useMediaQueryState(GRAPH_COMPACT_MEDIA_QUERY);
}

function getArgumentTypeLabel(type: string, t: (key: string, fallback: string) => string): string {
  const pair = TYPE_LABEL_I18N[type];
  return pair ? t(pair[0], pair[1]) : type;
}

function getArgumentStatusLabel(status: string, t: (key: string, fallback: string) => string): string {
  const pair = STATUS_LABEL_I18N[status];
  return pair ? t(pair[0], pair[1]) : status;
}

// S2-5: Map argument status to a stable CSS class for visual state.
// Applied via React Flow `node.className`; ArgumentMap.css targets the
// inner `.dag-card-node` button using descendant selectors.
// Each status gets a distinct sRGB-safe border/glow treatment.
const STATUS_NODE_CLASS: Record<string, string> = {
  accepted: 'argmap-node argmap-node--accepted',
  standing: 'argmap-node argmap-node--standing',
  unaddressed: 'argmap-node argmap-node--unaddressed',
  rebutted: 'argmap-node argmap-node--rebutted',
  rejected: 'argmap-node argmap-node--rejected',
};

function getArgumentStatusClass(status: string): string | undefined {
  return STATUS_NODE_CLASS[status];
}

// Status-specific colors (sRGB hex only — no oklch). Used for filter chip
// borders, empty-state tinting, and node border overrides. These values
// are intentionally local to ArgumentMap.tsx so we don't change behavior
// for KG / causal graphs that share `STATUS_COLORS_HEX` from graphTokens.
const ARGMAP_STATUS_BORDER_COLORS: Record<string, string> = {
  accepted: '#22c55e',
  standing: '#3b82f6',
  unaddressed: '#f59e0b',
  rebutted: '#a855f7',
  rejected: '#ef4444',
};

// P1: Side-based visual grouping. Proposition nodes get a warm pink wash,
// opposition nodes get a cool blue wash, judge nodes get a warm gold wash.
// Falls back to NODE_TYPE_COLORS_HEX for nodes without a recognized side
// (e.g. verdict nodes — handled separately below).
const SIDE_BG_COLORS: Record<string, string> = {
  proposition: '#fce4ec', // warm pink
  opposition: '#e3f2fd', // cool blue
  judge: '#fff8e1', // warm gold
};

// P1: Edge dual encoding — color + dash pattern by edge type. Verdict
// linking edges use purple (matching the verdict unit status). Supports
// use solid green; rebuts/counter use dashed red.
const ARGMAP_EDGE_STYLES: Record<string, { stroke: string; strokeDasharray?: string }> = {
  supports: { stroke: '#2e7d32' }, // green solid
  rebuts: { stroke: '#c62828', strokeDasharray: '6 3' }, // red dashed
  counter: { stroke: '#c62828', strokeDasharray: '6 3' }, // red dashed
  accepted: { stroke: '#7b1fa2' }, // purple
  rejected: { stroke: '#7b1fa2' }, // purple
  unaddressed: { stroke: '#7b1fa2' }, // purple
  standing: { stroke: '#7b1fa2' }, // purple
  rebutted: { stroke: '#7b1fa2' }, // purple
  verdict: { stroke: '#7b1fa2' }, // purple legend sample
};

// Status-specific text emoji icons used for the per-filter empty state.
const STATUS_EMPTY_ICONS: Record<string, string> = {
  accepted: '✓', // ✓
  standing: '⚡', // ⚡
  unaddressed: '○', // ○
  rebutted: '⟲', // ⟲
  rejected: '✕', // ✕
};

// Map status -> i18n key/fallback for the per-filter empty state message.
const STATUS_EMPTY_MESSAGE_I18N: Record<string, [string, string]> = {
  accepted: ['argument.filter_empty_accepted', 'No accepted arguments'],
  standing: ['argument.filter_empty_standing', 'No standing arguments'],
  unaddressed: ['argument.filter_empty_unaddressed', 'No unaddressed arguments'],
  rebutted: ['argument.filter_empty_rebutted', 'No rebutted arguments'],
  rejected: ['argument.filter_empty_rejected', 'No rejected arguments'],
};

// Convert a #RRGGBB hex string into an rgba() string with the given
// alpha. Used to build subtle status-tinted backgrounds for the
// per-filter empty state without depending on oklch.
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(120, 120, 120, ${alpha})`;
  const v = m[1];
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// S2-5: Tooltip explanation text (full sentence). Falls back to existing
// short tip if a longer explanation key is missing.
function getArgumentStatusTipText(
  status: string,
  t: (key: string, fallback: string) => string,
): string | undefined {
  const pair = STATUS_TIP_I18N[status];
  return pair ? t(pair[0], pair[1]) : undefined;
}

function getArgumentNodeActionLabel(
  typeLabel: string,
  label: string,
  t: (key: string, fallback: string) => string,
): string {
  return `${t('argument.open_details', 'Open details')}: ${typeLabel} - ${label}`;
}

function getArgumentEdgeRelationLabel(
  edge: GraphEdgeRaw,
  t: (key: string, fallback: string) => string,
): string {
  let base: string;
  if (edge.label && edge.label.trim()) base = edge.label.trim();
  else if (edge.type === 'rebuts') base = t('argument.edge_rebuts', 'rebuts');
  else if (edge.type === 'accepted') base = t('argument.edge_accepted', 'accepts');
  else if (edge.type === 'rejected') base = t('argument.edge_rejected', 'rejects');
  else if (edge.type === 'unaddressed') base = t('argument.edge_unaddressed', 'leaves unaddressed');
  else base = t('argument.edge_supports', 'supports');
  const roundNum = edge.evidence?.source_round_number;
  if (roundNum != null) {
    return `${base} (R${roundNum})`;
  }
  return base;
}

function getEvidenceTierLabel(
  tier: 'low' | 'medium' | 'high',
  t: (key: string, fallback: string) => string,
): string {
  return t(`causal.evidence_${tier}`, tier);
}

function GraphViewportResetButton({ onReset }: { onReset: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onReset}
      style={{
        minHeight: 40,
        padding: '6px 12px',
        borderRadius: 12,
        border: '1px solid #555',
        background: 'transparent',
        color: '#8ab4f8',
        cursor: 'pointer',
        fontSize: '0.8rem',
        lineHeight: 1.4,
      }}
    >
      {t('common.graph_fit_view', 'Fit view')}
    </button>
  );
}

export function ArgumentStrengthMeter({ units, compact }: StrengthMeterProps) {
  const { t } = useTranslation();
  const prefersReducedMotion = useReducedMotion();
  const total = units.length;
  if (total === 0) return null;

  const counts: Record<string, number> = {};
  for (const u of units) {
    counts[u.status] = (counts[u.status] ?? 0) + 1;
  }

  return (
    <div
      role="list"
      aria-label={t('argument.strength_label', 'Argument strength distribution')}
      style={{
        display: 'flex',
        height: compact ? 6 : 10,
        borderRadius: compact ? 3 : 5,
        overflow: 'hidden',
        background: '#222',
        width: '100%',
      }}
    >
      {STATUS_ORDER.map(status => {
        const count = counts[status] ?? 0;
        if (count === 0) return null;
        const pct = (count / total) * 100;
          return (
            <div
              key={status}
              role="listitem"
              aria-label={`${t(STATUS_LABEL_I18N[status][0], STATUS_LABEL_I18N[status][1])}: ${count}/${total}`}
              title={`${t(STATUS_LABEL_I18N[status][0], STATUS_LABEL_I18N[status][1])}: ${count}/${total}`}
              style={{
                width: `${pct}%`,
              background: STATUS_COLORS_HEX[status] ?? '#555',
              transition: prefersReducedMotion ? 'none' : 'width 0.3s ease',
            }}
          />
        );
      })}
    </div>
  );
}

// ── DAG Layout ──────────────────────────────────────────────

function layoutArgumentDag(
  rawNodes: GraphNodeRaw[],
  rawEdges: GraphEdgeRaw[],
  units: ArgumentUnit[],
  t: (key: string, fallback: string) => string,
  reduceMotion: boolean,
): { nodes: Node[]; edges: Edge[] } {
  const unitByNodeId = new Map<string, ArgumentUnit>();
  for (const u of units) {
    if (u.node_id) unitByNodeId.set(u.node_id, u);
  }

  const hasGraphNodes = rawNodes.length > 0;
  const ARG_NODE_W = 240;
  const ARG_NODE_H = 96;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: 'TB',
    ranksep: 140,
    nodesep: 50,
    edgesep: 20,
    ranker: 'tight-tree',
    marginx: 40,
    marginy: 40,
  });

  if (!hasGraphNodes) {
    for (const u of units) g.setNode(u.id, { width: ARG_NODE_W, height: ARG_NODE_H });
  } else {
    for (const n of rawNodes) g.setNode(n.id, { width: ARG_NODE_W, height: ARG_NODE_H });

    // Smart edge processing: build 3-tier hierarchy (verdict → claim → evidence/rebuttal)
    // by selectively feeding edges to dagre. ReactFlow edges are unchanged.
    const verdictNodeId = rawNodes.find(n => n.type === 'verdict')?.id;
    const nodeTypeMap = new Map<string, string>();
    for (const n of rawNodes) {
      const unit = unitByNodeId.get(n.id);
      const effectiveType = unit?.type ?? n.type;
      nodeTypeMap.set(n.id, effectiveType);
    }

    for (const e of rawEdges) {
      const edgeType = e.type || '';
      const targetType = nodeTypeMap.get(e.target) || '';

      if (e.source === verdictNodeId) {
        // Verdict-linking edges: ONLY include verdict→claim edges for dagre ranking.
        // Skip verdict→evidence and verdict→rebuttal to avoid flattening all units
        // into the same rank as claims.
        if (targetType === 'claim') {
          g.setEdge(e.source, e.target, { minlen: 1, weight: 2 });
        }
        // verdict→evidence/rebuttal: skip for dagre (still rendered as ReactFlow edges)
      } else if (edgeType === 'supports') {
        // Invert supports for dagre: evidence supports claim semantically, but in DAG
        // the claim should sit ABOVE evidence. Source/target in ReactFlow stay original.
        g.setEdge(e.target, e.source, { minlen: 1, weight: 1 });
      } else if (edgeType === 'rebuts' || edgeType === 'counter') {
        // Invert rebuts for dagre: rebuttal targets claim semantically, but in DAG
        // the claim should sit ABOVE rebuttal. Source/target in ReactFlow stay original.
        g.setEdge(e.target, e.source, { minlen: 2, weight: 3 });
      } else {
        // Other edges (e.g. temporal, accepted, rejected, unaddressed): keep direction.
        g.setEdge(e.source, e.target, { minlen: 1, weight: 1 });
      }
    }
  }

  dagre.layout(g);

  const flowNodes: Node[] = [];

  if (!hasGraphNodes) {
    for (const u of units) {
      const pos = g.node(u.id);
      const fullLabel = u.text;
      const label = truncateCodepoints(fullLabel, 60);
      const typeLabel = getArgumentTypeLabel(u.type, t);
      const ariaLabel = getArgumentNodeActionLabel(typeLabel, fullLabel, t);
      const statusLabel = getArgumentStatusLabel(u.status, t);
      const statusClass = getArgumentStatusClass(u.status);
      const statusTip = getArgumentStatusTipText(u.status, t);
      // P1: units carry no payload so fall back to type-based color.
      const sideBg = NODE_TYPE_COLORS_HEX[u.type] ?? '#555';
      flowNodes.push({
        id: u.id,
        type: 'graphCard',
        position: { x: pos.x - ARG_NODE_W / 2, y: pos.y - ARG_NODE_H / 2 },
        focusable: false,
        ariaLabel,
        className: statusClass,
        data: {
          label,
          fullLabel,
          meta: `${typeLabel} · ${statusLabel}`,
          ariaLabel,
          statusTooltip: statusTip,
          iconName: NODE_ICONS[u.type] ?? '',
          bgColor: sideBg,
          borderColor: ARGMAP_STATUS_BORDER_COLORS[u.status] ?? STATUS_COLORS_HEX[u.status] ?? '',
          dimmed: false,
          selected: false,
          connected: false,
          expanded: false,
          tooltipDisabled: false,
          reduceMotion,
          sourcePos: 'bottom',
          targetPos: 'top',
        },
      });
    }
    return { nodes: flowNodes, edges: [] };
  }

  for (const n of rawNodes) {
    const pos = g.node(n.id);
    const unit = unitByNodeId.get(n.id);
    const typeKey = unit?.type ?? n.type;
    const statusKey = unit?.status ?? '';
    const typeLabel = getArgumentTypeLabel(typeKey, t);
    const statusLabel = statusKey ? getArgumentStatusLabel(statusKey, t) : '';
    const fullLabel = n.label;
    const displayLabel = truncateCodepoints(fullLabel, 60);
    const ariaLabel = getArgumentNodeActionLabel(typeLabel, n.label, t);

    const statusClass = statusKey ? getArgumentStatusClass(statusKey) : undefined;
    const statusTip = statusKey ? getArgumentStatusTipText(statusKey, t) : undefined;
    // P1: extract side from raw payload (already a parsed object via
    // mapBackendNode). Map proposition/opposition/judge to side-tinted
    // backgrounds; fall back to the type color (or '#555') otherwise.
    const payload = safeParsePayload(n.payload);
    const side = String(payload?.side ?? '').toLowerCase();
    const sideBg = SIDE_BG_COLORS[side]
      ?? NODE_TYPE_COLORS_HEX[typeKey]
      ?? '#555';

    // Verdict nodes: show winner + truncated summary instead of raw tone label
    let enrichedLabel = displayLabel;
    let enrichedFullLabel = fullLabel;
    if (n.type === 'verdict' && payload) {
      const winner = String(payload.winner || '');
      const summary = String(payload.judge_summary || '');
      if (winner) {
        const winnerText = winner === 'proposition'
          ? t('debate.side_proposition', 'Proposition')
          : winner === 'opposition'
            ? t('debate.side_opposition', 'Opposition')
            : winner;
        enrichedLabel = summary
          ? `${winnerText} ${t('argument.verdict_wins', 'wins')}`
          : `${winnerText} ${t('argument.verdict_wins', 'wins')}`;
        enrichedFullLabel = summary || fullLabel;
      }
    }

    flowNodes.push({
      id: n.id,
      type: 'graphCard',
      position: { x: pos.x - ARG_NODE_W / 2, y: pos.y - ARG_NODE_H / 2 },
      focusable: false,
      ariaLabel,
      className: statusClass,
      data: {
        label: enrichedLabel,
        fullLabel: enrichedFullLabel,
        meta: statusLabel ? `${typeLabel} · ${statusLabel}` : typeLabel,
        ariaLabel,
        statusTooltip: statusTip,
        iconName: NODE_ICONS[typeKey] ?? '',
        bgColor: sideBg,
        borderColor: statusKey
          ? (ARGMAP_STATUS_BORDER_COLORS[statusKey] ?? STATUS_COLORS_HEX[statusKey] ?? '')
          : '',
        dimmed: false,
        selected: false,
        connected: false,
        expanded: false,
        tooltipDisabled: false,
        reduceMotion,
        sourcePos: 'bottom',
        targetPos: 'top',
      },
    });
  }

  // C2 + P1: Edge styling — prefer ArgumentMap dual encoding (supports green
  // solid / rebuts red dashed / verdict purple) and fall back to shared
  // EDGE_STYLES for any type not in our local map (e.g. temporal, attacks).
  const flowEdges: Edge[] = rawEdges.map(e => {
    const localStyle = ARGMAP_EDGE_STYLES[e.type];
    const sharedStyle = EDGE_STYLES[e.type];
    const stroke = localStyle?.stroke ?? sharedStyle?.stroke ?? '#888';
    const strokeDasharray = localStyle?.strokeDasharray ?? sharedStyle?.strokeDasharray;
    const tier = e.evidence?.confidence_tier;
    const tierColor = tier ? EVIDENCE_TIER_COLORS[tier] ?? undefined : undefined;
    const roundNum = e.evidence?.source_round_number;
    const baseLabel = e.label ?? undefined;
    const labelParts: string[] = [];
    if (baseLabel) labelParts.push(baseLabel);
    if (roundNum != null) labelParts.push(`R${roundNum}`);
    if (tier) labelParts.push(`[${getEvidenceTierLabel(tier, t)}]`);
    // source_ref is internal pipeline metadata (rule_extraction/verdict_linking) —
    // not shown in visible labels; still available in NodeDetailPanel via edge data.
    const edgeLabel = labelParts.length > 0 ? labelParts.join(' ') : undefined;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: edgeLabel,
      animated: !reduceMotion && (sharedStyle?.animated ?? false),
      style: { stroke, strokeDasharray },
      labelStyle: tierColor ? { fill: tierColor, fontSize: 10, fontWeight: 600 } : undefined,
      markerEnd: NO_ARROW_TYPES.has(e.type) ? undefined : { type: MarkerType.ArrowClosed, color: stroke },
      data: {
        ...(edgeLabel ? { label: edgeLabel } : {}),
        ...(e.evidence?.detail ? { detail: e.evidence.detail } : {}),
      },
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}


// ── Main Component ──────────────────────────────────────────

interface Props {
  debateId: string;
  visible: boolean;
  refreshTrigger?: number;
  conversationScenarioId?: string | null;
  autoTour?: boolean;
}

// FE-3-seq: NodeConversationSheet trigger state (append-only, not wired to layout).
interface ArgumentSheetState {
  open: boolean;
  scenarioId: string;
  identityId: string | null;
  origin: NodeConversationOrigin;
}

export function ArgumentMap({ debateId, visible, refreshTrigger, conversationScenarioId = null, autoTour = true }: Props) {
  const { t, i18n } = useTranslation();
  const isCompactViewport = useCompactGraphViewport();
  const prefersReducedMotion = useReducedMotion();
  // P6 Phase 3: track initial layout for entrance animation
  const layoutAppliedRef = useRef(false);
  const prevFilteredDataRef = useRef<unknown>(null);
  const [data, setData] = useState<ArgumentMapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorTier, setErrorTier] = useState<ErrorTier>(null);
  const [selectedNode, setSelectedNode] = useState<NodeDetail | null>(null);
  // FE-3-seq: append-only sheet state for NodeConversationSheet trigger.
  const [sheetState, setSheetState] = useState<ArgumentSheetState>({
    open: false,
    scenarioId: '',
    identityId: null,
    origin: { nodeId: '', nodeType: '' },
  });
  // P6 Phase 2: path highlighting
  const [highlightedPath, setHighlightedPath] = useState<Set<string> | null>(null);
  // P1-4: surface a dismissible notice when node conversation isn't available
  // (e.g. debate results with no scenario_id link).
  const [noConversationNoticeOpen, setNoConversationNoticeOpen] = useState(false);
  const noConversationDismissedRef = useRef(false);
  const edgeTypes = useMemo(() => ({ animated: AnimatedEdge }), []);
  // C5: Status filter
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  // P3: Mobile view toggle (graph vs list)
  const [mobileViewMode, setMobileViewMode] = useState<'graph' | 'list'>('graph');
  // Guide panel open state (default: open on first visit, persisted)
  const [guideOpen, setGuideOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const stored = window.localStorage?.getItem(ARGUMENT_GUIDE_STORAGE_KEY);
      return stored === null || stored === '1';
    } catch {
      return true;
    }
  });
  const handleGuideToggle = useCallback((next: boolean) => {
    setGuideOpen(next);
    try {
      window.localStorage?.setItem(ARGUMENT_GUIDE_STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* localStorage unavailable — ignore */
    }
  }, []);
  const exportRootId = `argument-map-${useId().replace(/:/g, '-')}`;
  const reactFlowRef = useRef<{
    fitView?: (options?: { padding?: number; duration?: number; nodes?: Array<{ id: string }> }) => void;
  } | null>(null);
  const latestRequestIdRef = useRef(0);
  const detailRestoreFocusRef = useRef<HTMLElement | null>(null);
  const encodedDebateId = encodeURIComponent(debateId);

  const translate = useCallback((key: string, fallback: string) => (
    t(key, fallback)
  ), [t]);

  const fetchData = useCallback(async () => {
    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;
    setLoading(true);
    setSelectedNode(null);
    setErrorTier(null);
    try {
      const res = await fetch(`/api/debate/${encodedDebateId}/argument-map`, {
        headers: buildSessionHeaders(),
      });
      if (requestId !== latestRequestIdRef.current) return;
      if (res.status === 401 || res.status === 403) { setErrorTier('unauthorized'); setData(null); return; }
      if (res.status === 404) {
        const body = await res.json().catch(() => ({}));
        if (requestId !== latestRequestIdRef.current) return;
        setErrorTier(body?.detail?.code === 'FEATURE_DISABLED' ? 'disabled' : 'not_found');
        setData(null);
        return;
      }
      if (res.status === 501) { setErrorTier('disabled'); setData(null); return; }
      if (res.status >= 500) { setErrorTier('server_error'); setData(null); return; }
      if (!res.ok) { setErrorTier('server_error'); setData(null); return; }
      const json = await res.json();
      if (requestId !== latestRequestIdRef.current) return;
      if (json.error) { setErrorTier('load_failed'); setData(null); return; }
      const mapped: ArgumentMapData = {
        snapshot_id: json.snapshot_id,
        nodes: Array.isArray(json.nodes) ? json.nodes.map((n: Record<string, unknown>) => mapBackendNode(n)) : [],
        edges: Array.isArray(json.edges) ? json.edges.map((e: Record<string, unknown>) => mapBackendEdge(e)) : [],
        units: Array.isArray(json.units) ? json.units.map((u: Record<string, unknown>) => mapBackendUnit(u)) : [],
      };
      const visualNodeCount = mapped.nodes.length > 0 ? mapped.nodes.length : mapped.units.length;
      if (visualNodeCount > 2000) { setErrorTier('too_large'); setData(null); return; }
      setData(mapped);
    } catch {
      if (requestId !== latestRequestIdRef.current) return;
      setErrorTier('network');
      setData(null);
    } finally {
      if (requestId === latestRequestIdRef.current) setLoading(false);
    }
  }, [encodedDebateId]);

  useEffect(() => {
    if (!visible || !debateId) return;
    fetchData();
  }, [debateId, visible, fetchData, refreshTrigger]);

  // C5: Filtered data based on status filter
  const filteredData = useMemo(() => {
    if (!data || statusFilter.size === 0) return data;
    const filteredUnits = data.units.filter(u => statusFilter.has(u.status));
    const unitNodeIds = new Set(filteredUnits.map(u => u.node_id).filter(Boolean));
    // Keep nodes linked to matching units + verdict/non-unit nodes
    const filteredNodes = data.nodes.filter(n =>
      unitNodeIds.has(n.id) || n.type === 'verdict' || !data.units.some(u => u.node_id === n.id),
    );
    const nodeIds = new Set(filteredNodes.map(n => n.id));
    const filteredEdges = data.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
    return { ...data, nodes: filteredNodes, edges: filteredEdges, units: filteredUnits };
  }, [data, statusFilter]);

  useEffect(() => {
    prevFilteredDataRef.current = filteredData;
    layoutAppliedRef.current = false;
  }, [filteredData]);

  const { nodes: layoutNodes, edges: layoutEdges } = useMemo(() => {
    if (!filteredData) return { nodes: [], edges: [] };
    const result = layoutArgumentDag(
      filteredData.nodes,
      filteredData.edges,
      filteredData.units,
      translate,
      prefersReducedMotion,
    );
    // P6 Phase 3: add entrance animation class on first layout only
    if (!layoutAppliedRef.current && result.nodes.length > 0 && !prefersReducedMotion) {
      layoutAppliedRef.current = true;
      return {
        ...result,
        nodes: result.nodes.map((n, i) => ({
          ...n,
          className: [n.className, 'dag-node-enter'].filter(Boolean).join(' '),
          style: { ...n.style, animationDelay: `${Math.min(i * 30, 300)}ms` },
        })),
      };
    }
    if (!layoutAppliedRef.current && result.nodes.length > 0) {
      layoutAppliedRef.current = true;
    }
    return result;
  }, [filteredData, prefersReducedMotion, translate]);
  const layoutSignature = useMemo(() => (
    `${layoutNodes.map(n => `${n.id}:${n.position.x}:${n.position.y}`).join('|')}::${layoutEdges.map(e => `${e.id}:${e.source}:${e.target}`).join('|')}`
  ), [layoutNodes, layoutEdges]);

  // `noFilterResults` triggers the legacy "No argument units match"
  // paragraph fallback. When exactly one status filter is active and we
  // would normally show that fallback, defer to the new in-graph empty
  // state (handled by `showFilterEmptyState` below) so users see the
  // status-specific icon + message instead.
  const noFilterResults = statusFilter.size > 1 && filteredData
    ? (data?.units.length ?? 0) > 0 && filteredData.units.length === 0
    : false;
  // Clear stale selection when filtered node disappears
  useEffect(() => {
    if (!selectedNode || !filteredData) return;
    const stillVisible = filteredData.nodes.some(n => n.id === selectedNode.id)
      || filteredData.units.some(u => u.id === selectedNode.id);
    if (!stillVisible) setSelectedNode(null);
  }, [selectedNode, filteredData]);

  // P6 Phase 2: Full recursive path tracing (replaces 1-hop neighborSet)
  const totalElements = layoutNodes.length + layoutEdges.length;
  const skipAnimations = prefersReducedMotion || totalElements > PERF_ANIMATION_LIMIT;

  // Compute full path highlight set when a node is selected
  useEffect(() => {
    if (!selectedNode || layoutEdges.length === 0) {
      setHighlightedPath(null);
      return;
    }
    const pathSet = traceConnectedPath(selectedNode.id, layoutEdges);
    setHighlightedPath(pathSet);
  }, [selectedNode, layoutEdges]);

  // Keep backward-compat neighborSet for node data (connected/dimmed flags)
  const neighborSet = useMemo(() => {
    return highlightedPath;
  }, [highlightedPath]);

  const [argSearch, setArgSearch] = useState<string>('');
  const [resetKey, setResetKey] = useState<number>(0);

  const searchState = useMemo(() => {
    const trimmed = argSearch.trim().toLowerCase();
    if (!trimmed || !filteredData) {
      return { matchIds: null as Set<string> | null, relatedIds: new Set<string>(), matchCount: 0, relatedCount: 0 };
    }
    const matchIds = new Set<string>();
    filteredData.nodes.forEach((n) => {
      const label = String(n.label ?? '').toLowerCase();
      const type = String(n.type ?? '').toLowerCase();
      if (label.includes(trimmed) || type.includes(trimmed)) matchIds.add(n.id);
    });
    filteredData.units.forEach((u) => {
      const text = String(u.text ?? '').toLowerCase();
      const type = String(u.type ?? '').toLowerCase();
      if (text.includes(trimmed) || type.includes(trimmed)) {
        if (u.node_id) matchIds.add(u.node_id);
      }
    });
    const relatedIds = new Set<string>();
    filteredData.edges.forEach((e) => {
      if (matchIds.has(e.source)) relatedIds.add(e.target);
      if (matchIds.has(e.target)) relatedIds.add(e.source);
    });
    matchIds.forEach((id) => relatedIds.delete(id));
    return { matchIds, relatedIds, matchCount: matchIds.size, relatedCount: relatedIds.size };
  }, [argSearch, filteredData]);

  const baseNodes = useMemo(() => {
    const tooltipDisabled = layoutNodes.length > PERF_TOOLTIP_LIMIT;
    return layoutNodes.map((n) => {
      const isSearchActive = searchState.matchIds !== null;
      const isMatch = isSearchActive && searchState.matchIds!.has(n.id);
      const isRelated = isSearchActive && !isMatch && searchState.relatedIds.has(n.id);
      const searchDim = isSearchActive && !isMatch && !isRelated;
      const pathDim = highlightedPath ? !highlightedPath.has(n.id) : false;
      return {
        ...n,
        style: {
          ...n.style,
          opacity: highlightedPath ? (highlightedPath.has(n.id) ? 1 : 0.2) : 1,
          transition: skipAnimations ? 'none' : 'opacity 150ms ease',
        },
        data: {
          ...n.data,
          selected: selectedNode?.id === n.id,
          connected: Boolean(neighborSet && selectedNode?.id !== n.id && neighborSet.has(n.id)),
          expanded: selectedNode?.id === n.id,
          controlsId: 'argument-node-detail-panel',
          dimmed: searchDim ? true : pathDim,
          searchMatch: isMatch,
          searchRelated: isRelated,
          tooltipDisabled,
        },
      };
    });
  }, [layoutNodes, neighborSet, highlightedPath, selectedNode?.id, searchState, skipAnimations]);

  const baseEdges = useMemo(() => {
    const isSearchActive = searchState.matchIds !== null;
    return layoutEdges.map((e) => {
      let opacity = 1;
      if (isSearchActive) {
        const sm = searchState.matchIds!.has(e.source);
        const tm = searchState.matchIds!.has(e.target);
        const sr = searchState.relatedIds.has(e.source);
        const tr = searchState.relatedIds.has(e.target);
        if (!sm && !tm && !sr && !tr) opacity = 0.08;
        else if (sm && tm) opacity = 1;
        else opacity = 0.4;
      } else if (highlightedPath) {
        opacity = highlightedPath.has(e.id) ? 1 : 0.2;
      }
      const isOnPath = highlightedPath?.has(e.id) ?? false;
      return {
        ...e,
        type: (isOnPath && !skipAnimations) ? 'animated' : undefined,
        selected: isOnPath,
        style: {
          ...e.style,
          opacity,
          transition: skipAnimations ? 'none' : 'opacity 150ms ease',
        },
      };
    });
  }, [layoutEdges, highlightedPath, searchState, skipAnimations]);

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(baseNodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(baseEdges);

  const layoutResetSignature = useMemo(
    () => `${layoutSignature}::reset=${resetKey}::lang=${i18n?.language ?? ''}`,
    [layoutSignature, resetKey, i18n?.language],
  );

  useEffect(() => {
    setFlowNodes(baseNodes);
    setFlowEdges(baseEdges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutResetSignature]);

  useEffect(() => {
    setFlowNodes((prev) => {
      const baseMap = new Map(baseNodes.map((b) => [b.id, b]));
      return prev.map((n) => {
        const base = baseMap.get(n.id);
        return base ? { ...n, data: base.data } : n;
      });
    });
    setFlowEdges((prev) => {
      const baseMap = new Map(baseEdges.map((b) => [b.id, b]));
      return prev.map((e) => {
        const base = baseMap.get(e.id);
        return base ? { ...e, style: base.style, type: base.type, selected: base.selected, data: base.data } : e;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchState, selectedNode?.id, neighborSet]);
  const viewportFitOptions = useMemo(() => ({
    padding: isCompactViewport ? 0.2 : 0.24,
    duration: 0,
  }), [isCompactViewport]);

  useEffect(() => {
    if (!reactFlowRef.current || noFilterResults || (layoutNodes.length === 0 && layoutEdges.length === 0)) return;
    reactFlowRef.current.fitView?.(viewportFitOptions);
  }, [layoutEdges.length, layoutNodes.length, layoutSignature, noFilterResults, viewportFitOptions]);

  // P2: Keyboard shortcuts — f/F = fit view, / = focus search,
  // Escape = clear selection + filters. Skip when the user is typing
  // in any input/textarea/contenteditable so we don't fight form
  // controls (search, BYOK fields, etc.).
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      const isEditableTarget = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (
          target instanceof HTMLElement
          && (
            target.isContentEditable
            || Boolean(target.closest('[contenteditable="true"], [role="textbox"]'))
          )
        );
      if (isEditableTarget) {
        // Allow Escape inside the search box to clear filters too;
        // every other key passes through.
        if (e.key !== 'Escape') return;
      }
      switch (e.key) {
        case 'f':
        case 'F': {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          e.preventDefault();
          reactFlowRef.current?.fitView?.(viewportFitOptions);
          break;
        }
        case '/': {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          e.preventDefault();
          const searchInput = document.querySelector<HTMLInputElement>('[data-testid="argmap-search-input"]');
          searchInput?.focus();
          break;
        }
        case 'Escape': {
          setSelectedNode(null);
          setStatusFilter(new Set());
          setArgSearch('');
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewportFitOptions, visible]);

  // P2: Double-click a node to zoom-fit on it. ReactFlow's
  // `zoomOnDoubleClick` is already disabled on the canvas so this
  // doesn't double-fire.
  const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: Node) => {
    reactFlowRef.current?.fitView?.({
      nodes: [{ id: node.id }],
      padding: 0.5,
      duration: prefersReducedMotion ? 0 : 300,
    });
  }, [prefersReducedMotion]);


  const { rawNodeMap, unitByNodeId, unitById } = useMemo(() => {
    const rnm = new Map<string, GraphNodeRaw>();
    const ubn = new Map<string, ArgumentUnit>();
    const ubi = new Map<string, ArgumentUnit>();
    if (filteredData) {
      for (const n of filteredData.nodes) rnm.set(n.id, n);
      for (const u of filteredData.units) {
        if (u.node_id) ubn.set(u.node_id, u);
        ubi.set(u.id, u);
      }
    }
    return { rawNodeMap: rnm, unitByNodeId: ubn, unitById: ubi };
  }, [filteredData]);
  const relationLines = useMemo(() => (
    (filteredData?.edges ?? []).map((edge) => {
      const source = rawNodeMap.get(edge.source);
      const target = rawNodeMap.get(edge.target);
      if (!source || !target) return null;
      let line = t('argument.edge_relation', {
        defaultValue: '{{source}} {{relation}} {{target}}',
        source: source.label,
        relation: getArgumentEdgeRelationLabel(edge, t),
        target: target.label,
      });
      if (edge.evidence?.confidence_tier) {
        line += ` [${t(`causal.evidence_${edge.evidence.confidence_tier}`, edge.evidence.confidence_tier)}]`;
      }
      // source_ref omitted from SR text — internal pipeline metadata
      return line;
    }).filter(Boolean) as string[]
  ), [filteredData?.edges, rawNodeMap, t]);
  const hasInteractiveGraph = visible
    && !loading
    && !errorTier
    && !noFilterResults
    && Boolean(data)
    && (layoutNodes.length > 0 || layoutEdges.length > 0);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    const raw = rawNodeMap.get(node.id);
    const unit = unitByNodeId.get(node.id) ?? unitById.get(node.id);
    const triggerElement = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-graph-node-card="true"]')
      : null;
    const fallbackTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    detailRestoreFocusRef.current = triggerElement ?? fallbackTrigger;
    setSelectedNode({
      id: node.id,
      label: raw?.label ?? unit?.text ?? node.id,
      type: unit?.type ?? raw?.type ?? 'unknown',
      round: raw?.round,
      payload: raw?.payload,
      unitText: unit?.text,
      unitStatus: unit?.status,
      unitTurnId: unit?.turn_id,
    });
    // FE-3-seq: open NodeConversationSheet — append only, existing behavior preserved.
    const nodeType = unit?.type ?? raw?.type ?? 'unknown';
    const excerpt = unit?.text ?? raw?.label;
    if (!conversationScenarioId) {
      // P1-4: tell the user why nothing happened (e.g. debate result graphs).
      if (!noConversationDismissedRef.current) {
        setNoConversationNoticeOpen(true);
      }
      return;
    }
    const relatedContext = (filteredData?.edges ?? [])
      .filter((edge) => edge.source === node.id || edge.target === node.id)
      .slice(0, 3)
      .flatMap((edge) => {
        const otherId = edge.source === node.id ? edge.target : edge.source;
        const other = rawNodeMap.get(otherId);
        const otherLabel = other?.label?.trim();
        if (!otherLabel) return [];
        return [
          t('argument.related_context_line', {
            relation: getArgumentEdgeRelationLabel(edge, t),
            label: otherLabel,
            defaultValue: '{{relation}}: {{label}}',
          }),
        ];
      });
    setSheetState({
      open: true,
      scenarioId: conversationScenarioId,
      identityId: null,
      origin: {
        surface: 'argument',
        nodeId: node.id,
        nodeType,
        excerpt,
        nodeLabel: raw?.label ?? unit?.text ?? node.id,
        roundNumber: raw?.round ?? null,
        targetLabel: t('node_context_banner.target_argument_analyst_label', 'Verdict graph analyst'),
        targetDescription: t(
          'node_context_banner.target_argument_analyst_description',
          'Answers from this claim, evidence, or verdict and its nearby argument links.',
        ),
        relatedContext,
      },
    });
  }, [conversationScenarioId, filteredData?.edges, rawNodeMap, t, unitByNodeId, unitById]);

  // C3: Background click resets highlight + closes detail panel
  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setHighlightedPath(null);
  }, []);
  // P1-4: dismiss the "conversation unavailable" notice and remember the choice.
  const dismissNoConversationNotice = useCallback(() => {
    noConversationDismissedRef.current = true;
    setNoConversationNoticeOpen(false);
  }, []);
  const resetViewport = useCallback(() => {
    reactFlowRef.current?.fitView?.(viewportFitOptions);
  }, [viewportFitOptions]);

  // C5: Toggle status filter
  const toggleStatus = useCallback((status: string) => {
    setStatusFilter(prev => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  // Count units by status from the *unfiltered* data so the badge is
  // a stable surface area regardless of the active filter set.
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {
      accepted: 0,
      standing: 0,
      unaddressed: 0,
      rebutted: 0,
      rejected: 0,
    };
    if (!data) return counts;
    for (const u of data.units) {
      if (counts[u.status] !== undefined) counts[u.status] += 1;
    }
    return counts;
  }, [data]);

  // When a single filter is active and produces 0 matches, surface a
  // status-specific empty state inside the graph area.
  const singleActiveStatus = statusFilter.size === 1
    ? Array.from(statusFilter)[0]
    : null;
  const showFilterEmptyState = Boolean(
    singleActiveStatus
    && filteredData
    && filteredData.units.length === 0
    && (data?.units.length ?? 0) > 0,
  );

  // Smooth filter transition: toggle `argmap-filtering` briefly when the
  // active filter set changes so the graph fades out then back in.
  const [isFiltering, setIsFiltering] = useState(false);
  const filterSignature = useMemo(
    () => Array.from(statusFilter).sort().join('|'),
    [statusFilter],
  );
  const filterSignatureRef = useRef(filterSignature);
  useEffect(() => {
    if (filterSignatureRef.current === filterSignature) return;
    filterSignatureRef.current = filterSignature;
    if (prefersReducedMotion) return;
    setIsFiltering(true);
    const timer = window.setTimeout(() => setIsFiltering(false), 150);
    return () => window.clearTimeout(timer);
  }, [filterSignature, prefersReducedMotion]);

  const graphAriaLabelConfig = useMemo(() => ({
    'node.a11yDescription.default': t('common.graph_node_a11y', 'Graph node. Press Enter or Space to open details.'),
    'node.a11yDescription.keyboardDisabled': t('common.graph_node_a11y', 'Graph node. Press Enter or Space to open details.'),
    'edge.a11yDescription.default': t('common.graph_edge_a11y', 'Graph edge. Relation details are available in the text summary below.'),
    'controls.ariaLabel': t('common.graph_controls', 'Graph controls'),
    'controls.zoomIn.ariaLabel': t('common.graph_zoom_in', 'Zoom in'),
    'controls.zoomOut.ariaLabel': t('common.graph_zoom_out', 'Zoom out'),
    'controls.fitView.ariaLabel': t('common.graph_fit_view', 'Fit view'),
    'controls.interactive.ariaLabel': t('common.graph_toggle_interactivity', 'Toggle interactivity'),
    'minimap.ariaLabel': t('common.graph_minimap', 'Mini map'),
    'handle.ariaLabel': t('common.graph_handle', 'Graph handle'),
  }), [t]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const className = 'has-argument-map';
    if (!hasInteractiveGraph) {
      document.body.classList.remove(className);
      return;
    }

    document.body.classList.add(className);
    return () => {
      document.body.classList.remove(className);
    };
  }, [hasInteractiveGraph]);

  if (!visible) return null;
  if (loading) return <p style={{ fontSize: '0.85rem', color: '#888' }}>{t('common.loading', 'Loading...')}</p>;
  if (errorTier) {
    const pair = ERROR_I18N[errorTier];
    return (
      <div role="alert" style={{ fontSize: '0.85rem', color: '#888', textAlign: 'center', padding: '1rem' }}>
        <p>{pair ? t(pair[0], pair[1]) : errorTier}</p>
        {(errorTier === 'network' || errorTier === 'server_error' || errorTier === 'load_failed') && (
          <button onClick={fetchData} style={{ marginTop: 8, padding: '4px 12px', borderRadius: 4, border: '1px solid #555', background: 'transparent', color: '#8ab4f8', cursor: 'pointer' }}>
            {t('common.retry', 'Retry')}
          </button>
        )}
      </div>
    );
  }
  if (!data || (data.units.length === 0 && data.nodes.length === 0)) {
    return (
      <div className="dag-empty-ghost" data-testid="dag-empty-state">
        <div className="dag-empty-skeleton dag-empty-shimmer">
          <div className="dag-empty-node" />
          <div className="dag-empty-edge" />
          <div className="dag-empty-node" />
        </div>
        <p className="dag-empty-text">{t('dag.empty_state_title', 'No graph data yet')}</p>
        <p className="dag-empty-text" style={{ fontSize: '0.78rem' }}>
          {t('argument.empty', 'No argument map available.')}
        </p>
        <p className="dag-empty-text" style={{ fontSize: '0.74rem', maxWidth: 480, margin: '0.25rem auto 0', color: '#888' }}>
          {t(
            'argument.empty_guide',
            'The argument map is automatically generated during the debate as AI extracts claims, evidence, and rebuttals. No analyzable argument units have been produced yet.',
          )}
        </p>
        <button className="dag-empty-cta" onClick={() => window.history.back()}>
          {t('dag.empty_state_cta', 'Back to input')}
        </button>
      </div>
    );
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <div
        aria-label={t('argument.a11y_label', 'Debate argument map')}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0 }}
      >
        {/* P1-7: Strength meter summary */}
        <ArgumentStrengthMeter units={filteredData?.units ?? data.units} />

        {/* Guide panel — collapsible overview, default open on first visit */}
        {guideOpen ? (
          <div
            id="argument-guide-panel"
            style={{
              padding: '0.75rem 1rem',
              borderRadius: 12,
              border: '1px solid rgba(140, 140, 140, 0.18)',
              background: 'rgba(255, 255, 255, 0.02)',
              fontSize: '0.78rem',
              color: '#bbb',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ color: '#eee', fontSize: '0.82rem' }}>
                {t('argument.guide_title', 'Map Guide')}
              </strong>
              <button
                type="button"
                onClick={() => handleGuideToggle(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#888',
                  cursor: 'pointer',
                  fontSize: '0.7rem',
                  padding: '2px 6px',
                  lineHeight: 1,
                }}
                aria-label={t('argument.guide_close', 'Hide guide')}
                aria-expanded={true}
                aria-controls="argument-guide-panel"
              >
                {'✕'}
              </button>
            </div>
            <p style={{ margin: '0 0 6px 0', color: '#bbb' }}>
              {t(
                'argument.guide_description',
                'The argument map visualizes claims, evidence, and rebuttal relationships from the debate. Nodes represent argument units, edges show their relationships.',
              )}
            </p>
            <div style={{ marginBottom: 6, color: '#888', fontSize: '0.72rem' }}>
              {t('argument.guide_nodes_units', {
                defaultValue: '{{nodes}} nodes · {{units}} argument items',
                nodes: (filteredData?.nodes.length ?? data.nodes.length),
                units: (filteredData?.units.length ?? data.units.length),
              })}
            </div>
            <p style={{ margin: 0, color: '#888', fontSize: '0.7rem' }}>
              {t('argument.guide_hint', 'Click any node for details. Use filters to narrow by status.')}
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => handleGuideToggle(true)}
            aria-expanded={false}
            style={{
              alignSelf: 'flex-start',
              padding: '4px 10px',
              background: 'none',
              border: '1px solid rgba(140, 140, 140, 0.25)',
              borderRadius: 8,
              color: '#888',
              fontSize: '0.7rem',
              cursor: 'pointer',
            }}
          >
            <span aria-hidden="true">{'▶'} </span>
            {t('argument.guide_show', 'Show guide')}
          </button>
        )}

        {/* P3: Mobile view toggle (graph vs list) */}
        {isCompactViewport && (
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <button
              onClick={() => setMobileViewMode('graph')}
              aria-pressed={mobileViewMode === 'graph'}
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                border: '1px solid rgba(64,48,40,0.15)',
                background: mobileViewMode === 'graph' ? '#2563eb' : 'transparent',
                color: mobileViewMode === 'graph' ? '#fff' : '#374151',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {t('argument.view_graph', 'Graph')}
            </button>
            <button
              onClick={() => setMobileViewMode('list')}
              aria-pressed={mobileViewMode === 'list'}
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                border: '1px solid rgba(64,48,40,0.15)',
                background: mobileViewMode === 'list' ? '#2563eb' : 'transparent',
                color: mobileViewMode === 'list' ? '#fff' : '#374151',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {t('argument.view_list', 'List')}
            </button>
          </div>
        )}

        {/* C5: Status filter chips */}
        <div
          role="group"
          aria-label={t('argument.filter_status_group', 'Filter argument units by status')}
          style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}
        >
          <span style={{ fontSize: '0.7rem', color: '#888', marginRight: 4 }}>
            {t('argument.filter_status', 'Filter:')}
          </span>
          {STATUS_ORDER.map(status => {
            const active = statusFilter.has(status);
            // Prefer status-specific border colors (sRGB), fall back to the
            // shared token if a status is somehow not registered.
            const color = ARGMAP_STATUS_BORDER_COLORS[status]
              ?? STATUS_COLORS_HEX[status]
              ?? '#888';
            const chipBright = isBrightGraphBackground(color);
            const tipPair = STATUS_TIP_I18N[status];
            const tipText = tipPair ? t(tipPair[0], tipPair[1]) : undefined;
            const count = statusCounts[status] ?? 0;
            // aria-hidden span on the count below keeps the button's
            // accessible name equal to the status label text (e.g.
            // "Accepted"), preserving existing test/locator semantics.
            // For users that benefit from a stronger description, the
            // count is also reflected in the title attribute.
            const countLabel = t('argument.filter_count', {
              defaultValue: '{{count}} items',
              count,
            });
            const titleWithCount = tipText
              ? `${tipText} — ${countLabel}`
              : countLabel;
            return (
              <button
                key={status}
                onClick={() => toggleStatus(status)}
                aria-pressed={active}
                title={titleWithCount}
                style={{
                  minHeight: 40,
                  padding: '6px 12px',
                  borderRadius: 12,
                  border: `1px solid ${color}`,
                  background: active ? color : 'transparent',
                  color: active ? (chipBright ? '#111' : '#fff') : color,
                  cursor: 'pointer',
                  fontSize: '0.78rem',
                  lineHeight: 1.4,
                }}
              >
                {t(STATUS_LABEL_I18N[status][0], STATUS_LABEL_I18N[status][1])}
                <span
                  aria-hidden="true"
                  className={`argmap-filter-count${count === 0 ? ' argmap-filter-count--zero' : ''}`}
                >
                  {' '}
                  ({count})
                </span>
              </button>
            );
          })}
          {statusFilter.size > 0 && (
            <button
              onClick={() => setStatusFilter(new Set())}
              style={{ minHeight: 36, fontSize: '0.74rem', color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              {t('common.clear', 'Clear')}
            </button>
          )}
          {isCompactViewport && !noFilterResults && (
            <>
              <GraphViewportResetButton onReset={resetViewport} />
              <span style={{ fontSize: '0.65rem', color: '#888' }}>
                {t('common.graph_mobile_hint', 'Drag to pan. Pinch or use the graph controls to zoom.')}
              </span>
            </>
          )}
        </div>

        {/* P2-4: Search + reset layout */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor={`${exportRootId}-search`} className="sr-only">
            {t('argument.search_label', 'Search argument map')}
          </label>
          <input
            id={`${exportRootId}-search`}
            type="search"
            value={argSearch}
            onChange={(e) => setArgSearch(e.target.value)}
            placeholder={t('argument.search_placeholder', 'Search label, text, type…')}
            aria-label={t('argument.search_label', 'Search argument map')}
            data-testid="argmap-search-input"
            style={{
              flex: isCompactViewport ? '1 1 100%' : '0 1 260px',
              minHeight: 44, padding: '6px 10px', fontSize: '0.82rem',
              borderRadius: 8, border: '1px solid #333', background: '#111', color: '#eee',
            }}
          />
          {searchState.matchIds !== null && (
            <span aria-live="polite" style={{ fontSize: '0.72rem', color: '#8ab4f8' }}>
              {searchState.matchCount > 0
                ? t('argument.search_match_count', { defaultValue: '{{matches}} matches, {{related}} related', matches: searchState.matchCount, related: searchState.relatedCount })
                : t('argument.search_no_match', 'No matches')}
            </span>
          )}
          <button
            type="button"
            onClick={() => setResetKey((k) => k + 1)}
            style={{ minHeight: 36, padding: '4px 10px', fontSize: '0.76rem', borderRadius: 6, border: '1px solid #555', background: 'transparent', color: '#8ab4f8', cursor: 'pointer' }}
            aria-label={t('argument.reset_layout', 'Reset layout')}
          >
            {t('argument.reset_layout', 'Reset layout')}
          </button>
        </div>

        {noFilterResults ? (
          <p style={{ fontSize: '0.85rem', color: '#888' }}>
            {t('argument.no_results', 'No argument units match the selected filters.')}
          </p>
        ) : isCompactViewport && mobileViewMode === 'list' ? (
          <ArgumentMapMobileList
            units={filteredData?.units ?? data?.units ?? []}
            onUnitClick={(unitId, nodeId) => {
              // Switch to graph view and select the node, using the same
              // rawNodeMap / unitByNodeId / unitById lookup as onNodeClick.
              setMobileViewMode('graph');
              const raw = nodeId ? rawNodeMap.get(nodeId) : undefined;
              const unit = (nodeId ? unitByNodeId.get(nodeId) : undefined) ?? unitById.get(unitId);
              const resolvedId = nodeId ?? unitId;
              setSelectedNode({
                id: resolvedId,
                label: raw?.label ?? unit?.text ?? resolvedId,
                type: unit?.type ?? raw?.type ?? 'unknown',
                round: raw?.round,
                payload: raw?.payload,
                unitText: unit?.text,
                unitStatus: unit?.status,
                unitTurnId: unit?.turn_id,
              });
            }}
          />
        ) : (
          <>
            {/* Export controls (P1-3) */}
            <ExportPanel
              containerSelector={`.argument-map-export-target[data-export-root="${exportRootId}"]`}
              filenamePrefix="argument-map"
            />

            {/* DAG container */}
            <div
              style={{
                height: isCompactViewport ? 'min(70vh, 600px)' : 'min(75vh, 800px)',
                minHeight: isCompactViewport ? 360 : 480,
                border: '1px solid rgba(64, 48, 40, 0.15)',
                borderRadius: 14,
                overflow: 'hidden',
                position: 'relative',
              }}
              className={`argument-map-container${isFiltering ? ' argmap-filtering' : ''}`}
            >
              {/* Per-filter empty state — shown only when a single status
                  filter is active and zero units match. */}
              {showFilterEmptyState && singleActiveStatus ? (
                (() => {
                  const emptyColor = ARGMAP_STATUS_BORDER_COLORS[singleActiveStatus] ?? '#cfd3da';
                  const emptyIcon = STATUS_EMPTY_ICONS[singleActiveStatus] ?? '○';
                  const messagePair = STATUS_EMPTY_MESSAGE_I18N[singleActiveStatus]
                    ?? ['argument.no_results', 'No argument units match the selected filters.'];
                  // Build a subtle tinted background via inline rgba()
                  // (use a low-opacity wash for the status color).
                  const tinted = hexToRgba(emptyColor, 0.06);
                  return (
                    <div
                      className="argmap-filter-empty"
                      role="status"
                      aria-live="polite"
                      data-testid="argmap-filter-empty"
                      style={{
                        // Layer rgba() fallback first, then via CSS var.
                        background: tinted,
                        ['--argmap-empty-bg' as string]: tinted,
                        ['--argmap-empty-color' as string]: emptyColor,
                      }}
                    >
                      <span className="argmap-filter-empty__icon" data-color aria-hidden="true">
                        {emptyIcon}
                      </span>
                      <p className="argmap-filter-empty__message">
                        {t(messagePair[0], messagePair[1])}
                      </p>
                    </div>
                  );
                })()
              ) : null}
              <div
                className="argument-map-export-target"
                data-testid="argument-map-export-target"
                data-export-root={exportRootId}
                style={{ position: 'absolute', inset: 0 }}
              >
                <ReactFlow
                  nodes={flowNodes}
                  edges={flowEdges}
                  ariaLabelConfig={graphAriaLabelConfig}
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onNodeClick={onNodeClick}
                  onNodeDoubleClick={onNodeDoubleClick}
                  onPaneClick={onPaneClick}
                onInit={(instance) => {
                  reactFlowRef.current = instance;
                }}
                fitView
                fitViewOptions={viewportFitOptions}
                deleteKeyCode={null}
                selectionKeyCode={null}
                panActivationKeyCode={null}
                zoomActivationKeyCode={null}
                panOnDrag={[0, 1]}
                preventScrolling
                zoomOnScroll
                zoomOnPinch
                panOnScroll={false}
                zoomOnDoubleClick={false}
                minZoom={0.05}
                maxZoom={4}
                nodesDraggable={true}
                nodesFocusable={false}
                edgesFocusable={false}
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
              >
                  <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
                  <Controls className="graph-export-chrome" />
                  {!isCompactViewport && (
                    <MiniMap
                      className="graph-export-chrome"
                      nodeColor={(n) => (n.data?.bgColor as string) || '#555'}
                      nodeStrokeWidth={3}
                      style={{ background: '#1a1a2e', pointerEvents: 'none' }}
                    />
                  )}
                </ReactFlow>
              </div>
              <NodeDetailPanel
                panelId="argument-node-detail-panel"
              key={selectedNode?.id ?? 'argument-map-closed'}
              node={selectedNode}
              onClose={() => setSelectedNode(null)}
              desktopRightOffset={sheetState.open && !isCompactViewport ? NODE_DETAIL_SHEET_CLEARANCE_PX : 8}
              restoreFocusTarget={detailRestoreFocusRef.current}
              />
            </div>
            {/* P1-4: explain why node conversation isn't available (debate result graphs). */}
            {!conversationScenarioId && noConversationNoticeOpen ? (
              <div className="argument-map__no-conversation-notice">
                <span className="argument-map__no-conversation-text">
                  {t(
                    'argument.conversation_unavailable',
                    'Node conversation is not available for debate results.',
                  )}
                </span>
                <button
                  type="button"
                  className="argument-map__no-conversation-dismiss btn btn-ghost"
                  onClick={dismissNoConversationNotice}
                  aria-label={t('argument.conversation_unavailable_dismiss', 'Dismiss')}
                >
                  {t('argument.conversation_unavailable_dismiss', 'Dismiss')}
                </button>
              </div>
            ) : null}
          </>
        )}

        {/* Legend — node types + statuses + edges + confidence tiers */}
        <div
          aria-label={t('argument.guide_title', 'Map Guide')}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '0.5rem 0.75rem',
            borderTop: '1px solid rgba(140, 140, 140, 0.15)',
            fontSize: '0.7rem',
            color: '#888',
          }}
        >
          {/* Row 1: Node types with descriptions */}
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={{ color: '#aaa', fontWeight: 600, minWidth: 64 }}>
              {t('argument.legend_types', 'Node types')}
            </span>
            {([
              ['claim', 'argument.legend_claim_desc', 'Core arguments from debaters'] as const,
              ['evidence', 'argument.legend_evidence_desc', 'Facts or data supporting a claim'] as const,
              ['rebuttal', 'argument.legend_rebuttal_desc', 'Counterarguments to opponent'] as const,
              ['counter', 'argument.legend_counter_desc', 'Responses to rebuttals'] as const,
            ]).map(([type, descKey, descFallback]) => {
              const pair = TYPE_LABEL_I18N[type];
              return (
                <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 10, height: 10, borderRadius: 2,
                      background: NODE_TYPE_COLORS_HEX[type], display: 'inline-block',
                    }}
                  />
                  <strong>{t(pair[0], pair[1])}</strong>
                  <span style={{ color: '#aaa', fontSize: '0.65rem' }}>
                    {t(descKey, descFallback)}
                  </span>
                </span>
              );
            })}
          </div>

          {/* Row 2: Statuses with descriptions */}
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={{ color: '#aaa', fontWeight: 600, minWidth: 64 }}>
              {t('argument.legend_statuses', 'Statuses')}
            </span>
            {STATUS_ORDER.map(status => {
              const labelPair = STATUS_LABEL_I18N[status];
              const tipPair = STATUS_TIP_I18N[status];
              return (
                <span
                  key={status}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 10, height: 10, borderRadius: '50%',
                      background: ARGMAP_STATUS_BORDER_COLORS[status] ?? STATUS_COLORS_HEX[status] ?? '#888',
                      display: 'inline-block',
                    }}
                  />
                  <strong>{t(labelPair[0], labelPair[1])}</strong>
                  {tipPair && (
                    <span style={{ color: '#aaa', fontSize: '0.65rem' }}>
                      {t(tipPair[0], tipPair[1])}
                    </span>
                  )}
                </span>
              );
            })}
          </div>

          {/* Row 3: Edges with descriptions */}
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={{ color: '#aaa', fontWeight: 600, minWidth: 64 }}>
              {t('argument.legend_edges', 'Relations')}
            </span>
            {EDGE_LEGEND_KEYS.map(edgeKey => {
              const style = ARGMAP_EDGE_STYLES[edgeKey] ?? EDGE_STYLES[edgeKey];
              const stroke = style?.stroke ?? '#888';
              const dashed = Boolean(style?.strokeDasharray);
              const labelPair = EDGE_LEGEND_LABEL_I18N[edgeKey];
              return (
                <span key={edgeKey} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <svg aria-hidden="true" width="22" height="6" viewBox="0 0 22 6" style={{ display: 'inline-block' }}>
                    <line x1="0" y1="3" x2="22" y2="3" stroke={stroke} strokeWidth="2"
                      strokeDasharray={dashed ? (style?.strokeDasharray ?? '') : undefined} />
                  </svg>
                  {t(labelPair[0], labelPair[1])}
                </span>
              );
            })}
          </div>

          {/* Row 4: Confidence tiers with descriptions + total units */}
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={{ color: '#aaa', fontWeight: 600, minWidth: 64 }}>
              {t('argument.legend_confidence', 'Confidence')}
            </span>
            {([
              ['high', '#22c55e', 'argument.legend_confidence_high_desc', 'Strong evidence, well-supported'] as const,
              ['medium', '#eab308', 'argument.legend_confidence_medium_desc', 'Partial evidence, needs more support'] as const,
              ['low', '#9ca3af', 'argument.legend_confidence_low_desc', 'Weak or indirect support'] as const,
            ]).map(([tier, color, descKey, descFallback]) => (
              <span key={tier} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span aria-hidden="true" style={{
                  width: 10, height: 10, borderRadius: 2,
                  background: EVIDENCE_TIER_COLORS[tier] ?? color, display: 'inline-block',
                }} />
                <strong>{t(`causal.evidence_${tier}`, tier)}</strong>
                <span style={{ color: '#aaa', fontSize: '0.65rem' }}>
                  {t(descKey, descFallback)}
                </span>
              </span>
            ))}
            <span style={{ color: '#999', fontSize: '0.65rem' }}>
              {t('argument.legend_thickness_hint', 'Thicker lines = stronger arguments')}
            </span>
            <span style={{ marginLeft: 'auto' }}>
              {filteredData?.units.length ?? 0} {t('argument.total_units', 'units')}
            </span>
          </div>
        </div>

        {/* a11y: screen reader fallback list */}
        <div className="sr-only" role="list" aria-label={t('argument.a11y_list', 'Argument units list')}>
          {(filteredData?.units.length ?? data.units.length) > 0
            ? (filteredData?.units ?? data.units).map(u => (
                <div key={u.id} role="listitem">
                  {`${getArgumentTypeLabel(u.type, t)}: ${u.text} [${getArgumentStatusLabel(u.status, t)}]`}
                </div>
              ))
            : (filteredData?.nodes ?? data.nodes).map((node) => (
                <div key={node.id} role="listitem">
                  {`${getArgumentTypeLabel(node.type, t)}: ${node.label}`}
                </div>
              ))}
        </div>
        <div className="sr-only" role="list" aria-label={t('argument.a11y_relations', 'Argument relations list')}>
          {relationLines.map((line, index) => (
            <div key={`${line}-${index}`} role="listitem">{line}</div>
          ))}
        </div>
        {/* FE-3-seq: NodeConversationSheet remains disabled until the caller provides a real scenario id. */}
        {sheetState.open && conversationScenarioId ? (
          <NodeConversationSheet
            open={sheetState.open}
            onOpenChange={(next) => setSheetState((prev) => ({ ...prev, open: next }))}
            onClose={() => setSheetState((prev) => ({ ...prev, open: false }))}
            scenarioId={sheetState.scenarioId}
            identityId={sheetState.identityId}
            origin={sheetState.origin}
          />
        ) : null}
        {/* P3: First-visit guided tour — only when data is present and not in mobile list view */}
        {autoTour && data && data.nodes.some((node) => node.type === 'verdict') && data.units.length > 0 && !(isCompactViewport && mobileViewMode === 'list') && (
          <ArgumentMapTour />
        )}
      </div>
    </Tooltip.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { STATUS_COLORS_HEX as STATUS_COLORS, TYPE_LABEL_I18N, safeParsePayload, mapBackendNode, mapBackendEdge, mapBackendUnit, traceConnectedPath, PERF_ANIMATION_LIMIT };
export type { ArgumentUnit, ArgumentMapData, ErrorTier };
