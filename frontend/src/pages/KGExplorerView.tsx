/* ═══════════════════════════════════════════════════════════
   FE-2 — KGExplorerView (/kg-explorer/:id)

   Renders the causal graph + identity layer with G6 Canvas (v5) and
   an @xyflow/react "dual stack" side panel. Three-tier responsive:
   - Desktop  ≥1024px: 50/50 split (G6 left, xyflow right)
   - Tablet   768-1023: 2-row tab layout
   - Mobile   <768px:  single view + bottom segmented switcher

   Accessibility:
   - sr-only <table> fallback lists every node (HC-B7)
   - `@media (forced-colors: active)` CSS adds outline + HTML label overlay
   - 400% zoom: container uses CSS grid minmax(0,1fr) stack

   Node interaction:
   - Clicking a node opens NodeConversationSheet directly (FE-3-seq
     Layer 5.5 wire-up). The previous CustomEvent('kg:openNodeSheet')
     bridge has been removed in favour of component-local state.

   Capability gate: useCapabilityCheck('kg_explorer') — disabled → 404.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useRef, useState, useDeferredValue } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GraphOptions } from '@antv/g6';

import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { useG6Graph } from '../hooks/useG6Graph';
import type { GraphPayload } from '../hooks/useScenarioGraph';
import { comboLayout } from '../lib/g6Layouts';
import { resolveKGG6Tokens, TYPE_LABEL_I18N } from '../lib/graphTokens';
import { KG_DEGRADE_THRESHOLDS, buildKgG6Options, toKgG6Data } from '../lib/kgGraphConfig';
import { buildSessionHeaders } from '../api/client';
import { NodeConversationSheet, type NodeConversationOrigin } from '../components/kg/NodeConversationSheet';

// ── Types ───────────────────────────────────────────────────

interface KGNode {
  id: string;
  key?: string;
  type: string;
  label: string;
  round: number | null;
  payload?: unknown;
}

interface KGEdge {
  id: string;
  source: string;
  target: string;
  type: string;
}

interface CausalGraphPayload {
  id: string;
  nodes: KGNode[];
  edges: KGEdge[];
}

type KGExplorerErrorState = {
  status: number | null;
};

type ViewportTier = 'mobile' | 'tablet' | 'desktop';
type MobileActivePane = 'graph' | 'sidebar';

interface KGSheetState {
  open: boolean;
  scenarioId: string;
  identityId: string | null;
  origin: NodeConversationOrigin;
}

function createClosedSheetState(): KGSheetState {
  return {
    open: false,
    scenarioId: '',
    identityId: null,
    origin: { nodeId: '', nodeType: '' },
  };
}

// ── Hooks ───────────────────────────────────────────────────

function useViewportTier(): ViewportTier {
  const [tier, setTier] = useState<ViewportTier>(() => computeTier());
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mqMobile = window.matchMedia('(max-width: 767px)');
    const mqTablet = window.matchMedia('(min-width: 768px) and (max-width: 1023px)');
    const recompute = () => setTier(computeTier());
    mqMobile.addEventListener?.('change', recompute);
    mqTablet.addEventListener?.('change', recompute);
    recompute();
    return () => {
      mqMobile.removeEventListener?.('change', recompute);
      mqTablet.removeEventListener?.('change', recompute);
    };
  }, []);
  return tier;
}

function computeTier(): ViewportTier {
  if (typeof window === 'undefined') return 'desktop';
  const w = window.innerWidth;
  if (w < 768) return 'mobile';
  if (w < 1024) return 'tablet';
  return 'desktop';
}

function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => readTheme());
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function readTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light';
  const root = document.documentElement;
  const ds = root.dataset?.theme;
  if (ds === 'dark' || ds === 'light') return ds;
  if (root.classList.contains('dark')) return 'dark';
  return 'light';
}

function getKgExplorerErrorMessage(
  error: KGExplorerErrorState,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  if (error.status === 404) {
    return t(
      'kg_explorer.error_missing',
      'Knowledge graph data is not available for this scenario.',
    );
  }
  if (error.status === 401 || error.status === 403) {
    return t(
      'kg_explorer.error_forbidden',
      'You do not have permission to view this knowledge graph.',
    );
  }
  return t(
    'kg_explorer.error_fetch',
    'Unable to load the knowledge graph right now. Please retry.',
  );
}

// ── Component ───────────────────────────────────────────────

export default function KGExplorerView() {
  const { id: scenarioId = '' } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const {
    loading: capLoading,
    enabled: capEnabled,
    error: capabilityError,
    reload: reloadCapability,
  } = useCapabilityCheck('kg_explorer');
  const tier = useViewportTier();
  const theme = useTheme();

  const [graphData, setGraphData] = useState<CausalGraphPayload | null>(null);
  const [dataError, setDataError] = useState<KGExplorerErrorState | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobileActivePane>('graph');
  const [searchTerm, setSearchTerm] = useState('');
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [minimapContainer, setMinimapContainer] = useState<HTMLDivElement | null>(null);
  // FE-3-seq: append-only sheet state for NodeConversationSheet trigger.
  const [sheetState, setSheetState] = useState<KGSheetState>(createClosedSheetState);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const loadRequestIdRef = useRef(0);

  const loadGraph = useCallback(async () => {
    if (!scenarioId) return;
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    const apiBase = (typeof window !== 'undefined'
      ? (window as unknown as { __API_BASE__?: string }).__API_BASE__
      : undefined) ?? '/api';
    setDataLoading(true);
    setDataError(null);
    setGraphData(null);
    try {
      const res = await fetch(
        `${apiBase}/scenario/${encodeURIComponent(scenarioId)}/causal-graph`,
        { headers: buildSessionHeaders() },
      );
      if (requestId !== loadRequestIdRef.current) return;
      if (!res.ok) {
        setDataError({ status: res.status });
        return;
      }
      const payload = (await res.json()) as CausalGraphPayload;
      if (requestId !== loadRequestIdRef.current) return;
      setGraphData(payload);
      setDataError(null);
    } catch {
      if (requestId !== loadRequestIdRef.current) return;
      setDataError({ status: null });
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setDataLoading(false);
      }
    }
  }, [scenarioId]);

  // Fetch causal-graph data (capability-gated).
  useEffect(() => {
    if (!capEnabled || capabilityError || !scenarioId) return;
    void loadGraph();
    return () => {
      loadRequestIdRef.current += 1;
    };
  }, [capEnabled, capabilityError, loadGraph, scenarioId]);

  useEffect(() => {
    setSheetState(createClosedSheetState());
  }, [scenarioId]);

  // Build G6 node/edge data — memoized so hook doesn't rebuild.
  const g6GraphData = useMemo(() => {
    if (!graphData) return { nodes: [], edges: [], truncatedFromCount: null };
    return toKgG6Data(graphData as unknown as GraphPayload, {
      searchTerm: deferredSearchTerm,
      typeFilter: Array.from(typeFilter),
      isMobile: tier === 'mobile',
      theme,
      t,
    });
  }, [graphData, tier, deferredSearchTerm, typeFilter, theme, t]);
  const graphNodeById = useMemo(
    () => new Map((graphData?.nodes ?? []).map((node) => [node.id, node])),
    [graphData],
  );

  // G3-W3/W4: hide NodeConversationSheet when its source node has been
  // filtered out of the visible graph (typeFilter / searchTerm narrowed the
  // visible set). Derived during render to avoid set-state-in-effect
  // cascading renders.
  const visibleNodeIds = useMemo(
    () => new Set(g6GraphData.nodes.map((n) => n.id)),
    [g6GraphData.nodes],
  );
  const explorerG6Data = useMemo(() => {
    const hasFocusedGraphIntent = deferredSearchTerm.trim().length > 0 || typeFilter.size > 0;
    const showNodeLabels =
      g6GraphData.nodes.length <= KG_DEGRADE_THRESHOLDS.nodeLabelLimit || hasFocusedGraphIntent;
    const showEdgeLabels =
      g6GraphData.edges.length <= Math.min(50, KG_DEGRADE_THRESHOLDS.edgeLabelLimit);
    if (showNodeLabels && showEdgeLabels) return g6GraphData;
    return {
      ...g6GraphData,
      nodes: g6GraphData.nodes.map((node) => ({
        ...node,
        style: {
          ...node.style,
          ...(showNodeLabels ? {} : { labelText: undefined }),
        },
      })),
      edges: g6GraphData.edges.map((edge) => ({
        ...edge,
        style: {
          ...edge.style,
          ...(showEdgeLabels ? {} : { labelText: undefined }),
        },
      })),
    };
  }, [deferredSearchTerm, g6GraphData, typeFilter]);
  const isSheetSourceVisible =
    !sheetState.open || visibleNodeIds.has(sheetState.origin.nodeId);
  const effectiveSheetOpen = sheetState.open && isSheetSourceVisible;

  // Node click → open NodeConversationSheet directly (FE-3-seq wire-up).
  const handleNodeClick = useCallback(
    (evt: unknown) => {
      const target = (evt as {
        target?: {
          id?: string;
          type?: string;
          data?: { kgType?: unknown };
          get?: (key: string) => unknown;
        };
      } | undefined)?.target;
      const nodeId = String(target?.id ?? target?.get?.('id') ?? '');
      const graphNode = graphNodeById.get(nodeId);
      const targetKgType = target?.data?.kgType;
      const nodeType = graphNode?.type
        ?? (typeof targetKgType === 'string' ? targetKgType : null)
        ?? 'unknown';
      const payload = typeof graphNode?.payload === 'object' && graphNode.payload !== null && !Array.isArray(graphNode.payload)
        ? graphNode.payload as Record<string, unknown>
        : {};
      const content = typeof payload.content === 'string' ? payload.content : '';
      const relatedContext = (graphData?.edges ?? [])
        .filter((edge) => edge.source === nodeId || edge.target === nodeId)
        .slice(0, 3)
        .flatMap((edge) => {
          const outgoing = edge.source === nodeId;
          const otherId = outgoing ? edge.target : edge.source;
          const otherLabel = graphNodeById.get(otherId)?.label?.trim();
          if (!otherLabel) return [];
          return [
            outgoing
              ? t('kg_explorer.related_outgoing', {
                  target: otherLabel,
                  defaultValue: 'Downstream: {{target}}',
                })
              : t('kg_explorer.related_incoming', {
                  source: otherLabel,
                  defaultValue: 'Upstream: {{source}}',
                }),
          ];
        });
      setSheetState({
        open: true,
        scenarioId,
        identityId: null,
        origin: {
          surface: 'knowledge',
          nodeId,
          nodeType,
          excerpt: content || graphNode?.label,
          nodeLabel: graphNode?.label,
          branchId: typeof payload.branch_id === 'string' ? payload.branch_id : null,
          roundNumber: graphNode?.round ?? null,
          targetLabel: t('node_context_banner.target_knowledge_analyst_label', 'Knowledge graph analyst'),
          targetDescription: t(
            'node_context_banner.target_knowledge_analyst_description',
            'Answers from this node and its connected concepts, agents, and events.',
          ),
          relatedContext,
        },
      });
    },
    [graphData?.edges, graphNodeById, scenarioId, t],
  );

  const tokens = useMemo(() => resolveKGG6Tokens(theme), [theme]);
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(mq.matches);
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);

  const g6Options = useMemo(
    () =>
      buildKgG6Options({
        data: explorerG6Data,
        theme,
        reducedMotion,
        minimapContainer,
        enableHover: true,
        layout: comboLayout(),
      }) as unknown as Omit<GraphOptions, 'container' | 'renderer' | 'devicePixelRatio'>,
    [explorerG6Data, theme, reducedMotion, minimapContainer],
  );

  const { canvasWrapperRef } = useG6Graph({
    containerRef,
    options: g6Options,
    onNodeClick: handleNodeClick,
  });

  // Capability gate → 404.
  if (capLoading) {
    return (
      <div data-testid="kg-explorer-root" className="p-6 text-sm">
        {t('common.loading', 'Loading…')}
      </div>
    );
  }
  if (capabilityError) {
    return (
      <div
        data-testid="kg-explorer-root"
        className="p-6 text-sm"
        role="status"
      >
        <h1 className="text-lg font-semibold mb-2">
          {t('kg_explorer.error_title', 'Knowledge Graph is unavailable')}
        </h1>
        <p>{t('kg_explorer.error_fetch', 'Unable to load the knowledge graph right now. Please retry.')}</p>
        <button type="button" className="underline" onClick={() => void reloadCapability?.()}>
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }
  if (!capEnabled) {
    return (
      <div
        data-testid="kg-explorer-root"
        className="p-6 text-sm"
        role="status"
      >
        <h1 className="text-lg font-semibold mb-2">
          {t('kg_explorer.feature_disabled_title', 'Feature unavailable')}
        </h1>
        <p>{t('kg_explorer.feature_disabled', 'KG Explorer is not enabled on this server.')}</p>
        <Link to="/" className="underline">
          {t('common.back_home', 'Back to home')}
        </Link>
      </div>
    );
  }
  if (dataError && !graphData && !dataLoading) {
    return (
      <div
        data-testid="kg-explorer-root"
        className="p-6 text-sm"
        role="status"
      >
        <h1 className="text-lg font-semibold mb-2">
          {t('kg_explorer.error_title', 'Knowledge Graph is unavailable')}
        </h1>
        <p>{getKgExplorerErrorMessage(dataError, t)}</p>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button type="button" className="underline" onClick={() => void loadGraph()}>
            {t('common.retry', 'Retry')}
          </button>
          <Link to="/" className="underline">
            {t('common.back_home', 'Back to home')}
          </Link>
        </div>
      </div>
    );
  }

  // Available node types for filter pills.
  const availableTypes = Array.from(new Set(graphData?.nodes.map((n) => n.type) ?? [])).sort();

  return (
    <main
      data-testid="kg-explorer-root"
      data-tier={tier}
      className="kg-explorer"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        minHeight: '100vh',
        padding: '0.75rem',
        gap: '0.75rem',
      }}
    >
      {/* Header / controls */}
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        <h1 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
          {t('kg_explorer.title', 'KG Explorer')}
        </h1>
        <input
          type="search"
          data-testid="kg-explorer-search"
          placeholder={t('kg_explorer.search_placeholder', 'Search nodes…')}
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setSheetState(createClosedSheetState());
          }}
          style={{ padding: '0.25rem 0.5rem', minWidth: 160 }}
          aria-label={t('kg_explorer.search_aria', 'Search graph nodes')}
        />
        <div
          data-testid="kg-explorer-filter-pills"
          role="group"
          aria-label={t('kg_explorer.filter_aria', 'Filter by node type')}
          style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}
        >
          {availableTypes.map((type) => {
            const active = typeFilter.has(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => {
                  setSheetState(createClosedSheetState());
                  setTypeFilter((prev) => {
                    const next = new Set(prev);
                    if (next.has(type)) next.delete(type);
                    else next.add(type);
                    return next;
                  });
                }}
                aria-pressed={active}
                style={{
                  padding: '0.125rem 0.5rem',
                  border: '1px solid currentColor',
                  borderRadius: 999,
                  background: active ? tokens.selectedStroke : 'transparent',
                  borderColor: active ? tokens.selectedStroke : 'currentColor',
                  color: active ? '#181611' : 'inherit',
                  cursor: 'pointer',
                }}
              >
                {t(TYPE_LABEL_I18N[type]?.[0] ?? type, TYPE_LABEL_I18N[type]?.[1] ?? type)}
              </button>
            );
          })}
        </div>
      </header>

      {/* Main content: responsive grid */}
      <div
        data-testid="kg-explorer-dual-stack"
        className="kg-explorer__dual-stack"
        style={{
          display: 'grid',
          gridTemplateColumns:
            tier === 'desktop' ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)',
          gap: '0.75rem',
          minHeight: 0,
        }}
      >
        {/* G6 Canvas region */}
        <section
          hidden={tier === 'mobile' && mobilePane !== 'graph'}
          style={{ display: 'flex', flexDirection: 'column', minHeight: 320 }}
          aria-label={t('kg_explorer.g6_aria', 'Causal graph canvas')}
        >
          {/* Focusable Canvas wrapper (FRM1 focus proxy) */}
          <div
            ref={containerRef}
            data-testid="kg-explorer-g6-canvas"
            tabIndex={0}
            role="application"
            aria-label={t('kg_explorer.g6_aria', 'Causal graph canvas')}
            style={{
              flex: 1,
              minHeight: 320,
              outline: 'none',
              position: 'relative',
              background: tokens.background,
            }}
          />
          {dataLoading && (
            <p role="status" style={{ fontSize: '0.75rem', padding: '0.25rem' }}>
              {t('common.loading', 'Loading…')}
            </p>
          )}
          {g6GraphData.truncatedFromCount !== null && (
            <p
              data-testid="kg-explorer-truncate-notice"
              role="status"
              aria-live="polite"
              style={{ fontSize: '0.75rem', padding: '0.25rem', margin: 0 }}
            >
              {t('kg_explorer.mobile_truncate_notice', {
                defaultValue: 'Showing first {{cap}} of {{total}} nodes. Refine search or filters to narrow results.',
                cap: g6GraphData.nodes.length,
                total: g6GraphData.truncatedFromCount,
              })}
            </p>
          )}
        </section>

        {/* xyflow "dual stack" side region — minimal stub (xyflow instance
            kept in CausalReviewView; here we render a summary panel). */}
        <aside
          data-testid="kg-explorer-xyflow"
          hidden={tier === 'mobile' && mobilePane !== 'sidebar'}
          aria-label={t('kg_explorer.sidebar_aria', 'Identity side panel')}
          style={{
            background: tokens.nodeFill,
            color: tokens.label,
            padding: '0.75rem',
            borderRadius: 8,
            minHeight: 320,
            overflow: 'auto',
          }}
        >
          <h2 style={{ fontSize: '0.95rem', fontWeight: 600, marginTop: 0 }}>
            {t('kg_explorer.sidebar_title', 'Identity Overview')}
          </h2>
          <div
            ref={setMinimapContainer}
            data-testid="kg-explorer-minimap"
            aria-label={t('kg_explorer.minimap_aria', 'Graph minimap')}
            role="img"
            style={{
              width: '100%',
              height: 96,
              marginBottom: 8,
              background: tokens.background,
              border: `1px solid ${tokens.edgeStroke}`,
              borderRadius: 4,
              overflow: 'hidden',
              position: 'relative',
            }}
          />
          <p style={{ fontSize: '0.8rem' }}>
            {graphData
              ? (g6GraphData.truncatedFromCount !== null
                  ? t('kg_explorer.node_count_visible', {
                      defaultValue: '{{visible}} of {{total}} nodes shown',
                      visible: g6GraphData.nodes.length,
                      total: g6GraphData.truncatedFromCount,
                    })
                  : t('kg_explorer.node_count', {
                      defaultValue: '{{count}} nodes',
                      count: graphData.nodes.length,
                    }))
              : '—'}
          </p>
        </aside>
      </div>

      {/* Mobile pane switcher (shown only on mobile) */}
      {tier === 'mobile' && (
        <nav
          aria-label={t('kg_explorer.mobile_switch_aria', 'Switch between graph and details')}
          style={{ display: 'flex', gap: '0.25rem' }}
        >
          <button
            type="button"
            onClick={() => setMobilePane('graph')}
            aria-pressed={mobilePane === 'graph'}
            style={{ flex: 1, padding: '0.5rem' }}
          >
            {t('kg_explorer.tab_graph', 'Graph')}
          </button>
          <button
            type="button"
            onClick={() => setMobilePane('sidebar')}
            aria-pressed={mobilePane === 'sidebar'}
            style={{ flex: 1, padding: '0.5rem' }}
          >
            {t('kg_explorer.tab_details', 'Details')}
          </button>
        </nav>
      )}

      {/* sr-only table a11y fallback (HC-B7) */}
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
        aria-label={t('kg_explorer.sr_table_aria', 'Accessible graph node list')}
      >
        <caption>{t('kg_explorer.sr_caption', 'Graph nodes (accessible fallback)')}</caption>
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

      {/* forced-colors + 400% zoom CSS — scoped via <style> for zero bundler churn */}
      <style>{`
        @media (forced-colors: active) {
          [data-testid="kg-explorer-g6-canvas"] { outline: 2px solid CanvasText !important; }
          [data-testid="kg-explorer-dual-stack"] > * {
            outline: 1px solid CanvasText;
          }
          [data-testid="kg-explorer-search"] { border: 1px solid CanvasText; }
          [data-testid="kg-explorer-filter-pills"] button { color: ButtonText !important; background-color: ButtonFace !important; border: 1px solid ButtonText !important; }
          [data-testid="kg-explorer-filter-pills"] button[aria-pressed="true"] { color: HighlightText !important; background-color: Highlight !important; border-color: HighlightText !important; }
          [data-testid="kg-explorer-xyflow"] { outline: 1px solid CanvasText; background-color: Canvas !important; color: CanvasText !important; }
        }
        @media (max-width: 640px) {
          .kg-explorer__dual-stack { grid-template-columns: minmax(0, 1fr) !important; }
        }
        /* Expose wrapper ref (unused here, kept for symmetry with FE-3 contract). */
        ${canvasWrapperRef ? '' : ''}
      `}</style>

      {/* FE-3-seq: NodeConversationSheet (append-only, direct state wire).
          G3-W3/W4: hide sheet when its source node is no longer visible (derived). */}
      {effectiveSheetOpen && (
        <NodeConversationSheet
          open={effectiveSheetOpen}
          onOpenChange={(next) =>
            setSheetState((prev) => (next ? prev : createClosedSheetState()))
          }
          onClose={() => setSheetState(createClosedSheetState())}
          scenarioId={sheetState.scenarioId}
          identityId={sheetState.identityId}
          origin={sheetState.origin}
        />
      )}
    </main>
  );
}
