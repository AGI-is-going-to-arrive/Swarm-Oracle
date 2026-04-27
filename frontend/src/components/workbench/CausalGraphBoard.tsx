import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportPanel } from '../ExportPanel';
import { NodeDetailPanel, type NodeDetail } from '../NodeDetailPanel';
import GraphNodeCard from '../GraphNodeCard';
import { useScenarioGraph, type GraphErrorState } from '../../hooks/useScenarioGraph';
import { traceConnectedPath, buildParallelEdgeIndex, PERF_ANIMATION_LIMIT } from '../../lib/graphTraversal';
import { resolveCausalNodeColors } from '../../lib/dagEditorialTokens';
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

export interface CausalGraphBoardProps {
  scenarioId: string;
  branchId?: string;
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
const LARGE_GRAPH_NODE_W = 280;
const LARGE_GRAPH_NODE_H = 58;
const PERF_TOOLTIP_LIMIT = 150;
const PERF_TEXT_FALLBACK_LIMIT = 500;
const NO_ARROW_TYPES = new Set(['temporal']);
const GRAPH_COMPACT_MEDIA_QUERY = '(max-width: 768px)';

// ── Helpers ─────────────────────────────────────────────────

function getCausalTypeLabel(type: string, t: (k: string, f: string) => string): string {
  const pair = GRAPH_TYPE_LABEL_I18N[type];
  return pair ? t(pair[0], pair[1]) : type;
}

function getEvidenceTierLabel(tier: 'low' | 'medium' | 'high', t: (k: string, f: string) => string): string {
  return t(`causal.evidence_${tier}`, tier);
}

function getCausalEdgeRelationLabel(edge: GraphEdgeData, t: (k: string, f: string) => string): string {
  let base: string;
  if (edge.label?.trim()) base = edge.label.trim();
  else if (edge.type === 'temporal') base = t('causal.edge_temporal', 'precedes');
  else if (edge.type === 'responds_to') base = t('causal.edge_responds_to', 'responds to');
  else if (edge.type === 'supports_stance') base = t('causal.edge_supports_stance', 'aligns with');
  else if (edge.type === 'opposes_stance') base = t('causal.edge_opposes_stance', 'opposes');
  else base = t('causal.edge_caused', 'causes');
  const roundNum = edge.evidence?.source_round_number;
  if (roundNum != null) return `${base} (R${roundNum})`;
  return base;
}

function getCausalErrorMessage(error: CausalGraphErrorState, t: (k: string, f: string) => string): string {
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
  t: (k: string, f: string) => string,
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
    const label = fullLabel.length > 50 ? fullLabel.slice(0, 50) + '…' : fullLabel;
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
    const baseLabel = getCausalEdgeRelationLabel(e, t);
    const labelParts: string[] = [];
    if (baseLabel) labelParts.push(baseLabel);
    if (roundNum != null && !baseLabel.includes(`R${roundNum}`)) labelParts.push(`R${roundNum}`);
    if (tier) labelParts.push(`[${getEvidenceTierLabel(tier, t)}]`);
    const edgeLabel = labelParts.length > 0 ? labelParts.join(' ') : undefined;
    const offset = parallelOffsets.get(e.id) ?? 0;
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
      data: { parallelOffset: offset, reducedMotion },
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
  const [agentSearch, setAgentSearch] = useState('');

  const exportRootId = `causal-board-${useId().replace(/:/g, '-')}`;
  const reactFlowRef = useRef<{ fitView?: (opts?: { padding?: number; duration?: number }) => void } | null>(null);
  const pendingFitSignatureRef = useRef<string | null>(null);
  const detailRestoreFocusRef = useRef<HTMLElement | null>(null);

  const translate = useCallback((key: string, fallback: string) => t(key, fallback), [t]);

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
    return layoutDagre(filteredData.nodes, filteredData.edges, translate, isCompactViewport, reducedMotion);
  }, [filteredData, isCompactViewport, isNonInteractiveFallback, translate, reducedMotion]);

  const layoutSignature = useMemo(() => (
    `${layoutResult.nodes.map(n => `${n.id}:${n.position.x}:${n.position.y}`).join('|')}::${layoutResult.edges.map(e => `${e.id}:${e.source}:${e.target}`).join('|')}`
  ), [layoutResult]);

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(layoutResult.nodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(layoutResult.edges);
  const flowSignature = useMemo(() => (
    `${flowNodes.map(n => `${n.id}:${n.position.x}:${n.position.y}`).join('|')}::${flowEdges.map(e => `${e.id}:${e.source}:${e.target}`).join('|')}`
  ), [flowNodes, flowEdges]);

  useEffect(() => {
    pendingFitSignatureRef.current = layoutSignature;
    setFlowNodes(layoutResult.nodes);
    setFlowEdges(layoutResult.edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSignature, setFlowNodes, setFlowEdges]);

  useEffect(() => {
    if (!selectedNode || !filteredData) return;
    if (!filteredData.nodes.some(n => n.id === selectedNode.id)) setSelectedNode(null);
  }, [selectedNode, filteredData]);

  const highlightedPath = useMemo(() => {
    if (!selectedNode || layoutResult.edges.length === 0) return null;
    return traceConnectedPath(selectedNode.id, layoutResult.edges);
  }, [selectedNode, layoutResult.edges]);

  useEffect(() => {
    setFlowNodes(prev => prev.map(n => ({
      ...n,
      data: {
        ...n.data,
        selected: selectedNode?.id === n.id,
        connected: Boolean(highlightedPath && selectedNode?.id !== n.id && highlightedPath.has(n.id)),
        expanded: selectedNode?.id === n.id,
        dimmed: highlightedPath ? !highlightedPath.has(n.id) : false,
      },
    })));
  }, [highlightedPath, selectedNode?.id, setFlowNodes]);

  useEffect(() => {
    setFlowEdges(prev => {
      if (!highlightedPath) return prev.map(e => ({ ...e, selected: false, style: { ...e.style, opacity: 1 } }));
      return prev.map(e => {
        const onPath = highlightedPath.has(e.source) && highlightedPath.has(e.target);
        return {
          ...e,
          selected: onPath,
          style: { ...e.style, opacity: onPath ? 1 : 0.15 },
        };
      });
    });
  }, [highlightedPath, setFlowEdges]);

  const viewportFitOptions = useMemo(() => ({
    padding: isCompactViewport ? 0.2 : 0.24,
    duration: 0,
  }), [isCompactViewport]);

  useEffect(() => {
    if (!pendingFitSignatureRef.current || pendingFitSignatureRef.current !== flowSignature) return;
    if (flowNodes.length === 0 || flowNodes.length > PERF_TEXT_FALLBACK_LIMIT) {
      pendingFitSignatureRef.current = null;
      return;
    }
    if (!reactFlowRef.current) return;
    pendingFitSignatureRef.current = null;
    reactFlowRef.current.fitView?.(viewportFitOptions);
  }, [flowNodes, flowEdges, flowSignature, viewportFitOptions]);

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
    detailRestoreFocusRef.current = triggerElement?.isConnected ? triggerElement : null;
    setSelectedNode({ id: raw.id, label: raw.label || raw.key, type: raw.type, round: raw.round, payload: raw.payload });
    externalOnNodeClick?.(raw);
  }, [rawNodeMap, externalOnNodeClick]);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    const trigger = _event.target instanceof Element
      ? _event.target.closest<HTMLElement>('[data-graph-node-card="true"]')
      : null;
    openNodeDetail(node.id, trigger ?? (_event.currentTarget instanceof HTMLElement ? _event.currentTarget : null));
  }, [openNodeDetail]);

  const onPaneClick = useCallback(() => setSelectedNode(null), []);

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
          <NodeDetailPanel panelId="causal-board-detail" key={selectedNode?.id ?? 'closed'} node={selectedNode} onClose={() => setSelectedNode(null)} restoreFocusTarget={detailRestoreFocusRef.current} />
        </div>
      ) : (
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <div className="causal-board-export" data-testid="causal-board-export-target" data-export-root={exportRootId} style={{ position: 'absolute', inset: 0 }}>
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeClick={handleNodeClick}
              onPaneClick={onPaneClick}
              onInit={instance => { reactFlowRef.current = instance; }}
              fitView
              fitViewOptions={viewportFitOptions}
              deleteKeyCode={null}
              selectionKeyCode={null}
              panActivationKeyCode={null}
              zoomActivationKeyCode={null}
              panOnDrag={[0, 1]}
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
          <NodeDetailPanel panelId="causal-board-detail" key={selectedNode?.id ?? 'closed'} node={selectedNode} onClose={() => setSelectedNode(null)} restoreFocusTarget={detailRestoreFocusRef.current} />
        </div>
      )}

      {/* sr-only a11y */}
      {!isNonInteractiveFallback && (
        <div className="sr-only" role="list" aria-label={t('causal.a11y_relations', 'Causal relations list')}>
          {relationLines.map((line, i) => <div key={`${line}-${i}`} role="listitem">{line}</div>)}
        </div>
      )}
    </div>
  );
}
