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
import { buildKgNodeLabel } from '../lib/kgGraphConfig';
import { buildSessionHeaders } from '../api/client';
import { getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import { NodeDetailPanel, type NodeDetail, type NodeDetailEvidence } from '../components/NodeDetailPanel';

interface GalaxyNode {
  id: string;
  label: string;
  type?: string;
  round: number | null;
  payload?: unknown;
}

interface GalaxyEdge extends NodeDetailEvidence {
  id: string;
  source: string;
  target: string;
  evidence?: NodeDetailEvidence | null;
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
  const {
    loading: capLoading,
    enabled: explorerEnabled,
    capabilities,
    error: capError,
    reload: reloadCapability,
  } = useCapabilityCheck('kg_explorer');

  const causalEnabled = capabilities
    ? capabilities.causal_graph?.enabled === true
    : explorerEnabled;
  const capEnabled = explorerEnabled && causalEnabled;

  const [loadedPayload, setLoadedPayload] = useState<{ scenarioId: string; data: GalaxyPayload } | null>(null);
  const payload = loadedPayload?.scenarioId === scenarioId ? loadedPayload.data : null;
  const [loadError, setError] = useState<{ scenarioId: string; status: number | null; code: string | null } | null>(null);
  const error = loadError?.scenarioId === scenarioId ? loadError : null;
  const [selection, setSelection] = useState<{ scenarioId: string; nodeId: string } | null>(null);
  const [unavailableNodeScenario, setUnavailableNodeScenario] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (capError || !capEnabled || !scenarioId) return;
    let cancelled = false;
    const apiBase = (typeof window !== 'undefined'
      ? (window as unknown as { __API_BASE__?: string }).__API_BASE__
      : undefined) ?? '/api';
    fetch(`${apiBase}/scenario/${encodeURIComponent(scenarioId)}/causal-graph`, {
      headers: buildSessionHeaders(),
    })
      .then(async (res) => {
        if (!res.ok) {
          let code: string | null = null;
          try {
            const body = await res.json();
            if (body && typeof body === 'object') {
              const r = body as Record<string, unknown>;
              if (r.detail && typeof r.detail === 'object') {
                const dr = r.detail as Record<string, unknown>;
                if (typeof dr.code === 'string') code = dr.code;
              } else if (typeof r.code === 'string') {
                code = r.code;
              }
            }
          } catch {
            // ignore error body parsing failures
          }
          throw { status: res.status, code };
        }
        const data = (await res.json()) as { nodes: GalaxyNode[]; edges: GalaxyEdge[] };
        const maxRound = data.nodes.reduce<number>((acc, n) => {
          if (typeof n.round === 'number' && n.round > acc) return n.round;
          return acc;
        }, 0);
        if (!cancelled) {
          setError(null);
          setLoadedPayload({ scenarioId, data: { ...data, max_round: maxRound } });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err && typeof err === 'object' && ('status' in err || 'code' in err)) {
          const e = err as { status: number | null; code: string | null };
          setError({ scenarioId, status: e.status, code: e.code });
        } else {
          setError({ scenarioId, status: null, code: 'NETWORK_ERROR' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [capEnabled, capError, scenarioId, retryNonce]);

  const theme: 'light' | 'dark' =
    typeof document !== 'undefined' && document.documentElement.dataset?.theme === 'dark'
      ? 'dark'
      : 'light';
  const tokens = useMemo(() => resolveG6Tokens(theme), [theme]);
  const nodesById = useMemo(() => new Map((payload?.nodes ?? []).map((node) => [node.id, node])), [payload]);
  const selectedNode = useMemo<NodeDetail | null>(() => {
    if (selection?.scenarioId !== scenarioId) return null;
    const node = nodesById.get(selection.nodeId);
    if (!node) return null;
    return {
      ...node,
      type: node.type || 'unknown',
      evidenceList: (payload?.edges ?? [])
        .filter((edge) => edge.source === node.id || edge.target === node.id)
        .map((edge) => ({
          ...edge.evidence,
          direction: edge.source === node.id ? 'outgoing' : 'incoming',
          metric_kind: edge.metric_kind,
          provenance_kind: edge.provenance_kind,
          synthetic_provenance: edge.synthetic_provenance,
          evidence_status: edge.evidence_status,
          evidence_caveat: edge.evidence_caveat,
          caveat: edge.caveat,
        })),
    };
  }, [nodesById, payload, scenarioId, selection]);

  const g6Options = useMemo(() => {
    const nodes = (payload?.nodes ?? []).map((n) => ({
      id: n.id,
      type: 'circle',
      style: { labelText: buildKgNodeLabel(n.label, n.round, n.payload), labelPlacement: 'bottom' as const },
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
      const target = (evt as { target?: { id?: unknown; get?: (key: string) => unknown } } | undefined)?.target;
      const nodeId = target?.id ?? target?.get?.('id');
      if (typeof nodeId !== 'string' || !nodesById.has(nodeId)) {
        setSelection(null);
        setUnavailableNodeScenario(scenarioId);
        return;
      }
      setUnavailableNodeScenario(null);
      containerRef.current?.focus();
      setSelection({ scenarioId, nodeId });
    },
    [nodesById, scenarioId],
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
  if (capError) {
    return (
      <div data-testid="timeline-galaxy-root" className="p-6 text-sm" role="alert">
        <h1>{t('common.capability_error_title', 'Cannot verify feature')}</h1>
        <p>{t('common.capability_error', 'Unable to verify feature availability. Please try again.')}</p>
        <button type="button" onClick={() => void reloadCapability?.()}>
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }
  // Only a real FEATURE_DISABLED code (or a failed capability probe) means the
  // feature is off; a 403 is an auth error and falls to the localized error
  // surface below — matching CausalGraphBoard/KGGraphBoard.
  const isFeatureDisabled =
    !capEnabled ||
    Boolean(error && error.code === 'FEATURE_DISABLED');

  if (isFeatureDisabled) {
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
      <div style={{ position: 'relative' }}>
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
        <NodeDetailPanel
          key={selectedNode?.id ?? 'closed'}
          panelId="timeline-node-detail"
          node={selectedNode}
          onClose={() => setSelection(null)}
        />
      </div>
      {unavailableNodeScenario === scenarioId && (
        <div role="alert">
          <p>{t('timeline_galaxy.node_unavailable')}</p>
          <button type="button" onClick={() => {
            setUnavailableNodeScenario(null);
            setRetryNonce((current) => current + 1);
          }}>
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}
      {error && (
        <div role="alert" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.4rem', marginTop: '0.5rem' }}>
          <p style={{ color: 'var(--text-error, #c0392b)', fontSize: '0.8rem', margin: 0 }}>
            {getLocalizedApiErrorMessage(
              error,
              t,
              t('timeline_galaxy.load_error', 'Unable to load the timeline right now. Please retry.'),
            )}
          </p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setRetryNonce((n) => n + 1);
            }}
            style={{
              padding: '4px 10px',
              borderRadius: 4,
              border: '1px solid var(--border-default, #ccc)',
              background: 'transparent',
              color: 'var(--text-link, #8ab4f8)',
              cursor: 'pointer',
              fontSize: '0.78rem',
            }}
          >
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}
    </main>
  );
}
