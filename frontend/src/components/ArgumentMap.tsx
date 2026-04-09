/* ═══════════════════════════════════════════════════════════
   Phase 3 F6 — Debate Argument Map Panel
   Displays argument units as an interactive DAG using @xyflow/react.
   Upgraded from flat tree to ReactFlow graph (P1-6).
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import dagre from 'dagre';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ── Data Types ──────────────────────────────────────────────

interface ArgumentUnit {
  id: string;
  type: string;  // claim | evidence | rebuttal | counter
  status: string; // standing | rebutted | unaddressed | accepted | rejected
  text: string;
  turn_id: string;
  node_id?: string;
}

interface GraphNodeRaw {
  id: string;
  key: string;
  type: string;
  label: string;
  round: number | null;
  payload: unknown;
}

interface GraphEdgeRaw {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number | null;
  label: string | null;
}

interface ArgumentMapData {
  snapshot_id: string | null;
  nodes: GraphNodeRaw[];
  edges: GraphEdgeRaw[];
  units: ArgumentUnit[];
}

// ── Style Constants ─────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  standing: '#2ecc71',
  rebutted: '#e74c3c',
  unaddressed: '#888',
  accepted: '#4a90d9',
  rejected: '#e74c3c',
};

const TYPE_COLORS: Record<string, string> = {
  claim: '#4a90d9',
  evidence: '#2ecc71',
  rebuttal: '#e74c3c',
  counter: '#e67e22',
};

// Labels resolved via i18n in render — key → [i18n_key, fallback]
const TYPE_LABEL_I18N: Record<string, [string, string]> = {
  claim: ['argument.claim', 'Claim'],
  evidence: ['argument.evidence', 'Evidence'],
  rebuttal: ['argument.rebuttal', 'Rebuttal'],
  counter: ['argument.counter', 'Counter'],
};

const EDGE_STYLE_MAP: Record<string, { stroke: string; animated: boolean }> = {
  supports: { stroke: '#2ecc71', animated: false },
  attacks: { stroke: '#e74c3c', animated: true },
  rebuts: { stroke: '#e67e22', animated: true },
};

// ── Strength Meter (P1-7) ───────────────────────────────────

interface StrengthMeterProps {
  units: ArgumentUnit[];
  compact?: boolean;
}

const STATUS_ORDER = ['accepted', 'standing', 'unaddressed', 'rebutted', 'rejected'] as const;
const STATUS_LABEL_I18N: Record<string, [string, string]> = {
  standing: ['argument.status_standing', 'Standing'],
  rebutted: ['argument.status_rebutted', 'Rebutted'],
  unaddressed: ['argument.status_unaddressed', 'Unaddressed'],
  accepted: ['argument.status_accepted', 'Accepted'],
  rejected: ['argument.status_rejected', 'Rejected'],
};

export function ArgumentStrengthMeter({ units, compact }: StrengthMeterProps) {
  const { t } = useTranslation();
  const total = units.length;
  if (total === 0) return null;

  const counts: Record<string, number> = {};
  for (const u of units) {
    counts[u.status] = (counts[u.status] ?? 0) + 1;
  }

  return (
    <div
      role="meter"
      aria-label={t('argument.strength_label', 'Argument strength distribution')}
      aria-valuemin={0}
      aria-valuemax={total}
      style={{
        display: 'flex',
        height: compact ? 4 : 8,
        borderRadius: compact ? 2 : 4,
        overflow: 'hidden',
        background: '#222',
        width: '100%',
      }}
    >
      {STATUS_ORDER.map(status => {
        const count = counts[status] ?? 0;
        if (count === 0) return null;
        const pct = (count / total) * 100;
        return (
          <div
            key={status}
            title={`${t(STATUS_LABEL_I18N[status][0], STATUS_LABEL_I18N[status][1])}: ${count}/${total}`}
            style={{
              width: `${pct}%`,
              background: STATUS_COLORS[status] ?? '#555',
              transition: 'width 0.3s ease',
            }}
          />
        );
      })}
    </div>
  );
}

// ── DAG Layout ──────────────────────────────────────────────

function layoutArgumentDag(
  rawNodes: GraphNodeRaw[],
  rawEdges: GraphEdgeRaw[],
  units: ArgumentUnit[],
  t: (key: string, fallback: string) => string,
): { nodes: Node[]; edges: Edge[] } {
  // Build unit lookup by node_id for status enrichment
  const unitByNodeId = new Map<string, ArgumentUnit>();
  for (const u of units) {
    if (u.node_id) unitByNodeId.set(u.node_id, u);
  }

  // If no graph nodes, synthesise from units
  const hasGraphNodes = rawNodes.length > 0;

  const nodeWidth = 220;
  const nodeHeight = 60;

  // Build dagre graph
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', ranksep: 60, nodesep: 30 });

  if (!hasGraphNodes) {
    // Fallback: create synthetic nodes from units
    for (const u of units) {
      g.setNode(u.id, { width: nodeWidth, height: nodeHeight });
    }
    // No edges in fallback
  } else {
    for (const n of rawNodes) {
      g.setNode(n.id, { width: nodeWidth, height: nodeHeight });
    }
    for (const e of rawEdges) {
      g.setEdge(e.source, e.target);
    }
  }

  dagre.layout(g);

  // Convert to ReactFlow nodes
  const flowNodes: Node[] = [];

  if (!hasGraphNodes) {
    for (const u of units) {
      const pos = g.node(u.id);
      const label = u.text.length > 60 ? u.text.slice(0, 60) + '…' : u.text;
      flowNodes.push({
        id: u.id,
        position: { x: pos.x - nodeWidth / 2, y: pos.y - nodeHeight / 2 },
        data: { label },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        style: {
          background: TYPE_COLORS[u.type] ?? '#555',
          color: '#fff',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: '0.75rem',
          maxWidth: nodeWidth,
          border: `2px solid ${STATUS_COLORS[u.status] ?? '#555'}`,
        },
      });
    }
    return { nodes: flowNodes, edges: [] };
  }

  // Primary path: graph nodes laid out by dagre
  for (const n of rawNodes) {
    const pos = g.node(n.id);
    const unit = unitByNodeId.get(n.id);
    const typeKey = unit?.type ?? n.type;
    const statusKey = unit?.status ?? 'standing';
    const typePair = TYPE_LABEL_I18N[typeKey];
    const typeLabel = typePair ? t(typePair[0], typePair[1]) : typeKey;
    const displayLabel = n.label.length > 60 ? n.label.slice(0, 60) + '…' : n.label;

    flowNodes.push({
      id: n.id,
      position: { x: pos.x - nodeWidth / 2, y: pos.y - nodeHeight / 2 },
      data: { label: `[${typeLabel}] ${displayLabel}` },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      style: {
        background: TYPE_COLORS[typeKey] ?? '#555',
        color: '#fff',
        borderRadius: 6,
        padding: '8px 12px',
        fontSize: '0.75rem',
        maxWidth: nodeWidth,
        border: `2px solid ${STATUS_COLORS[statusKey] ?? '#555'}`,
      },
    });
  }

  const flowEdges: Edge[] = rawEdges.map(e => {
    const edgeStyle = EDGE_STYLE_MAP[e.type] ?? { stroke: '#888', animated: false };
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label ?? undefined,
      animated: edgeStyle.animated,
      style: { stroke: edgeStyle.stroke },
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}

// ── Main Component ──────────────────────────────────────────

interface Props {
  debateId: string;
  visible: boolean;
  /** Increment to trigger a re-fetch without remounting the component */
  refreshTrigger?: number;
}

