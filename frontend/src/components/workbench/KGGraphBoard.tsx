import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Maximize2, Minus, Plus, RotateCcw, Search } from 'lucide-react';
import { useG6Graph } from '../../hooks/useG6Graph';
import useReducedMotion from '../../hooks/useReducedMotion';
import { useScenarioGraph } from '../../hooks/useScenarioGraph';
import { NODE_TYPE_COLORS_HEX } from '../../lib/graphTokens';
import {
  KG_DEGRADE_THRESHOLDS,
  buildKgG6Options,
  computeNodeSize,
  getKGNodeStyle,
  toKgG6Data,
} from '../../lib/kgGraphConfig';
import { NodeDetailPanel, type NodeDetail } from '../NodeDetailPanel';
import NodeQuickCard from './NodeQuickCard';

export interface KGGraphBoardProps {
  scenarioId: string;
  branchId?: string;
  onNodeClick?: (node: unknown) => void;
  className?: string;
  themeOverride?: 'light' | 'dark';
}

// ── Theme hook ──────────────────────────────────────────────

function useAutoTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document === 'undefined') return 'light';
    const root = document.documentElement;
    if (root.dataset?.theme === 'dark' || root.classList.contains('dark')) return 'dark';
    return 'light';
  });
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      if (root.dataset?.theme === 'dark' || root.classList.contains('dark')) setTheme('dark');
      else setTheme('light');
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function useViewportIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth < 768;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mqPointer = window.matchMedia('(pointer: coarse)');
    const mqWidth = window.matchMedia('(max-width: 767px)');
    const handle = () => setMobile(mqPointer.matches || mqWidth.matches);
    mqPointer.addEventListener?.('change', handle);
    mqWidth.addEventListener?.('change', handle);
    return () => {
      mqPointer.removeEventListener?.('change', handle);
      mqWidth.removeEventListener?.('change', handle);
    };
  }, []);
  return mobile;
}

// ── Component ───────────────────────────────────────────────

