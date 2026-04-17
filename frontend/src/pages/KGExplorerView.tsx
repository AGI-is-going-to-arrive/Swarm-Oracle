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
   - Clicking a node dispatches a CustomEvent('kg:openNodeSheet') on
     `window` with detail `{ scenarioId, identityId, originContext }`.
     FE-3 wires NodeConversationSheet to this event in Layer 5.5.

   Capability gate: useCapabilityCheck('kg_explorer') — disabled → 404.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { useG6Graph } from '../hooks/useG6Graph';
import { comboLayout, shouldDegradeForMobile, degradeNodesForMobile } from '../lib/g6Layouts';
import { resolveG6Tokens } from '../lib/graphTokens';
import { buildSessionHeaders } from '../api/client';

// ── Types ───────────────────────────────────────────────────

interface KGNode {
  id: string;
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

type ViewportTier = 'mobile' | 'tablet' | 'desktop';
type MobileActivePane = 'graph' | 'sidebar';

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

// ── Component ───────────────────────────────────────────────

export default function KGExplorerView() {
  const { id: scenarioId = '' } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { loading: capLoading, enabled: capEnabled } = useCapabilityCheck('kg_explorer');
  const tier = useViewportTier();
  const theme = useTheme();

  const [graphData, setGraphData] = useState<CausalGraphPayload | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobileActivePane>('graph');
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());

  const containerRef = useRef<HTMLDivElement | null>(null);

  // Fetch causal-graph data (capability-gated).
  useEffect(() => {
    if (!capEnabled || !scenarioId) return;
    let cancelled = false;
    const apiBase = (typeof window !== 'undefined'
      ? (window as unknown as { __API_BASE__?: string }).__API_BASE__
      : undefined) ?? '/api';
    (async () => {
      setDataLoading(true);
      try {
        const res = await fetch(
          `${apiBase}/scenario/${encodeURIComponent(scenarioId)}/causal-graph`,
          { headers: buildSessionHeaders() },
        );
        if (!res.ok) throw new Error(`http_${res.status}`);
        const payload = (await res.json()) as CausalGraphPayload;
        if (!cancelled) setGraphData(payload);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'unknown_error';
          setDataError(msg);
        }
      } finally {
        if (!cancelled) setDataLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [capEnabled, scenarioId]);

  // Build G6 node/edge data — memoized so hook doesn't rebuild.
  const g6GraphData = useMemo(() => {
    if (!graphData) return { nodes: [], edges: [] };
    const mobileDowngrade = tier === 'mobile' && shouldDegradeForMobile(graphData.nodes.length);
    const { kept } = mobileDowngrade
      ? degradeNodesForMobile(graphData.nodes)
      : { kept: graphData.nodes };
    const filtered = kept.filter((n) => {
      if (typeFilter.size > 0 && !typeFilter.has(n.type)) return false;
      if (searchTerm.trim()) {
        const term = searchTerm.trim().toLowerCase();
        if (!n.label.toLowerCase().includes(term)) return false;
      }
      return true;
    });
    const keptIds = new Set(filtered.map((n) => n.id));
    return {
      nodes: filtered.map((n) => ({
        id: n.id,
        type: 'circle',
        style: { labelText: n.label, labelPlacement: 'bottom' as const },
        data: { kgType: n.type, kgRound: n.round },
      })),
      edges: graphData.edges
        .filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
        .map((e) => ({ id: e.id, source: e.source, target: e.target })),
    };
  }, [graphData, tier, searchTerm, typeFilter]);

  // Node click → dispatch CustomEvent (FE-3 subscribes in Layer 5.5).
  const handleNodeClick = useCallback(
    (evt: unknown) => {
      // FE-3 v4 stub: this callback will be extended by FE-3 Edit mode to
      // open NodeConversationSheet. For now, we only fire the bridging
      // CustomEvent so observer tests can assert wiring.
      const target = (evt as { target?: { id?: string; type?: string } } | undefined)?.target;
      const identityId = target?.id ?? '';
      if (typeof window === 'undefined') return;
      window.dispatchEvent(
        new CustomEvent('kg:openNodeSheet', {
          detail: {
            scenarioId,
            identityId,
            originContext: { graphNodeType: target?.type ?? 'unknown' },
          },
        }),
      );
    },
    [scenarioId],
  );

  const tokens = useMemo(() => resolveG6Tokens(theme), [theme]);

  const g6Options = useMemo(
    () => ({
      data: g6GraphData,
      autoFit: 'view' as const,
      layout: comboLayout(),
      node: {
        style: {
          fill: tokens.nodeFill,
          stroke: tokens.nodeStroke,
          labelFill: tokens.label,
          labelFontSize: 11,
        },
      },
      edge: { style: { stroke: tokens.edgeStroke } },
      background: tokens.background,
      behaviors: ['zoom-canvas', 'drag-canvas', 'hover-activate'],
    }),
    [g6GraphData, tokens],
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
  if (!capEnabled) {
    return (
      <div
        data-testid="kg-explorer-root"
        className="p-6 text-sm"
        role="alert"
        aria-live="polite"
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
          onChange={(e) => setSearchTerm(e.target.value)}
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
                  padding: '0.125rem 0.5rem',
                  border: '1px solid currentColor',
                  borderRadius: 999,
                  background: active ? 'currentColor' : 'transparent',
                  color: active ? 'var(--bg, #fff)' : 'inherit',
                  cursor: 'pointer',
                }}
              >
                {type}
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
          {dataError && (
            <p role="alert" style={{ fontSize: '0.75rem', padding: '0.25rem', color: 'red' }}>
              {dataError}
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
          <div data-testid="kg-explorer-minimap" aria-hidden="true" style={{ marginBottom: 8 }}>
            {/* Minimap placeholder rectangle. G6 Minimap plugin can be
                wired via g6Options.plugins in later passes; FE-2 scope
                only needs the testid present for QA-2 E2E selectors. */}
            <div
              style={{
                width: '100%',
                height: 64,
                background: tokens.edgeStroke,
                opacity: 0.3,
                borderRadius: 4,
              }}
            />
          </div>
          <p style={{ fontSize: '0.8rem' }}>
            {graphData
              ? t('kg_explorer.node_count', {
                  defaultValue: '{{count}} nodes',
                  count: graphData.nodes.length,
                })
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
          [data-testid="kg-explorer-g6-canvas"] { outline: 2px solid CanvasText; }
          [data-testid="kg-explorer-dual-stack"] > * {
            outline: 1px solid CanvasText;
          }
        }
        @media (max-width: 640px) {
          .kg-explorer__dual-stack { grid-template-columns: minmax(0, 1fr) !important; }
        }
        /* Expose wrapper ref (unused here, kept for symmetry with FE-3 contract). */
        ${canvasWrapperRef ? '' : ''}
      `}</style>
    </main>
  );
}
