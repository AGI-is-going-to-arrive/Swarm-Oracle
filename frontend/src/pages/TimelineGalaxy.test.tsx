/**
 * FE-2 — TimelineGalaxy tests
 *
 * Covers:
 *   - Capability gate (shares kg_explorer with KGExplorerView)
 *   - Happy path: renders root + Canvas + handles empty data safely
 *   - Node click dispatches kg:openNodeSheet CustomEvent
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('node click dispatches kg:openNodeSheet with timeline context', async () => {
    mockUseCapabilityCheck.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ nodes: [], edges: [] }),
    });
    renderAt('sc-55');
    await waitFor(() => expect(nodeClickHandlers.length).toBeGreaterThan(0));
    const listener = vi.fn();
    window.addEventListener('kg:openNodeSheet', listener);
    nodeClickHandlers[0]({ target: { id: 'node-1' } });
    expect(listener).toHaveBeenCalled();
    const evt = listener.mock.calls[0][0] as CustomEvent;
    expect(evt.detail.scenarioId).toBe('sc-55');
    expect(evt.detail.originContext.graphNodeType).toBe('timeline-galaxy');
    window.removeEventListener('kg:openNodeSheet', listener);
  });
});
