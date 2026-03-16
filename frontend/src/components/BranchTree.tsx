/* ═══════════════════════════════════════════════════════════
   SwarmOracle — BranchTree (React Flow Canvas)
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';

import { BranchNode } from './BranchNode';
import { BranchEdge } from './BranchEdge';
import { useSimulationStore } from '../stores/simulationStore';
import type { Branch } from '../types';
import './BranchTree.css';

// ── Node types registration ─────────────────────────────────
const nodeTypes = { branchNode: BranchNode };
const edgeTypes = { branchEdge: BranchEdge };

// ── Dagre auto-layout ───────────────────────────────────────
const LAYOUT_CONFIG = {
  rankdir: 'TB' as const,
  nodesep: 120,
  ranksep: 160,
  marginx: 60,
  marginy: 60,
};

const NODE_WIDTH = 340;
const NODE_HEIGHT = 200;

function getLayoutedElements(rawNodes: Node[], rawEdges: Edge[]) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph(LAYOUT_CONFIG);

  rawNodes.forEach((node) => {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  rawEdges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  dagre.layout(g);

  const layoutedNodes = rawNodes.map((node) => {
    const { x, y } = g.node(node.id);
    return {
      ...node,
      position: { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 },
    };
  });

  return { nodes: layoutedNodes, edges: rawEdges };
}

// ── Convert branches to React Flow elements ─────────────────
function branchesToFlow(
  branches: Branch[],
  agents: { id: string; name: string }[],
  branchActivity: Record<string, { thinking: number; recent: number }>,
  onIntervene?: (branchId: string, title: string) => void,
  onDetail?: (branchId: string) => void,
): {
  nodes: Node[];
  edges: Edge[];
} {
  if (branches.length === 0) {
    return { nodes: [], edges: [] };
  }

  const rawNodes: Node[] = branches.map((b) => {
    const activity = branchActivity[b.id] || { thinking: 0, recent: 0 };
    return {
      id: b.id,
      type: 'branchNode',
      position: { x: 0, y: 0 },
      data: {
        title: b.title || '',
        description: b.description,
        probability: b.probability,
        status: b.status,
        forkReason: b.fork_reason,
        story: b.story,
        agentNames: agents.slice(0, 6).map((a) => a.name),
        branchId: b.id,
        thinkingCount: activity.thinking,
        recentMessageCount: activity.recent,
        onIntervene,
        onDetail,
      },
    };
  });

  const rawEdges: Edge[] = branches
    .filter((b) => b.parent_branch_id)
    .map((b) => ({
      id: `e-${b.parent_branch_id}-${b.id}`,
      source: b.parent_branch_id!,
      target: b.id,
      type: 'branchEdge',
      data: { status: b.status },
    }));

  return getLayoutedElements(rawNodes, rawEdges);
}

// ── Component ───────────────────────────────────────────────
export function BranchTree({ onIntervene, onDetail }: { onIntervene?: (branchId: string, title: string) => void; onDetail?: (branchId: string) => void }) {
  const { t } = useTranslation();
  const branches = useSimulationStore((s) => s.branches);
  const agents = useSimulationStore((s) => s.agents);
  const status = useSimulationStore((s) => s.status);
  const thinkingAgents = useSimulationStore((s) => s.thinkingAgents);
  const messages = useSimulationStore((s) => s.messages);
  const { fitView } = useReactFlow();

  // Compute per-branch activity: thinking count + recent messages (last 30s)
  const branchActivity = useMemo(() => {
    const activity: Record<string, { thinking: number; recent: number }> = {};
    // Count thinking agents per branch
    thinkingAgents.forEach((t) => {
      if (!activity[t.branch]) activity[t.branch] = { thinking: 0, recent: 0 };
      activity[t.branch].thinking++;
    });
    // Count recent messages (last 5 messages per branch as proxy)
    const msgsByBranch: Record<string, number> = {};
    messages.forEach((m) => {
      msgsByBranch[m.branch] = (msgsByBranch[m.branch] || 0) + 1;
    });
    Object.entries(msgsByBranch).forEach(([bid, count]) => {
      if (!activity[bid]) activity[bid] = { thinking: 0, recent: 0 };
      activity[bid].recent = count;
    });
    return activity;
  }, [thinkingAgents, messages]);

  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
    () => branchesToFlow(branches, agents, branchActivity, onIntervene, onDetail),
    [branches, agents, branchActivity, onIntervene, onDetail],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges);

  // Sync when branches update
  useEffect(() => {
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);

    // Delay fitView to let all fork-related nodes settle
    const timer = setTimeout(() => {
      fitView({ padding: 0.4, duration: 400, includeHiddenNodes: true });
    }, 500);
    return () => clearTimeout(timer);
  }, [layoutedNodes, layoutedEdges, setNodes, setEdges, fitView]);

  const onInit = useCallback(() => {
    fitView({ padding: 0.3, duration: 800 });
  }, [fitView]);

  return (
    <div className="branch-tree">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={onInit}
        fitView
        attributionPosition="bottom-left"
        minZoom={0.2}
        maxZoom={2}
        defaultEdgeOptions={{ animated: false }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="rgba(255,255,255,0.03)" gap={20} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            const s = n.data?.status;
            if (s === 'ACTIVE') return '#444';
            if (s === 'COMPLETED') return '#888';
            return '#ccc';
          }}
          maskColor="rgba(250, 248, 245, 0.85)"
        />
      </ReactFlow>

      {/* Empty state */}
      {branches.length === 0 && status !== 'idle' && (
        <div className="branch-tree__empty">
          <div className="spinner" />
          <p>{t('sim.tree.waiting')}</p>
        </div>
      )}
    </div>
  );
}
