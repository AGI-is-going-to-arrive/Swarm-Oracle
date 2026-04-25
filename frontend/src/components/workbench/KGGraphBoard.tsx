import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useG6Graph } from '../../hooks/useG6Graph';
import useReducedMotion from '../../hooks/useReducedMotion';
import { useScenarioGraph } from '../../hooks/useScenarioGraph';
import {
  KG_DEGRADE_THRESHOLDS,
  KG_DIM_OPACITY,
  buildKgG6Options,
  computeNodeSize,
  getKGNodeStyle,
  toKgG6Data,
} from '../../lib/kgGraphConfig';
import { NodeDetailPanel, type NodeDetail } from '../NodeDetailPanel';

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
  } = useScenarioGraph(scenarioId || null, branchId);

  const errorMessage = graphError
    ? t('kg_explorer.error_fetch', 'Unable to load the knowledge graph right now. Please retry.')
    : null;

  const containerRef = useRef<HTMLDivElement | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());

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
    return toKgG6Data(graphData, { searchTerm, typeFilter: Array.from(typeFilter), isMobile });
  }, [graphData, searchTerm, typeFilter, isMobile]);

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

  const activeHighlight = lockedNodeId ?? highlightedNodeId;

  const styledG6Data = useMemo(() => {
    const neighbors = activeHighlight ? adjacencyMap.get(activeHighlight) ?? new Set() : null;
    return {
      nodes: g6GraphData.nodes.map((n) => {
        const degree = degreeMap.get(n.id) ?? 1;
        const size = computeNodeSize(degree);
        const nodeStyle = getKGNodeStyle(n.data.kgType, theme);
        const isDimmed = activeHighlight && n.id !== activeHighlight && !neighbors?.has(n.id);
        return {
          ...n,
          style: {
            ...n.style,
            size,
            fill: nodeStyle.fill,
            stroke: n.id === activeHighlight ? nodeStyle.stroke : nodeStyle.stroke,
            lineWidth: n.id === activeHighlight ? 3 : nodeStyle.lineWidth,
            labelFill: nodeStyle.textColor,
            labelFontSize: 11,
            opacity: isDimmed ? KG_DIM_OPACITY : 1,
          },
        };
      }),
      edges: g6GraphData.edges.map((e) => {
        const isDimmed =
          activeHighlight &&
          e.source !== activeHighlight &&
          e.target !== activeHighlight;
        return {
          ...e,
          style: { opacity: isDimmed ? KG_DIM_OPACITY : 0.6 },
        };
      }),
    };
  }, [g6GraphData, degreeMap, activeHighlight, adjacencyMap, theme]);

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
      } | undefined)?.target;
      const nodeId = String(target?.id ?? target?.get?.('id') ?? '');
      const graphNode = graphNodeById.get(nodeId);
      if (!graphNode) return;

      if (isMobile) {
        setLockedNodeId((prev) => (prev === nodeId ? null : nodeId));
      }

      setSelectedNode({
        id: graphNode.id,
        label: graphNode.label,
        type: graphNode.type,
        round: graphNode.round,
        payload: graphNode.payload,
      });

      onNodeClick?.(target);
    },
    [graphNodeById, onNodeClick, isMobile, setSelectedNode, setLockedNodeId],
  );

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

  if (loading) {
    return (
      <div data-testid="kg-graph-board" className={className} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
        <p style={{ color: '#9aa4b2' }}>{t('common.loading', 'Loading...')}</p>
      </div>
    );
  }

  if (errorMessage) {
    return (
      <div data-testid="kg-graph-board" className={className} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 200, gap: '0.5rem' }}>
        <p role="alert" style={{ color: '#ff7a70' }}>{errorMessage}</p>
        <button onClick={() => void loadGraph()} style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #555', background: 'transparent', color: '#8ab4f8', cursor: 'pointer' }}>
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  return (
    <div data-testid="kg-graph-board" className={className} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 320, position: 'relative' }}>
      {/* Toolbar */}
      <div style={{ padding: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{t('workbench.kg_panel', 'Knowledge Graph')}</span>
        {graphData && (
          <span style={{ color: '#9aa4b2', fontSize: '0.78rem' }}>
            {g6GraphData.nodes.length} {t('causal.nodes', 'nodes')}
          </span>
        )}
        {/* Search */}
        <input
          type="search"
          data-testid="kg-graph-board-search"
          placeholder={t('kg_graph_board.search_placeholder', 'Search nodes...')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          aria-label={t('kg_graph_board.search_aria', 'Search graph nodes')}
          style={{ padding: '2px 6px', fontSize: '0.78rem', minWidth: 120, borderRadius: 4, border: '1px solid #555', background: 'transparent', color: 'inherit' }}
        />
        {/* Zoom controls */}
        <div style={{ display: 'flex', gap: '2px', marginLeft: 'auto' }}>
          <button
            type="button"
            onClick={handleZoomIn}
            aria-label={t('kg_graph_board.zoom_in', 'Zoom in')}
            title={t('kg_graph_board.zoom_in', 'Zoom in')}
            style={zoomBtnStyle}
          >
            +
          </button>
          <button
            type="button"
            onClick={handleZoomOut}
            aria-label={t('kg_graph_board.zoom_out', 'Zoom out')}
            title={t('kg_graph_board.zoom_out', 'Zoom out')}
            style={zoomBtnStyle}
          >
            &minus;
          </button>
          <button
            type="button"
            onClick={handleFitView}
            aria-label={t('kg_graph_board.fit_view', 'Fit to view')}
            title={t('kg_graph_board.fit_view', 'Fit to view')}
            style={zoomBtnStyle}
          >
            &#x2922;
          </button>
        </div>
      </div>

      {/* Type filter chips */}
      {availableTypes.length > 0 && (
        <div
          data-testid="kg-graph-board-filter-pills"
          role="group"
          aria-label={t('kg_graph_board.filter_aria', 'Filter by node type')}
          style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', padding: '0 0.5rem 0.25rem' }}
        >
          {availableTypes.map((type) => {
            const active = typeFilter.has(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() =>
                  setTypeFilter((prev) => {
                    const next = new Set(prev);
                    if (next.has(type)) next.delete(type);
                    else next.add(type);
                    return next;
                  })
                }
                aria-pressed={active}
                style={{
                  padding: '1px 6px',
                  border: '1px solid currentColor',
                  borderRadius: 999,
                  background: active ? 'currentColor' : 'transparent',
                  color: active ? 'var(--bg, #fff)' : 'inherit',
                  cursor: 'pointer',
                  fontSize: '0.72rem',
                }}
              >
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
          role="status"
          aria-live="polite"
          style={{
            padding: '4px 0.5rem',
            fontSize: '0.72rem',
            color: '#cbd5e1',
            background: 'rgba(255,176,32,0.12)',
            borderTop: '1px solid rgba(255,176,32,0.28)',
            borderBottom: '1px solid rgba(255,176,32,0.28)',
          }}
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
        style={{ flex: 1, minHeight: 280, position: 'relative', outline: 'none' }}
        onFocus={(e) => { e.currentTarget.style.outline = '2px solid #8ab4f8'; e.currentTarget.style.outlineOffset = '2px'; }}
        onBlur={(e) => { e.currentTarget.style.outline = 'none'; }}
      />

      {/* Minimap container */}
      <div
        ref={setMinimapContainer}
        data-testid="kg-graph-board-minimap"
        aria-label={t('kg_graph_board.minimap_aria', 'Graph minimap')}
        role="img"
        style={{
          position: 'absolute',
          bottom: 8,
          left: 8,
          width: 180,
          height: 96,
          borderRadius: 4,
          overflow: 'hidden',
          border: '1px solid #444',
          pointerEvents: 'none',
        }}
      />

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

const zoomBtnStyle: React.CSSProperties = {
  width: 26,
  height: 26,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: '1px solid #555',
  borderRadius: 4,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: '0.85rem',
  lineHeight: 1,
  padding: 0,
};
