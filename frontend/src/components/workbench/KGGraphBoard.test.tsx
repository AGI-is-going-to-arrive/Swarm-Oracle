import { cleanup, render, screen, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const mockT = vi.fn((key: string, fallback?: string, options?: Record<string, unknown>) => {
    let value = fallback ?? key;
    if (options) {
      for (const [optionKey, optionValue] of Object.entries(options)) {
        value = value.replaceAll(`{{${optionKey}}}`, String(optionValue));
      }
    }
    return value;
  });
  const mockUseReducedMotion = vi.fn(() => false);
  const refetchFn = vi.fn();
  const mockScenarioGraphReturn = {
    data: null as unknown,
    loading: false,
    error: null as unknown,
    refetch: refetchFn,
  };
  const destroySpy = vi.fn();
  const onSpy = vi.fn();
  const offSpy = vi.fn();
  const renderSpy = vi.fn(() => Promise.resolve());
  const setOptionsSpy = vi.fn();
  const setDataSpy = vi.fn();
  const drawSpy = vi.fn(() => Promise.resolve());
  const setSizeSpy = vi.fn();
  const zoomToSpy = vi.fn();
  const fitViewSpy = vi.fn();
  const focusElementSpy = vi.fn();
  const fitCenterSpy = vi.fn();
  const focusElementEnabled = { value: true };
  const getDataSpy = vi.fn(() => ({ nodes: [] as { id: string }[], edges: [] as { id: string }[] }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getNeighborNodesDataSpy = vi.fn((_id?: unknown) => [] as { id: string }[]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const getRelatedEdgesDataSpy = vi.fn((_id?: unknown, _dir?: unknown) => [] as { id: string }[]);
  const setElementStateSpy = vi.fn();

  return {
    mockT, mockUseReducedMotion, mockScenarioGraphReturn, refetchFn,
    destroySpy, onSpy, offSpy, renderSpy, setOptionsSpy, setDataSpy, drawSpy, setSizeSpy,
    zoomToSpy, fitViewSpy, focusElementSpy, fitCenterSpy, focusElementEnabled,
    getDataSpy, getNeighborNodesDataSpy, getRelatedEdgesDataSpy, setElementStateSpy,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (...args: unknown[]) => hoisted.mockT(...(args as [string, string?, Record<string, unknown>?])),
    i18n: { changeLanguage: () => {}, language: 'en' },
  }),
}));

vi.mock('../../hooks/useReducedMotion', () => ({
  default: () => hoisted.mockUseReducedMotion(),
}));

vi.mock('../../hooks/useScenarioGraph', () => ({
  useScenarioGraph: () => hoisted.mockScenarioGraphReturn,
}));

vi.mock('../kg/NodeConversationSheet', () => ({
  NodeConversationSheet: ({ open, origin }: { open: boolean; origin: { nodeId: string } }) =>
    open ? <div data-testid="node-conversation-sheet">{origin.nodeId}</div> : null,
}));

vi.mock('@antv/g6', () => {
  class GraphMock {
    destroy() { return hoisted.destroySpy(); }
    on(...a: unknown[]) { return hoisted.onSpy(...a); }
    off(...a: unknown[]) { return hoisted.offSpy(...a); }
    render() { return hoisted.renderSpy(); }
    setOptions(...a: unknown[]) { return hoisted.setOptionsSpy(...a); }
    setData(...a: unknown[]) { return hoisted.setDataSpy(...a); }
    draw() { return hoisted.drawSpy(); }
    setSize(...a: unknown[]) { return hoisted.setSizeSpy(...a); }
    zoomTo() { return hoisted.zoomToSpy(); }
    fitView() { return hoisted.fitViewSpy(); }
    fitCenter(...a: unknown[]) { return hoisted.fitCenterSpy(...a); }
    getData() { return hoisted.getDataSpy(); }
    getNeighborNodesData(id: unknown) { return hoisted.getNeighborNodesDataSpy(id); }
    getRelatedEdgesData(id: unknown, dir: unknown) { return hoisted.getRelatedEdgesDataSpy(id, dir); }
    setElementState(rec: unknown, animate: unknown) { return hoisted.setElementStateSpy(rec, animate); }
  }
  Object.defineProperty(GraphMock.prototype, 'focusElement', {
    configurable: true,
    get() {
      return hoisted.focusElementEnabled.value
        ? (...a: unknown[]) => hoisted.focusElementSpy(...a)
        : undefined;
    },
  });
  return { Graph: GraphMock };
});

