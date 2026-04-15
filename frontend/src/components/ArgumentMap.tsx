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
import dagre from 'dagre';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ExportPanel } from './ExportPanel';
import { NodeDetailPanel, type NodeDetail } from './NodeDetailPanel';
import GraphNodeCard from './GraphNodeCard';
import {
  NODE_TYPE_COLORS_HEX,
  STATUS_COLORS_HEX,
  EDGE_STYLES,
  NODE_ICONS,
  TYPE_LABEL_I18N as GRAPH_TYPE_LABEL_I18N,
  STATUS_LABEL_I18N as GRAPH_STATUS_LABEL_I18N,
} from '../lib/graphTokens';

// ── Custom node type (stable reference) ────────────────────

const nodeTypes = { graphCard: GraphNodeCard };

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

interface GraphEdgeRaw {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number | null;
  label: string | null;
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
  return {
    id: String(raw.id ?? ''),
    source: String(raw.source ?? raw.source_node_id ?? ''),
    target: String(raw.target ?? raw.target_node_id ?? ''),
    type: String(raw.type ?? raw.edge_type ?? ''),
    weight: typeof raw.weight === 'number' ? raw.weight : null,
    label: typeof raw.label === 'string' ? raw.label : null,
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
const GRAPH_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

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

function useMediaQueryState(query: string) {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mediaQueryList = window.matchMedia(query);
    const handleChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    mediaQueryList.addEventListener?.('change', handleChange);
    return () => mediaQueryList.removeEventListener?.('change', handleChange);
  }, [query]);

  return matches;
}

function useCompactGraphViewport() {
  return useMediaQueryState(GRAPH_COMPACT_MEDIA_QUERY);
}

function useReducedMotionPreference() {
  return useMediaQueryState(GRAPH_REDUCED_MOTION_QUERY);
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

function GraphViewportResetButton({ onReset }: { onReset: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onReset}
      style={{
        padding: '2px 8px',
        borderRadius: 12,
        border: '1px solid #555',
        background: 'transparent',
        color: '#8ab4f8',
        cursor: 'pointer',
        fontSize: '0.65rem',
        lineHeight: 1.4,
      }}
    >
      {t('common.graph_fit_view', 'Fit view')}
    </button>
  );
}

