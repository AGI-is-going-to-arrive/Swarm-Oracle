/**
 * FE-2 — KGExplorerView tests
 *
 * Covers:
 *   - Capability gate: kg_explorer.enabled=false → feature_disabled surface
 *   - Happy path: fetch causal-graph + render root + search + filter pills
 *   - Node click (simulated via CustomEvent dispatcher) fires kg:openNodeSheet
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const nodeClickHandlers: Array<(evt: unknown) => void> = [];
const graphDestroySpy = vi.fn();

vi.mock('@antv/g6', () => {
  class MockGraph {
    on(event: string, cb: (evt: unknown) => void) {
      if (event === 'node:click') nodeClickHandlers.push(cb);
    }
    off() {}
    render() {
      return Promise.resolve();
    }
    destroy() {
      graphDestroySpy();
    }
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
import KGExplorerView from './KGExplorerView';

const mockUseCapabilityCheck = vi.mocked(useCapabilityCheck);

function renderAt(id = 'abc123') {
  return render(
    <MemoryRouter initialEntries={[`/kg-explorer/${id}`]}>
      <Routes>
        <Route path="/kg-explorer/:id" element={<KGExplorerView />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  nodeClickHandlers.length = 0;
  graphDestroySpy.mockClear();
  fetchMock.mockReset();
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

afterEach(() => {
  cleanup();
});

describe('KGExplorerView capability gate', () => {
  it('shows feature-disabled surface when capability is off', async () => {
    mockUseCapabilityCheck.mockReturnValue({
      loading: false,
      enabled: false,
      capabilities: null,
    });
    renderAt();
    expect(await screen.findByTestId('kg-explorer-root')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Fetch must NOT happen when capability is disabled.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows loading placeholder while capability is pending', () => {
    mockUseCapabilityCheck.mockReturnValue({
      loading: true,
      enabled: false,
      capabilities: null,
    });
    renderAt();
    expect(screen.getByTestId('kg-explorer-root')).toBeInTheDocument();
  });
});

describe('KGExplorerView happy path', () => {
  beforeEach(() => {
    mockUseCapabilityCheck.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'g-1',
        nodes: [
          { id: 'n1', type: 'event', label: 'alpha event', round: 1 },
          { id: 'n2', type: 'fork', label: 'beta fork', round: 2 },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'caused' }],
      }),
    });
  });

  it('renders root + dual stack + xyflow + minimap + filter pills + search', async () => {
    renderAt();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('kg-explorer-root')).toBeInTheDocument();
    expect(screen.getByTestId('kg-explorer-g6-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('kg-explorer-dual-stack')).toBeInTheDocument();
    expect(screen.getByTestId('kg-explorer-xyflow')).toBeInTheDocument();
    expect(screen.getByTestId('kg-explorer-minimap')).toBeInTheDocument();
    expect(screen.getByTestId('kg-explorer-filter-pills')).toBeInTheDocument();
    expect(screen.getByTestId('kg-explorer-search')).toBeInTheDocument();
  });

  it('Canvas wrapper is keyboard-focusable (tabIndex=0)', async () => {
    renderAt();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const canvas = screen.getByTestId('kg-explorer-g6-canvas');
    expect(canvas).toHaveAttribute('tabindex', '0');
  });

  it('node click dispatches kg:openNodeSheet CustomEvent', async () => {
    renderAt('scn-42');
    await waitFor(() => expect(nodeClickHandlers.length).toBeGreaterThan(0));
    const listener = vi.fn();
    window.addEventListener('kg:openNodeSheet', listener);
    // Simulate node click via our mock Graph.on callback.
    nodeClickHandlers[0]({ target: { id: 'node-9', type: 'circle' } });
    expect(listener).toHaveBeenCalled();
    const evt = listener.mock.calls[0][0] as CustomEvent;
    expect(evt.detail).toEqual({
      scenarioId: 'scn-42',
      identityId: 'node-9',
      originContext: { graphNodeType: 'circle' },
    });
    window.removeEventListener('kg:openNodeSheet', listener);
  });

  it('search input updates value (controlled component)', async () => {
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const search = screen.getByTestId('kg-explorer-search') as HTMLInputElement;
    await user.type(search, 'alpha');
    expect(search.value).toBe('alpha');
  });
});
