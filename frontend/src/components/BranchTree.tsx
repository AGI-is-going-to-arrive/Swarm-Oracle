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
  useNodesData,
  type Node,
  type Edge,
  type MiniMapNodeProps,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';

import { BranchNode } from './BranchNode';
import { BranchEdge } from './BranchEdge';
import { buildReadableBranchTitle } from './branchTitle';
import { useSimulationStore } from '../stores/simulationStore';
import type { Branch } from '../types';
import './BranchTree.css';

// ── Node types registration ─────────────────────────────────
const nodeTypes = { branchNode: BranchNode };
const edgeTypes = { branchEdge: BranchEdge };

// ── Dagre auto-layout ───────────────────────────────────────
const LAYOUT_CONFIG = {
  rankdir: 'TB' as const,
  nodesep: 90,
  ranksep: 120,
  marginx: 60,
  marginy: 60,
};

const NODE_WIDTH = 340;
const NODE_HEIGHT = 224;
const MINIMAP_DENSE_NODE_COUNT = 30;
const MINIMAP_COMPACT_NODE_COUNT = 50;

type MiniMapStrokeProps = {
  strokeWidth: number;
  vectorEffect?: 'non-scaling-stroke';
};

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
  isZh: boolean,
  onIntervene?: (branchId: string, title: string) => void,
  onDetail?: (branchId: string) => void,
  canIntervene?: boolean,
  scenarioTerminal?: boolean,
) {
  const rawTitle = branch.title || '';
  return {
    title: buildReadableBranchTitle(
      rawTitle,
      branch.description,
      branch.fork_reason,
      isZh,
    ),
    rawTitle,
    description: branch.description,
    probability: branch.probability,
    status: branch.status,
    interrupted:
      Boolean(scenarioTerminal) &&
      (branch.status === 'ACTIVE' || branch.status === 'PRUNED'),
    forkReason: branch.fork_reason,
    story: branch.story,
    agentNames,
    branchId: branch.id,
    thinkingCount: branchActivity.thinking,
    recentMessageCount: branchActivity.recent,
    canIntervene,
    onIntervene,
    onDetail,
  };
}

// ── Convert branches to React Flow elements ─────────────────
function layoutBranchesToFlow(
  branches: Branch[],
  agents: { id: string; name: string }[],
  isZh: boolean,
  onIntervene?: (branchId: string, title: string) => void,
  onDetail?: (branchId: string) => void,
  canIntervene?: boolean,
  scenarioTerminal?: boolean,
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
      data: buildBranchNodeData(b, agentNames, { thinking: 0, recent: 0 }, isZh, onIntervene, onDetail, canIntervene, scenarioTerminal),
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
  isZh: boolean,
  onIntervene?: (branchId: string, title: string) => void,
  onDetail?: (branchId: string) => void,
  canIntervene?: boolean,
  scenarioTerminal?: boolean,
): Node[] {
  const agentNames = agents.slice(0, 6).map((agent) => agent.name);
  const branchById = new Map(branches.map((branch) => [branch.id, branch]));

  return nodes.map((node) => {
    const branch = branchById.get(node.id);
    if (!branch) return node;
    const activity = branchActivity[branch.id] || { thinking: 0, recent: 0 };
    return {
      ...node,
      data: buildBranchNodeData(branch, agentNames, activity, isZh, onIntervene, onDetail, canIntervene, scenarioTerminal),
    };
  });
}

