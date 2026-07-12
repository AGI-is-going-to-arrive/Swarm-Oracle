import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const fitViewMock = vi.fn();
  const useScenarioGraphMock = vi.fn();
  const mockScenarioGraphReturn = {
    data: null as unknown,
    loading: false,
    error: null as unknown,
    refetch: vi.fn(),
  };
  const localeState = { current: 'en' as 'en' | 'zh' };
  return { fitViewMock, useScenarioGraphMock, mockScenarioGraphReturn, localeState };
});

vi.mock('react-i18next', () => {
  const t = (key: string, fallback?: string) => {
    const translations: Record<string, string> = {
      'causal.a11y_relations': 'Causal relations list',
      'causal.edge_responds_to': 'responds to',
      'causal.edge_supports_stance': 'aligns with',
      'causal.edge_opposes_stance': 'opposes',
      'causal.edge_affect_alignment_proxy': 'affect aligned (proxy)',
      'causal.edge_affect_distance_proxy': 'affect distant (proxy)',
      'causal.scope_branch_lineage': hoisted.localeState.current === 'zh'
        ? '仅展示所选分支的有效范围；父分支分叉后的轮次、兄弟分支轮次及无关源分支坐标均已排除。'
        : 'Showing the selected branch’s effective scope only; parent post-fork rounds, sibling rounds, and unrelated source-branch coordinates are excluded.',
      'causal.edge_triggered_fork': '触发分支',
      'causal.edge_stance_shift': '立场转变',
    };
    return translations[key] ?? fallback ?? key;
  };
  return { useTranslation: () => ({ t }) };
});

