/**
 * Phase C1 — CausalReviewView tests
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
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
    MiniMap: ({ style }: { style?: React.CSSProperties }) => (
      <div data-testid="rf-minimap" data-pointer-events={String(style?.pointerEvents ?? '')} />
    ),
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

const createDeferredResponse = () => {
  let resolve!: (value: Response) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

function BranchNavigationHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/sim/test-id/causal-map?branch_id=br1')}>Go br1</button>
      <button onClick={() => navigate('/sim/test-id/causal-map?branch_id=br2')}>Go br2</button>
      <CausalReviewView />
    </>
  );
}

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

  it('surfaces structured backend error details for invalid branch filters', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        detail: {
          code: 'BRANCH_NOT_FOUND',
          message: 'Branch missing-branch not found in scenario',
        },
      }),
    } as Response);
    renderView('/sim/test-id/causal-map?branch_id=missing-branch');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Branch missing-branch not found in scenario');
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

  it('shows a snapshot fallback instead of ReactFlow when the graph has multiple nodes but no edges', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-relationless',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: null },
          { id: 'n2', key: 'e2', type: 'event', label: 'Beta', round: 2, payload: null },
        ],
        edges: [],
      }),
    } as Response);

    renderView();

    expect(await screen.findByText('No causal edges were generated for this scenario yet. Showing event snapshots instead.')).toBeInTheDocument();
    expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-panel')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Round 1/i })).toBeInTheDocument();
    expect(screen.getAllByRole('list', { name: 'Causal events list' })).toHaveLength(1);
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
    const searchInput = screen.getByPlaceholderText('Search Agent...');
    expect(searchInput).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('renders the minimap as a non-interactive overlay', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-minimap',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [],
      }),
    } as Response);
    renderView();
    await screen.findByTestId('reactflow');
    expect(screen.getByTestId('rf-minimap')).toHaveAttribute('data-pointer-events', 'none');
    vi.restoreAllMocks();
  });

  it('hides the minimap on narrow viewports to avoid covering the graph', async () => {
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-mobile-minimap',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [],
      }),
    } as Response);
    renderView();
    await screen.findByTestId('reactflow');
    expect(screen.queryByTestId('rf-minimap')).not.toBeInTheDocument();
    matchMediaSpy.mockRestore();
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

  it('prefers scenario branch titles and probabilities in the branch selector', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-branch-meta',
          nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
          edges: [{ id: 'edge-1', source: 'n1', target: 'n1', type: 'causal', weight: 1, label: null }],
          available_branches: ['branch-1', 'branch-2'],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'scenario-1',
          branches: [
            { id: 'branch-1', title: 'Worldline Alpha', probability: 0.73 },
            { id: 'branch-2', title: 'Worldline Beta', probability: 0.27 },
          ],
        }),
      } as Response);

    renderView('/sim/test-id/causal-map?branch_id=branch-1');

    const selector = await screen.findByRole('combobox', { name: 'Select branch' });
    expect(within(selector).getByRole('option', { name: 'Worldline Alpha · 73.0%' })).toBeInTheDocument();
    expect(within(selector).getByRole('option', { name: 'Worldline Beta · 27.0%' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('renders full branch labels so similar prefixes stay distinguishable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-branch-labels',
        available_branches: ['branch-1234-A', 'branch-1234-B'],
        nodes: [
          {
            id: 'n1',
            key: 'e1',
            type: 'event',
            label: 'Filtered branch node',
            round: 1,
            payload: { branch_id: 'branch-1234-A' },
          },
        ],
        edges: [],
      }),
    } as Response);

    renderView('/sim/test-id/causal-map?branch_id=branch-1234-A');
    await screen.findByTestId('reactflow');

    expect(screen.getByRole('option', { name: 'branch-1234-A' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'branch-1234-B' })).toBeInTheDocument();
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
    await screen.findByText('No causal edges were generated for this scenario yet. Showing event snapshots instead.');

    expect(screen.getByLabelText('Select branch')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All branches' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /br-paren/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /br-sibli/ })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('sends an encoded branch_id query when the selector changes', async () => {
    const user = userEvent.setup();
    const encodedBranchId = 'branch/child?2';
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-initial',
          available_branches: ['branch-root', encodedBranchId],
          nodes: [
            {
              id: 'n1',
              key: 'e1',
              type: 'event',
              label: 'Root branch node',
              round: 1,
              payload: { branch_id: 'branch-root' },
            },
          ],
          edges: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'scenario-initial',
          branches: [
            { id: 'branch-root', title: 'Root branch', probability: 1 },
            { id: encodedBranchId, title: 'Filtered branch', probability: 0.5 },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-filtered',
          available_branches: ['branch-root', encodedBranchId],
          nodes: [
            {
              id: 'n2',
              key: 'e2',
              type: 'event',
              label: 'Filtered branch node',
              round: 2,
              payload: { branch_id: encodedBranchId },
            },
          ],
          edges: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'scenario-filtered',
          branches: [
            { id: 'branch-root', title: 'Root branch', probability: 1 },
            { id: encodedBranchId, title: 'Filtered branch', probability: 0.5 },
          ],
        }),
      } as Response);

    renderView();
    await screen.findByTestId('reactflow');

    await user.selectOptions(screen.getByLabelText('Select branch'), encodedBranchId);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });
    const filteredGraphUrl = fetchSpy.mock.calls
      .map((call) => call[0])
      .find((value) => {
        if (typeof value === 'string') return value.includes('branch_id=');
        if (value instanceof URL) return value.toString().includes('branch_id=');
        return value.url.includes('branch_id=');
      });
    const serializedUrl =
      typeof filteredGraphUrl === 'string'
        ? filteredGraphUrl
        : filteredGraphUrl instanceof URL
          ? filteredGraphUrl.toString()
          : filteredGraphUrl?.url ?? '';
    expect(serializedUrl).toContain('branch_id=branch%2Fchild%3F2');
  });

  it('treats blank branch_id query params as no filter', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-blank-branch',
        available_branches: ['branch-root'],
        nodes: [
          {
            id: 'n1',
            key: 'e1',
            type: 'event',
            label: 'Root branch node',
            round: 1,
            payload: { branch_id: 'branch-root' },
          },
        ],
        edges: [],
      }),
    } as Response);

    renderView('/sim/test-id/causal-map?branch_id=%20%20');
    await screen.findByTestId('reactflow');

    const firstCallUrl = fetchSpy.mock.calls[0]?.[0];
    const serializedUrl =
      typeof firstCallUrl === 'string'
        ? firstCallUrl
        : firstCallUrl instanceof URL
          ? firstCallUrl.toString()
          : firstCallUrl.url;
    expect(serializedUrl).toBe('/api/scenario/test-id/causal-graph');
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
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);
    renderView();
    await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(fitViewMock.mock.calls.length).toBeGreaterThan(0);
    });
    const initialCalls = fitViewMock.mock.calls.length;

    await user.type(screen.getByPlaceholderText('Search Agent...'), 'beta');

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

    await user.click(await screen.findByTestId('rf-node-n1'));
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

  it('keeps the node detail panel outside the export target so transient UI is not exported', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-export-scope',
        available_branches: ['br1'],
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Agent Alpha speaks', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
        ],
        edges: [],
      }),
    } as Response);

    const { container } = renderView();
    const nodeButton = await screen.findByTestId('rf-node-n1');
    await user.click(nodeButton);

    const detailPanel = await screen.findByTestId('node-detail-panel');
    const exportRoot = await screen.findByTestId('causal-graph-export-target');
    expect(container.contains(exportRoot)).toBe(true);
    expect(exportRoot?.contains(detailPanel)).toBe(false);
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

  it('ignores stale branch responses when a newer branch selection resolves first', async () => {
    const user = userEvent.setup();
    const branchOneResponse = createDeferredResponse();
    const branchTwoResponse = createDeferredResponse();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('branch_id=br1')) return branchOneResponse.promise;
      if (url.includes('branch_id=br2')) return branchTwoResponse.promise;
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    render(
      <MemoryRouter initialEntries={['/sim/test-id/causal-map?branch_id=br1']}>
        <Routes>
          <Route path="/sim/:id/causal-map" element={<BranchNavigationHarness />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('button', { name: 'Go br2' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    branchTwoResponse.resolve({
      ok: true,
      json: async () => ({
        id: 'g-branch-two',
        available_branches: ['br1', 'br2'],
        nodes: [{ id: 'n2', key: 'e2', type: 'event', label: 'Branch 2 fresh event', round: 1, payload: { branch_id: 'br2' } }],
        edges: [],
      }),
    } as Response);

    await screen.findByText(/Branch 2 fresh event/);

    branchOneResponse.resolve({
      ok: true,
      json: async () => ({
        id: 'g-branch-one',
        available_branches: ['br1', 'br2'],
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Branch 1 stale event', round: 1, payload: { branch_id: 'br1' } }],
        edges: [],
      }),
    } as Response);

    await waitFor(() => {
      expect(screen.getByText(/Branch 2 fresh event/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Branch 1 stale event/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('hides export controls when large graphs fall back to the text list', async () => {
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
    expect(screen.queryByTestId('export-panel')).not.toBeInTheDocument();
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
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Event');
    vi.restoreAllMocks();
  });

  it('uses a single named a11y list when large graphs use the text fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-fallback-a11y',
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

    const visibleList = await screen.findByRole('list', { name: 'Causal events list' });
    expect(visibleList).toBeInTheDocument();
    expect(screen.getAllByRole('list')).toHaveLength(1);
    expect(within(visibleList).getAllByRole('listitem')[0]).toHaveTextContent('Event');
  });
});
