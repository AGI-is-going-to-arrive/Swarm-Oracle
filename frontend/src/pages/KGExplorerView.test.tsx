/**
 * FE-2 / FE-3-seq — KGExplorerView tests
 *
 * Covers:
 *   - Capability gate: kg_explorer.enabled=false → feature_disabled surface
 *   - Happy path: fetch causal-graph + render root + search + filter pills
 *   - Node click opens NodeConversationSheet (FE-3-seq wire-up, replaces
 *     the legacy kg:openNodeSheet CustomEvent bridge)
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

interface KgGraphMockState {
  nodeClickHandlers: Array<(evt: unknown) => void>;
  destroyCount: number;
  setOptionsCalls: unknown[][];
  renderCount: number;
}

function getKgGraphMockState(): KgGraphMockState {
  const scope = globalThis as unknown as { __kgGraphMockState?: KgGraphMockState };
  if (!scope.__kgGraphMockState) {
    scope.__kgGraphMockState = {
      nodeClickHandlers: [],
      destroyCount: 0,
      setOptionsCalls: [],
      renderCount: 0,
    };
  }
  return scope.__kgGraphMockState;
}

vi.mock('@antv/g6', () => {
  const graphState = getKgGraphMockState();
  class MockGraph {
    on(event: string, cb: (evt: unknown) => void) {
      if (event === 'node:click') graphState.nodeClickHandlers.push(cb);
    }
    off() {}
    render() {
      graphState.renderCount += 1;
      return Promise.resolve();
    }
    setOptions(...args: unknown[]) {
      graphState.setOptionsCalls.push(args);
    }
    setSize() {}
    destroy() {
      graphState.destroyCount += 1;
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

function renderWithNavigator(initialId = 'abc123') {
  function Harness() {
    const navigate = useNavigate();
    return (
      <>
        <button
          type="button"
          data-testid="kg-explorer-nav-next"
          onClick={() => navigate('/kg-explorer/scn-b')}
        >
          next
        </button>
        <Routes>
          <Route path="/kg-explorer/:id" element={<KGExplorerView />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </>
    );
  }

  return render(
    <MemoryRouter initialEntries={[`/kg-explorer/${initialId}`]}>
      <Harness />
    </MemoryRouter>,
  );
}

function makeConversationSseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const chunks = frames.map((frame) => encoder.encode(frame));
  let index = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: vi.fn(async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        }),
      }),
    },
  } as unknown as Response;
}

const fetchMock = vi.fn();

class NoopWS {
  static OPEN = 1;
  readyState = NoopWS.OPEN;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    /* noop */
  }
}

