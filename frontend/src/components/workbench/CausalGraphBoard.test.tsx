import { cleanup, render, screen, within } from '@testing-library/react';
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
  return { fitViewMock, useScenarioGraphMock, mockScenarioGraphReturn };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const translations: Record<string, string> = {
        'causal.a11y_relations': 'Causal relations list',
        'causal.edge_responds_to': 'responds to',
        'causal.edge_supports_stance': 'aligns with',
        'causal.edge_opposes_stance': 'opposes',
        'causal.edge_triggered_fork': '触发分支',
        'causal.edge_stance_shift': '立场转变',
      };
      return translations[key] ?? fallback ?? key;
    },
  }),
}));

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
    }: {
      children?: React.ReactNode;
      onInit?: (instance: { fitView: typeof hoisted.fitViewMock }) => void;
    }) => {
      React.useEffect(() => {
        onInit?.({ fitView: hoisted.fitViewMock });
      }, [onInit]);
      return <div data-testid="reactflow">{children}</div>;
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

import CausalGraphBoard from './CausalGraphBoard';

afterEach(() => {
  cleanup();
  hoisted.mockScenarioGraphReturn.data = null;
  hoisted.mockScenarioGraphReturn.loading = false;
  hoisted.mockScenarioGraphReturn.error = null;
  hoisted.mockScenarioGraphReturn.refetch.mockClear();
  hoisted.fitViewMock.mockClear();
  hoisted.useScenarioGraphMock.mockClear();
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
