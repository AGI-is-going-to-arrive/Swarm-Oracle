import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ExportPanel } from '../ExportPanel';
import { NodeDetailPanel, type NodeDetail } from '../NodeDetailPanel';
import { NodeConversationSheet, type NodeConversationOrigin } from '../kg/NodeConversationSheet';
import GraphNodeCard from '../GraphNodeCard';
import { useScenarioGraph, type GraphErrorState } from '../../hooks/useScenarioGraph';
import { traceConnectedPath, buildParallelEdgeIndex, PERF_ANIMATION_LIMIT } from '../../lib/graphTraversal';
import { resolveCausalNodeColors } from '../../lib/dagEditorialTokens';
import { truncateCodepoints } from '../../lib/textUtils';
import useMediaQueryState from '../../hooks/useMediaQueryState';
import useReducedMotion from '../../hooks/useReducedMotion';
import AnimatedEdge from '../AnimatedEdge';
import dagre from 'dagre';
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
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  NODE_TYPE_COLORS_HEX,
  EDGE_STYLES,
  NODE_ICONS,
  EVIDENCE_TIER_COLORS,
  TYPE_LABEL_I18N as GRAPH_TYPE_LABEL_I18N,
} from '../../lib/graphTokens';

// ── Types ───────────────────────────────────────────────────

interface GraphNodeData {
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

interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number | null;
  label: string | null;
  evidence?: EdgeEvidence | null;
}

type CausalGraphErrorState = GraphErrorState;

interface ConvSheetState {
  open: boolean;
  scenarioId: string;
  identityId: string | null;
  origin: NodeConversationOrigin;
}

const CLOSED_SHEET: ConvSheetState = {
  open: false,
  scenarioId: '',
  identityId: null,
  origin: { nodeId: '', nodeType: '' },
};

export interface CausalGraphBoardProps {
  scenarioId: string;
  onNodeClick?: (node: unknown) => void;
  className?: string;
  hideExport?: boolean;
}

// ── Constants ───────────────────────────────────────────────

const nodeTypes = { graphCard: GraphNodeCard };
const edgeTypes = { animated: AnimatedEdge };

const COLORS = {
  textMuted: '#9aa4b2',
  textLink: '#8ab4f8',
  textError: '#ff7a70',
  textBody: '#b8c1d1',
  textStrong: '#e4e8f1',
  surfacePanel: '#17172a',
  surfaceField: '#1a1a2e',
  borderDefault: '#555',
  borderSubtle: '#333',
  inputText: '#ffffff',
  decorativeNodeFallback: '#555',
  decorativeEdgeFallback: '#888',
  decorativeLegendFallback: '#666',
} as const;

const NODE_W = 280;
const NODE_H = 120;
const LARGE_GRAPH_THRESHOLD = 50;
const LARGE_GRAPH_FIT_MIN_ZOOM = 0.35;
const LARGE_GRAPH_NODE_W = 280;
const LARGE_GRAPH_NODE_H = 58;
const PERF_TOOLTIP_LIMIT = 150;
const PERF_TEXT_FALLBACK_LIMIT = 500;
const NO_ARROW_TYPES = new Set(['temporal']);
const GRAPH_COMPACT_MEDIA_QUERY = '(max-width: 768px)';
type CausalTranslate = TFunction<'translation', undefined>;

// ── Helpers ─────────────────────────────────────────────────

function getCausalTypeLabel(type: string, t: CausalTranslate): string {
  const pair = GRAPH_TYPE_LABEL_I18N[type];
  return pair ? t(pair[0], pair[1]) : type;
}

function getEvidenceTierLabel(tier: 'low' | 'medium' | 'high', t: CausalTranslate): string {
  return t(`causal.evidence_${tier}`, tier);
}

const BACKEND_LABEL_I18N: Record<string, [string, string]> = {
  'triggered fork': ['causal.edge_triggered_fork', 'triggered fork'],
  'stance shift': ['causal.edge_stance_shift', 'stance shift'],
};

