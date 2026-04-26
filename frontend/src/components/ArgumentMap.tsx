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
import { ExportPanel } from './ExportPanel';
import { NodeDetailPanel, type NodeDetail } from './NodeDetailPanel';
import GraphNodeCard from './GraphNodeCard';
import AnimatedEdge from './AnimatedEdge';
import { NodeConversationSheet } from './kg/NodeConversationSheet';
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
  const nodeWidth = 280;
  const nodeHeight = 120;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: 100, nodesep: 80 });

  if (!hasGraphNodes) {
    for (const u of units) g.setNode(u.id, { width: nodeWidth, height: nodeHeight });
  } else {
    for (const n of rawNodes) g.setNode(n.id, { width: nodeWidth, height: nodeHeight });
    for (const e of rawEdges) g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const flowNodes: Node[] = [];

  if (!hasGraphNodes) {
    for (const u of units) {
      const pos = g.node(u.id);
      const fullLabel = u.text;
      const label = fullLabel.length > 60 ? fullLabel.slice(0, 60) + '\u2026' : fullLabel;
      const typeLabel = getArgumentTypeLabel(u.type, t);
      const ariaLabel = getArgumentNodeActionLabel(typeLabel, fullLabel, t);
      const statusLabel = getArgumentStatusLabel(u.status, t);
      flowNodes.push({
        id: u.id,
        type: 'graphCard',
        position: { x: pos.x - nodeWidth / 2, y: pos.y - nodeHeight / 2 },
        focusable: false,
        ariaLabel,
        data: {
          label,
          fullLabel,
          meta: `${typeLabel} · ${statusLabel}`,
          ariaLabel,
          iconName: NODE_ICONS[u.type] ?? '',
          bgColor: NODE_TYPE_COLORS_HEX[u.type] ?? '#555',
          borderColor: STATUS_COLORS_HEX[u.status] ?? '',
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
    const displayLabel = fullLabel.length > 60 ? fullLabel.slice(0, 60) + '\u2026' : fullLabel;
    const ariaLabel = getArgumentNodeActionLabel(typeLabel, n.label, t);

    flowNodes.push({
      id: n.id,
      type: 'graphCard',
      position: { x: pos.x - nodeWidth / 2, y: pos.y - nodeHeight / 2 },
      focusable: false,
      ariaLabel,
      data: {
        label: displayLabel,
        fullLabel,
        meta: statusLabel ? `${typeLabel} · ${statusLabel}` : typeLabel,
        ariaLabel,
        iconName: NODE_ICONS[typeKey] ?? '',
        bgColor: NODE_TYPE_COLORS_HEX[typeKey] ?? '#555',
        borderColor: statusKey ? (STATUS_COLORS_HEX[statusKey] ?? '') : '',
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

  // C2: Edge styling from EDGE_STYLES + evidence badge
  const flowEdges: Edge[] = rawEdges.map(e => {
    const style = EDGE_STYLES[e.type];
    const stroke = style?.stroke ?? '#888';
    const tier = e.evidence?.confidence_tier;
    const tierColor = tier ? EVIDENCE_TIER_COLORS[tier] ?? undefined : undefined;
    const roundNum = e.evidence?.source_round_number;
    const sourceRef = e.evidence?.source_ref;
    const baseLabel = e.label ?? undefined;
    const labelParts: string[] = [];
    if (baseLabel) labelParts.push(baseLabel);
    if (roundNum != null) labelParts.push(`R${roundNum}`);
    if (tier) labelParts.push(`[${getEvidenceTierLabel(tier, t)}]`);
    if (sourceRef) labelParts.push(`(${sourceRef})`);
    const edgeLabel = labelParts.length > 0 ? labelParts.join(' ') : undefined;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: edgeLabel,
      animated: !reduceMotion && (style?.animated ?? false),
      style: { stroke, strokeDasharray: style?.strokeDasharray },
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
}

// FE-3-seq: NodeConversationSheet trigger state (append-only, not wired to layout).
interface ArgumentSheetState {
  open: boolean;
  scenarioId: string;
  identityId: string | null;
  origin: { nodeId: string; nodeType: string; excerpt?: string };
}

export function ArgumentMap({ debateId, visible, refreshTrigger, conversationScenarioId = null }: Props) {
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
  const edgeTypes = useMemo(() => ({ animated: AnimatedEdge }), []);
  // C5: Status filter
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const exportRootId = `argument-map-${useId().replace(/:/g, '-')}`;
  const reactFlowRef = useRef<{ fitView?: (options?: { padding?: number; duration?: number }) => void } | null>(null);
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
          className: 'dag-node-enter',
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

  const noFilterResults = statusFilter.size > 0 && filteredData
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
      if (edge.evidence?.source_ref) {
        line += ` (${t('argument.evidence_source', { defaultValue: 'Source: {{source}}', source: edge.evidence.source_ref })})`;
      }
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
      return;
    }
    setSheetState({
      open: true,
      scenarioId: conversationScenarioId,
      identityId: null,
      origin: { nodeId: node.id, nodeType, excerpt },
    });
  }, [conversationScenarioId, rawNodeMap, unitByNodeId, unitById]);

  // C3: Background click resets highlight + closes detail panel
  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setHighlightedPath(null);
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
            const color = STATUS_COLORS_HEX[status] ?? '#888';
            const chipBright = isBrightGraphBackground(color);
            return (
              <button
                key={status}
                onClick={() => toggleStatus(status)}
                aria-pressed={active}
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
                height: isCompactViewport ? 'min(62vh, 540px)' : 'min(50vh, 480px)',
                minHeight: isCompactViewport ? 320 : 280,
                border: '1px solid #333',
                borderRadius: 6,
                overflow: 'hidden',
                position: 'relative',
              }}
              className="argument-map-container"
            >
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
                preventScrolling={false}
                zoomOnScroll={false}
                panOnScroll={false}
                zoomOnDoubleClick={false}
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
          </>
        )}

        {/* Legend */}
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.7rem', color: '#888' }}>
          {(['claim', 'evidence', 'rebuttal', 'counter'] as const).map(type => {
            const pair = TYPE_LABEL_I18N[type];
            return (
              <span key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: NODE_TYPE_COLORS_HEX[type], display: 'inline-block' }} />
                {t(pair[0], pair[1])}
              </span>
            );
          })}
          <span style={{ marginLeft: 'auto' }}>
            {filteredData?.units.length ?? 0} {t('argument.total_units', 'units')}
          </span>
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
      </div>
    </Tooltip.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { STATUS_COLORS_HEX as STATUS_COLORS, TYPE_LABEL_I18N, safeParsePayload, mapBackendNode, mapBackendEdge, mapBackendUnit, traceConnectedPath, PERF_ANIMATION_LIMIT };
export type { ArgumentUnit, ArgumentMapData, ErrorTier };
