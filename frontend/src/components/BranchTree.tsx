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

function buildBranchNodeData(
  branch: Branch,
  agentNames: string[],
  branchActivity: { thinking: number; recent: number },
  onIntervene?: (branchId: string, title: string) => void,
  onDetail?: (branchId: string) => void,
) {
  return {
    title: branch.title || '',
    description: branch.description,
    probability: branch.probability,
    status: branch.status,
    forkReason: branch.fork_reason,
    story: branch.story,
    agentNames,
    branchId: branch.id,
    thinkingCount: branchActivity.thinking,
    recentMessageCount: branchActivity.recent,
    onIntervene,
    onDetail,
  };
}

// ── Convert branches to React Flow elements ─────────────────
function layoutBranchesToFlow(
  branches: Branch[],
  agents: { id: string; name: string }[],
  onIntervene?: (branchId: string, title: string) => void,
  onDetail?: (branchId: string) => void,
): {
  nodes: Node[];
  edges: Edge[];
} {
  if (branches.length === 0) {
    return { nodes: [], edges: [] };
  }

  const agentNames = agents.slice(0, 6).map((agent) => agent.name);
  const rawNodes: Node[] = branches.map((b) => {
    return {
      id: b.id,
      type: 'branchNode',
      position: { x: 0, y: 0 },
      data: buildBranchNodeData(b, agentNames, { thinking: 0, recent: 0 }, onIntervene, onDetail),
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

function applyBranchActivityToNodes(
  nodes: Node[],
  branches: Branch[],
  agents: { id: string; name: string }[],
  branchActivity: Record<string, { thinking: number; recent: number }>,
  onIntervene?: (branchId: string, title: string) => void,
  onDetail?: (branchId: string) => void,
): Node[] {
  const agentNames = agents.slice(0, 6).map((agent) => agent.name);
  const branchById = new Map(branches.map((branch) => [branch.id, branch]));

  return nodes.map((node) => {
    const branch = branchById.get(node.id);
    if (!branch) return node;
    const activity = branchActivity[branch.id] || { thinking: 0, recent: 0 };
    return {
      ...node,
      data: buildBranchNodeData(branch, agentNames, activity, onIntervene, onDetail),
    };
  });
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

  const { nodes: structuralNodes, edges: structuralEdges } = useMemo(
    () => layoutBranchesToFlow(branches, agents, onIntervene, onDetail),
    [branches, agents, onIntervene, onDetail],
  );

  const layoutedNodes = useMemo(
    () => applyBranchActivityToNodes(structuralNodes, branches, agents, branchActivity, onIntervene, onDetail),
    [agents, branchActivity, branches, onDetail, onIntervene, structuralNodes],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(structuralEdges);

  useEffect(() => {
    setNodes(layoutedNodes);
  }, [layoutedNodes, setNodes]);

  useEffect(() => {
    setEdges(structuralEdges);
  }, [setEdges, structuralEdges]);

  // Only refit when the graph topology changes (new node added or new edge),
  // not when branch content updates (status / probability / story / activity).
  // Without this guard, every WS round update re-creates structuralNodes/Edges
  // references and overrides the user's pinch-zoom / pan within 500ms.
  const topologySignature = useMemo(() => {
    const nodeIds = structuralNodes.map((n) => n.id).sort().join('|');
    const edgeIds = structuralEdges.map((e) => `${e.source}->${e.target}`).sort().join('|');
    return `${nodeIds}::${edgeIds}`;
  }, [structuralNodes, structuralEdges]);

  useEffect(() => {
    // Delay fitView to let all fork-related nodes settle
    const timer = setTimeout(() => {
      fitView({ padding: 0.4, duration: 400, includeHiddenNodes: true });
    }, 500);
    return () => clearTimeout(timer);
  }, [fitView, topologySignature]);

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