export function ArgumentMap({ debateId, visible, refreshTrigger }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<ArgumentMapData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/debate/${debateId}/argument-map`);
      if (res.status === 501) { setData(null); setLoading(false); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setData(d);
    } catch { setData(null); }
    setLoading(false);
  }, [debateId]);

  useEffect(() => {
    if (!visible || !debateId) return;
    fetchData();
  }, [debateId, visible, fetchData, refreshTrigger]);

  const { nodes, edges } = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    return layoutArgumentDag(data.nodes, data.edges, data.units, t);
  }, [data, t]);

  const onNodesChange = useCallback(() => {}, []);
  const onEdgesChange = useCallback(() => {}, []);

  if (!visible) return null;
  if (loading) return <p style={{ fontSize: '0.85rem', color: '#888' }}>{t('common.loading', 'Loading...')}</p>;
  if (!data || (data.units.length === 0 && data.nodes.length === 0)) {
    return <p style={{ fontSize: '0.85rem', color: '#888' }}>{t('argument.empty', 'No argument map available.')}</p>;
  }

  return (
    <div
      aria-label={t('argument.a11y_label', 'Debate argument map')}
      style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
    >
      {/* P1-7: Strength meter summary */}
      <ArgumentStrengthMeter units={data.units} />

      {/* DAG container */}
      <div style={{ height: 360, border: '1px solid #333', borderRadius: 6, overflow: 'hidden' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
          <MiniMap
            nodeStrokeWidth={3}
            style={{ background: '#1a1a2e' }}
          />
        </ReactFlow>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.7rem', color: '#888' }}>
        {(['claim', 'evidence', 'rebuttal', 'counter'] as const).map(type => {
          const pair = TYPE_LABEL_I18N[type];
          return (
            <span key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: TYPE_COLORS[type], display: 'inline-block' }} />
              {t(pair[0], pair[1])}
            </span>
          );
        })}
        <span style={{ marginLeft: 'auto' }}>
          {data.units.length} {t('argument.total_units', 'units')}
        </span>
      </div>

      {/* a11y: screen reader fallback list */}
      <div className="sr-only" role="list" aria-label={t('argument.a11y_list', 'Argument units list')}>
        {data.units.map(u => (
          <div key={u.id} role="listitem">
            {u.type}: {u.text} [{u.status}]
          </div>
        ))}
      </div>
    </div>
  );
}

export { STATUS_COLORS, TYPE_LABEL_I18N };
export type { ArgumentUnit, ArgumentMapData };
