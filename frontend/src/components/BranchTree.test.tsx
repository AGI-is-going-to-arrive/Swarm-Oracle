import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, BranchInfo } from '../types';

const {
  fitViewMock,
  flowState,
  layoutSpy,
  MockGraph,
} = vi.hoisted(() => {
  const fitViewMock = vi.fn();
  type MockFlowNode = {
    id: string;
    data?: Record<string, unknown>;
    position?: { x: number; y: number };
    selected?: boolean;
  };
  const flowState = {
    lastNodes: [] as MockFlowNode[],
    nodesById: new Map<string, MockFlowNode>(),
    setNodes: undefined as undefined | ((value: unknown) => void),
  };
  const layoutSpy = vi.fn((graph: { _nodes: Map<string, { width: number; height: number; x?: number; y?: number }> }) => {
    let index = 0;
    for (const [id, node] of graph._nodes.entries()) {
      graph._nodes.set(id, {
        ...node,
        x: 200 + index * 40,
        y: 120 + index * 30,
      });
      index += 1;
    }
  });

  class MockGraph {
    _nodes = new Map<string, { width: number; height: number; x?: number; y?: number }>();

    setDefaultEdgeLabel(factory: () => unknown): void {
      void factory;
    }

    setGraph(config: unknown): void {
      void config;
    }

    setNode(id: string, value: { width: number; height: number }): void {
      this._nodes.set(id, value);
    }

    setEdge(source: string, target: string): void {
      void source;
      void target;
    }

    node(id: string): { width: number; height: number; x?: number; y?: number } {
      return this._nodes.get(id) ?? { width: 0, height: 0, x: 0, y: 0 };
    }
  }

  return {
    fitViewMock,
    flowState,
    layoutSpy,
    MockGraph,
  };
});

const mockStore: {
  branches: BranchInfo[];
  agents: AgentInfo[];
  status: 'idle' | 'parsing' | 'simulating' | 'narrating' | 'done' | 'error' | 'cancelled';
  thinkingAgents: Array<{ branch: string }>;
  messages: Array<{ branch: string }>;
} = {
  branches: [
    {
      id: 'b1',
      parent_branch_id: null,
      fork_round: 0,
      fork_reason: '',
      title: 'Main Branch',
      summary: '',
      story: '',
      insight: '',
      key_moments: [],
      probability: 1,
      status: 'COMPLETED' as const,
    },
  ] as BranchInfo[],
  agents: [
    {
      id: 'a1',
      name: 'Agent One',
      role: 'Analyst',
      tier: 'CORE' as const,
      emotion: 'calm',
    },
  ] as AgentInfo[],
  status: 'done' as const,
  thinkingAgents: [] as Array<{ branch: string }>,
  messages: [] as Array<{ branch: string }>,
};

