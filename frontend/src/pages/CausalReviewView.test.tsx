/**
 * Phase C1 — CausalReviewView tests
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

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
vi.mock('@xyflow/react', () => {
  const identity = <T,>(items: T[]) => [items, vi.fn(), vi.fn()] as const;
  return {
    ReactFlow: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="reactflow">{children}</div>
    ),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    useNodesState: identity,
    useEdgesState: identity,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
  };
});

import { Route, Routes } from 'react-router-dom';
import { CausalReviewView } from './CausalReviewView';

afterEach(cleanup);

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

  it('keeps the branch selector visible when a branch filter is active', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g1',
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
