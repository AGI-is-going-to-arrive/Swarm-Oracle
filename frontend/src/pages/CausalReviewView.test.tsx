/**
 * Phase C1 — CausalReviewView tests
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import dagre from 'dagre';

const fitViewMock = vi.fn();

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({ loading: false, enabled: true, capabilities: null }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

// Mock @xyflow/react to avoid canvas errors in jsdom
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  const useStatefulFlow = <T,>(items: T[]) => {
    const [state, setState] = React.useState(items);
    return [state, setState, vi.fn()] as const;
  };
  return {
    ReactFlow: ({
      children,
      nodes,
      onInit,
      onNodeClick,
      onPaneClick,
    }: {
      children?: React.ReactNode;
      nodes?: Array<{ id: string }>;
      onInit?: (instance: { fitView: typeof fitViewMock }) => void;
      onNodeClick?: (event: unknown, node: { id: string }) => void;
      onPaneClick?: () => void;
    }) => {
      React.useEffect(() => {
        onInit?.({ fitView: fitViewMock });
      }, [onInit]);
      return (
        <div data-testid="reactflow">
          {nodes?.map((node) => (
            <button
              key={node.id}
              data-testid={`rf-node-${node.id}`}
              onClick={(event) => onNodeClick?.(event, node)}
            />
          ))}
          <button data-testid="rf-pane" onClick={() => onPaneClick?.()} />
          {children}
        </div>
      );
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    useNodesState: useStatefulFlow,
    useEdgesState: useStatefulFlow,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
  };
});

import { Route, Routes } from 'react-router-dom';
import { CausalReviewView } from './CausalReviewView';

afterEach(() => {
  cleanup();
  fitViewMock.mockReset();
});

const renderView = (path = '/sim/test-id/causal-map') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/sim/:id/causal-map" element={<CausalReviewView />} />
      </Routes>
    </MemoryRouter>,
  );

describe('CausalReviewView', () => {
  it('shows loading state initially', () => {
    // Mock fetch to never resolve
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    renderView();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('shows error when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));
    renderView();
    // Wait for error to appear
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Network error');
    vi.restoreAllMocks();
  });

  it('shows empty state when graph has no nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'g1', nodes: [], edges: [] }),
    } as Response);
    renderView();
    const empty = await screen.findByText(/No causal graph data/);
    expect(empty).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('renders ReactFlow when graph has nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g1',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [],
      }),
    } as Response);
    renderView();
    const flow = await screen.findByTestId('reactflow');
    expect(flow).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('shows export panel when graph has nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g1',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [],
      }),
    } as Response);
    renderView();
    const panel = await screen.findByTestId('export-panel');
    expect(panel).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('does not show export panel when graph is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'g1', nodes: [], edges: [] }),
    } as Response);
    renderView();
    await screen.findByText(/No causal graph data/);
    expect(screen.queryByTestId('export-panel')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('renders agent search input (C5)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g1',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Agent Alpha speaks', round: 1, payload: { agent_id: 'alpha' } }],
        edges: [],
      }),
    } as Response);
    renderView();
    await screen.findByTestId('reactflow');
    const searchInput = screen.getByPlaceholderText('Search agent...');
    expect(searchInput).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('keeps sibling branch options available when a branch filter is active', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g1',
        available_branches: ['br1', 'br2'],
        nodes: [
          {
            id: 'n1',
            key: 'e1',
            type: 'event',
            label: 'Filtered branch node',
            round: 1,
            payload: { branch_id: 'br1' },
          },
        ],
        edges: [],
      }),
    } as Response);
    renderView('/sim/test-id/causal-map?branch_id=br1');
    await screen.findByTestId('reactflow');
    expect(screen.getByLabelText('Select branch')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All branches' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /br2/ })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('reconstructs branch options from payload branch ids and fork children when available_branches is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-fallback-branches',
        nodes: [
          {
            id: 'fork-1',
            key: 'fork-parent',
            type: 'fork',
            label: 'Forked branch',
            round: 1,
            payload: { branch_id: 'br-parent', children: ['br-child', 'br-sibling'] },
          },
          {
            id: 'child-event',
            key: 'event-child',
            type: 'event',
            label: 'Child branch event',
            round: 2,
            payload: { branch_id: 'br-child', agent_id: 'alpha' },
          },
        ],
        edges: [],
      }),
    } as Response);
    renderView('/sim/test-id/causal-map?branch_id=br-child');
    await screen.findByTestId('reactflow');

    expect(screen.getByLabelText('Select branch')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All branches' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /br-paren/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /br-sibli/ })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('refits the viewport after search filtering changes the node set', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-fit',
        available_branches: ['br1'],
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Agent Alpha speaks', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
          { id: 'n2', key: 'e2', type: 'event', label: 'Agent Beta speaks', round: 1, payload: { agent_id: 'beta', branch_id: 'br1' } },
        ],
        edges: [],
      }),
    } as Response);
    renderView();
    await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(fitViewMock.mock.calls.length).toBeGreaterThan(0);
    });
    const initialCalls = fitViewMock.mock.calls.length;

    await user.type(screen.getByPlaceholderText('Search agent...'), 'beta');

    await waitFor(() => {
      expect(fitViewMock.mock.calls.length).toBeGreaterThan(initialCalls);
    });
    vi.restoreAllMocks();
  });

  it('does not refit the viewport when selecting or clearing a highlighted node', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-select',
        available_branches: ['br1'],
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Agent Alpha speaks', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
          { id: 'n2', key: 'e2', type: 'event', label: 'Agent Beta speaks', round: 1, payload: { agent_id: 'beta', branch_id: 'br1' } },
        ],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);
    renderView();
    await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(fitViewMock.mock.calls.length).toBeGreaterThan(0);
    });
    const initialCalls = fitViewMock.mock.calls.length;

    await user.click(screen.getByTestId('rf-node-n1'));
    await waitFor(() => {
      expect(screen.getByTestId('node-detail-panel')).toBeInTheDocument();
    });
    expect(fitViewMock.mock.calls.length).toBe(initialCalls);

    await user.click(screen.getByTestId('rf-pane'));
    await waitFor(() => {
      expect(screen.queryByTestId('node-detail-panel')).not.toBeInTheDocument();
    });
    expect(fitViewMock.mock.calls.length).toBe(initialCalls);
    vi.restoreAllMocks();
  });

  it('recovers after retrying a failed fetch', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g1',
          nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Recovered', round: 1, payload: null }],
          edges: [],
        }),
      } as Response);

    renderView();

    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    vi.restoreAllMocks();
  });

  it('keeps an export target container when large graphs fall back to the text list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-fallback-export',
        nodes: Array.from({ length: 501 }, (_, index) => ({
          id: `n${index}`,
          key: `e${index}`,
          type: 'event',
          label: `Large node ${index}`,
          round: 1,
          payload: null,
        })),
        edges: [],
      }),
    } as Response);

    renderView();

    await screen.findByText('Graph too large for interactive view. Showing text list.');
    expect(screen.getByTestId('export-panel')).toBeInTheDocument();
    expect(document.querySelector('.causal-graph-container')).not.toBeNull();
  });

  it('skips dagre layout work when large graphs render through the text fallback path', async () => {
    const layoutSpy = vi.spyOn(dagre, 'layout');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-fallback-layout',
        nodes: Array.from({ length: 501 }, (_, index) => ({
          id: `n${index}`,
          key: `e${index}`,
          type: 'event',
          label: `Large node ${index}`,
          round: 1,
          payload: null,
        })),
        edges: [],
      }),
    } as Response);

    renderView();

    await screen.findByText('Graph too large for interactive view. Showing text list.');
    expect(layoutSpy).not.toHaveBeenCalled();
  });

  it('includes a11y screen reader list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g1',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test', round: 2, payload: null }],
        edges: [],
      }),
    } as Response);
    renderView();
    const list = await screen.findByRole('list', { name: /Causal events/i });
    expect(list).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