export function ArgumentStrengthMeter({ units, compact }: StrengthMeterProps) {
  const { t } = useTranslation();
  const prefersReducedMotion = useReducedMotionPreference();
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
        height: compact ? 4 : 8,
        borderRadius: compact ? 2 : 4,
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
  const nodeWidth = 220;
  const nodeHeight = 60;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: 60, nodesep: 30 });

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
      flowNodes.push({
        id: u.id,
        type: 'graphCard',
        position: { x: pos.x - nodeWidth / 2, y: pos.y - nodeHeight / 2 },
        focusable: false,
        ariaLabel,
        data: {
          label,
          fullLabel,
          ariaLabel,
          iconName: NODE_ICONS[u.type] ?? '',
          bgColor: NODE_TYPE_COLORS_HEX[u.type] ?? '#555',
          borderColor: STATUS_COLORS_HEX[u.status] ?? '',
          dimmed: false,
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
    const fullLabel = `[${typeLabel}] ${n.label}`;
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
        ariaLabel,
        iconName: NODE_ICONS[typeKey] ?? '',
        bgColor: NODE_TYPE_COLORS_HEX[typeKey] ?? '#555',
        borderColor: statusKey ? (STATUS_COLORS_HEX[statusKey] ?? '') : '',
        dimmed: false,
        tooltipDisabled: false,
        reduceMotion,
        sourcePos: 'bottom',
        targetPos: 'top',
      },
    });
  }

  // C2: Edge styling from EDGE_STYLES
  const flowEdges: Edge[] = rawEdges.map(e => {
    const style = EDGE_STYLES[e.type];
    const stroke = style?.stroke ?? '#888';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label ?? undefined,
      animated: !reduceMotion && (style?.animated ?? false),
      style: { stroke, strokeDasharray: style?.strokeDasharray },
      markerEnd: NO_ARROW_TYPES.has(e.type) ? undefined : { type: MarkerType.ArrowClosed, color: stroke },
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}

// ── Main Component ──────────────────────────────────────────

interface Props {
  debateId: string;
  visible: boolean;
  refreshTrigger?: number;
}

export function ArgumentMap({ debateId, visible, refreshTrigger }: Props) {
  const { t } = useTranslation();
  const isCompactViewport = useCompactGraphViewport();
  const prefersReducedMotion = useReducedMotionPreference();
  const [data, setData] = useState<ArgumentMapData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorTier, setErrorTier] = useState<ErrorTier>(null);
  const [selectedNode, setSelectedNode] = useState<NodeDetail | null>(null);
  // C5: Status filter
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const exportRootId = `argument-map-${useId().replace(/:/g, '-')}`;
  const reactFlowRef = useRef<{ fitView?: () => void } | null>(null);
  const latestRequestIdRef = useRef(0);

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
      const res = await fetch(`/api/debate/${debateId}/argument-map`, {
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
  }, [debateId]);

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

  const { nodes: layoutNodes, edges: layoutEdges } = useMemo(() => {
    if (!filteredData) return { nodes: [], edges: [] };
    return layoutArgumentDag(
      filteredData.nodes,
      filteredData.edges,
      filteredData.units,
      translate,
      prefersReducedMotion,
    );
  }, [filteredData, prefersReducedMotion, translate]);
  const layoutSignature = useMemo(() => (
    `${layoutNodes.map(n => `${n.id}:${n.position.x}:${n.position.y}`).join('|')}::${layoutEdges.map(e => `${e.id}:${e.source}:${e.target}`).join('|')}`
  ), [layoutNodes, layoutEdges]);

  const noFilterResults = statusFilter.size > 0 && filteredData ? filteredData.units.length === 0 : false;

  // Clear stale selection when filtered node disappears
  useEffect(() => {
    if (!selectedNode || !filteredData) return;
    const stillVisible = filteredData.nodes.some(n => n.id === selectedNode.id)
      || filteredData.units.some(u => u.id === selectedNode.id);
    if (!stillVisible) setSelectedNode(null);
  }, [selectedNode, filteredData]);

  // C3: Neighbor highlight based on selected node
  const neighborSet = useMemo(() => {
    if (!selectedNode || !filteredData) return null;
    const set = new Set<string>([selectedNode.id]);
    for (const e of filteredData.edges) {
      if (e.source === selectedNode.id) set.add(e.target);
      if (e.target === selectedNode.id) set.add(e.source);
    }
    return set;
  }, [selectedNode, filteredData]);

  const nodes = useMemo(() => {
    const tooltipDisabled = layoutNodes.length > PERF_TOOLTIP_LIMIT;
    return layoutNodes.map(n => ({
      ...n,
      data: {
        ...n.data,
        dimmed: neighborSet ? !neighborSet.has(n.id) : false,
        tooltipDisabled,
      },
    }));
  }, [layoutNodes, neighborSet]);

  const edges = useMemo(() => {
    if (!neighborSet) return layoutEdges;
    return layoutEdges.map(e => ({
      ...e,
      style: {
        ...e.style,
        opacity: (neighborSet.has(e.source) && neighborSet.has(e.target)) ? 1 : 0.1,
      },
    }));
  }, [layoutEdges, neighborSet]);

  useEffect(() => {
    if (!reactFlowRef.current || noFilterResults || (layoutNodes.length === 0 && layoutEdges.length === 0)) return;
    reactFlowRef.current.fitView?.();
  }, [layoutEdges.length, layoutNodes.length, layoutSignature, noFilterResults]);

  const onNodesChange = useCallback(() => {}, []);
  const onEdgesChange = useCallback(() => {}, []);

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

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    const raw = rawNodeMap.get(node.id);
    const unit = unitByNodeId.get(node.id) ?? unitById.get(node.id);
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
  }, [rawNodeMap, unitByNodeId, unitById]);

  // C3: Background click resets highlight + closes detail panel
  const onPaneClick = useCallback(() => setSelectedNode(null), []);
  const resetViewport = useCallback(() => {
    reactFlowRef.current?.fitView?.();
  }, []);

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
    'controls.ariaLabel': t('common.graph_controls', 'Graph controls'),
    'controls.zoomIn.ariaLabel': t('common.graph_zoom_in', 'Zoom in'),
    'controls.zoomOut.ariaLabel': t('common.graph_zoom_out', 'Zoom out'),
    'controls.fitView.ariaLabel': t('common.graph_fit_view', 'Fit view'),
    'controls.interactive.ariaLabel': t('common.graph_toggle_interactivity', 'Toggle interactivity'),
    'minimap.ariaLabel': t('common.graph_minimap', 'Mini map'),
  }), [t]);

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
    return <p style={{ fontSize: '0.85rem', color: '#888' }}>{t('argument.empty', 'No argument map available.')}</p>;
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <div
        aria-label={t('argument.a11y_label', 'Debate argument map')}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0 }}
      >
        {/* P1-7: Strength meter summary */}
        <ArgumentStrengthMeter units={data.units} />

        {/* C5: Status filter chips */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '0.7rem', color: '#888', marginRight: 4 }}>
            {t('argument.filter_status', 'Filter:')}
          </span>
          {STATUS_ORDER.map(status => {
            const active = statusFilter.has(status);
            const color = STATUS_COLORS_HEX[status] ?? '#888';
            const chipBright = color === '#2ecc71' || color === '#f1c40f';
            return (
              <button
                key={status}
                onClick={() => toggleStatus(status)}
                aria-pressed={active}
                style={{
                  padding: '2px 8px',
                  borderRadius: 12,
                  border: `1px solid ${color}`,
                  background: active ? color : 'transparent',
                  color: active ? (chipBright ? '#111' : '#fff') : color,
                  cursor: 'pointer',
                  fontSize: '0.65rem',
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
              style={{ fontSize: '0.65rem', color: '#888', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              {t('common.clear', 'Clear')}
            </button>
          )}
          {isCompactViewport && !noFilterResults && (
            <GraphViewportResetButton onReset={resetViewport} />
          )}
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
                  nodes={nodes}
                  edges={edges}
                  ariaLabelConfig={graphAriaLabelConfig}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onNodeClick={onNodeClick}
                  onPaneClick={onPaneClick}
                  onInit={(instance) => {
                    reactFlowRef.current = instance;
                  }}
                  fitView
                  proOptions={{ hideAttribution: true }}
                >
                  <Background />
                  {!isCompactViewport && <Controls className="graph-export-chrome" />}
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
              <NodeDetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} />
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
      </div>
    </Tooltip.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { STATUS_COLORS_HEX as STATUS_COLORS, TYPE_LABEL_I18N, safeParsePayload, mapBackendNode, mapBackendEdge, mapBackendUnit };
export type { ArgumentUnit, ArgumentMapData, ErrorTier };
