/**
 * Phase C2 — ArgumentMap tests (upgraded for @xyflow/react DAG)
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fitViewMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  return {
    ReactFlow: (props: Record<string, unknown>) => {
      const nodes = props.nodes as Array<{ id: string }> | undefined;
      const edges = props.edges as Array<Record<string, unknown>> | undefined;
      const children = props.children as React.ReactNode;
      const onNodeClick = props.onNodeClick as ((e: unknown, n: unknown) => void) | undefined;
      const onPaneClick = props.onPaneClick as (() => void) | undefined;
      const onInit = props.onInit as ((instance: { fitView: typeof fitViewMock }) => void) | undefined;
      const firstEdge = edges?.[0];

      React.useEffect(() => {
        onInit?.({ fitView: fitViewMock });
      }, [onInit]);

      return (
        <div
          data-testid="reactflow"
          data-nodes={nodes?.length}
          data-edges={edges?.length}
          data-edge-stroke={String((firstEdge?.style as Record<string, unknown> | undefined)?.stroke ?? '')}
          data-edge-dash={String((firstEdge?.style as Record<string, unknown> | undefined)?.strokeDasharray ?? '')}
          data-edge-animated={String(firstEdge?.animated ?? false)}
          data-edge-marker={JSON.stringify(firstEdge?.markerEnd ?? null)}
        >
          {/* Expose clickable elements per node for testing onNodeClick */}
          {nodes?.map(n => (
            <button key={n.id} data-testid={`rf-node-${n.id}`} onClick={(e) => onNodeClick?.(e, n)} />
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
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
  };
});

import { ArgumentMap, ArgumentStrengthMeter, type ArgumentUnit } from './ArgumentMap';

afterEach(() => {
  cleanup();
  fitViewMock.mockReset();
  vi.restoreAllMocks();
});

const createDeferredResponse = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

// ── ArgumentMap main component ──────────────────────────────