export default function KGGraphBoard({
  scenarioId,
  branchId,
  onNodeClick,
  className,
  themeOverride,
}: KGGraphBoardProps) {
  const { t } = useTranslation();
  const autoTheme = useAutoTheme();
  const theme = themeOverride ?? autoTheme;
  const isMobile = useViewportIsMobile();
  const reducedMotion = useReducedMotion();

  const {
    data: graphData,
    loading,
    error: graphError,
    refetch: loadGraph,
  } = useScenarioGraph(scenarioId || null);

  const errorMessage = graphError
    ? t('kg_explorer.error_fetch', 'Unable to load the knowledge graph right now. Please retry.')
    : null;

  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track canvas size reactively via ResizeObserver so NodeQuickCard
  // clamping doesn't read containerRef.current during render
  // (react-hooks/refs lint).
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({
    width: 1024,
    height: 768,
  });

  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [edgeLabelOverride, setEdgeLabelOverride] = useState<boolean | null>(null);
  const [quickCardState, setQuickCardState] = useState<{
    key: string;
    node: { id: string; label: string; type: string; round: number | null };
    position: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setCanvasSize({ width: w, height: h });
    };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resetKey = `${scenarioId}:${branchId ?? ''}`;
  const [selectionState, setSelectionState] = useState<{
    key: string;
    selectedNode: NodeDetail | null;
    highlightedNodeId: string | null;
    lockedNodeId: string | null;
  }>({ key: resetKey, selectedNode: null, highlightedNodeId: null, lockedNodeId: null });

  const effectiveSelection = selectionState.key === resetKey
    ? selectionState
    : { key: resetKey, selectedNode: null, highlightedNodeId: null, lockedNodeId: null };

  const selectedNode = effectiveSelection.selectedNode;
  const highlightedNodeId = effectiveSelection.highlightedNodeId;
  const lockedNodeId = effectiveSelection.lockedNodeId;

  const setSelectedNode = useCallback((node: NodeDetail | null) => {
    setSelectionState((prev) => ({ ...prev, key: resetKey, selectedNode: node }));
  }, [resetKey]);
  const setHighlightedNodeId = useCallback((id: string | null) => {
    setSelectionState((prev) => ({ ...prev, key: resetKey, highlightedNodeId: id }));
  }, [resetKey]);
  const setLockedNodeId = useCallback((updater: string | null | ((prev: string | null) => string | null)) => {
    setSelectionState((prev) => {
      const next = typeof updater === 'function' ? updater(prev.lockedNodeId) : updater;
      return { ...prev, key: resetKey, lockedNodeId: next };
    });
  }, [resetKey]);

  const g6GraphData = useMemo(() => {
    if (!graphData) return { nodes: [], edges: [], truncatedFromCount: null as number | null };
    return toKgG6Data(graphData, {
      searchTerm,
      typeFilter: Array.from(typeFilter),
      isMobile,
      theme,
      t: (key: string, fallback: string) => t(key, fallback ?? '') as string,
    });
  }, [graphData, searchTerm, typeFilter, isMobile, theme, t]);

  const graphNodeById = useMemo(
    () => new Map((graphData?.nodes ?? []).map((n) => [n.id, n])),
    [graphData],
  );

  const adjacencyMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of g6GraphData.edges) {
      if (!map.has(edge.source)) map.set(edge.source, new Set());
      if (!map.has(edge.target)) map.set(edge.target, new Set());
      map.get(edge.source)!.add(edge.target);
      map.get(edge.target)!.add(edge.source);
    }
    return map;
  }, [g6GraphData.edges]);

  const degreeMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of g6GraphData.nodes) {
      map.set(node.id, (adjacencyMap.get(node.id)?.size ?? 0) + 1);
    }
    return map;
  }, [g6GraphData.nodes, adjacencyMap]);

  const defaultShowEdgeLabels = g6GraphData.edges.length <= 50;
  const showEdgeLabels = edgeLabelOverride ?? defaultShowEdgeLabels;
  const effectiveShowLabels = showEdgeLabels && g6GraphData.edges.length <= KG_DEGRADE_THRESHOLDS.edgeLabelLimit;
  const effectiveQuickCardState = quickCardState?.key === resetKey ? quickCardState : null;

  const hasFocusedGraphIntent =
    searchTerm.trim().length > 0 ||
    typeFilter.size > 0 ||
    lockedNodeId !== null ||
    highlightedNodeId !== null;
  const showAllNodeLabels =
    g6GraphData.nodes.length <= KG_DEGRADE_THRESHOLDS.nodeLabelLimit ||
    hasFocusedGraphIntent;

  const styledG6Data = useMemo(() => {
    return {
      nodes: g6GraphData.nodes.map((n) => {
        const degree = degreeMap.get(n.id) ?? 1;
        const size = computeNodeSize(degree);
        const nodeStyle = getKGNodeStyle(n.data.kgType, theme);
        const showNodeLabel = showAllNodeLabels;
        return {
          ...n,
          style: {
            ...n.style,
            labelText: showNodeLabel ? n.style.labelText : undefined,
            size,
            fill: nodeStyle.fill,
            stroke: nodeStyle.stroke,
            lineWidth: nodeStyle.lineWidth,
            labelFill: nodeStyle.textColor,
            labelFontSize: 11,
          },
        };
      }),
      edges: g6GraphData.edges.map((e) => ({
        ...e,
        style: {
          ...e.style,
          ...(effectiveShowLabels ? {} : { labelText: undefined }),
        },
      })),
    };
  }, [g6GraphData, degreeMap, theme, effectiveShowLabels, showAllNodeLabels]);

  const shouldDisableAnimation =
    reducedMotion || g6GraphData.nodes.length > KG_DEGRADE_THRESHOLDS.animationLimit;

  const [minimapContainer, setMinimapContainer] = useState<HTMLDivElement | null>(null);

  const g6Options = useMemo(
    () =>
      buildKgG6Options({
        data: styledG6Data,
        theme,
        reducedMotion: shouldDisableAnimation,
        minimapContainer,
        enableHover: !isMobile,
      }),
    [styledG6Data, theme, shouldDisableAnimation, minimapContainer, isMobile],
  );

  const handleNodeClick = useCallback(
    (evt: unknown) => {
      const target = (evt as {
        target?: {
          id?: string;
          data?: { kgType?: unknown; kgRound?: unknown };
          get?: (key: string) => unknown;
        };
        viewport?: { x: number; y: number };
        canvas?: { x: number; y: number };
      } | undefined);
      const tgt = target?.target;
      const nodeId = String(tgt?.id ?? tgt?.get?.('id') ?? '');
      const graphNode = graphNodeById.get(nodeId);
      if (!graphNode) return;

      if (isMobile) {
        setLockedNodeId((prev) => (prev === nodeId ? null : nodeId));
      }

      const point = target?.viewport;
      if (point && !isMobile) {
        setSelectedNode(null);
        setQuickCardState({
          key: resetKey,
          node: { id: graphNode.id, label: graphNode.label, type: graphNode.type, round: graphNode.round },
          position: point,
        });
      } else {
        setQuickCardState(null);
        setSelectedNode({
          id: graphNode.id,
          label: graphNode.label,
          type: graphNode.type,
          round: graphNode.round,
          payload: graphNode.payload,
        });
      }

      onNodeClick?.(tgt);
    },
    [graphNodeById, onNodeClick, isMobile, setSelectedNode, setLockedNodeId, resetKey],
  );

  const handleOpenDetail = useCallback(() => {
    if (!effectiveQuickCardState) return;
    const fullNode = graphNodeById.get(effectiveQuickCardState.node.id);
    setQuickCardState(null);
    setSelectedNode({
      id: effectiveQuickCardState.node.id,
      label: effectiveQuickCardState.node.label,
      type: effectiveQuickCardState.node.type,
      round: effectiveQuickCardState.node.round,
      payload: fullNode?.payload ?? null,
    });
  }, [effectiveQuickCardState, graphNodeById, setSelectedNode]);

  const closeQuickCard = useCallback(() => setQuickCardState(null), []);

  const handleNodeHover = useCallback(
    (evt: unknown) => {
      if (isMobile) return;
      const target = (evt as { target?: { id?: string; get?: (k: string) => unknown } } | undefined)?.target;
      const nodeId = String(target?.id ?? target?.get?.('id') ?? '');
      if (nodeId) setHighlightedNodeId(nodeId);
    },
    [isMobile, setHighlightedNodeId],
  );

  const handleNodeLeave = useCallback(() => {
    if (isMobile) return;
    setHighlightedNodeId(null);
  }, [isMobile, setHighlightedNodeId]);

  const { graphRef } = useG6Graph({
    containerRef,
    options: g6Options as unknown as Parameters<typeof useG6Graph>[0]['options'],
    onNodeClick: handleNodeClick,
    onNodeHover: handleNodeHover,
    onNodeLeave: handleNodeLeave,
  });

  // ── G6 native state management (P6: replaces JS-level opacity dimming) ──
  const lockHighlight = useCallback((nodeId: string) => {
    const graph = graphRef.current;
    if (!graph) return;
    const data = graph.getData();
    const allIds = [
      ...(data.nodes ?? []).map((n) => String(n.id ?? '')),
      ...(data.edges ?? []).map((e) => String(e.id ?? '')),
    ].filter(Boolean);
    const neighborIds = new Set(
      graph.getNeighborNodesData(nodeId).map((n) => String(n.id ?? ''))
    );
    const edgeIds = new Set(
      graph.getRelatedEdgesData(nodeId, 'both').map((e) => String(e.id ?? ''))
    );
    const rec: Record<string, string[]> = {};
    for (const id of allIds) {
      rec[id] = id === nodeId
        ? ['selected']
        : neighborIds.has(id) || edgeIds.has(id)
          ? ['active']
          : ['inactive'];
    }
    graph.setElementState(rec, !shouldDisableAnimation);
  }, [graphRef, shouldDisableAnimation]);

  const clearHighlight = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const data = graph.getData();
    const allIds = [
      ...(data.nodes ?? []).map((n) => String(n.id ?? '')),
      ...(data.edges ?? []).map((e) => String(e.id ?? '')),
    ].filter(Boolean);
    const rec: Record<string, string[]> = {};
    for (const id of allIds) rec[id] = [];
    graph.setElementState(rec, !shouldDisableAnimation);
  }, [graphRef, shouldDisableAnimation]);

  useEffect(() => {
    if (lockedNodeId) {
      lockHighlight(lockedNodeId);
    } else {
      clearHighlight();
    }
  }, [lockedNodeId, lockHighlight, clearHighlight]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const handler = (evt: unknown) => {
      const tgt = (evt as { target?: { id?: string } } | undefined)?.target;
      const nodeId = String(tgt?.id ?? '');
      if (!nodeId) return;
      try {
        const focusEl = (graph as unknown as { focusElement?: (id: string) => void }).focusElement;
        if (typeof focusEl === 'function') focusEl.call(graph, nodeId);
        else graph.fitView();
      } catch { /* noop */ }
    };
    try { (graph as unknown as { on: (event: string, h: (e: unknown) => void) => void }).on('node:dblclick', handler); }
    catch { /* graph not ready */ }
    return () => {
      try { (graph as unknown as { off?: (event: string, h: (e: unknown) => void) => void }).off?.('node:dblclick', handler); }
      catch { /* noop */ }
    };
  }, [graphRef, g6GraphData.nodes.length]);

  const handleZoomIn = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    try { graph.zoomTo(1.3, undefined, undefined); } catch { /* noop */ }
  }, [graphRef]);

  const handleZoomOut = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    try { graph.zoomTo(0.7, undefined, undefined); } catch { /* noop */ }
  }, [graphRef]);

  const handleFitView = useCallback(() => {
    const graph = graphRef.current;
    if (!graph) return;
    try { graph.fitView(); } catch { /* noop */ }
  }, [graphRef]);

  const availableTypes = useMemo(
    () => Array.from(new Set(graphData?.nodes.map((n) => n.type) ?? [])).sort(),
    [graphData],
  );

  const wrapperClassName = ['kg-board', className].filter(Boolean).join(' ');

  if (loading) {
    return (
      <div
        data-testid="kg-graph-board"
        className={wrapperClassName}
        style={{ display: 'flex', flexDirection: 'column', minHeight: 320 }}
      >
        <div
          data-testid="kg-graph-board-skeleton"
          className="kg-loading-skeleton"
          role="status"
          aria-live="polite"
        >
          <span
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: 'hidden',
              clip: 'rect(0, 0, 0, 0)',
              whiteSpace: 'nowrap',
              borderWidth: 0,
            }}
          >
            {t('common.loading', 'Loading...')}
          </span>
        </div>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div
        data-testid="kg-graph-board"
        className={wrapperClassName}
        style={{ display: 'flex', flexDirection: 'column', minHeight: 320 }}
      >
        <div className="kg-status-stack">
          <p role="alert" className="kg-status-error">{errorMessage}</p>
          <button
            type="button"
            onClick={() => void loadGraph()}
            className="kg-icon-btn"
            aria-label={t('common.retry', 'Retry')}
            title={t('common.retry', 'Retry')}
            style={{ width: 'auto', padding: '4px 10px', gap: 6 }}
          >
            <RotateCcw aria-hidden="true" />
            <span style={{ fontSize: '0.78rem' }}>{t('common.retry', 'Retry')}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="kg-graph-board"
      className={wrapperClassName}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 320,
        position: 'relative',
        gap: 6,
      }}
    >
      {/* Toolbar */}
      <div
        className="kg-toolbar"
        role="toolbar"
        aria-label={t('kg_graph_board.toolbar_aria', 'Knowledge graph toolbar')}
      >
        <span className="kg-toolbar-title">
          {t('workbench.kg_panel', 'Knowledge Graph')}
        </span>

        {graphData && (
          <span
            className="kg-toolbar-count"
            data-testid="kg-graph-board-node-count"
            aria-label={t('kg_graph_board.nodes_count_label', '{{count}} nodes', {
              count: g6GraphData.nodes.length,
            })}
          >
            <strong>{g6GraphData.nodes.length}</strong>
            {' '}
            <span>{t('causal.nodes', 'nodes')}</span>
          </span>
        )}

        <span
          className="kg-toolbar-count"
          aria-hidden="true"
          style={{ marginLeft: 4, color: 'var(--text-muted)' }}
        >
          · {t('kg_graph_board.drag_hint', 'Drag any node to rearrange')}
        </span>

        {/* Search */}
        <label
          className="kg-toolbar-group"
          style={{ position: 'relative', marginLeft: 'auto' }}
        >
          <Search
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              width: 12,
              height: 12,
              color: 'var(--text-muted)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="search"
            data-testid="kg-graph-board-search"
            className="kg-search"
            placeholder={t('kg_graph_board.search_placeholder', 'Search nodes...')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            aria-label={t('kg_graph_board.search_aria', 'Search graph nodes')}
            style={{ paddingLeft: 26 }}
          />
        </label>

        {/* Edge labels toggle */}
        <button
          type="button"
          className="kg-icon-btn"
          onClick={() => setEdgeLabelOverride((v) => !(v ?? defaultShowEdgeLabels))}
          aria-pressed={showEdgeLabels}
          aria-label={t('kg_graph_board.toggle_edge_labels', 'Toggle edge labels')}
          title={effectiveShowLabels
            ? t('kg_graph_board.hide_labels', 'Hide edge labels')
            : t('kg_graph_board.show_labels', 'Show edge labels')}
          data-testid="kg-graph-board-edge-labels-toggle"
        >
          {effectiveShowLabels
            ? <Eye aria-hidden="true" />
            : <EyeOff aria-hidden="true" />}
        </button>

        {/* Zoom controls */}
        <div className="kg-toolbar-group">
          <button
            type="button"
            className="kg-icon-btn"
            onClick={handleZoomIn}
            aria-label={t('kg_graph_board.zoom_in', 'Zoom in')}
            title={t('kg_graph_board.zoom_in', 'Zoom in')}
          >
            <Plus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="kg-icon-btn"
            onClick={handleZoomOut}
            aria-label={t('kg_graph_board.zoom_out', 'Zoom out')}
            title={t('kg_graph_board.zoom_out', 'Zoom out')}
          >
            <Minus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="kg-icon-btn"
            onClick={handleFitView}
            aria-label={t('kg_graph_board.fit_view', 'Fit to view')}
            title={t('kg_graph_board.fit_view', 'Fit to view')}
          >
            <Maximize2 aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Type filter chips */}
      {availableTypes.length > 0 && (
        <div
          data-testid="kg-graph-board-filter-pills"
          className="kg-chip-row"
          role="group"
          aria-label={t('kg_graph_board.filter_aria', 'Filter by node type')}
        >
          {availableTypes.map((type) => {
            const active = typeFilter.has(type);
            const dotColor = NODE_TYPE_COLORS_HEX[type] ?? '#888';
            return (
              <button
                key={type}
                type="button"
                className="kg-chip"
                data-testid={`kg-graph-board-chip-${type}`}
                onClick={() =>
                  setTypeFilter((prev) => {
                    const next = new Set(prev);
                    if (next.has(type)) next.delete(type);
                    else next.add(type);
                    return next;
                  })
                }
                aria-pressed={active}
              >
                <span
                  className="kg-chip-dot"
                  aria-hidden="true"
                  style={{ background: dotColor }}
                />
                {type}
              </button>
            );
          })}
        </div>
      )}

      {/* Mobile truncation notice */}
      {g6GraphData.truncatedFromCount !== null && (
        <div
          data-testid="kg-graph-board-truncate-notice"
          className="kg-truncate-notice"
          role="status"
          aria-live="polite"
        >
          {t(
            'kg_graph_board.mobile_truncate_notice',
            'Showing first {{cap}} of {{total}} nodes. Refine search or filter to narrow results.',
            { cap: KG_DEGRADE_THRESHOLDS.mobileNodes, total: g6GraphData.truncatedFromCount },
          )}
        </div>
      )}

      {/* Canvas */}
      <div
        ref={containerRef}
        data-testid="kg-graph-board-canvas"
        tabIndex={0}
        role="application"
        aria-label={t('kg_explorer.g6_aria', 'Causal graph canvas')}
        aria-description={t('kg_graph_board.drag_hint', 'Drag any node to rearrange')}
        className="kg-canvas-shell kg-canvas-cursor"
      />

      {/* Minimap container */}
      <div
        ref={setMinimapContainer}
        data-testid="kg-graph-board-minimap"
        className="kg-minimap"
        aria-label={t('kg_graph_board.minimap_aria', 'Graph minimap')}
        role="img"
      />

      {/* NodeQuickCard */}
      {effectiveQuickCardState && (
        <NodeQuickCard
          node={effectiveQuickCardState.node}
          position={effectiveQuickCardState.position}
          viewportSize={canvasSize}
          onOpenDetail={handleOpenDetail}
          onClose={closeQuickCard}
        />
      )}

      {/* NodeDetailPanel */}
      {selectedNode && (
        <NodeDetailPanel
          node={selectedNode}
          onClose={() => {
            setSelectedNode(null);
            setLockedNodeId(null);
          }}
        />
      )}

      {/* sr-only accessible node list */}
      <table
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          borderWidth: 0,
        }}
        aria-label={t('kg_graph_board.sr_table_aria', 'Accessible graph node list')}
      >
        <caption>{t('kg_graph_board.sr_caption', 'Graph nodes (accessible fallback)')}</caption>
        <thead>
          <tr>
            <th>{t('kg_explorer.col_id', 'ID')}</th>
            <th>{t('kg_explorer.col_type', 'Type')}</th>
            <th>{t('kg_explorer.col_label', 'Label')}</th>
            <th>{t('kg_explorer.col_round', 'Round')}</th>
          </tr>
        </thead>
        <tbody>
          {(graphData?.nodes ?? []).map((n) => (
            <tr key={n.id}>
              <td>{n.id}</td>
              <td>{n.type}</td>
              <td>{n.label}</td>
              <td>{n.round ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