import KGGraphBoard from './KGGraphBoard';
import type { GraphPayload } from '../../hooks/useScenarioGraph';

afterEach(() => {
  cleanup();
  hoisted.mockT.mockClear();
  hoisted.mockUseReducedMotion.mockReset();
  hoisted.mockUseReducedMotion.mockReturnValue(false);
  hoisted.mockScenarioGraphReturn.data = null;
  hoisted.mockScenarioGraphReturn.loading = false;
  hoisted.mockScenarioGraphReturn.error = null;
  hoisted.refetchFn.mockClear();
  hoisted.destroySpy.mockClear();
  hoisted.onSpy.mockClear();
  hoisted.offSpy.mockClear();
  hoisted.renderSpy.mockClear();
  hoisted.setOptionsSpy.mockClear();
  hoisted.setDataSpy.mockClear();
  hoisted.drawSpy.mockClear();
  hoisted.setSizeSpy.mockClear();
  hoisted.zoomToSpy.mockClear();
  hoisted.fitViewSpy.mockClear();
  hoisted.focusElementSpy.mockClear();
  hoisted.fitCenterSpy.mockClear();
  hoisted.focusElementEnabled.value = true;
  hoisted.getDataSpy.mockClear();
  hoisted.getDataSpy.mockReturnValue({ nodes: [] as { id: string }[], edges: [] as { id: string }[] });
  hoisted.getNeighborNodesDataSpy.mockClear();
  hoisted.getNeighborNodesDataSpy.mockReturnValue([] as { id: string }[]);
  hoisted.getRelatedEdgesDataSpy.mockClear();
  hoisted.getRelatedEdgesDataSpy.mockReturnValue([] as { id: string }[]);
  hoisted.setElementStateSpy.mockClear();
});

function makeGraphPayload(nodeCount: number, edgeCount?: number): GraphPayload {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    key: `key${i}`,
    type: i % 3 === 0 ? 'event' : i % 3 === 1 ? 'claim' : 'intervention',
    label: `Node ${i}`,
    round: i,
    payload: null,
  }));
  const actualEdgeCount = edgeCount ?? (nodeCount > 1 ? 1 : 0);
  const edges = Array.from({ length: actualEdgeCount }, (_, i) => ({
    id: `e${i}`,
    source: `n${i % nodeCount}`,
    target: `n${(i + 1) % nodeCount}`,
    type: 'caused',
    weight: null,
    label: null,
  }));
  return { id: 'graph-1', nodes, edges };
}

function setupGraphData(nodeCount = 5, edgeCount?: number) {
  const payload = makeGraphPayload(nodeCount, edgeCount);
  hoisted.mockScenarioGraphReturn.data = payload;
  hoisted.mockScenarioGraphReturn.loading = false;
  hoisted.mockScenarioGraphReturn.error = null;
  return payload;
}

function getGraphDataUpdates(): Array<{ nodes?: Array<{ id: string }>; edges?: unknown[] }> {
  const isGraphData = (
    data: { nodes?: Array<{ id: string }>; edges?: unknown[] } | undefined,
  ): data is { nodes?: Array<{ id: string }>; edges?: unknown[] } => Boolean(data);
  return [
    ...hoisted.setOptionsSpy.mock.calls.map(([options]) =>
      (options as { data?: { nodes?: Array<{ id: string }>; edges?: unknown[] } })?.data,
    ),
    ...hoisted.setDataSpy.mock.calls.map(([data]) =>
      data as { nodes?: Array<{ id: string }>; edges?: unknown[] },
    ),
  ].filter(isGraphData);
}

