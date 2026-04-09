/* ═══════════════════════════════════════════════════════════
   Phase 3 F2 — Causal Review View
   Displays a DAG of causal events extracted from a simulation.
   Uses @xyflow/react (already a dependency) with dagre layout.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

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
}

const NODE_TYPE_COLORS: Record<string, string> = {
  event: '#4a90d9',
  intervention: '#e67e22',
  stance_shift: '#9b59b6',
  fork: '#e74c3c',
  round: '#2ecc71',
  verdict: '#f1c40f',
};

function layoutDagre(nodes: GraphNodeData[], edges: GraphEdgeData[]): { nodes: Node[]; edges: Edge[] } {
  // Simple left-to-right layout by round number
  const sorted = [...nodes].sort((a, b) => (a.round ?? 0) - (b.round ?? 0));
  const roundGroups = new Map<number, GraphNodeData[]>();
  for (const n of sorted) {
    const r = n.round ?? 0;
    if (!roundGroups.has(r)) roundGroups.set(r, []);
    roundGroups.get(r)!.push(n);
  }

  const flowNodes: Node[] = [];
  let x = 0;
  for (const [, group] of [...roundGroups.entries()].sort((a, b) => a[0] - b[0])) {
    let y = 0;
    for (const n of group) {
      flowNodes.push({
        id: n.id,
        position: { x, y },
        data: { label: n.label || n.key },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: NODE_TYPE_COLORS[n.type] ?? '#555',
          color: '#fff',
          borderRadius: 6,
          padding: '8px 12px',
          fontSize: '0.8rem',
          border: 'none',
          maxWidth: 180,
        },
      });
      y += 80;
    }
    x += 240;
  }

  const flowEdges: Edge[] = edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label ?? undefined,
    animated: e.type === 'caused',
    style: { stroke: '#888' },
  }));

  return { nodes: flowNodes, edges: flowEdges };
}

export function CausalReviewView() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [graphData, setGraphData] = useState<CausalGraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetch(`/api/scenario/${id}/causal-graph`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => { setGraphData(data); setLoading(false); })
      .catch(err => { setError((err as Error).message); setLoading(false); });
  }, [id]);

  const { nodes, edges } = useMemo(() => {
    if (!graphData || graphData.nodes.length === 0) return { nodes: [], edges: [] };
    return layoutDagre(graphData.nodes, graphData.edges);
  }, [graphData]);

  const onNodesChange = useCallback(() => {}, []);
  const onEdgesChange = useCallback(() => {}, []);

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
        <Link to={`/result/${id}`} style={{ color: '#8ab4f8' }}>
          {t('common.back_to_result', 'Back to Result')}
        </Link>
      </div>
    );
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', borderBottom: '1px solid #333' }}>
        <Link to={`/result/${id}`} style={{ color: '#8ab4f8', textDecoration: 'none' }}>
          ← {t('common.back_to_result', 'Back to Result')}
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.2rem' }}>{t('causal.title', 'Causal Graph')}</h1>
        <span style={{ color: '#888', fontSize: '0.85rem' }}>
          {nodes.length} {t('causal.nodes', 'nodes')} · {edges.length} {t('causal.edges', 'edges')}
        </span>
      </div>

      {nodes.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: '#888' }}>{t('causal.empty', 'No causal graph data available for this scenario.')}</p>
        </div>
      ) : (
        <div style={{ flex: 1 }}>
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
          </ReactFlow>
        </div>
      )}

      {/* a11y: screen reader fallback list (Gemini review recommendation) */}
      <div className="sr-only" role="list" aria-label={t('causal.a11y_list', 'Causal events list')}>
        {graphData?.nodes.map(n => (
          <div key={n.id} role="listitem">
            {n.type}: {n.label} ({t('causal.round_label', 'Round')} {n.round ?? '?'})
          </div>
        ))}
      </div>
    </div>
  );
}

export default CausalReviewView;
