/**
 * FE-2 — TimelineGalaxy tests
 *
 * Covers:
 *   - Capability gate (shares kg_explorer with KGExplorerView)
 *   - Happy path: renders root + Canvas + handles empty data safely
 *   - Node clicks open shared details using the actual causal node and evidence
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const nodeClickHandlers: Array<(evt: unknown) => void> = [];

vi.mock('@antv/g6', () => {
  class MockGraph {
    on(event: string, cb: (evt: unknown) => void) {
      if (event === 'node:click') nodeClickHandlers.push(cb);
    }
    off() {}
    render() {
      return Promise.resolve();
    }
    destroy() {}
  }
  return { Graph: MockGraph };
});

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: vi.fn(),
}));

vi.mock('../api/client', () => ({
  buildSessionHeaders: () => ({}),
}));

import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import TimelineGalaxy from './TimelineGalaxy';

const mockUseCapabilityCheck = vi.mocked(useCapabilityCheck);
const fetchMock = vi.fn();

function renderAt(id = 'scn-1') {
  return render(
    <MemoryRouter initialEntries={[`/timeline-galaxy/${id}`]}>
      <Routes>
        <Route path="/timeline-galaxy/:id" element={<TimelineGalaxy />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  nodeClickHandlers.length = 0;
  fetchMock.mockReset();
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

afterEach(() => {
  cleanup();
});

describe('TimelineGalaxy', () => {
  it('renders feature-disabled surface when capability is off', () => {
    mockUseCapabilityCheck.mockReturnValue({
      loading: false,
      enabled: false,
      capabilities: null,
    });
    renderAt();
    expect(screen.getByTestId('timeline-galaxy-root')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders retryable capability probe error before feature-disabled state', () => {
    const reload = vi.fn(async () => undefined);
    mockUseCapabilityCheck.mockReturnValue({
      loading: false,
      enabled: false,
      capabilities: null,
      error: new Error('capability probe failed'),
      reload,
    });
    renderAt();
    expect(screen.getByTestId('timeline-galaxy-root')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot verify feature');
    expect(screen.queryByText('KG Explorer is not enabled on this server.')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('renders Canvas + calls fetch when capability on', async () => {
    mockUseCapabilityCheck.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [
          { id: 'a', label: 'turn 1', round: 1 },
          { id: 'b', label: 'turn 3', round: 3 },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
      }),
    });
    renderAt('scn-9');
    expect(screen.getByTestId('timeline-galaxy-root')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('opens an event detail with its evidence rather than treating the graph ID as an identity', async () => {
    mockUseCapabilityCheck.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [{ id: 'event-1', label: 'An opening statement', type: 'event', round: 2, payload: { agent_id: 'runtime-agent-9', agent_name: 'Ada', content: 'The original statement.', message_id: 'message-7', branch_id: 'branch-2' } }],
        edges: [{ id: 'edge-1', source: 'event-1', target: 'outcome-2', evidence: { source_ref: 'message-7', confidence_tier: 'high', source_round_number: 2 } }],
      }),
    });
    renderAt('sc-55');
    await waitFor(() => expect(nodeClickHandlers.length).toBeGreaterThan(1));
    act(() => nodeClickHandlers.at(-1)!({ target: { id: 'event-1' } }));
    const detail = screen.getByRole('dialog', { name: 'An opening statement' });
    expect(detail).toHaveTextContent('The original statement.');
    expect(detail).toHaveTextContent('runtime-agent-9');
    expect(detail).toHaveTextContent('High');
    expect(detail).toHaveTextContent('message-7');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('application')).toHaveFocus();
  });

  it('opens outcome-specific details from a G6 target getter', async () => {
    mockUseCapabilityCheck.mockReturnValue({ loading: false, enabled: true, capabilities: null });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({
      nodes: [{ id: 'outcome-1', type: 'outcome', label: 'A saved ending', round: 4, payload: { story_excerpt: 'The branch ending.', probability: 0.4, provenance_kind: 'runtime_projection' } }],
      edges: [],
    }) });
    renderAt();
    await waitFor(() => expect(nodeClickHandlers.length).toBeGreaterThan(1));
    act(() => nodeClickHandlers.at(-1)!({ target: { get: () => 'outcome-1' } }));
    const detail = screen.getByRole('dialog', { name: 'A saved ending' });
    expect(detail).toHaveTextContent('The branch ending.');
    expect(detail).toHaveTextContent('40.0%');
    expect(screen.getByTestId('node-detail-provenance-caveat')).toBeInTheDocument();
  });

  it('shows retry feedback for a node no longer present in the response', async () => {
    mockUseCapabilityCheck.mockReturnValue({ loading: false, enabled: true, capabilities: null });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ nodes: [], edges: [] }) });
    renderAt();
    await waitFor(() => expect(nodeClickHandlers.length).toBeGreaterThan(1));
    act(() => nodeClickHandlers.at(-1)!({ target: { id: 'missing' } }));
    expect(screen.getByRole('alert')).toHaveTextContent('This node is no longer available. Reload the timeline.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