describe('ArgumentMap', () => {
  it('returns null when not visible', () => {
    const { container } = render(<ArgumentMap debateId="d1" visible={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows loading state while fetching', () => {
    // Never resolve the fetch to keep loading state
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise(() => {}));
    render(<ArgumentMap debateId="d1" visible={true} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows empty state when API returns no units and no nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ snapshot_id: null, nodes: [], edges: [], units: [] }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const msg = await screen.findByText(/No argument map/);
    expect(msg).toBeInTheDocument();
  });

  it('keeps filter controls available when no units match the selected statuses', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-empty-filter',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Only standing', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Only standing', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    await user.click(screen.getByRole('button', { name: 'Accepted' }));

    expect(await screen.findByText('No argument units match the selected filters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Standing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(await screen.findByTestId('reactflow')).toBeInTheDocument();
    expect(screen.queryByText('No argument units match the selected filters.')).not.toBeInTheDocument();
  });

  it('renders ReactFlow component when data has units (fallback layout)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Economy grows', turn_id: 't1' },
          { id: 'u2', type: 'rebuttal', status: 'rebutted', text: 'Inflation rises', turn_id: 't2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow).toBeInTheDocument();
    // Fallback layout: 2 units → 2 nodes, 0 edges
    expect(flow.getAttribute('data-nodes')).toBe('2');
    expect(flow.getAttribute('data-edges')).toBe('0');
  });

  it('renders ReactFlow with graph nodes and edges', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's2',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'Supporting data', round: 2, payload: null },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', type: 'supports', weight: 1, label: null },
        ],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'Supporting data', turn_id: 't2', node_id: 'n2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-nodes')).toBe('2');
    expect(flow.getAttribute('data-edges')).toBe('1');
  });

  it('handles 501 gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 501,
      json: async () => ({}),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const msg = await screen.findByText(/Feature not enabled|not enabled/i);
    expect(msg).toBeInTheDocument();
  });

  it('applies the too_large guard when fallback data contains many units but no raw graph nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-too-large-fallback',
        nodes: [],
        edges: [],
        units: Array.from({ length: 2001 }, (_, index) => ({
          id: `u${index}`,
          type: 'claim',
          status: 'standing',
          text: `Claim ${index}`,
          turn_id: `t${index}`,
        })),
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    expect(await screen.findByText('Too many nodes to display')).toBeInTheDocument();
    expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument();
  });

  it('handles network error gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network failed'));
    render(<ArgumentMap debateId="d1" visible={true} />);
    const msg = await screen.findByText(/Network error/i);
    expect(msg).toBeInTheDocument();
  });

  it('treats a 200 payload with json.error as load_failed and keeps graph/export hidden', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-error',
        nodes: [],
        edges: [],
        units: [],
        error: 'ARGUMENT_MAP_LOAD_FAILED',
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    expect(await screen.findByText('Load failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(/No argument map/)).not.toBeInTheDocument();
  });

  it('shows export panel when data has units', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'A claim', turn_id: 't1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const panel = await screen.findByTestId('export-panel');
    expect(panel).toBeInTheDocument();
  });

  it('renders legend with all type labels', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'A claim', turn_id: 't1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    expect(screen.getByText('Claim')).toBeInTheDocument();
    expect(screen.getByText('Evidence')).toBeInTheDocument();
    expect(screen.getByText('Rebuttal')).toBeInTheDocument();
    expect(screen.getByText('Counter')).toBeInTheDocument();
    expect(screen.getByText(/1 units/)).toBeInTheDocument();
  });

  it('renders the minimap as a non-interactive overlay so it does not block node clicks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-minimap',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    const minimap = await screen.findByTestId('rf-minimap');
    expect(minimap).toHaveAttribute('data-pointer-events', 'none');
  });

  it('renders the rejected status filter when backend data uses that status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-rejected',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Rejected claim', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'rejected', text: 'Rejected claim', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    expect(screen.getByRole('button', { name: 'Rejected' })).toBeInTheDocument();
  });

  it('renders screen reader fallback list with all units', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'A claim', turn_id: 't1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'Proof', turn_id: 't2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    const srList = screen.getByRole('list', { name: 'Argument units list' });
    const items = within(srList).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('claim');
    expect(items[0].textContent).toContain('A claim');
    expect(items[0].textContent).toContain('standing');
  });

  it('renders aria-label on map container', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'X', turn_id: 't1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    expect(screen.getByLabelText('Debate argument map')).toBeInTheDocument();
  });

  it('clears node detail panel when refreshTrigger fires re-fetch', async () => {
    // First render: load data with a graph node
    const data = {
      snapshot_id: 's1',
      nodes: [{ id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null }],
      edges: [],
      units: [{ id: 'u1', type: 'claim', status: 'standing', text: 'Main claim full', turn_id: 't1', node_id: 'n1' }],
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => data } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => data } as Response);

    const user = userEvent.setup();
    const { rerender } = render(<ArgumentMap debateId="d1" visible={true} refreshTrigger={0} />);
    await screen.findByTestId('reactflow');

    // Click node to open detail panel
    await user.click(screen.getByTestId('rf-node-n1'));
    expect(screen.getByTestId('node-detail-panel')).toBeInTheDocument();

    // Re-render with new refreshTrigger → triggers re-fetch → should clear panel
    rerender(<ArgumentMap debateId="d1" visible={true} refreshTrigger={1} />);
    // After re-fetch, detail panel should be gone
    await screen.findByTestId('reactflow');
    expect(screen.queryByTestId('node-detail-panel')).not.toBeInTheDocument();
  });

  it('ignores stale responses when debateId changes and a newer request resolves first', async () => {
    const firstResponse = createDeferredResponse();
    const secondResponse = createDeferredResponse();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/debate/d1/argument-map')) return firstResponse.promise;
      if (url.includes('/api/debate/d2/argument-map')) return secondResponse.promise;
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const { rerender } = render(<ArgumentMap debateId="d1" visible={true} />);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    rerender(<ArgumentMap debateId="d2" visible={true} />);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    secondResponse.resolve({
      ok: true,
      json: async () => ({
        snapshot_id: 's-new',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'New claim', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'New evidence', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'New claim', turn_id: 't2', node_id: 'n1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'New evidence', turn_id: 't2', node_id: 'n2' },
        ],
      }),
    } as Response);

    const flow = await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(flow.getAttribute('data-nodes')).toBe('2');
    });

    firstResponse.resolve({
      ok: true,
      json: async () => ({
        snapshot_id: 's-old',
        nodes: [
          { id: 'old-1', key: 'old-k1', type: 'claim', label: 'Old claim', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'old-u1', type: 'claim', status: 'standing', text: 'Old claim', turn_id: 't1', node_id: 'old-1' },
        ],
      }),
    } as Response);

    await waitFor(() => {
      expect(screen.getByTestId('reactflow').getAttribute('data-nodes')).toBe('2');
    });
    expect(screen.getByText(/2 units/)).toBeInTheDocument();
  });

  it('refits the viewport after status filters change the graph', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-fit',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Claim A', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'Evidence B', round: 1, payload: null },
        ],
        edges: [{ id: 'e1', source: 'n2', target: 'n1', type: 'supports', weight: 1, label: null }],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Claim A', turn_id: 't1', node_id: 'n1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'Evidence B', turn_id: 't1', node_id: 'n2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    const initialCalls = fitViewMock.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Accepted' }));

    expect(fitViewMock.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('does not refit the viewport when selecting or clearing a node highlight', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-select',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Claim A', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'Evidence B', round: 1, payload: null },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'supports', weight: 1, label: null }],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Claim A', turn_id: 't1', node_id: 'n1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'Evidence B', turn_id: 't1', node_id: 'n2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
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
  });
});