function getCausalEdgeBaseRelationLabel(edge: GraphEdgeData, t: CausalTranslate): string {
  if (edge.type === 'temporal') return t('causal.edge_temporal', 'precedes');
  if (edge.type === 'responds_to') return t('causal.edge_responds_to', 'responds to');
  if (edge.type === 'supports_stance') return t('causal.edge_supports_stance', 'aligns with');
  if (edge.type === 'opposes_stance') return t('causal.edge_opposes_stance', 'opposes');
  if (edge.type === 'led_to') return t('causal.edge_led_to', 'leads to');
  const rawLabel = edge.label?.trim();
  if (rawLabel) {
    const mapping = BACKEND_LABEL_I18N[rawLabel.toLowerCase()];
    if (mapping) return t(mapping[0], mapping[1]);
    if (edge.type === 'caused' && /^(causes?|caused)$/i.test(rawLabel)) {
      return t('causal.edge_caused', 'causes');
    }
    return rawLabel;
  }
  return t('causal.edge_caused', 'causes');
}

function getCausalEdgeRelationLabel(edge: GraphEdgeData, t: CausalTranslate): string {
  const base = getCausalEdgeBaseRelationLabel(edge, t);
  const roundNum = edge.evidence?.source_round_number;
  if (roundNum != null) return `${base} (R${roundNum})`;
  return base;
}

function getCausalErrorMessage(error: CausalGraphErrorState, t: CausalTranslate): string {
  switch (error.code) {
    case 'NETWORK_ERROR':
      return t('causal.error.network', 'Unable to load the causal graph. Check your connection and try again.');
    case 'BRANCH_NOT_FOUND':
      return t('causal.error.branch_not_found', 'The selected branch is no longer available for this scenario.');
    case 'FEATURE_DISABLED':
      return t('causal.feature_disabled', 'Causal graph feature is not enabled.');
    default: break;
  }
  if (error.status === 401 || error.status === 403)
    return t('causal.error.unauthorized', 'You do not have permission to view this causal graph.');
  if (error.status != null && error.status >= 500)
    return t('causal.error.server', 'The server could not load the causal graph right now.');
  return t('causal.error.load_failed', 'Unable to load the causal graph right now. Please retry.');
}

// ── Layout ──────────────────────────────────────────────────