// ── Custom MiniMap Node for Data-Ink Minimal styling ──────────
// NOTE: xyflow's MiniMap nodeComponent renders in FLOW coordinates (node body
// is ~340×224), NOT minimap pixels. Radii/strokes must scale with node size or
// they collapse to sub-pixel after the minimap viewBox downscale (invisible).
function CustomMiniMapNode({
  id,
  x,
  y,
  width,
  height,
  selected,
  nodeCount,
}: MiniMapNodeProps & { nodeCount: number }) {
  const nodeData = useNodesData(id);
  const interrupted = nodeData?.data?.interrupted === true;
  const status = interrupted ? 'INTERRUPTED' : nodeData?.data?.status;

  const cx = x + width / 2;
  const cy = y + height / 2;
  const base = Math.min(width, height);
  const r = base * 0.22;   // ~49 in flow coords → ~3-4px after downscale
  const sw = base * 0.05;  // ~11 stroke so it survives the downscale
  const isDense = nodeCount > MINIMAP_DENSE_NODE_COUNT;
  const isCompact = nodeCount > MINIMAP_COMPACT_NODE_COUNT;
  const strokeProps = (normalWidth: number, denseWidth = 1.25): MiniMapStrokeProps => (
    isDense
      ? { strokeWidth: denseWidth, vectorEffect: 'non-scaling-stroke' }
      : { strokeWidth: normalWidth }
  );

  if (isCompact) {
    const insetX = width * 0.28;
    const insetY = height * 0.26;
    const statusClass = status === 'INTERRUPTED'
      ? 'interrupted'
      : status === 'ACTIVE'
        ? 'active'
        : status === 'COMPLETED'
          ? 'completed'
          : status === 'PRUNED'
            ? 'pruned'
            : 'neutral';
    const stroke = selected
      ? '#1c1a17'
      : status === 'INTERRUPTED'
        ? '#8d8780'
        : status === 'ACTIVE'
          ? '#1c1a17'
          : status === 'COMPLETED'
            ? '#74706a'
            : status === 'PRUNED'
              ? '#b8b2aa'
              : '#a9a49c';

    return (
      <g className={`minimap-node-${statusClass} minimap-node-dense`}>
        <rect
          x={x + insetX}
          y={y + insetY}
          width={width - insetX * 2}
          height={height - insetY * 2}
          rx={base * 0.08}
          fill={status === 'ACTIVE' ? '#1c1a17' : 'none'}
          stroke={stroke}
          strokeDasharray={status === 'PRUNED' || status === 'INTERRUPTED' ? '4 3' : undefined}
          {...strokeProps(selected ? sw * 1.4 : sw, selected ? 1.8 : 1.2)}
        />
        {selected && (
          <rect
            className="minimap-node-selection"
            x={x + insetX * 0.72}
            y={y + insetY * 0.72}
            width={width - insetX * 1.44}
            height={height - insetY * 1.44}
            rx={base * 0.1}
            fill="none"
            stroke="#1c1a17"
            {...strokeProps(sw * 1.6, 2)}
          />
        )}
      </g>
    );
  }

  if (status === 'ACTIVE') {
    return (
      <g className="minimap-node-active">
        {/* Pulsing halo ring (stroke, so it doesn't smother neighbours) */}
        {!isDense && (
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="#1c1a17"
            strokeWidth={sw}
            className="branch-tree-minimap-node-pulse"
          />
        )}
        {/* Core solid dot */}
        <circle
          className="minimap-node-core"
          cx={cx}
          cy={cy}
          r={r}
          fill="#1c1a17"
          stroke={isDense ? '#1c1a17' : undefined}
          {...(isDense ? strokeProps(sw, 1.3) : {})}
        />
        {/* Selection ring */}
        {selected && (
          <circle
            className="minimap-node-selection"
            cx={cx}
            cy={cy}
            r={r * 1.7}
            fill="none"
            stroke="#1c1a17"
            {...strokeProps(sw, 2)}
          />
        )}
      </g>
    );
  }

  if (status === 'INTERRUPTED') {
    return (
      <g className="minimap-node-interrupted">
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={selected ? '#1c1a17' : '#8d8780'}
          strokeDasharray={isDense ? '4 3' : `${sw * 1.1} ${sw * 1.35}`}
          {...strokeProps(selected ? sw * 1.4 : sw * 0.85, selected ? 1.7 : 1.15)}
        />
      </g>
    );
  }

  if (status === 'COMPLETED') {
    return (
      <g className="minimap-node-completed">
        {/* Outer ring */}
        <circle
          cx={cx}
          cy={cy}
          r={r * 1.15}
          fill="none"
          stroke={selected ? '#1c1a17' : '#74706a'}
          {...strokeProps(selected ? sw * 1.5 : sw, selected ? 1.8 : 1.25)}
        />
        {/* Center dot */}
        <circle
          className="minimap-node-core"
          cx={cx}
          cy={cy}
          r={r * 0.32}
          fill={selected ? '#1c1a17' : '#74706a'}
          stroke={isDense ? (selected ? '#1c1a17' : '#74706a') : undefined}
          {...(isDense ? strokeProps(sw * 0.4, 1.05) : {})}
        />
      </g>
    );
  }

  if (status === 'PRUNED') {
    return (
      <g className="minimap-node-pruned">
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={selected ? '#1c1a17' : '#b8b2aa'}
          strokeDasharray={isDense ? '4 3' : `${sw * 1.5} ${sw * 1.2}`}
          {...strokeProps(selected ? sw * 1.4 : sw * 0.8, selected ? 1.7 : 1.15)}
        />
      </g>
    );
  }

  // Neutral / catch-all covers future/unknown status.
  return (
    <g className="minimap-node-neutral">
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={selected ? '#1c1a17' : '#a9a49c'}
        {...strokeProps(selected ? sw * 1.4 : sw * 0.9, selected ? 1.7 : 1.15)}
      />
    </g>
  );
}

