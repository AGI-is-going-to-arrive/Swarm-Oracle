/* ═══════════════════════════════════════════════════════════
   Phase 3 F2 — Causal Review View
   Displays a DAG of causal events extracted from a simulation.
   Uses @xyflow/react (already a dependency) with dagre layout.
   Phase C: icons, OKLCH cards, edge styling, neighbor highlight,
            tooltips, agent search.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { buildSessionHeaders } from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { ExportPanel } from '../components/ExportPanel';
import { NodeDetailPanel, type NodeDetail } from '../components/NodeDetailPanel';
import GraphNodeCard from '../components/GraphNodeCard';
import dagre from 'dagre';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useSearchParams } from 'react-router-dom';
import { NODE_TYPE_COLORS_HEX, EDGE_STYLES, NODE_ICONS } from '../lib/graphTokens';

// ── Custom node type (stable reference) ────────────────────

const nodeTypes = { graphCard: GraphNodeCard };

// ── Types ───────────────────────────────────────────────────

interface GraphNodeData {
  id: string;
  key: string;
  type: string;
  label: string;
  round: number | null;
  payload: unknown;
}

interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number | null;
  label: string | null;
}

interface CausalGraphData {
  id: string;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  available_branches?: string[];
}

// ── Constants ───────────────────────────────────────────────

const NODE_W = 200;
const NODE_H = 50;
const PERF_ANIMATION_LIMIT = 150;
const PERF_TOOLTIP_LIMIT = 150;
const PERF_TEXT_FALLBACK_LIMIT = 500;
const NO_ARROW_TYPES = new Set(['temporal']);

function extractAvailableBranches(data: Pick<CausalGraphData, 'nodes' | 'available_branches'>): string[] {
  const explicit = Array.isArray(data.available_branches)
    ? data.available_branches.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  if (explicit.length > 0) return [...new Set(explicit)].sort();

  const branchSet = new Set<string>();
  for (const node of data.nodes ?? []) {
    const payload = (typeof node.payload === 'object' && node.payload && !Array.isArray(node.payload))
      ? node.payload as Record<string, unknown>
      : {};
    const branch = payload.branch_id;
    if (typeof branch === 'string' && branch) branchSet.add(branch);
    const children = payload.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === 'string' && child) branchSet.add(child);
      }
    }
  }
  return [...branchSet].sort();
}

// ── Layout ──────────────────────────────────────────────────

function layoutDagre(nodes: GraphNodeData[], edges: GraphEdgeData[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 40 });

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const disableAnim = nodes.length > PERF_ANIMATION_LIMIT;
  const tooltipDisabled = nodes.length > PERF_TOOLTIP_LIMIT;

  const flowNodes: Node[] = nodes.map(n => {
    const pos = g.node(n.id);
    const fullLabel = n.label || n.key;
    const label = fullLabel.length > 50 ? fullLabel.slice(0, 50) + '\u2026' : fullLabel;
    return {
      id: n.id,
      type: 'graphCard',
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: {
        label,
        fullLabel,
        iconName: NODE_ICONS[n.type] ?? '',
        bgColor: NODE_TYPE_COLORS_HEX[n.type] ?? '#555',
        borderColor: '',
        dimmed: false,
        tooltipDisabled,
        sourcePos: 'right',
        targetPos: 'left',
      },
    };
  });

  // C2: Edge styling from EDGE_STYLES
  const flowEdges: Edge[] = edges.map(e => {
    const style = EDGE_STYLES[e.type];
    const stroke = style?.stroke ?? '#888';
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label ?? undefined,
      animated: !disableAnim && (style?.animated ?? false),
      style: { stroke, strokeDasharray: style?.strokeDasharray },
      markerEnd: NO_ARROW_TYPES.has(e.type) ? undefined : { type: MarkerType.ArrowClosed, color: stroke },
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}

// ── Component ───────────────────────────────────────────────

export function CausalReviewView() {
  const { t } = useTranslation();
  const { loading: capLoading, enabled } = useCapabilityCheck('causal_graph');
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const branchId = searchParams.get('branch_id') ?? undefined;
  const [graphData, setGraphData] = useState<CausalGraphData | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeDetail | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  // C5: Agent search
  const [agentSearch, setAgentSearch] = useState('');
  const reactFlowRef = useRef<{ fitView?: () => void } | null>(null);
  const pendingFitSignatureRef = useRef<string | null>(null);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setSelectedNode(null);
    setError(null);
    try {
      const url = branchId
        ? `/api/scenario/${id}/causal-graph?branch_id=${encodeURIComponent(branchId)}`
        : `/api/scenario/${id}/causal-graph`;
      const res = await fetch(url, { headers: buildSessionHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setGraphData(data);
      setError(null);
      setBranches(extractAvailableBranches(data));
    } catch (err) { setError((err as Error).message); }
    setLoading(false);
  }, [id, branchId]);

  useEffect(() => {
    if (!id || !enabled) return;
    fetchGraph();
  }, [id, fetchGraph, enabled]);

  // C5: Filtered data based on agent search
  const filteredData = useMemo(() => {
    if (!graphData || !agentSearch.trim()) return graphData;
    const search = agentSearch.toLowerCase();
    const matchingNodes = graphData.nodes.filter(n => {
      const p = (typeof n.payload === 'object' && n.payload ? n.payload : {}) as Record<string, unknown>;
      const agentId = String(p.agent_id ?? '').toLowerCase();
      const agentName = String(p.agent_name ?? '').toLowerCase();
      const label = n.label.toLowerCase();
      return agentId.includes(search) || agentName.includes(search) || label.includes(search);
    });
    const nodeIds = new Set(matchingNodes.map(n => n.id));
    const matchingEdges = graphData.edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
    return { ...graphData, nodes: matchingNodes, edges: matchingEdges };
  }, [graphData, agentSearch]);

  const nodeCount = filteredData?.nodes.length ?? 0;
  const edgeCount = filteredData?.edges.length ?? 0;
  const isTextFallback = nodeCount > PERF_TEXT_FALLBACK_LIMIT;

  const layoutResult = useMemo(() => {
    if (!filteredData || filteredData.nodes.length === 0 || isTextFallback) return { nodes: [], edges: [] };
    return layoutDagre(filteredData.nodes, filteredData.edges);
  }, [filteredData, isTextFallback]);

  const layoutSignature = useMemo(() => (
    `${layoutResult.nodes.map(n => `${n.id}:${n.position.x}:${n.position.y}`).join('|')}::${layoutResult.edges.map(e => `${e.id}:${e.source}:${e.target}`).join('|')}`
  ), [layoutResult]);

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(layoutResult.nodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(layoutResult.edges);
  const flowSignature = useMemo(() => (
    `${flowNodes.map(n => `${n.id}:${n.position.x}:${n.position.y}`).join('|')}::${flowEdges.map(e => `${e.id}:${e.source}:${e.target}`).join('|')}`
  ), [flowNodes, flowEdges]);

  // Sync layout result into state when data/filter changes
  useEffect(() => {
    pendingFitSignatureRef.current = layoutSignature;
    setFlowNodes(layoutResult.nodes);
    setFlowEdges(layoutResult.edges);
  }, [layoutResult, layoutSignature, setFlowNodes, setFlowEdges]);

  // Clear stale selection when filtered node disappears
  useEffect(() => {
    if (!selectedNode || !filteredData) return;
    if (!filteredData.nodes.some(n => n.id === selectedNode.id)) setSelectedNode(null);
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

  // Apply highlight to flow nodes
  useEffect(() => {
    setFlowNodes(prev => prev.map(n => ({
      ...n,
      data: {
        ...n.data,
        dimmed: neighborSet ? !neighborSet.has(n.id) : false,
      },
    })));
  }, [neighborSet, setFlowNodes]);

  // Apply highlight to flow edges
  useEffect(() => {
    setFlowEdges(prev => {
      if (!neighborSet) return prev.map(e => ({ ...e, style: { ...e.style, opacity: 1 } }));
      return prev.map(e => ({
        ...e,
        style: {
          ...e.style,
          opacity: (neighborSet.has(e.source) && neighborSet.has(e.target)) ? 1 : 0.1,
        },
      }));
    });
  }, [neighborSet, setFlowEdges]);

  const nodes = flowNodes;
  const edges = flowEdges;

  useEffect(() => {
    if (!pendingFitSignatureRef.current || pendingFitSignatureRef.current !== flowSignature) return;
    if (flowNodes.length === 0 || flowNodes.length > PERF_TEXT_FALLBACK_LIMIT) {
      pendingFitSignatureRef.current = null;
      return;
    }
    if (!reactFlowRef.current) return;
    pendingFitSignatureRef.current = null;
    reactFlowRef.current.fitView?.();
  }, [flowNodes, flowEdges, flowSignature]);

  const rawNodeMap = useMemo(() => {
    const m = new Map<string, GraphNodeData>();
    if (filteredData) for (const n of filteredData.nodes) m.set(n.id, n);
    return m;
  }, [filteredData]);

  const availableBranches = useMemo(() => {
    if (!branchId) return branches;
    return branches.includes(branchId) ? branches : [branchId, ...branches];
  }, [branchId, branches]);

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    const raw = rawNodeMap.get(node.id);
    if (!raw) return;
    setSelectedNode({
      id: raw.id,
      label: raw.label || raw.key,
      type: raw.type,
      round: raw.round,
      payload: raw.payload,
    });
  }, [rawNodeMap]);

  // C3: Background click resets highlight + closes detail panel
  const onPaneClick = useCallback(() => setSelectedNode(null), []);

  if (capLoading) return <div style={{ padding: '3rem', textAlign: 'center' }}>{t('common.loading', 'Loading...')}</div>;
  if (!enabled) return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '3rem', textAlign: 'center' }}>
      <p style={{ color: '#888' }}>{t('causal.feature_disabled', 'Causal graph feature is not enabled.')}</p>
      <Link to={id ? `/result/${id}` : '/'} style={{ color: '#8ab4f8' }}>{t('common.back_to_result', 'Back to Result')}</Link>
    </div>
  );

  if (loading) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1rem', textAlign: 'center' }}>
        <p>{t('common.loading', 'Loading...')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1rem', textAlign: 'center' }}>
        <h1>{t('causal.title', 'Causal Graph')}</h1>
        <p role="alert" style={{ color: '#e74c3c' }}>{error}</p>
        <button
          onClick={() => void fetchGraph()}
          style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #555', background: 'transparent', color: '#8ab4f8', cursor: 'pointer', marginRight: '0.75rem' }}
        >
          {t('common.retry', 'Retry')}
        </button>
        <Link to={`/result/${id}`} style={{ color: '#8ab4f8' }}>
          {t('common.back_to_result', 'Back to Result')}
        </Link>
      </div>
    );
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', borderBottom: '1px solid #333', flexWrap: 'wrap' }}>
          <Link to={`/result/${id}`} style={{ color: '#8ab4f8', textDecoration: 'none' }}>
            &larr; {t('common.back_to_result', 'Back to Result')}
          </Link>
          <h1 style={{ margin: 0, fontSize: '1.2rem' }}>{t('causal.title', 'Causal Graph')}</h1>
          <span style={{ color: '#888', fontSize: '0.85rem' }}>
            {nodeCount} {t('causal.nodes', 'nodes')} &middot; {edgeCount} {t('causal.edges', 'edges')}
          </span>
          {/* B6: Branch selector */}
          {(availableBranches.length > 1 || Boolean(branchId)) && (
            <select
              value={branchId ?? ''}
              onChange={e => {
                const val = e.target.value;
                if (val) setSearchParams({ branch_id: val });
                else setSearchParams({});
              }}
              style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #555', background: '#1a1a2e', color: '#fff', fontSize: '0.8rem' }}
              aria-label={t('causal.branch_select', 'Select branch')}
            >
              <option value="">{t('causal.all_branches', 'All branches')}</option>
              {availableBranches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          {/* C5: Agent search */}
          <input
            type="search"
            value={agentSearch}
            onChange={e => setAgentSearch(e.target.value)}
            placeholder={t('causal.search_agent', 'Search agent...')}
            aria-label={t('causal.search_agent', 'Search agent...')}
            style={{
              padding: '4px 8px', borderRadius: 4, border: '1px solid #555',
              background: '#1a1a2e', color: '#fff', fontSize: '0.8rem', width: 150,
            }}
          />
          {nodeCount > 0 && (
            <ExportPanel containerSelector=".causal-graph-container" filenamePrefix="causal-graph" />
          )}
          {/* B6: Legend toggle */}
          <button
            onClick={() => setLegendOpen(v => !v)}
            style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #555', background: 'transparent', color: '#8ab4f8', cursor: 'pointer', fontSize: '0.75rem' }}
          >
            {legendOpen ? t('causal.hide_legend', 'Hide Legend') : t('causal.show_legend', 'Legend')}
          </button>
        </div>
        {/* B6: Collapsible Legend */}
        {legendOpen && (
          <div style={{ padding: '0.5rem 1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.7rem', color: '#888', borderBottom: '1px solid #333' }}>
            {Object.entries(NODE_TYPE_COLORS_HEX).filter(([k]) => ['event', 'intervention', 'stance_shift', 'fork', 'verdict'].includes(k)).map(([type, color]) => (
              <span key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
                {t(`causal.type_${type}`, type.replace('_', ' '))}
              </span>
            ))}
          </div>
        )}

        {nodeCount === 0 && !agentSearch ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <p style={{ color: '#888' }}>{t('causal.empty', 'No causal graph data available for this scenario.')}</p>
          </div>
        ) : nodeCount === 0 && agentSearch ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <p style={{ color: '#888' }}>{t('causal.no_results', 'No nodes match your search.')}</p>
          </div>
        ) : isTextFallback ? (
          <div style={{ flex: 1, overflow: 'auto', padding: '1rem' }} className="causal-graph-container">
            <p style={{ color: '#888', marginBottom: '0.5rem' }}>{t('causal.text_fallback', 'Graph too large for interactive view. Showing text list.')}</p>
            <div role="list">
              {filteredData?.nodes.map(n => (
                <div key={n.id} role="listitem" style={{ fontSize: '0.8rem', color: '#ccc', padding: '2px 0' }}>
                  [{n.type}] {n.label} (R{n.round ?? '?'})
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, position: 'relative' }} className="causal-graph-container">
            <ReactFlow
              nodes={nodes}
              edges={edges}
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
              <Controls />
              <MiniMap nodeColor={(n) => (n.data?.bgColor as string) || '#555'} nodeStrokeWidth={3} style={{ background: '#1a1a2e' }} />
            </ReactFlow>
            <NodeDetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} />
          </div>
        )}

        {/* a11y: screen reader fallback list */}
        <div className="sr-only" role="list" aria-label={t('causal.a11y_list', 'Causal events list')}>
          {(filteredData?.nodes ?? graphData?.nodes ?? []).map(n => (
            <div key={n.id} role="listitem">
              {n.type}: {n.label} ({t('causal.round_label', 'Round')} {n.round ?? '?'})
            </div>
          ))}
        </div>
      </div>
    </Tooltip.Provider>
  );
}

export default CausalReviewView;
