import type { ReactNode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, BranchInfo } from '../types';

const {
  fitViewMock,
  layoutSpy,
  MockGraph,
} = vi.hoisted(() => {
  const fitViewMock = vi.fn();
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
    layoutSpy,
    MockGraph,
  };
});

const mockStore: {
  branches: BranchInfo[];
  agents: AgentInfo[];
  status: 'done';
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
  return {
    ReactFlow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    useNodesState: (initialNodes: unknown[]) => {
      const [nodes, setNodes] = React.useState(initialNodes);
      return [nodes, setNodes, vi.fn()] as const;
    },
    useEdgesState: (initialEdges: unknown[]) => {
      const [edges, setEdges] = React.useState(initialEdges);
      return [edges, setEdges, vi.fn()] as const;
    },
    useReactFlow: () => ({ fitView: fitViewMock }),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../stores/simulationStore', () => ({
  useSimulationStore: (selector: (state: typeof mockStore) => unknown) => selector(mockStore),
}));

import { BranchTree } from './BranchTree';

describe('BranchTree', () => {
  beforeEach(() => {
    layoutSpy.mockClear();
    fitViewMock.mockClear();
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
});