vi.mock('../../hooks/useScenarioGraph', () => ({
  useScenarioGraph: (scenarioId: string | null) => {
    hoisted.useScenarioGraphMock(scenarioId);
    return hoisted.mockScenarioGraphReturn;
  },
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  const useStatefulFlow = <T,>(items: T[]) => {
    const [state, setState] = React.useState(items);
    return [state, setState, vi.fn()] as const;
  };

  return {
    ReactFlow: ({
      children,
      onInit,
      nodes,
      onNodeClick,
    }: {
      children?: React.ReactNode;
      onInit?: (instance: { fitView: typeof hoisted.fitViewMock }) => void;
      nodes?: Array<{ id: string; data?: Record<string, unknown> }>;
      onNodeClick?: (event: React.MouseEvent<HTMLButtonElement>, node: { id: string; data?: Record<string, unknown> }) => void;
    }) => {
      React.useEffect(() => {
        onInit?.({ fitView: hoisted.fitViewMock });
      }, [onInit]);
      return (
        <div data-testid="reactflow">
          {nodes?.map(node => (
            <button
              key={node.id}
              type="button"
              data-testid={`flow-node-${node.id}`}
              onClick={event => onNodeClick?.(event, node)}
            >
              {String(node.data?.fullLabel ?? node.id)}
            </button>
          ))}
          {children}
        </div>
      );
    },
    Background: () => null,
    BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
    Controls: () => null,
    MiniMap: () => null,
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
    useNodesState: useStatefulFlow,
    useEdgesState: useStatefulFlow,
  };
});

vi.mock('../kg/NodeConversationSheet', () => ({
  NodeConversationSheet: () => null,
}));

import CausalGraphBoard from './CausalGraphBoard';

afterEach(() => {
  cleanup();
  hoisted.mockScenarioGraphReturn.data = null;
  hoisted.mockScenarioGraphReturn.loading = false;
  hoisted.mockScenarioGraphReturn.error = null;
  hoisted.mockScenarioGraphReturn.refetch.mockClear();
  hoisted.fitViewMock.mockClear();
  hoisted.useScenarioGraphMock.mockClear();
  hoisted.localeState.current = 'en';
});

describe('CausalGraphBoard', () => {
  it('exposes inter-agent causal edge labels in the relation list', async () => {
    hoisted.mockScenarioGraphReturn.data = {
      id: 'g-workbench-inter-agent',
      nodes: [
        { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: null },
        { id: 'n2', key: 'e2', type: 'event', label: 'Beta', round: 1, payload: null },
        { id: 'n3', key: 'e3', type: 'event', label: 'Gamma', round: 1, payload: null },
        { id: 'n4', key: 'e4', type: 'event', label: 'Delta', round: 1, payload: null },
      ],
      edges: [
        { id: 'edge-1', source: 'n1', target: 'n2', type: 'responds_to', weight: 1, label: null },
        { id: 'edge-2', source: 'n2', target: 'n3', type: 'supports_stance', weight: 1, label: null },
        { id: 'edge-3', source: 'n3', target: 'n4', type: 'opposes_stance', weight: 1, label: null },
      ],
    };

    render(<CausalGraphBoard scenarioId="s1" hideExport />);

    expect(await screen.findByTestId('reactflow')).toBeInTheDocument();
    const relationList = screen.getByRole('list', { name: 'Causal relations list' });
    const items = within(relationList).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Alpha responds to Beta',
      'Beta aligns with Gamma',
      'Gamma opposes Delta',
    ]);
  });

  it('uses known backend labels before falling back to generic caused labels', async () => {
    hoisted.mockScenarioGraphReturn.data = {
      id: 'g-workbench-backend-labels',
      nodes: [
        { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: null },
        { id: 'n2', key: 'e2', type: 'fork', label: 'Beta', round: 1, payload: null },
        { id: 'n3', key: 'e3', type: 'stance_shift', label: 'Gamma', round: 2, payload: null },
      ],
      edges: [
        { id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: 'Triggered Fork' },
        { id: 'edge-2', source: 'n2', target: 'n3', type: 'caused', weight: 1, label: 'Stance Shift' },
      ],
    };

    render(<CausalGraphBoard scenarioId="s1" hideExport />);

    expect(await screen.findByTestId('reactflow')).toBeInTheDocument();
    const relationList = screen.getByRole('list', { name: 'Causal relations list' });
    const items = within(relationList).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Alpha 触发分支 Beta',
      'Beta 立场转变 Gamma',
    ]);
  });

  it('passes only stable, deduplicated adjacent edge evidence to the selected node detail', async () => {
    const user = userEvent.setup();
    hoisted.mockScenarioGraphReturn.data = {
      id: 'g-workbench-evidence',
      nodes: [
        { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: { content: 'Alpha' } },
        { id: 'n2', key: 'e2', type: 'event', label: 'Beta', round: 2, payload: { content: 'Beta' } },
        { id: 'n3', key: 'e3', type: 'event', label: 'Gamma', round: 3, payload: { content: 'Gamma' } },
        { id: 'n4', key: 'e4', type: 'event', label: 'Delta', round: 4, payload: { content: 'Delta' } },
        { id: 'n5', key: 'e5', type: 'event', label: 'Epsilon', round: 5, payload: { content: 'Epsilon' } },
      ],
      edges: [
        {
          id: 'edge-in',
          source: 'n1',
          target: 'n2',
          type: 'responds_to',
          weight: 1,
          label: null,
          evidence: {
            confidence_tier: 'high',
            source_ref: 'message-in',
            source_round_number: 1,
            detail: 'Incoming direct response.',
          },
        },
        {
          id: 'edge-out',
          source: 'n2',
          target: 'n3',
          type: 'supports_stance',
          weight: 1,
          label: null,
          evidence: {
            confidence_tier: 'medium',
            source_ref: 'message-out',
            source_round_number: 2,
            detail: 'Outgoing alignment.',
          },
        },
        {
          id: 'edge-out-duplicate',
          source: 'n2',
          target: 'n4',
          type: 'supports_stance',
          weight: 1,
          label: null,
          evidence: {
            confidence_tier: 'medium',
            source_ref: 'message-out',
            source_round_number: 2,
            detail: 'Outgoing alignment.',
          },
        },
        {
          id: 'edge-unrelated',
          source: 'n4',
          target: 'n5',
          type: 'opposes_stance',
          weight: 1,
          label: null,
          evidence: {
            confidence_tier: 'low',
            source_ref: 'message-unrelated',
            source_round_number: 4,
            detail: 'Must not leak into Beta.',
          },
        },
        {
          id: 'edge-empty',
          source: 'n3',
          target: 'n2',
          type: 'caused',
          weight: 1,
          label: null,
          evidence: {
            confidence_tier: null,
            source_ref: null,
            source_round_number: null,
            detail: null,
          },
        },
      ],
    };

    render(<CausalGraphBoard scenarioId="s1" hideExport />);
    await user.click(await screen.findByTestId('flow-node-n2'));

    const evidenceItems = screen.getAllByTestId('node-detail-evidence-item');
    expect(evidenceItems).toHaveLength(2);
    expect(evidenceItems.map(item => item.textContent)).toEqual([
      expect.stringMatching(/Relation:\s*responds to.*Direction:\s*Incoming.*high.*message-in.*1.*Incoming direct response\./s),
      expect.stringMatching(/Relation:\s*aligns with.*Direction:\s*Outgoing.*medium.*message-out.*2.*Outgoing alignment\./s),
    ]);
    expect(screen.queryByText('message-unrelated')).not.toBeInTheDocument();
    expect(screen.queryByText('Must not leak into Beta.')).not.toBeInTheDocument();
  });

  it('renders affect-proxy display types and uses the truthful localized scope baseline', async () => {
    hoisted.mockScenarioGraphReturn.data = {
      id: 'g-workbench-affect-proxy',
      scope_kind: 'branch_lineage',
      scope_caveat: 'Selected branch lineage includes pre-fork ancestor rounds.',
      nodes: [
        { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: null },
        { id: 'n2', key: 'e2', type: 'event', label: 'Beta', round: 1, payload: null },
      ],
      edges: [
        {
          id: 'edge-1',
          source: 'n1',
          target: 'n2',
          type: 'supports_stance',
          display_type: 'affect_alignment_proxy',
          weight: 1,
          label: null,
        },
      ],
    };

    render(<CausalGraphBoard scenarioId="s1" hideExport />);

    expect(await screen.findByTestId('reactflow')).toBeInTheDocument();
    const scopeNote = screen.getByRole('note');
    expect(scopeNote).toHaveTextContent(
      'Showing the selected branch’s effective scope only; parent post-fork rounds, sibling rounds, and unrelated source-branch coordinates are excluded.',
    );
    expect(scopeNote).not.toHaveTextContent(/ancestor/i);
    expect(
      within(screen.getByRole('list', { name: 'Causal relations list' }))
        .getByRole('listitem'),
    ).toHaveTextContent('Alpha affect aligned (proxy) Beta');
  });

  it('uses the localized branch-lineage baseline when the server caveat is absent', async () => {
    hoisted.mockScenarioGraphReturn.data = {
      id: 'g-workbench-lineage-fallback',
      scope_kind: 'branch_lineage',
      nodes: [
        { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: null },
      ],
      edges: [],
    };

    render(<CausalGraphBoard scenarioId="s1" hideExport />);

    expect(await screen.findByTestId('reactflow')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      'Showing the selected branch’s effective scope only; parent post-fork rounds, sibling rounds, and unrelated source-branch coordinates are excluded.',
    );
  });

  it('keeps a nonempty English server caveat localized in Chinese without promising ancestors', async () => {
    hoisted.localeState.current = 'zh';
    hoisted.mockScenarioGraphReturn.data = {
      id: 'g-workbench-lineage-zh',
      scope_kind: 'branch_lineage',
      scope_caveat: 'Selected branch lineage includes pre-fork ancestor rounds.',
      nodes: [
        { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: null },
      ],
      edges: [],
    };

    render(<CausalGraphBoard scenarioId="s1" hideExport />);

    expect(await screen.findByTestId('reactflow')).toBeInTheDocument();
    const scopeNote = screen.getByRole('note');
    expect(scopeNote).toHaveTextContent(
      '仅展示所选分支的有效范围；父分支分叉后的轮次、兄弟分支轮次及无关源分支坐标均已排除。',
    );
    expect(scopeNote).not.toHaveTextContent(/ancestor|祖先/i);
  });

  it.each([
    ['a server caveat', 'Selected branch lineage includes pre-fork ancestor rounds.'],
    ['a blank caveat', '   '],
    ['a malformed caveat', { unexpected: true }],
  ])('keeps the localized scope note visible for an empty scoped graph with %s', async (_label, scopeCaveat) => {
    hoisted.mockScenarioGraphReturn.data = {
      id: 'g-workbench-lineage-empty',
      scope_kind: 'branch_lineage',
      scope_caveat: scopeCaveat,
      nodes: [],
      edges: [],
    };

    render(<CausalGraphBoard scenarioId="s1" hideExport />);

    expect(screen.getByRole('note')).toHaveTextContent(
      'Showing the selected branch’s effective scope only; parent post-fork rounds, sibling rounds, and unrelated source-branch coordinates are excluded.',
    );
    expect(screen.getByText('No causal graph data available for this scenario.')).toBeInTheDocument();
  });

  it('does not render a lineage scope note for an unscoped graph response', async () => {
    hoisted.mockScenarioGraphReturn.data = {
      id: 'g-workbench-unscoped',
      nodes: [
        { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: null },
      ],
      edges: [],
    };

    render(<CausalGraphBoard scenarioId="s1" hideExport />);

    expect(await screen.findByTestId('reactflow')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('always fetches the full causal graph without branch filtering', async () => {
    hoisted.mockScenarioGraphReturn.data = {
      id: 'g-workbench-branch',
      nodes: [
        { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: null },
      ],
      edges: [],
    };

    render(<CausalGraphBoard scenarioId="s1" hideExport />);

    expect(await screen.findByTestId('reactflow')).toBeInTheDocument();
    expect(hoisted.useScenarioGraphMock).toHaveBeenCalledWith('s1');
  });
});
