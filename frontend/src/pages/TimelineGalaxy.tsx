/* ═══════════════════════════════════════════════════════════
   FE-2 — TimelineGalaxy (/timeline-galaxy/:id)

   G6 force layout with the x-axis bound to a normalized round/time
   accessor. Shares the `kg_explorer` capability gate with KGExplorerView.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { useG6Graph } from '../hooks/useG6Graph';
import { forceTimelineLayout } from '../lib/g6Layouts';
import { resolveG6Tokens } from '../lib/graphTokens';
import { buildSessionHeaders } from '../api/client';

interface GalaxyNode {
  id: string;
  label: string;
  round: number | null;
}

interface GalaxyEdge {
  id: string;
  source: string;
  target: string;
}

interface GalaxyPayload {
  nodes: GalaxyNode[];
  edges: GalaxyEdge[];
  /** Maximum round, used for x-axis normalization. */
  max_round?: number | null;
}

export default function TimelineGalaxy() {
  const { id: scenarioId = '' } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const { loading: capLoading, enabled: capEnabled } = useCapabilityCheck('kg_explorer');

  const [payload, setPayload] = useState<GalaxyPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!capEnabled || !scenarioId) return;
    let cancelled = false;
    const apiBase = (typeof window !== 'undefined'
      ? (window as unknown as { __API_BASE__?: string }).__API_BASE__
      : undefined) ?? '/api';
    fetch(`${apiBase}/scenario/${encodeURIComponent(scenarioId)}/causal-graph`, {
      headers: buildSessionHeaders(),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`http_${res.status}`);
        const data = (await res.json()) as { nodes: GalaxyNode[]; edges: GalaxyEdge[] };
        const maxRound = data.nodes.reduce<number>((acc, n) => {
          if (typeof n.round === 'number' && n.round > acc) return n.round;
          return acc;
        }, 0);
        if (!cancelled) setPayload({ ...data, max_round: maxRound });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'unknown_error');
      });
    return () => {
      cancelled = true;
    };
  }, [capEnabled, scenarioId]);

  const theme: 'light' | 'dark' =
    typeof document !== 'undefined' && document.documentElement.dataset?.theme === 'dark'
      ? 'dark'
      : 'light';
  const tokens = useMemo(() => resolveG6Tokens(theme), [theme]);

  const g6Options = useMemo(() => {
    const nodes = (payload?.nodes ?? []).map((n) => ({
      id: n.id,
      type: 'circle',
      style: { labelText: n.label, labelPlacement: 'bottom' as const },
      data: { round: n.round ?? 0 },
    }));
    const edges = (payload?.edges ?? []).map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
    }));
    const maxRound = Math.max(1, payload?.max_round ?? 1);
    return {
      data: { nodes, edges },
      autoFit: 'view' as const,
      layout: forceTimelineLayout({
        width: 1000,
        timeAccessor: (d) => {
          const round = (d.data?.round as number | undefined) ?? 0;
          return round / maxRound;
        },
      }),
      node: { style: { fill: tokens.nodeFill, stroke: tokens.nodeStroke } },
      edge: { style: { stroke: tokens.edgeStroke } },
      background: tokens.background,
      behaviors: ['zoom-canvas', 'drag-canvas'],
    };
  }, [payload, tokens]);

  const handleNodeClick = useCallback(
    (evt: unknown) => {
      const target = (evt as { target?: { id?: string; type?: string } } | undefined)?.target;
      if (typeof window === 'undefined') return;
      window.dispatchEvent(
        new CustomEvent('kg:openNodeSheet', {
          detail: {
            scenarioId,
            identityId: target?.id ?? '',
            originContext: { graphNodeType: 'timeline-galaxy' },
          },
        }),
      );
    },
    [scenarioId],
  );

  useG6Graph({
    containerRef,
    options: g6Options,
    onNodeClick: handleNodeClick,
  });

  if (capLoading) {
    return (
      <div data-testid="timeline-galaxy-root" className="p-6 text-sm">
        {t('common.loading', 'Loading…')}
      </div>
    );
  }
  if (!capEnabled) {
    return (
      <div data-testid="timeline-galaxy-root" className="p-6 text-sm" role="alert">
        <h1>{t('kg_explorer.feature_disabled_title', 'Feature unavailable')}</h1>
        <p>{t('kg_explorer.feature_disabled', 'KG Explorer is not enabled on this server.')}</p>
        <Link to="/">{t('common.back_home', 'Back to home')}</Link>
      </div>
    );
  }

  return (
    <main data-testid="timeline-galaxy-root" style={{ padding: '0.75rem' }}>
      <h1 style={{ fontSize: '1.125rem', fontWeight: 600 }}>
        {t('timeline_galaxy.title', 'Timeline Galaxy')}
      </h1>
      <div
        ref={containerRef}
        tabIndex={0}
        role="application"
        aria-label={t('timeline_galaxy.canvas_aria', 'Timeline graph canvas')}
        style={{
          width: '100%',
          minHeight: 480,
          background: tokens.background,
          outline: 'none',
        }}
      />
      {error && (
        <p role="alert" style={{ color: 'red', fontSize: '0.8rem' }}>
          {error}
        </p>
      )}
    </main>
  );
}