vi.mock('dagre', () => ({
  default: {
    graphlib: { Graph: MockGraph },
    layout: layoutSpy,
  },
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  type MockFlowNode = {
    id: string;
    data?: Record<string, unknown>;
    position?: { x: number; y: number };
    selected?: boolean;
  };
  type MockMiniMapNodeProps = {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    selected?: boolean;
  };
  return {
    ReactFlow: ({ children, nodes }: { children: ReactNode; nodes?: MockFlowNode[] }) => {
      flowState.lastNodes = nodes ?? [];
      flowState.nodesById = new Map(flowState.lastNodes.map((node) => [node.id, node]));
      return <div>{children}</div>;
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: ({ nodeComponent: NodeComponent }: {
      nodeComponent?: (props: MockMiniMapNodeProps) => ReactNode;
    }) => (
      <svg data-testid="branch-minimap">
        {NodeComponent
          ? flowState.lastNodes.map((node) => (
            <NodeComponent
              key={node.id}
              id={node.id}
              x={node.position?.x ?? 0}
              y={node.position?.y ?? 0}
              width={340}
              height={224}
              selected={node.selected}
            />
          ))
          : null}
      </svg>
    ),
    useNodesState: (initialNodes: unknown[]) => {
      const [nodes, setNodes] = React.useState(initialNodes);
      flowState.setNodes = setNodes as (value: unknown) => void;
      return [nodes, setNodes, vi.fn()] as const;
    },
    useEdgesState: (initialEdges: unknown[]) => {
      const [edges, setEdges] = React.useState(initialEdges);
      return [edges, setEdges, vi.fn()] as const;
    },
    useReactFlow: () => ({ fitView: fitViewMock }),
    useNodesData: (id: string) => flowState.nodesById.get(id),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}));

import { buildReadableBranchTitle } from './branchTitle';
import { BranchTree } from './BranchTree';

describe('buildReadableBranchTitle', () => {
  it('adds the first description clue to terse Chinese branch titles', () => {
    expect(buildReadableBranchTitle(
      '固本再图北伐',
      '诸葛亮把重心转向成都、汉中、剑阁的后方整备，优先固化粮道。',
      '',
      true,
    )).toBe('固本再图北伐：诸葛亮把重心转向成都');
  });

  it('keeps already descriptive Chinese titles unchanged', () => {
    expect(buildReadableBranchTitle(
      '巩固粮道再北伐',
      '诸葛亮把重心转向后方整备。',
      '',
      true,
    )).toBe('巩固粮道再北伐');
  });

  it('adds a compact English clue to terse branch titles', () => {
    expect(buildReadableBranchTitle(
      'Total War',
      'Cao Cao mobilizes two hundred thousand troops toward Jingzhou, forcing Liu Bei back.',
      '',
      false,
    )).toBe('Total War: Cao Cao mobilizes two hundred thousand troops toward Jingzhou');
  });
});

describe('BranchTree', () => {
  beforeEach(() => {
    layoutSpy.mockClear();
    fitViewMock.mockClear();
    flowState.lastNodes = [];
    flowState.nodesById = new Map();
    flowState.setNodes = undefined;
    mockStore.branches = [
      {
        id: 'b1',
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: '',
        title: 'Main Branch',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 1,
        status: 'COMPLETED' as const,
      },
    ] as BranchInfo[];
    mockStore.agents = [
      {
        id: 'a1',
        name: 'Agent One',
        role: 'Analyst',
        tier: 'CORE' as const,
        emotion: 'calm',
      },
    ] as AgentInfo[];
    mockStore.status = 'done';
    mockStore.thinkingAgents = [];
    mockStore.messages = [];
  });

  it('does not rerun dagre layout when only branch activity changes', async () => {
    const view = render(<BranchTree />);

    expect(layoutSpy).toHaveBeenCalledTimes(1);

    mockStore.messages = [{ branch: 'b1' }];
    view.rerender(<BranchTree />);

    await waitFor(() => {
      expect(layoutSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps BranchTree minimap chrome out of global React Flow overrides', () => {
    const indexCss = readFileSync('src/index.css', 'utf8');
    const branchTreeCss = readFileSync('src/components/BranchTree.css', 'utf8');

    expect(indexCss).toContain('.react-flow__minimap');
    expect(indexCss).not.toContain('background: #f4f3f0');
    expect(indexCss).not.toContain('branch-tree-minimap-pulse');
    expect(branchTreeCss).toContain('.branch-tree .react-flow__minimap');
    expect(branchTreeCss).toContain('@keyframes branch-tree-minimap-pulse');
  });

  it('preserves selected minimap state across live branch activity updates', async () => {
    mockStore.branches = [
      {
        ...mockStore.branches[0],
        status: 'ACTIVE' as const,
      },
    ];
    const view = render(<BranchTree />);

    await waitFor(() => {
      expect(flowState.lastNodes).toHaveLength(1);
    });

    const setNodes = flowState.setNodes;
    expect(setNodes).toBeTypeOf('function');
    act(() => {
      setNodes?.((prevNodes: Array<{ id: string }>) => (
        prevNodes.map((node) => (node.id === 'b1' ? { ...node, selected: true } : node))
      ));
    });

    await waitFor(() => {
      expect(flowState.lastNodes[0]?.selected).toBe(true);
    });

    mockStore.messages = [{ branch: 'b1' }];
    view.rerender(<BranchTree />);

    await waitFor(() => {
      expect(flowState.lastNodes[0]?.selected).toBe(true);
    });
    expect(view.container.querySelector('.minimap-node-selection')).not.toBeNull();
  });

  it('renders pruned branches with an explicit minimap glyph', () => {
    mockStore.branches = [
      {
        ...mockStore.branches[0],
        status: 'PRUNED' as const,
      },
    ];

    const { container } = render(<BranchTree />);

    expect(container.querySelector('.minimap-node-pruned')).not.toBeNull();
    expect(container.querySelector('.minimap-node-neutral')).toBeNull();
  });

  it('uses dense minimap glyphs without pulse animation for large branch sets', () => {
    mockStore.branches = Array.from({ length: 31 }, (_, index) => ({
      ...mockStore.branches[0],
      id: `b${index}`,
      parent_branch_id: index === 0 ? null : `b${index - 1}`,
      title: `Branch ${index}`,
      status: 'ACTIVE' as const,
    }));

    const { container, rerender } = render(<BranchTree />);

    expect(container.querySelector('.branch-tree-minimap-node-pulse')).toBeNull();
    expect(container.querySelector('circle[vector-effect="non-scaling-stroke"]')).not.toBeNull();

    mockStore.branches = Array.from({ length: 51 }, (_, index) => ({
      ...mockStore.branches[0],
      id: `c${index}`,
      parent_branch_id: index === 0 ? null : `c${index - 1}`,
      title: `Compact Branch ${index}`,
      status: 'ACTIVE' as const,
    }));
    rerender(<BranchTree />);

    expect(container.querySelector('.minimap-node-dense rect')).not.toBeNull();
  });

  it('reruns dagre layout when the branch graph changes', async () => {
    const view = render(<BranchTree />);

    expect(layoutSpy).toHaveBeenCalledTimes(1);

    mockStore.branches = [
      ...mockStore.branches,
      {
        id: 'b2',
        parent_branch_id: 'b1',
        fork_round: 2,
        fork_reason: 'Fork',
        title: 'Child Branch',
        summary: '',
        story: '',
        insight: '',
        key_moments: [],
        probability: 0.4,
        status: 'ACTIVE' as const,
      },
    ] as BranchInfo[];
    view.rerender(<BranchTree />);

    await waitFor(() => {
      expect(layoutSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('marks unfinished branches interrupted when the scenario failed (ACTIVE or reconciled PRUNED)', async () => {
    mockStore.status = 'error';
    mockStore.branches = [
      { ...mockStore.branches[0], id: 'b1', parent_branch_id: null, status: 'PRUNED' as const },
      { ...mockStore.branches[0], id: 'b2', parent_branch_id: 'b1', status: 'ACTIVE' as const },
      { ...mockStore.branches[0], id: 'b3', parent_branch_id: 'b1', status: 'COMPLETED' as const },
    ] as BranchInfo[];

    const { container } = render(<BranchTree />);

    await waitFor(() => {
      expect(flowState.lastNodes).toHaveLength(3);
    });
    // Backend reconciles a failed run's unfinished branch to PRUNED; the canvas must
    // still read it as "interrupted", not the misleading "low probability" pruned copy.
    expect(flowState.nodesById.get('b1')?.data?.interrupted).toBe(true);
    // A branch left ACTIVE (frontend saw it before the backend reconcile landed).
    expect(flowState.nodesById.get('b2')?.data?.interrupted).toBe(true);
    // A branch that genuinely finished stays COMPLETED, never interrupted.
    expect(flowState.nodesById.get('b3')?.data?.interrupted).toBe(false);
    expect(container.querySelectorAll('.minimap-node-interrupted')).toHaveLength(2);
    expect(container.querySelector('.minimap-node-active')).toBeNull();
    expect(container.querySelector('.minimap-node-pruned')).toBeNull();
  });

  it('keeps genuinely pruned branches non-interrupted when the scenario completed normally', async () => {
    mockStore.status = 'done';
    mockStore.branches = [
      { ...mockStore.branches[0], id: 'b1', status: 'PRUNED' as const },
    ] as BranchInfo[];

    render(<BranchTree />);

    await waitFor(() => {
      expect(flowState.lastNodes).toHaveLength(1);
    });
    // A DONE scenario's PRUNED branch is a real model decision — keep "low probability".
    expect(flowState.nodesById.get('b1')?.data?.interrupted).toBe(false);
  });
});