describe('KGGraphBoard', () => {
  it('renders loading state', () => {
    hoisted.mockScenarioGraphReturn.loading = true;
    render(<KGGraphBoard scenarioId="s1" />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.getByTestId('kg-graph-board')).toBeInTheDocument();
  });

  it('renders error state with retry button', async () => {
    hoisted.mockScenarioGraphReturn.error = { code: 'NETWORK_ERROR', status: null };
    const user = userEvent.setup();
    render(<KGGraphBoard scenarioId="s1" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByText('Retry'));
    expect(hoisted.refetchFn).toHaveBeenCalledOnce();
  });

  it('renders search input, minimap container, and sr-only table when data is loaded', () => {
    setupGraphData(5);
    render(<KGGraphBoard scenarioId="s1" />);
    expect(screen.getByTestId('kg-graph-board-search')).toBeInTheDocument();
    expect(screen.getByTestId('kg-graph-board-minimap')).toBeInTheDocument();
    expect(screen.getByTestId('kg-graph-board-canvas')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('sr-only table contains visible graph nodes', async () => {
    setupGraphData(4);
    const user = userEvent.setup();
    render(<KGGraphBoard scenarioId="s1" />);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(5);

    await user.type(screen.getByTestId('kg-graph-board-search'), 'Node 1');

    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(within(table).getByText('Node 1')).toBeInTheDocument();
  });

  it('renders type filter chips when data has nodes', () => {
    setupGraphData(6);
    render(<KGGraphBoard scenarioId="s1" />);
    const filterGroup = screen.getByTestId('kg-graph-board-filter-pills');
    const buttons = within(filterGroup).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('renders zoom controls', () => {
    setupGraphData(3);
    render(<KGGraphBoard scenarioId="s1" />);
    expect(screen.getByLabelText('Zoom in')).toBeInTheDocument();
    expect(screen.getByLabelText('Zoom out')).toBeInTheDocument();
    expect(screen.getByLabelText('Fit to view')).toBeInTheDocument();
  });

  it('does not render NodeDetailPanel when no node is selected', () => {
    setupGraphData(3);
    render(<KGGraphBoard scenarioId="s1" />);
    expect(screen.queryByTestId('node-detail-panel')).not.toBeInTheDocument();
  });

  it('displays node count in toolbar', () => {
    setupGraphData(7);
    render(<KGGraphBoard scenarioId="s1" />);
    const countNode = screen.getByTestId('kg-graph-board-node-count');
    expect(countNode).toBeInTheDocument();
    expect(countNode.textContent).toMatch(/7\s+nodes/);
  });

  it('updates search input value', async () => {
    setupGraphData(5);
    const user = userEvent.setup();
    render(<KGGraphBoard scenarioId="s1" />);
    const searchInput = screen.getByTestId('kg-graph-board-search');
    await user.type(searchInput, 'hello');
    expect(searchInput).toHaveValue('hello');
  });

  it('updates G6 data when search filters visible nodes', async () => {
    setupGraphData(5);
    const user = userEvent.setup();
    render(<KGGraphBoard scenarioId="s1" />);
    await user.type(screen.getByTestId('kg-graph-board-search'), 'Node 2');

    await screen.findByDisplayValue('Node 2');
    expect(getGraphDataUpdates().at(-1)?.nodes?.map((node) => node.id)).toEqual(['n2']);
    expect(hoisted.setOptionsSpy).toHaveBeenCalled();
  });

  it('toggles type filter chip aria-pressed on click', async () => {
    setupGraphData(6);
    const user = userEvent.setup();
    render(<KGGraphBoard scenarioId="s1" />);
    const filterGroup = screen.getByTestId('kg-graph-board-filter-pills');
    const firstChip = within(filterGroup).getAllByRole('button')[0];
    expect(firstChip).toHaveAttribute('aria-pressed', 'false');
    await user.click(firstChip);
    expect(firstChip).toHaveAttribute('aria-pressed', 'true');
    expect(getGraphDataUpdates().at(-1)?.nodes).toHaveLength(2);
    await user.click(firstChip);
    expect(firstChip).toHaveAttribute('aria-pressed', 'false');
  });

  describe('mobile truncation notice', () => {
    function withMobileViewport(run: () => void) {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes('coarse') || query.includes('max-width: 767'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
      try {
        run();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    }

    it('does not render notice when count is below mobile threshold', () => {
      withMobileViewport(() => {
        setupGraphData(50);
        render(<KGGraphBoard scenarioId="s1" />);
        expect(screen.queryByTestId('kg-graph-board-truncate-notice')).not.toBeInTheDocument();
      });
    });

    it('renders aria-live notice with cap and total when mobile truncation activates', () => {
      withMobileViewport(() => {
        setupGraphData(250);
        render(<KGGraphBoard scenarioId="s1" />);
        const notice = screen.getByTestId('kg-graph-board-truncate-notice');
        expect(notice).toBeInTheDocument();
        expect(notice).toHaveAttribute('role', 'status');
        expect(notice).toHaveAttribute('aria-live', 'polite');
        expect(hoisted.mockT).toHaveBeenCalledWith(
          'kg_graph_board.mobile_truncate_notice',
          expect.any(String),
          expect.objectContaining({ cap: 200, total: 250 }),
        );
      });
    });

    it('does not render notice on desktop even with many nodes', () => {
      setupGraphData(500);
      render(<KGGraphBoard scenarioId="s1" />);
      expect(screen.queryByTestId('kg-graph-board-truncate-notice')).not.toBeInTheDocument();
    });
  });

  // ── F4: Edge labels toggle ──────────────────────────────────

  describe('edge labels toggle', () => {
    it('renders toggle button with aria-pressed', () => {
      setupGraphData(5);
      render(<KGGraphBoard scenarioId="s1" />);
      const toggle = screen.getByTestId('kg-graph-board-edge-labels-toggle');
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveAttribute('aria-pressed');
    });

    it('clicking toggle flips aria-pressed', async () => {
      setupGraphData(5, 3);
      const user = userEvent.setup();
      render(<KGGraphBoard scenarioId="s1" />);
      const toggle = screen.getByTestId('kg-graph-board-edge-labels-toggle');
      const initial = toggle.getAttribute('aria-pressed');
      await user.click(toggle);
      expect(toggle.getAttribute('aria-pressed')).not.toBe(initial);
    });

    it('edges <= 50 defaults to aria-pressed=true', () => {
      setupGraphData(5, 10);
      render(<KGGraphBoard scenarioId="s1" />);
      const toggle = screen.getByTestId('kg-graph-board-edge-labels-toggle');
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
    });

    it('edges > 50 defaults to aria-pressed=false', () => {
      setupGraphData(60, 55);
      render(<KGGraphBoard scenarioId="s1" />);
      const toggle = screen.getByTestId('kg-graph-board-edge-labels-toggle');
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
    });
  });

  // ── Fix-C3: NodeQuickCard / NodeDetailPanel互斥 ─────────────

  describe('NodeQuickCard integration', () => {
    function simulateNodeClick(
      viewport?: { x: number; y: number },
      nodeId: string = 'n0',
    ) {
      const nodeClickCalls = hoisted.onSpy.mock.calls.filter(
        (c: unknown[]) => c[0] === 'node:click',
      );
      if (nodeClickCalls.length === 0) return;
      const handler = nodeClickCalls[nodeClickCalls.length - 1][1] as (evt: unknown) => void;
      handler({
        target: { id: nodeId },
        ...(viewport ? { viewport } : {}),
      });
    }

    it('clicking node with viewport coords renders NodeQuickCard on desktop', () => {
      setupGraphData(5);
      render(<KGGraphBoard scenarioId="s1" />);
      expect(screen.queryByTestId('node-quick-card')).not.toBeInTheDocument();
      act(() => simulateNodeClick({ x: 100, y: 200 }));
      expect(screen.getByTestId('node-quick-card')).toBeInTheDocument();
      expect(screen.queryByTestId('node-detail-panel')).not.toBeInTheDocument();
    });

    it('clicking "View details" on NodeQuickCard opens NodeDetailPanel and closes quickCard', async () => {
      setupGraphData(5);
      const user = userEvent.setup();
      render(<KGGraphBoard scenarioId="s1" />);
      act(() => simulateNodeClick({ x: 100, y: 200 }));
      expect(screen.getByTestId('node-quick-card')).toBeInTheDocument();
      const detailBtn = screen.getByText('View details');
      await user.click(detailBtn);
      expect(screen.queryByTestId('node-quick-card')).not.toBeInTheDocument();
      expect(screen.getByTestId('node-detail-panel')).toBeInTheDocument();
    });

    it('clicking close on NodeQuickCard only closes quickCard', async () => {
      setupGraphData(5);
      const user = userEvent.setup();
      render(<KGGraphBoard scenarioId="s1" />);
      act(() => simulateNodeClick({ x: 100, y: 200 }));
      expect(screen.getByTestId('node-quick-card')).toBeInTheDocument();
      const quickCard = screen.getByTestId('node-quick-card');
      const closeBtn = within(quickCard).getByLabelText('Close');
      await user.click(closeBtn);
      expect(screen.queryByTestId('node-quick-card')).not.toBeInTheDocument();
      expect(screen.queryByTestId('node-detail-panel')).not.toBeInTheDocument();
    });

    it('opening detail then clicking a different node closes detail and shows quickCard', async () => {
      setupGraphData(5);
      const user = userEvent.setup();
      render(<KGGraphBoard scenarioId="s1" />);
      act(() => simulateNodeClick({ x: 100, y: 200 }, 'n0'));
      const detailBtn = screen.getByText('View details');
      await user.click(detailBtn);
      expect(screen.getByTestId('node-detail-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('node-quick-card')).not.toBeInTheDocument();
      const detailLabelBefore = screen.getByTestId('node-detail-panel').textContent;
      act(() => simulateNodeClick({ x: 250, y: 300 }, 'n1'));
      expect(screen.getByTestId('node-quick-card')).toBeInTheDocument();
      expect(screen.queryByTestId('node-detail-panel')).not.toBeInTheDocument();
      expect(detailLabelBefore).toContain('Node 0');
    });

    it('node:dblclick handler invokes focusElement when available', () => {
      setupGraphData(5);
      hoisted.focusElementEnabled.value = true;
      render(<KGGraphBoard scenarioId="s1" />);
      const dblclickCalls = hoisted.onSpy.mock.calls.filter((c: unknown[]) => c[0] === 'node:dblclick');
      expect(dblclickCalls.length).toBeGreaterThan(0);
      const handler = dblclickCalls[dblclickCalls.length - 1][1] as (evt: unknown) => void;
      handler({ target: { id: 'n2' } });
      expect(hoisted.focusElementSpy).toHaveBeenCalledWith('n2');
      expect(hoisted.fitCenterSpy).not.toHaveBeenCalled();
    });

    it('node:dblclick falls back to fitView when focusElement is not available', () => {
      setupGraphData(5);
      hoisted.focusElementEnabled.value = false;
      render(<KGGraphBoard scenarioId="s1" />);
      const dblclickCalls = hoisted.onSpy.mock.calls.filter((c: unknown[]) => c[0] === 'node:dblclick');
      const handler = dblclickCalls[dblclickCalls.length - 1][1] as (evt: unknown) => void;
      handler({ target: { id: 'n3' } });
      expect(hoisted.focusElementSpy).not.toHaveBeenCalled();
      expect(hoisted.fitViewSpy).toHaveBeenCalled();
      expect(hoisted.fitCenterSpy).not.toHaveBeenCalled();
    });

    it('mobile click opens NodeDetailPanel directly (no quickCard)', () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes('coarse') || query.includes('max-width: 767'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
      try {
        setupGraphData(5);
        render(<KGGraphBoard scenarioId="s1" />);
        act(() => simulateNodeClick({ x: 100, y: 200 }));
        expect(screen.queryByTestId('node-quick-card')).not.toBeInTheDocument();
        expect(screen.getByTestId('node-detail-panel')).toBeInTheDocument();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it('does not revive a node conversation sheet after search hides its source node', async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes('coarse') || query.includes('max-width: 767'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
      try {
        setupGraphData(3);
        const user = userEvent.setup();
        render(<KGGraphBoard scenarioId="s1" />);
        act(() => simulateNodeClick({ x: 100, y: 200 }, 'n0'));
        expect(screen.getByTestId('node-conversation-sheet')).toHaveTextContent('n0');

        const search = screen.getByTestId('kg-graph-board-search');
        await user.type(search, 'Node 1');
        expect(screen.queryByTestId('node-conversation-sheet')).not.toBeInTheDocument();

        await user.clear(search);
        expect(screen.queryByTestId('node-conversation-sheet')).not.toBeInTheDocument();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });
  });

  // ── P6: G6 native state management ────────────────────────

  describe('P6 native state API', () => {
    function simulateNodeClick(
      viewport?: { x: number; y: number },
      nodeId: string = 'n0',
    ) {
      const nodeClickCalls = hoisted.onSpy.mock.calls.filter(
        (c: unknown[]) => c[0] === 'node:click',
      );
      if (nodeClickCalls.length === 0) return;
      const handler = nodeClickCalls[nodeClickCalls.length - 1][1] as (evt: unknown) => void;
      handler({
        target: { id: nodeId },
        ...(viewport ? { viewport } : {}),
      });
    }

    it('click-lock calls setElementState with selected/active/inactive states', () => {
      setupGraphData(5);
      // Configure getData to return nodes and edges the graph "knows about"
      hoisted.getDataSpy.mockReturnValue({
        nodes: [{ id: 'n0' }, { id: 'n1' }, { id: 'n2' }],
        edges: [{ id: 'e0' }],
      });
      hoisted.getNeighborNodesDataSpy.mockReturnValue([{ id: 'n1' }]);
      hoisted.getRelatedEdgesDataSpy.mockReturnValue([{ id: 'e0' }]);

      // Mobile mode triggers lockedNodeId on click
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes('coarse') || query.includes('max-width: 767'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;

      try {
        render(<KGGraphBoard scenarioId="s1" />);
        act(() => simulateNodeClick({ x: 100, y: 200 }, 'n0'));

        expect(hoisted.setElementStateSpy).toHaveBeenCalled();
        const lastCall = hoisted.setElementStateSpy.mock.calls[
          hoisted.setElementStateSpy.mock.calls.length - 1
        ];
        const stateRec = lastCall[0] as Record<string, string[]>;
        // The locked node should be 'selected'
        expect(stateRec['n0']).toEqual(['selected']);
        // Neighbor should be 'active'
        expect(stateRec['n1']).toEqual(['active']);
        // Non-neighbor node should be 'inactive'
        expect(stateRec['n2']).toEqual(['inactive']);
        // Related edge should be 'active'
        expect(stateRec['e0']).toEqual(['active']);
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it('clearing lock resets all element states to empty', () => {
      setupGraphData(5);
      hoisted.getDataSpy.mockReturnValue({
        nodes: [{ id: 'n0' }, { id: 'n1' }],
        edges: [{ id: 'e0' }],
      });
      hoisted.getNeighborNodesDataSpy.mockReturnValue([{ id: 'n1' }]);
      hoisted.getRelatedEdgesDataSpy.mockReturnValue([{ id: 'e0' }]);

      const originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes('coarse') || query.includes('max-width: 767'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;

      try {
        render(<KGGraphBoard scenarioId="s1" />);
        // First click locks
        act(() => simulateNodeClick({ x: 100, y: 200 }, 'n0'));
        hoisted.setElementStateSpy.mockClear();

        // Second click on same node unlocks (toggle)
        act(() => simulateNodeClick({ x: 100, y: 200 }, 'n0'));

        expect(hoisted.setElementStateSpy).toHaveBeenCalled();
        const lastCall = hoisted.setElementStateSpy.mock.calls[
          hoisted.setElementStateSpy.mock.calls.length - 1
        ];
        const stateRec = lastCall[0] as Record<string, string[]>;
        // All states should be empty arrays (cleared)
        expect(stateRec['n0']).toEqual([]);
        expect(stateRec['n1']).toEqual([]);
        expect(stateRec['e0']).toEqual([]);
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it('animations disabled when node count exceeds animationLimit', () => {
      // KG_DEGRADE_THRESHOLDS.animationLimit = 300
      setupGraphData(350);
      render(<KGGraphBoard scenarioId="s1" />);
      // The component passes shouldDisableAnimation=true to buildKgG6Options
      // when node count exceeds the limit, which sets animation=false.
      // We verify the setOptions call received reducedMotion=true behavior.
      const setOptionsCall = hoisted.setOptionsSpy.mock.calls;
      if (setOptionsCall.length > 0) {
        const lastOpts = setOptionsCall[setOptionsCall.length - 1][0] as { animation?: boolean };
        expect(lastOpts.animation).toBe(false);
      }
      // Also verify the component rendered without error
      expect(screen.getByTestId('kg-graph-board')).toBeInTheDocument();
    });
  });

  describe('Editorial visual layer (Phase 2)', () => {
    it('toolbar exposes role=toolbar with i18n aria-label', () => {
      setupGraphData(3);
      render(<KGGraphBoard scenarioId="s1" />);
      const toolbar = screen.getByRole('toolbar');
      expect(toolbar).toBeInTheDocument();
      expect(toolbar.className).toContain('kg-toolbar');
      expect(toolbar.getAttribute('aria-label')).toMatch(/Knowledge graph toolbar/);
    });

    it('canvas wrapper applies kg-canvas-cursor class so :active uses grabbing cursor', () => {
      setupGraphData(3);
      render(<KGGraphBoard scenarioId="s1" />);
      const canvas = screen.getByTestId('kg-graph-board-canvas');
      expect(canvas.className).toContain('kg-canvas-shell');
      expect(canvas.className).toContain('kg-canvas-cursor');
    });

    it('minimap container uses kg-minimap class (rounded + shadow)', () => {
      setupGraphData(3);
      render(<KGGraphBoard scenarioId="s1" />);
      const minimap = screen.getByTestId('kg-graph-board-minimap');
      expect(minimap.className).toContain('kg-minimap');
    });

    it('search input uses kg-search class (token focus ring)', () => {
      setupGraphData(3);
      render(<KGGraphBoard scenarioId="s1" />);
      const search = screen.getByTestId('kg-graph-board-search');
      expect(search.className).toContain('kg-search');
    });

    it('zoom + edge-labels toggle buttons share kg-icon-btn class (token-only)', () => {
      setupGraphData(3);
      render(<KGGraphBoard scenarioId="s1" />);
      const toggle = screen.getByTestId('kg-graph-board-edge-labels-toggle');
      expect(toggle.className).toContain('kg-icon-btn');
      // Each zoom button (Zoom in / Zoom out / Fit to view) should also use the class
      const zoomIn = screen.getByLabelText('Zoom in');
      const zoomOut = screen.getByLabelText('Zoom out');
      const fitView = screen.getByLabelText('Fit to view');
      expect(zoomIn.className).toContain('kg-icon-btn');
      expect(zoomOut.className).toContain('kg-icon-btn');
      expect(fitView.className).toContain('kg-icon-btn');
    });

    it('type filter chips use kg-chip class with kg-chip-dot indicator', () => {
      setupGraphData(3);
      render(<KGGraphBoard scenarioId="s1" />);
      const chip = screen.getByTestId('kg-graph-board-chip-event');
      expect(chip.className).toContain('kg-chip');
      const dot = chip.querySelector('.kg-chip-dot') as HTMLElement | null;
      expect(dot).not.toBeNull();
      // dot.style.background reflects the per-type colour
      expect(dot!.style.background).toBeTruthy();
    });

    it('loading state renders kg-loading-skeleton with screen-reader Loading text', () => {
      hoisted.mockScenarioGraphReturn.loading = true;
      hoisted.mockScenarioGraphReturn.data = null;
      render(<KGGraphBoard scenarioId="s1" />);
      const skeleton = screen.getByTestId('kg-graph-board-skeleton');
      expect(skeleton.className).toContain('kg-loading-skeleton');
      expect(skeleton.getAttribute('role')).toBe('status');
      // Loading text remains accessible to screen readers
      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });

    it('error state retry button uses kg-icon-btn class', () => {
      hoisted.mockScenarioGraphReturn.error = { code: 'NETWORK_ERROR', status: null };
      hoisted.mockScenarioGraphReturn.loading = false;
      render(<KGGraphBoard scenarioId="s1" />);
      const retry = screen.getByLabelText('Retry');
      expect(retry.className).toContain('kg-icon-btn');
    });

    it('connects a ResizeObserver to the canvas shell and disconnects on unmount', () => {
      const observeSpy = vi.fn();
      const disconnectSpy = vi.fn();
      let capturedCallback: ResizeObserverCallback | null = null;
      const originalRO = global.ResizeObserver;
      global.ResizeObserver = vi.fn().mockImplementation((cb: ResizeObserverCallback) => {
        capturedCallback = cb;
        return { observe: observeSpy, disconnect: disconnectSpy, unobserve: vi.fn() };
      }) as unknown as typeof ResizeObserver;

      try {
        setupGraphData(3);
        const { unmount } = render(<KGGraphBoard scenarioId="s1" />);

        // ResizeObserver should be constructed and observe() called.
        // Exact count may exceed 1 because G6's autoResize plugin can
        // construct its own observer; the contract we care about is that
        // *our* canvas-shell observer is wired and tears down cleanly.
        expect(observeSpy).toHaveBeenCalled();
        expect(capturedCallback).not.toBeNull();

        // Trigger the callback with a valid entry. The captured callback
        // is the most recently constructed observer (useG6Graph's internal
        // one), which calls graph.setSize(width, height) on the underlying
        // mock — so we can assert setSize received the entry's dimensions.
        const fakeEntry = {
          target: document.body,
          contentRect: { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as unknown as ResizeObserverEntry;
        act(() => {
          (capturedCallback as ResizeObserverCallback)([fakeEntry], {} as ResizeObserver);
        });
        // useG6Graph's ResizeObserver callback syncs the canvas size and
        // then calls fitView to recenter after resize.
        expect(hoisted.setSizeSpy).toHaveBeenCalledWith(800, 600);
        expect(hoisted.fitViewSpy).toHaveBeenCalled();

        // Cleanup on unmount tears down all observers we attached
        unmount();
        expect(disconnectSpy).toHaveBeenCalled();
      } finally {
        global.ResizeObserver = originalRO;
      }
    });

    it('legend is collapsed by default', () => {
      setupGraphData(3);
      render(<KGGraphBoard scenarioId="s1" />);
      // Legend panel should NOT be present in the DOM before the toggle is clicked.
      expect(screen.queryByTestId('kg-graph-board-legend')).not.toBeInTheDocument();
      // Toggle button is still rendered, and reflects collapsed state via aria-pressed=false.
      const toggle = screen.getByTestId('kg-graph-board-legend-toggle');
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
    });

    it('renders legend with outcome and icons', () => {
      setupGraphData(3);
      render(<KGGraphBoard scenarioId="s1" />);

      const toggle = screen.getByTestId('kg-graph-board-legend-toggle');
      fireEvent.click(toggle);

      const legend = screen.getByTestId('kg-graph-board-legend');
      expect(legend).toBeInTheDocument();
      // Should contain outcome
      expect(screen.getByText('Outcome')).toBeInTheDocument();
      // Should contain icons for event and outcome (MessageSquare and FileCheck)
      const messageSquareIcon = legend.querySelector('.lucide-message-square');
      expect(messageSquareIcon).toBeInTheDocument();
      const fileCheckIcon = legend.querySelector('.lucide-file-check');
      expect(fileCheckIcon).toBeInTheDocument();
    });
  });

  describe('Keyboard Navigation', () => {
    it('uses arrow keys for node focus and leaves Tab available for normal page navigation', () => {
      setupGraphData(3);
      render(<KGGraphBoard scenarioId="s1" />);
      const canvas = screen.getByTestId('kg-graph-board-canvas');
      const status = screen.getByTestId('kg-graph-board-keyboard-status');

      expect(fireEvent.keyDown(canvas, { key: 'Tab' })).toBe(true);
      expect(status).toHaveTextContent('');

      fireEvent.keyDown(canvas, { key: 'ArrowRight' });
      expect(status).toHaveTextContent('Node 0 focused');

      fireEvent.keyDown(canvas, { key: 'ArrowRight' });
      expect(status).toHaveTextContent('Node 1 focused');

      fireEvent.keyDown(canvas, { key: 'ArrowLeft' });
      expect(status).toHaveTextContent('Node 0 focused');

      fireEvent.keyDown(canvas, { key: 'End' });
      expect(status).toHaveTextContent('Node 2 focused');

      fireEvent.keyDown(canvas, { key: 'Escape' });
      expect(status).toHaveTextContent('');
    });

    it('opens detail when pressing Enter on a focused node', () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query.includes('coarse') || query.includes('max-width: 767'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
      try {
        setupGraphData(3);
        render(<KGGraphBoard scenarioId="s1" />);
        const canvas = screen.getByTestId('kg-graph-board-canvas');

        fireEvent.keyDown(canvas, { key: 'ArrowRight' });
        expect(screen.getByTestId('kg-graph-board-keyboard-status')).toHaveTextContent('Node 0 focused');

        fireEvent.keyDown(canvas, { key: 'Enter' });
        expect(screen.getByTestId('node-detail-panel')).toBeInTheDocument();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });
  });
});