function layoutDagre(
  nodes: GraphNodeData[],
  edges: GraphEdgeData[],
  t: CausalTranslate,
  compactViewport: boolean,
  reducedMotion: boolean,
): { nodes: Node[]; edges: Edge[] } {
  const isLargeGraph = nodes.length > LARGE_GRAPH_THRESHOLD;
  const nodeW = isLargeGraph ? LARGE_GRAPH_NODE_W : NODE_W;
  const nodeH = isLargeGraph ? LARGE_GRAPH_NODE_H : NODE_H;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: compactViewport ? 'TB' : 'LR',
    ranksep: isLargeGraph ? 60 : 120,
    nodesep: isLargeGraph ? 16 : 100,
  });
  for (const n of nodes) g.setNode(n.id, { width: nodeW, height: nodeH });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const disableAnim = reducedMotion || nodes.length > PERF_ANIMATION_LIMIT;
  const tooltipDisabled = nodes.length > PERF_TOOLTIP_LIMIT;

  const flowNodes: Node[] = nodes.map(n => {
    const pos = g.node(n.id);
    const fullLabel = n.label || n.key;
    const label = truncateCodepoints(fullLabel, 50);
    const typeLabel = getCausalTypeLabel(n.type, t);
    const roundLabel = t('causal.round_label', 'Round');
    const ariaLabel = `${t('causal.open_details', 'Open details')}: ${typeLabel} - ${fullLabel}`;
    return {
      id: n.id,
      type: 'graphCard',
      position: { x: pos.x - nodeW / 2, y: pos.y - nodeH / 2 },
      focusable: false,
      ariaLabel,
      data: {
        label,
        fullLabel,
        meta: n.round != null ? `${typeLabel} · ${roundLabel} ${n.round}` : typeLabel,
        ariaLabel,
        iconName: NODE_ICONS[n.type] ?? '',
        bgColor: NODE_TYPE_COLORS_HEX[n.type] ?? COLORS.decorativeNodeFallback,
        borderColor: '',
        accentColor: resolveCausalNodeColors(n.type, 'dark').accent,
        round: n.round ?? undefined,
        dimmed: false,
        selected: false,
        connected: false,
        expanded: false,
        disableNodeDrag: false,
        tooltipDisabled,
        sourcePos: compactViewport ? 'bottom' : 'right',
        targetPos: compactViewport ? 'top' : 'left',
      },
    };
  });

  const parallelOffsets = buildParallelEdgeIndex(edges);

  const flowEdges: Edge[] = edges.map(e => {
    const style = EDGE_STYLES[e.type];
    const stroke = style?.stroke ?? COLORS.decorativeEdgeFallback;
    const tier = e.evidence?.confidence_tier;
    const tierColor = tier ? EVIDENCE_TIER_COLORS[tier] ?? undefined : undefined;
    const roundNum = e.evidence?.source_round_number;
    const baseLabel = getCausalEdgeBaseRelationLabel(e, t);
    const edgeLabel = baseLabel || undefined;
    const detailParts: string[] = [];
    if (roundNum != null) {
      detailParts.push(t('causal.edge_round_context', {
        round: roundNum,
        defaultValue: 'Round {{round}}',
      }));
    }
    if (tier) {
      detailParts.push(t('causal.edge_confidence_context', {
        tier: getEvidenceTierLabel(tier, t),
        defaultValue: 'confidence: {{tier}}',
      }));
    }
    const edgeDetail = detailParts.length > 0 ? detailParts.join(' · ') : undefined;
    const isHighPriority = e.type === 'caused' || e.type === 'led_to' || Boolean(edgeLabel && /trigger|fork|导致|导向|causes|caused|leads/i.test(edgeLabel));
    const offset = parallelOffsets.get(e.id) ?? 0;
    const edgeData = (edgeLabel || edgeDetail || tierColor) ? {
      ...(edgeLabel ? { label: edgeLabel } : {}),
      ...(edgeDetail ? { detail: edgeDetail } : {}),
      ...(tierColor ? { tierColor } : {}),
      ...(isHighPriority ? { priority: 'high' } : {}),
      ...(offset !== 0 ? { parallelOffset: offset } : {}),
    } : undefined;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'animated',
      label: edgeLabel,
      animated: !disableAnim && (style?.animated ?? false),
      selected: false,
      style: { stroke, strokeDasharray: style?.strokeDasharray },
      labelStyle: tierColor ? { fill: tierColor, fontSize: 10, fontWeight: 600 } : undefined,
      markerEnd: NO_ARROW_TYPES.has(e.type) ? undefined : { type: MarkerType.ArrowClosed, color: stroke },
      data: edgeData,
      ...(offset !== 0 ? { pathOptions: { offset } } : {}),
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}

// ── Component ───────────────────────────────────────────────

export default function CausalGraphBoard({
  scenarioId,
  onNodeClick: externalOnNodeClick,
  className,
  hideExport = false,
}: CausalGraphBoardProps) {
  const { t } = useTranslation();
  const isCompactViewport = useMediaQueryState(GRAPH_COMPACT_MEDIA_QUERY);
  const reducedMotion = useReducedMotion();

  const {
    data: graphData,
    loading,
    error,
    refetch: fetchGraph,
  } = useScenarioGraph(scenarioId || null);

  const [selectedNode, setSelectedNode] = useState<NodeDetail | null>(null);
  const [sheetState, setSheetState] = useState<ConvSheetState>(CLOSED_SHEET);
  const [agentSearch, setAgentSearch] = useState('');

  const exportRootId = `causal-board-${useId().replace(/:/g, '-')}`;
  const reactFlowRef = useRef<{ fitView?: (opts?: { padding?: number; duration?: number }) => void } | null>(null);
  const [detailRestoreFocusTarget, setDetailRestoreFocusTarget] = useState<HTMLElement | null>(null);

  const searchState = useMemo(() => {
    if (!graphData) return { data: null, matchCount: 0, relatedCount: 0 };
    if (!agentSearch.trim()) return { data: graphData, matchCount: 0, relatedCount: 0 };
    const search = agentSearch.toLowerCase();
    const matchingNodes = graphData.nodes.filter(n => {
      const p = (typeof n.payload === 'object' && n.payload ? n.payload : {}) as Record<string, unknown>;
      return String(p.agent_id ?? '').toLowerCase().includes(search)
        || String(p.agent_name ?? '').toLowerCase().includes(search)
        || n.label.toLowerCase().includes(search);
    });
    const matchedIds = new Set(matchingNodes.map(n => n.id));
    if (matchedIds.size === 0) return { data: { ...graphData, nodes: [], edges: [] }, matchCount: 0, relatedCount: 0 };
    const contextualIds = new Set(matchedIds);
    for (const edge of graphData.edges) {
      if (matchedIds.has(edge.source) || matchedIds.has(edge.target)) {
        contextualIds.add(edge.source);
        contextualIds.add(edge.target);
      }
    }
    const contextualNodes = graphData.nodes.filter(n => contextualIds.has(n.id));
    const contextualEdges = graphData.edges.filter(e => contextualIds.has(e.source) && contextualIds.has(e.target));
    return {
      data: { ...graphData, nodes: contextualNodes, edges: contextualEdges },
      matchCount: matchingNodes.length,
      relatedCount: Math.max(0, contextualNodes.length - matchingNodes.length),
    };
  }, [graphData, agentSearch]);

  const filteredData = searchState.data;
  const nodeCount = filteredData?.nodes.length ?? 0;
  const edgeCount = filteredData?.edges.length ?? 0;
  const isTextFallback = nodeCount > PERF_TEXT_FALLBACK_LIMIT;
  const hasSourceEdges = (graphData?.edges.length ?? 0) > 0;
  const isRelationlessFallback = nodeCount > 1 && edgeCount === 0 && !hasSourceEdges;
  const isNonInteractiveFallback = isTextFallback || isRelationlessFallback;

  const layoutResult = useMemo(() => {
    if (!filteredData || filteredData.nodes.length === 0 || isNonInteractiveFallback) return { nodes: [], edges: [] };
    return layoutDagre(filteredData.nodes, filteredData.edges, t, isCompactViewport, reducedMotion);
  }, [filteredData, isCompactViewport, isNonInteractiveFallback, t, reducedMotion]);

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(layoutResult.nodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(layoutResult.edges);
  const [currentZoom, setCurrentZoom] = useState(1);

  const onViewportChange = useCallback(({ zoom }: Viewport) => {
    const bucket = zoom < 0.3 ? 0 : zoom < 0.6 ? 1 : 2;
    setCurrentZoom(prev => {
      const prevBucket = prev < 0.3 ? 0 : prev < 0.6 ? 1 : 2;
      return bucket !== prevBucket ? zoom : prev;
    });
  }, []);

  const viewportFitOptions = useMemo(() => ({
    padding: isCompactViewport ? 0.2 : 0.24,
    duration: 0,
    ...(flowNodes.length > LARGE_GRAPH_THRESHOLD ? { minZoom: LARGE_GRAPH_FIT_MIN_ZOOM } : {}),
  }), [isCompactViewport, flowNodes.length]);

  const isExportPanelVisible = !hideExport && nodeCount > 0 && !isNonInteractiveFallback;
  // ExportPanel captures this ReactFlow canvas, so keep all nodes mounted while export controls are visible.
  const shouldCullInvisibleElements = !isExportPanelVisible && flowNodes.length > 30;

  useEffect(() => {
    setFlowNodes(layoutResult.nodes);
    setFlowEdges(layoutResult.edges);
    if (layoutResult.nodes.length === 0 || layoutResult.nodes.length > PERF_TEXT_FALLBACK_LIMIT) return;
    let innerRaf: number | null = null;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        reactFlowRef.current?.fitView?.(viewportFitOptions);
      });
    });
    return () => {
      cancelAnimationFrame(outerRaf);
      if (innerRaf !== null) cancelAnimationFrame(innerRaf);
    };
  }, [layoutResult, setFlowNodes, setFlowEdges, viewportFitOptions]);

  useEffect(() => {
    if (!selectedNode || !filteredData) return;
    if (!filteredData.nodes.some(n => n.id === selectedNode.id)) {
      const t = setTimeout(() => setSelectedNode(null), 0);
      return () => clearTimeout(t);
    }
  }, [selectedNode, filteredData]);

  const highlightedPath = useMemo(() => {
    if (!selectedNode || layoutResult.edges.length === 0) return null;
    return traceConnectedPath(selectedNode.id, layoutResult.edges);
  }, [selectedNode, layoutResult.edges]);

  useEffect(() => {
    setFlowNodes(prev => {
      let changed = false;
      const next = prev.map(n => {
        const wantSelected = selectedNode?.id === n.id;
        const wantConnected = Boolean(highlightedPath && selectedNode?.id !== n.id && highlightedPath.has(n.id));
        const wantExpanded = wantSelected;
        const wantDimmed = highlightedPath ? !highlightedPath.has(n.id) : false;
        const data = n.data as Record<string, unknown>;
        if (
          data.selected === wantSelected
          && data.connected === wantConnected
          && data.expanded === wantExpanded
          && data.dimmed === wantDimmed
        ) {
          return n;
        }
        changed = true;
        return {
          ...n,
          data: {
            ...data,
            selected: wantSelected,
            connected: wantConnected,
            expanded: wantExpanded,
            dimmed: wantDimmed,
          },
        };
      });
      return changed ? next : prev;
    });
  }, [highlightedPath, selectedNode?.id, setFlowNodes]);

  useEffect(() => {
    setFlowEdges(prev => {
      let changed = false;
      const next = prev.map(e => {
        // traceConnectedPath returns node IDs and the specific traversed edge IDs; edge IDs avoid highlighting parallel siblings.
        const onPath = highlightedPath ? highlightedPath.has(e.id) : false;
        const wantSelected = onPath;
        const wantOpacity = highlightedPath ? (onPath ? 1 : 0.15) : 1;
        const currentOpacity = (e.style as { opacity?: number } | undefined)?.opacity ?? 1;
        if (e.selected === wantSelected && currentOpacity === wantOpacity) {
          return e;
        }
        changed = true;
        return { ...e, selected: wantSelected, style: { ...e.style, opacity: wantOpacity } };
      });
      return changed ? next : prev;
    });
  }, [highlightedPath, setFlowEdges]);

  const rawNodeMap = useMemo(() => {
    const m = new Map<string, GraphNodeData>();
    if (filteredData) for (const n of filteredData.nodes) m.set(n.id, n);
    return m;
  }, [filteredData]);

  const relationLines = useMemo(() => (
    (filteredData?.edges ?? []).map(edge => {
      const source = rawNodeMap.get(edge.source);
      const target = rawNodeMap.get(edge.target);
      if (!source || !target) return null;
      let line = `${source.label || source.key} ${getCausalEdgeRelationLabel(edge, t)} ${target.label || target.key}`;
      if (edge.evidence?.confidence_tier) line += ` [${t(`causal.evidence_${edge.evidence.confidence_tier}`, edge.evidence.confidence_tier)}]`;
      return line;
    }).filter(Boolean) as string[]
  ), [filteredData?.edges, rawNodeMap, t]);

  const openNodeDetail = useCallback((nodeId: string, triggerElement?: HTMLElement | null) => {
    const raw = rawNodeMap.get(nodeId);
    if (!raw) return;
    setDetailRestoreFocusTarget(triggerElement?.isConnected ? triggerElement : null);
    setSelectedNode({ id: raw.id, label: raw.label || raw.key, type: raw.type, round: raw.round, payload: raw.payload });
    externalOnNodeClick?.(raw);

    const rawPayload = typeof raw.payload === 'object' && raw.payload !== null && !Array.isArray(raw.payload)
      ? raw.payload as Record<string, unknown>
      : {};
    const agentName = typeof rawPayload.agent_name === 'string' ? rawPayload.agent_name : undefined;
    const fullContent = typeof rawPayload.content === 'string' ? rawPayload.content : '';
    setSheetState({
      open: true,
      scenarioId,
      identityId: null,
      origin: {
        nodeId: raw.id,
        nodeType: raw.type,
        excerpt: fullContent || raw.label || raw.key,
        branchId: typeof rawPayload.branch_id === 'string' ? rawPayload.branch_id : undefined,
        roundNumber: raw.round,
        agentName,
        nodeLabel: raw.label || raw.key,
        typeColor: NODE_TYPE_COLORS_HEX[raw.type] ?? NODE_TYPE_COLORS_HEX.event,
      },
    });
  }, [rawNodeMap, externalOnNodeClick, scenarioId]);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    const trigger = _event.target instanceof Element
      ? _event.target.closest<HTMLElement>('[data-graph-node-card="true"]')
      : null;
    openNodeDetail(node.id, trigger ?? (_event.currentTarget instanceof HTMLElement ? _event.currentTarget : null));
  }, [openNodeDetail]);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setSheetState(prev => prev.open ? { ...prev, open: false } : prev);
  }, []);

  if (loading) {
    return (
      <div data-testid="causal-graph-board" className={className} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
        <p style={{ color: COLORS.textMuted }}>{t('common.loading', 'Loading...')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="causal-graph-board" className={className} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 200, gap: '0.5rem' }}>
        <p role="alert" style={{ color: COLORS.textError }}>{getCausalErrorMessage(error, t)}</p>
        <button onClick={() => void fetchGraph()} style={{ padding: '4px 10px', borderRadius: 4, border: `1px solid ${COLORS.borderDefault}`, background: 'transparent', color: COLORS.textLink, cursor: 'pointer' }}>
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  if (nodeCount === 0) {
    return (
      <div data-testid="causal-graph-board" className={className} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
        <p style={{ color: COLORS.textMuted }}>{t('causal.empty', 'No causal graph data available for this scenario.')}</p>
      </div>
    );
  }

  return (
    <div data-testid="causal-graph-board" className={className} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 320, position: 'relative' }}>
      {/* Search bar */}
      <div style={{ display: 'flex', gap: '0.5rem', padding: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="search"
          value={agentSearch}
          onChange={e => setAgentSearch(e.target.value)}
          placeholder={t('causal.search_agent', 'Search nodes or agents...')}
          aria-label={t('causal.search_agent', 'Search nodes or agents...')}
          style={{ minHeight: 32, padding: '4px 8px', borderRadius: 8, border: `1px solid ${COLORS.borderDefault}`, background: COLORS.surfaceField, color: COLORS.inputText, fontSize: '0.85rem', flex: '1 1 auto', minWidth: 120 }}
        />
        {agentSearch.trim() && (
          <button type="button" onClick={() => setAgentSearch('')} style={{ padding: '4px 8px', borderRadius: 8, border: `1px solid ${COLORS.borderDefault}`, background: 'transparent', color: COLORS.textMuted, cursor: 'pointer', fontSize: '0.8rem' }}>
            {t('common.clear', 'Clear')}
          </button>
        )}
        <span style={{ color: COLORS.textMuted, fontSize: '0.78rem' }}>
          {nodeCount} {t('causal.nodes', 'nodes')} · {edgeCount} {t('causal.edges', 'edges')}
        </span>
        {!hideExport && nodeCount > 0 && !isNonInteractiveFallback && (
          <ExportPanel containerSelector={`.causal-board-export[data-export-root="${exportRootId}"]`} filenamePrefix="causal-graph" />
        )}
      </div>

      {/* Graph */}
      {isNonInteractiveFallback ? (
        <div style={{ flex: 1, overflow: 'auto', padding: '0.5rem' }}>
          <p style={{ color: COLORS.textMuted, fontSize: '0.8rem', marginBottom: '0.5rem' }}>
            {isTextFallback
              ? t('causal.text_fallback', 'Graph too large for interactive view. Showing text list.')
              : t('causal.relationless_snapshot', 'No causal edges were generated for this scenario yet. Showing event snapshots instead.')}
          </p>
          <div data-testid="causal-events-list" role="list">
            {filteredData?.nodes.map(n => (
              <div key={n.id} role="listitem" style={{ fontSize: '0.8rem', color: COLORS.textBody, padding: '2px 0' }}>
                <button type="button" onClick={e => openNodeDetail(n.id, e.currentTarget)} style={{ width: '100%', textAlign: 'left', border: `1px solid ${COLORS.borderSubtle}`, borderRadius: 6, background: COLORS.surfacePanel, color: COLORS.textStrong, padding: '0.5rem 0.6rem', cursor: 'pointer' }}>
                  {`${t('causal.round_label', 'Round')} ${n.round ?? '?'} · ${getCausalTypeLabel(n.type, t)}: ${n.label}`}
                </button>
              </div>
            ))}
          </div>
          <NodeDetailPanel panelId="causal-board-detail" key={selectedNode?.id ?? 'closed'} node={selectedNode} onClose={() => setSelectedNode(null)} restoreFocusTarget={detailRestoreFocusTarget} />
        </div>
      ) : (
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <div
            className="causal-board-export"
            data-testid="causal-board-export-target"
            data-export-root={exportRootId}
            data-zoom-level={currentZoom < 0.3 ? 'far' : currentZoom < 0.6 ? 'mid' : 'near'}
            style={{ position: 'absolute', inset: 0 }}
          >
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={handleNodeClick}
              onPaneClick={onPaneClick}
              onViewportChange={onViewportChange}
              minZoom={0.02}
              maxZoom={4}
              onInit={instance => { reactFlowRef.current = instance; }}
              fitView
              fitViewOptions={viewportFitOptions}
              onlyRenderVisibleElements={shouldCullInvisibleElements}
              deleteKeyCode={null}
              selectionKeyCode={null}
              panActivationKeyCode={null}
              zoomActivationKeyCode={null}
              panOnDrag={[0, 1]}
              zoomOnScroll
              zoomOnPinch
              zoomOnDoubleClick={!isCompactViewport}
              nodesDraggable
              nodesFocusable={false}
              edgesFocusable={false}
              elementsSelectable
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
              <Controls className="graph-export-chrome" />
              {!isCompactViewport && (
                <MiniMap className="graph-export-chrome" nodeColor={n => (n.data?.bgColor as string) || COLORS.decorativeNodeFallback} nodeStrokeWidth={3} style={{ background: COLORS.surfaceField, pointerEvents: 'none' }} />
              )}
            </ReactFlow>
          </div>
          <NodeDetailPanel panelId="causal-board-detail" key={selectedNode?.id ?? 'closed'} node={selectedNode} onClose={() => setSelectedNode(null)} restoreFocusTarget={detailRestoreFocusTarget} />
        </div>
      )}

      {/* sr-only a11y */}
      {!isNonInteractiveFallback && (
        <div className="sr-only" role="list" aria-label={t('causal.a11y_relations', 'Causal relations list')}>
          {relationLines.map((line, i) => <div key={`${line}-${i}`} role="listitem">{line}</div>)}
        </div>
      )}

      {sheetState.open && (
        <NodeConversationSheet
          key={`${sheetState.scenarioId}:${sheetState.origin.nodeId}`}
          open={sheetState.open}
          onOpenChange={(next) => setSheetState(prev => ({ ...prev, open: next }))}
          onClose={() => setSheetState(prev => ({ ...prev, open: false }))}
          scenarioId={sheetState.scenarioId}
          identityId={sheetState.identityId}
          origin={sheetState.origin}
        />
      )}
    </div>
  );
}
