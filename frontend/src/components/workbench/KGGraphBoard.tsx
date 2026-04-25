import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useG6Graph } from '../../hooks/useG6Graph';
import { useScenarioGraph } from '../../hooks/useScenarioGraph';
import { comboLayout, shouldDegradeForMobile, degradeNodesForMobile } from '../../lib/g6Layouts';
import { resolveG6Tokens } from '../../lib/graphTokens';

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
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 767px)');
    const handle = () => setMobile(mq.matches);
    mq.addEventListener?.('change', handle);
    return () => mq.removeEventListener?.('change', handle);
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

  const handleNodeClick = useCallback(
    (evt: unknown) => {
      if (!onNodeClick) return;
      const target = (evt as { target?: { id?: string } } | undefined)?.target;
      onNodeClick(target);
    },
    [onNodeClick],
  );

  const tokens = useMemo(() => resolveG6Tokens(theme), [theme]);

  const g6GraphData = useMemo(() => {
    if (!graphData) return { nodes: [], edges: [] };
    const mobileDowngrade = isMobile && shouldDegradeForMobile(graphData.nodes.length);
    const { kept } = mobileDowngrade
      ? degradeNodesForMobile(graphData.nodes)
      : { kept: graphData.nodes };
    const keptIds = new Set(kept.map(n => n.id));
    return {
      nodes: kept.map(n => ({
        id: n.id,
        type: 'circle' as const,
        style: { labelText: n.label, labelPlacement: 'bottom' as const },
        data: { kgType: n.type, kgRound: n.round },
      })),
      edges: graphData.edges
        .filter(e => keptIds.has(e.source) && keptIds.has(e.target))
        .map(e => ({ id: e.id, source: e.source, target: e.target })),
    };
  }, [graphData, isMobile]);

  const g6Options = useMemo(() => ({
    data: g6GraphData,
    autoFit: 'view' as const,
    autoResize: true,
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
    plugins: [],
  }), [g6GraphData, tokens]);

  useG6Graph({
    containerRef,
    options: g6Options,
    onNodeClick: handleNodeClick,
  });

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
    <div data-testid="kg-graph-board" className={className} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 320 }}>
      <div style={{ padding: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{t('workbench.kg_panel', 'Knowledge Graph')}</span>
        {graphData && (
          <span style={{ color: '#9aa4b2', fontSize: '0.78rem' }}>
            {graphData.nodes.length} {t('causal.nodes', 'nodes')}
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        data-testid="kg-graph-board-canvas"
        tabIndex={0}
        role="application"
        aria-label={t('kg_explorer.g6_aria', 'Causal graph canvas')}
        style={{ flex: 1, minHeight: 280, position: 'relative', background: tokens.background, outline: 'none' }}
        onFocus={(e) => { e.currentTarget.style.outline = '2px solid #8ab4f8'; e.currentTarget.style.outlineOffset = '2px'; }}
        onBlur={(e) => { e.currentTarget.style.outline = 'none'; }}
      />
    </div>
  );
}
