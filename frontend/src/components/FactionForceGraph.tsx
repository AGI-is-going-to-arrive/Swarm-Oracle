import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getFactionRelations, isApiError, type FactionRelationEdge, type FactionRelationsResponse } from '../api/client';
import { useG6Graph } from '../hooks/useG6Graph';
import { forceTimelineLayout } from '../lib/g6Layouts';
import { Slider } from './ui/slider';

const TRUST_COLOR = '#2ecc71';
const OPPOSITION_COLOR = '#e74c3c';
const FACTION_COLORS = ['#4a90d9', '#e74c3c', '#2ecc71', '#9b59b6', '#e67e22', '#1abc9c', '#f1c40f', '#e91e63'];
const MIN_AGENTS_FOR_GRAPH = 4;

export interface FactionForceGraphProps {
  scenarioId: string;
  branchId: string;
  factions: Array<{ key: string; members: string[]; label?: string }>;
  totalRounds: number;
  agentNames?: Record<string, string>;
}

interface G6NodeData {
  id: string;
  data: { label: string; edgeCount: number; factionColor: string; combo: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface G6EdgeData {
  id: string;
  source: string;
  target: string;
  data: { relationType: 'trust' | 'opposition'; weight: number; [key: string]: unknown };
  [key: string]: unknown;
}

interface G6ComboData {
  id: string;
  data: { label: string; color: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface G6Data {
  nodes: G6NodeData[];
  edges: G6EdgeData[];
  combos: G6ComboData[];
}

function buildAgentFactionMap(
  factions: FactionForceGraphProps['factions'],
): Record<string, { factionKey: string; color: string }> {
  const map: Record<string, { factionKey: string; color: string }> = {};
  factions.forEach((f, idx) => {
    const color = FACTION_COLORS[idx % FACTION_COLORS.length];
    f.members.forEach((m) => {
      map[m] = { factionKey: f.key, color };
    });
  });
  return map;
}

// exported for testing only — keep below FactionForceGraph to satisfy react-refresh
// eslint-disable-next-line react-refresh/only-export-components
export function transformToG6Data(
  edges: FactionRelationEdge[],
  factions: FactionForceGraphProps['factions'],
  targetRound: number,
  agentNames?: Record<string, string>,
): G6Data {
  const filteredEdges = edges.filter((e) => e.round <= targetRound);
  const agentFactionMap = buildAgentFactionMap(factions);

  const agentEdgeCount: Record<string, number> = {};
  filteredEdges.forEach((e) => {
    agentEdgeCount[e.source_agent_id] = (agentEdgeCount[e.source_agent_id] ?? 0) + 1;
    agentEdgeCount[e.target_agent_id] = (agentEdgeCount[e.target_agent_id] ?? 0) + 1;
  });

  const uniqueAgents = new Set<string>();
  filteredEdges.forEach((e) => {
    uniqueAgents.add(e.source_agent_id);
    uniqueAgents.add(e.target_agent_id);
  });

  const nodes: G6NodeData[] = [...uniqueAgents].map((agentId) => {
    const info = agentFactionMap[agentId];
    return {
      id: agentId,
      data: {
        label: agentNames?.[agentId] ?? agentId.slice(0, 8),
        edgeCount: agentEdgeCount[agentId] ?? 0,
        factionColor: info?.color ?? '#888',
        combo: info?.factionKey ?? 'unknown',
      },
    };
  });

  const g6Edges: G6EdgeData[] = filteredEdges.map((e) => ({
    id: e.id,
    source: e.source_agent_id,
    target: e.target_agent_id,
    data: {
      relationType: e.relation_type,
      weight: e.weight,
    },
  }));

  const comboKeys = new Set(nodes.map((n) => n.data.combo));
  const combos: G6ComboData[] = [...comboKeys].map((key) => {
    const idx = factions.findIndex((f) => f.key === key);
    return {
      id: key,
      data: {
        label: (idx >= 0 ? factions[idx].label : key) ?? key,
        color: idx >= 0 ? FACTION_COLORS[idx % FACTION_COLORS.length] : '#888',
      },
    };
  });

  return { nodes, edges: g6Edges, combos };
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setReduced(e.matches);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener?.('change', handler);
    }
    mql.addListener?.(handler);
    return () => mql.removeListener?.(handler);
  }, []);
  return reduced;
}

export function FactionForceGraph({
  scenarioId,
  branchId,
  factions,
  totalRounds,
  agentNames,
}: FactionForceGraphProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  const [currentRound, setCurrentRound] = useState(totalRounds);
  const [debouncedRound, setDebouncedRound] = useState(totalRounds);
  const [relationsData, setRelationsData] = useState<FactionRelationsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchIdRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedRound(currentRound), 200);
    return () => clearTimeout(timer);
  }, [currentRound]);

  const allAgentIds = useMemo(() => {
    const ids = new Set<string>();
    factions.forEach((f) => f.members.forEach((m) => ids.add(m)));
    return ids;
  }, [factions]);

  const isEmpty = totalRounds < 1 || factions.length === 0 || allAgentIds.size < MIN_AGENTS_FOR_GRAPH;

  const fetchRelations = useCallback(async (round: number) => {
    fetchIdRef.current += 1;
    const requestId = fetchIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await getFactionRelations(scenarioId, branchId, { roundMax: round });
      if (requestId !== fetchIdRef.current) return;
      setRelationsData(data);
    } catch (err) {
      if (requestId !== fetchIdRef.current) return;
      const message = isApiError(err) ? (err as Error).message : 'fetch_error';
      setError(message);
    } finally {
      if (requestId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [scenarioId, branchId]);

  useEffect(() => {
    if (!isEmpty) {
      void fetchRelations(debouncedRound);
    }
  }, [fetchRelations, debouncedRound, isEmpty]);

  const g6Data = useMemo(() => {
    if (!relationsData) return { nodes: [], edges: [], combos: [] };
    return transformToG6Data(relationsData.edges, factions, currentRound, agentNames);
  }, [relationsData, factions, currentRound, agentNames]);

  type D = { data?: Record<string, unknown> };
  const g6Options = useMemo(() => ({
    data: g6Data as unknown as Record<string, unknown>,
    layout: prefersReducedMotion
      ? { type: 'force', animate: false, maxIteration: 0, preventOverlap: true, nodeSize: 20 }
      : forceTimelineLayout({ width: 500 }),
    node: {
      style: {
        size: (d: D) => 12 + (Number(d.data?.edgeCount) || 0) * 2,
        fill: (d: D) => (d.data?.factionColor as string) ?? '#888',
        stroke: '#fff',
        lineWidth: 1,
        labelText: (d: D) => (d.data?.label as string) ?? '',
        labelFontSize: 9,
        labelFill: '#e0e0e0',
      },
    },
    edge: {
      style: {
        stroke: (d: D) => d.data?.relationType === 'trust' ? TRUST_COLOR : OPPOSITION_COLOR,
        lineWidth: (d: D) => Math.max(1, (Number(d.data?.weight) || 0.5) * 3),
        opacity: 0.7,
      },
    },
    combo: {
      style: {
        fill: (d: D) => d.data?.color ? `${d.data.color as string}20` : 'rgba(100,100,100,0.1)',
        stroke: (d: D) => (d.data?.color as string) ?? '#888',
        labelText: (d: D) => (d.data?.label as string) ?? '',
        labelFontSize: 10,
        labelFill: '#aaa',
      },
    },
    autoFit: 'view' as const,
    behaviors: ['drag-canvas', 'zoom-canvas'],
  }), [g6Data, prefersReducedMotion]);

  useG6Graph({ containerRef, options: g6Options });

  const handleSliderChange = useCallback((value: number[]) => {
    setCurrentRound(value[0]);
  }, []);

  if (isEmpty) {
    const message = allAgentIds.size < MIN_AGENTS_FOR_GRAPH
      ? t('factions.force_graph_empty_few_agents', 'The force graph requires at least 4 agents to display meaningful faction relationships.')
      : t('factions.force_graph_empty_no_data', 'No faction data available for this scenario.');
    return (
      <div data-testid="faction-force-graph-empty" style={{ padding: '1rem', textAlign: 'center', color: '#9aa4b2', fontSize: '0.85rem' }}>
        <p>{message}</p>
      </div>
    );
  }

  return (
    <div data-testid="faction-force-graph" style={{ display: 'grid', gap: '0.75rem' }}>
      <h4 style={{ margin: 0, fontSize: '0.95rem' }}>
        {t('factions.force_graph_title', 'Faction Force Graph')}
      </h4>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <label
          htmlFor="faction-round-slider"
          style={{ fontSize: '0.8rem', color: '#9aa4b2', whiteSpace: 'nowrap' }}
        >
          {t('factions.force_graph_slider_label', 'Round')}
        </label>
        <Slider
          id="faction-round-slider"
          data-testid="faction-round-slider"
          aria-label={t('factions.force_graph_slider_label', 'Round')}
          min={1}
          max={totalRounds}
          step={1}
          value={[currentRound]}
          onValueChange={handleSliderChange}
          style={{ flex: 1, minWidth: '120px' }}
        />
        <span style={{ fontSize: '0.78rem', color: '#cfe1ff', minWidth: '3.5rem', textAlign: 'right' }}>
          {t('factions.force_graph_slider_round', 'Round {{round}}', { round: currentRound })}
        </span>
      </div>

      {relationsData?.truncated && (
        <p
          data-testid="faction-truncated-warning"
          role="alert"
          style={{ margin: 0, fontSize: '0.78rem', color: '#e67e22', padding: '0.35rem 0.55rem', background: 'rgba(230, 126, 34, 0.1)', borderRadius: '4px', border: '1px solid rgba(230, 126, 34, 0.25)' }}
        >
          {t('factions.force_graph_truncated_warning', 'Some weaker relations are hidden due to the display limit.')}
        </p>
      )}

      <div style={{ display: 'flex', gap: '0.6rem', fontSize: '0.72rem', color: '#9aa4b2' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <span style={{ width: 10, height: 3, background: TRUST_COLOR, borderRadius: 2, display: 'inline-block' }} />
          {t('factions.force_graph_relation_trust', 'Trust')}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
          <span style={{ width: 10, height: 3, background: OPPOSITION_COLOR, borderRadius: 2, display: 'inline-block' }} />
          {t('factions.force_graph_relation_opposition', 'Opposition')}
        </span>
      </div>

      {error && (
        <div data-testid="faction-force-graph-error" style={{ textAlign: 'center', padding: '1rem' }}>
          <p style={{ color: '#e74c3c', fontSize: '0.85rem', margin: '0 0 0.5rem' }}>{error}</p>
          <button
            onClick={() => void fetchRelations(currentRound)}
            style={{ fontSize: '0.78rem', padding: '0.35rem 0.75rem', cursor: 'pointer', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '4px', color: '#cfe1ff' }}
          >
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        tabIndex={0}
        role="application"
        aria-label={t('factions.force_graph_a11y_label', 'Faction force graph canvas')}
        data-testid="faction-force-graph-canvas"
        style={{
          width: '100%',
          height: 320,
          borderRadius: '6px',
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(0,0,0,0.15)',
          position: 'relative',
          opacity: loading ? 0.5 : 1,
          transition: prefersReducedMotion ? 'none' : 'opacity 0.2s',
        }}
      />

      {/* a11y: screen reader fallback lists for graph content */}
      <div className="sr-only" role="list" aria-label={t('factions.force_graph_a11y_nodes', 'Faction agent nodes')}>
        {g6Data.nodes.map((node) => (
          <div key={node.id} role="listitem">
            {t('factions.force_graph_a11y_node', '{{name}}, faction {{faction}}', {
              name: node.data.label,
              faction: node.data.combo,
            })}
          </div>
        ))}
      </div>
      <div className="sr-only" role="list" aria-label={t('factions.force_graph_a11y_edges', 'Faction relation edges')}>
        {g6Data.edges.map((edge) => {
          const sourceName = agentNames?.[edge.source] ?? edge.source.slice(0, 8);
          const targetName = agentNames?.[edge.target] ?? edge.target.slice(0, 8);
          return (
            <div key={edge.id} role="listitem">
              {edge.data.relationType === 'trust'
                ? t('factions.force_graph_a11y_edge_trust', 'Trust: {{source}} → {{target}}', { source: sourceName, target: targetName })
                : t('factions.force_graph_a11y_edge_opposition', 'Opposition: {{source}} → {{target}}', { source: sourceName, target: targetName })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