// ── Phase C: Status filter (C5) ─────────────────────────────

describe('ArgumentMap status filter (C5)', () => {
  const dataWithStatuses = {
    snapshot_id: 's1',
    nodes: [
      { id: 'n1', key: 'k1', type: 'claim', label: 'Claim A', round: 1, payload: null },
      { id: 'n2', key: 'k2', type: 'evidence', label: 'Evidence B', round: 1, payload: null },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'supports', weight: 1, label: null }],
    units: [
      { id: 'u1', type: 'claim', status: 'standing', text: 'Claim A', turn_id: 't1', node_id: 'n1' },
      { id: 'u2', type: 'evidence', status: 'accepted', text: 'Evidence B', turn_id: 't2', node_id: 'n2' },
    ],
  };

  it('renders filter chips for all statuses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => dataWithStatuses,
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    expect(screen.getByRole('button', { name: 'Accepted' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Standing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unaddressed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rebutted' })).toBeInTheDocument();
  });

  it('shows clear button when filter is active', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => dataWithStatuses,
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    // Initially no clear button
    expect(screen.queryByText('Clear')).not.toBeInTheDocument();

    // Click a filter chip
    await user.click(screen.getByRole('button', { name: 'Standing' }));

    // Clear button should appear
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('filters displayed nodes by status', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => dataWithStatuses,
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-nodes')).toBe('2');

    // Filter to only 'accepted' — should show 1 node (n2 with accepted unit)
    await user.click(screen.getByRole('button', { name: 'Accepted' }));
    expect(flow.getAttribute('data-nodes')).toBe('1');
  });
});

// ── Phase C: Edge styling (C2) ──────────────────────────────

describe('ArgumentMap edge styling (C2)', () => {
  it('edges use EDGE_STYLES colors from graphTokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's2',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'A', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'B', round: 1, payload: null },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', type: 'supports', weight: 1, label: null },
        ],
        units: [],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-edges')).toBe('1');
    expect(flow.getAttribute('data-edge-stroke')).toBe('#2ecc71');
    expect(flow.getAttribute('data-edge-animated')).toBe('false');
    expect(flow.getAttribute('data-edge-marker')).toContain('arrowclosed');
  });

  it('temporal edges omit arrow markers and use dashed styling', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's3',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'A', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'claim', label: 'B', round: 2, payload: null },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', type: 'temporal', weight: 0.5, label: null },
        ],
        units: [],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-edge-dash')).toBe('4 4');
    expect(flow.getAttribute('data-edge-marker')).toBe('null');
  });
});

// ── ArgumentStrengthMeter ───────────────────────────────────

describe('ArgumentStrengthMeter', () => {
  it('returns null when units are empty', () => {
    const { container } = render(<ArgumentStrengthMeter units={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders correct color segments based on unit statuses', () => {
    const units: ArgumentUnit[] = [
      { id: 'u1', type: 'claim', status: 'standing', text: '', turn_id: 't1' },
      { id: 'u2', type: 'claim', status: 'standing', text: '', turn_id: 't2' },
      { id: 'u3', type: 'rebuttal', status: 'rebutted', text: '', turn_id: 't3' },
    ];
    render(<ArgumentStrengthMeter units={units} />);
    const meter = screen.getByRole('meter');
    expect(meter).toBeInTheDocument();
    expect(meter.getAttribute('aria-valuemax')).toBe('3');

    // Check segments are rendered via title attributes
    const standingSegment = screen.getByTitle(/Standing: 2\/3/);
    expect(standingSegment).toBeInTheDocument();
    expect(standingSegment).toHaveStyle({ background: '#2ecc71' });

    const rebuttedSegment = screen.getByTitle(/Rebutted: 1\/3/);
    expect(rebuttedSegment).toBeInTheDocument();
    expect(rebuttedSegment).toHaveStyle({ background: '#e74c3c' });
  });

  it('skips zero-count statuses', () => {
    const units: ArgumentUnit[] = [
      { id: 'u1', type: 'claim', status: 'accepted', text: '', turn_id: 't1' },
    ];
    render(<ArgumentStrengthMeter units={units} />);
    const meter = screen.getByRole('meter');
    // Only 1 child segment (accepted)
    const segments = meter.children;
    expect(segments.length).toBe(1);
    expect(screen.getByTitle(/Accepted: 1\/1/)).toBeInTheDocument();
  });

  it('renders compact height when compact prop is true', () => {
    const units: ArgumentUnit[] = [
      { id: 'u1', type: 'claim', status: 'standing', text: '', turn_id: 't1' },
    ];
    render(<ArgumentStrengthMeter units={units} compact />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveStyle({ height: '4px' });
  });
});
