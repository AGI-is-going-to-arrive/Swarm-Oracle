/**
 * Phase C1 — CausalReviewView tests
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

// Mock @xyflow/react to avoid canvas errors in jsdom
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="reactflow">{children}</div>
  ),
  Background: () => null,
  Controls: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

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