beforeEach(() => {
  const graphState = getKgGraphMockState();
  graphState.nodeClickHandlers.length = 0;
  graphState.destroyCount = 0;
  graphState.setOptionsCalls.length = 0;
  graphState.renderCount = 0;
  fetchMock.mockReset();
  (globalThis as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
  vi.stubGlobal('WebSocket', NoopWS as unknown as typeof WebSocket);
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

  it('shows a retryable error surface when capability loading fails', async () => {
    const reload = vi.fn();
    mockUseCapabilityCheck.mockReturnValue({
      loading: false,
      enabled: false,
      capabilities: null,
      error: new Error('capabilities failed'),
      reload,
    });
    renderAt();

    expect(await screen.findByText('Knowledge Graph is unavailable')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledTimes(1);
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

  it('node click opens NodeConversationSheet (FE-3-seq wire-up)', async () => {
    renderAt('scn-42');
    await waitFor(() => expect(getKgGraphMockState().nodeClickHandlers.length).toBeGreaterThan(0));
    // Sheet is not mounted prior to interaction.
    expect(screen.queryByTestId('node-conversation-sheet')).toBeNull();
    // Simulate node click via our mock Graph.on callback.
    act(() => {
      getKgGraphMockState().nodeClickHandlers.at(-1)?.({ target: { id: 'node-9', type: 'circle' } });
    });
    const sheet = await screen.findByTestId('node-conversation-sheet');
    expect(sheet).toBeInTheDocument();
  });

  it('starts node conversation with the explorer scenario id and a null identity id', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'graph-1',
          nodes: [{ id: 'node-9', type: 'event', label: 'Node 9', round: 1 }],
          edges: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ thread_id: 'thread-kg-1' }),
      } as Response)
      .mockResolvedValueOnce(
        makeConversationSseResponse([
          'event: turn_started\ndata: {"turn_id":"turn-kg-1","thread_id":"thread-kg-1","sequence":2}\n\n',
          'event: turn_token_delta\ndata: {"turn_id":"turn-kg-1","delta":"ok"}\n\n',
          'event: turn_completed\ndata: {"turn_id":"turn-kg-1","sequence":2,"status":"committed"}\n\n',
        ]),
      );

    renderAt('scn-42');
    await waitFor(() => {
      const dataUpdates = getKgGraphMockState().setOptionsCalls
        .map(([options]) => (options as { data?: { nodes?: Array<{ id: string }> } }).data)
        .filter(Boolean);
      expect(dataUpdates.at(-1)?.nodes?.map((node) => node.id)).toEqual(['node-9']);
    });
    act(() => {
      getKgGraphMockState().nodeClickHandlers.at(-1)?.({ target: { id: 'node-9', type: 'circle' } });
    });

    await user.type(await screen.findByTestId('node-conversation-input'), 'inspect node');
    await user.click(screen.getByTestId('node-conversation-send'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/conversation/start',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    const [, startOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
    const startBody = JSON.parse(String(startOptions.body));
    expect(startBody.scenario_id).toBe('scn-42');
    expect(startBody.agent_identity_id).toBeNull();
    expect(startBody.origin_node_id).toBe('node-9');
    expect(startBody.origin_node_type).toBe('event');
    expect(startBody.origin_round_number).toBe(1);
  });

  it('closes the open sheet when the route scenario id changes', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'graph-a',
          nodes: [{ id: 'node-a', type: 'circle', label: 'Node A', round: 1 }],
          edges: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'graph-b',
          nodes: [{ id: 'node-b', type: 'circle', label: 'Node B', round: 2 }],
          edges: [],
        }),
      } as Response);

    renderWithNavigator('scn-a');
    await waitFor(() => expect(getKgGraphMockState().nodeClickHandlers.length).toBeGreaterThan(0));

    act(() => {
      getKgGraphMockState().nodeClickHandlers.at(-1)?.({ target: { id: 'node-a', type: 'circle' } });
    });
    expect(await screen.findByTestId('node-conversation-sheet')).toBeInTheDocument();

    await user.click(screen.getByTestId('kg-explorer-nav-next'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        '/api/scenario/scn-b/causal-graph',
        expect.any(Object),
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId('node-conversation-sheet')).toBeNull();
    });
  });

  it('search input updates value (controlled component)', async () => {
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const search = screen.getByTestId('kg-explorer-search') as HTMLInputElement;
    await user.type(search, 'alpha');
    expect(search.value).toBe('alpha');
  });

  it('search updates the visible G6 graph data', async () => {
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const search = screen.getByTestId('kg-explorer-search') as HTMLInputElement;
    await user.type(search, 'alpha');

    await waitFor(() => {
      const dataUpdates = getKgGraphMockState().setOptionsCalls
        .map(([options]) => (options as { data?: { nodes?: Array<{ id: string }> } }).data)
        .filter(Boolean);
      expect(dataUpdates.at(-1)?.nodes?.map((node) => node.id)).toEqual(['n1']);
    });
  });

  it('renders a friendly fetch error and retries the graph request', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-2',
          nodes: [{ id: 'n3', type: 'event', label: 'Recovered node', round: 3 }],
          edges: [],
        }),
      } as Response);

    renderAt();

    expect(await screen.findByText('Knowledge graph data is not available for this scenario.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('kg-explorer-g6-canvas')).toBeInTheDocument();
  });
});