// ── Component ───────────────────────────────────────────────
export function BranchTree({
  onIntervene,
  onDetail,
  canIntervene,
}: {
  onIntervene?: (branchId: string, title: string) => void;
  onDetail?: (branchId: string) => void;
  canIntervene?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const branches = useSimulationStore((s) => s.branches);
  const agents = useSimulationStore((s) => s.agents);
  const status = useSimulationStore((s) => s.status);
  const thinkingAgents = useSimulationStore((s) => s.thinkingAgents);
  const messages = useSimulationStore((s) => s.messages);
  const { fitView } = useReactFlow();
  const isZh = (i18n.language || '').toLowerCase().startsWith('zh');
  // Scenario reached a terminal failure state (error/cancelled). Any unfinished
  // branch — still flagged ACTIVE, or back-end-reconciled to PRUNED when the run
  // failed — should render as a neutral "interrupted" state, not the misleading
  // "in progress" pulse nor the "low probability" copy (which implies the model
  // deliberately pruned it). Branches that genuinely COMPLETED stay COMPLETED.
  const scenarioTerminal = status === 'error' || status === 'cancelled';

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
    () => layoutBranchesToFlow(branches, agents, isZh, onIntervene, onDetail, canIntervene, scenarioTerminal),
    [branches, agents, isZh, onIntervene, onDetail, canIntervene, scenarioTerminal],
  );

  const layoutedNodes = useMemo(
    () => applyBranchActivityToNodes(structuralNodes, branches, agents, branchActivity, isZh, onIntervene, onDetail, canIntervene, scenarioTerminal),
    [agents, branchActivity, branches, isZh, onDetail, onIntervene, structuralNodes, canIntervene, scenarioTerminal],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(structuralEdges);

  useEffect(() => {
    setNodes((prevNodes) => {
      const previousById = new Map(prevNodes.map((node) => [node.id, node]));
      return layoutedNodes.map((node) => {
        const previous = previousById.get(node.id);
        if (!previous) return node;
        return {
          ...node,
          selected: previous.selected,
        };
      });
    });
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

  // Tighten padding when only a couple of nodes exist so a lone branch
  // is not blown up into a sea of empty canvas; cap zoom-in via maxZoom.
  const nodeCount = structuralNodes.length;
  const miniMapNodeComponent = useCallback(
    (props: MiniMapNodeProps) => <CustomMiniMapNode {...props} nodeCount={nodeCount} />,
    [nodeCount],
  );

  useEffect(() => {
    // Delay fitView to let all fork-related nodes settle
    const pad = nodeCount <= 2 ? 0.18 : 0.3;
    const timer = setTimeout(() => {
      fitView({ padding: pad, maxZoom: 1.1, duration: 400, includeHiddenNodes: true });
    }, 500);
    return () => clearTimeout(timer);
  }, [fitView, topologySignature, nodeCount]);

  const onInit = useCallback(() => {
    fitView({ padding: 0.2, maxZoom: 1.1, duration: 800 });
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
        <Background color="rgba(198,21,131,0.05)" gap={28} />
        <Controls showInteractive={false} />
        <MiniMap
          nodeComponent={miniMapNodeComponent}
          bgColor="#eceae6"
          maskColor="rgba(236, 234, 230, 0.6)"
          maskStrokeColor="#3f3c38"
          maskStrokeWidth={1.3}
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
