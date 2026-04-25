import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const mockT = vi.fn((key: string, fallback?: string) => fallback ?? key);
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
  const setSizeSpy = vi.fn();
  const zoomToSpy = vi.fn();
  const fitViewSpy = vi.fn();

  return {
    mockT, mockUseReducedMotion, mockScenarioGraphReturn, refetchFn,
    destroySpy, onSpy, offSpy, renderSpy, setOptionsSpy, setSizeSpy,
    zoomToSpy, fitViewSpy,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (...args: unknown[]) => hoisted.mockT(...(args as [string, string?])),
    i18n: { changeLanguage: () => {}, language: 'en' },
  }),
}));

vi.mock('../../hooks/useReducedMotion', () => ({
  default: () => hoisted.mockUseReducedMotion(),
}));

vi.mock('../../hooks/useScenarioGraph', () => ({
  useScenarioGraph: () => hoisted.mockScenarioGraphReturn,
}));

vi.mock('@antv/g6', () => {
  return {
    Graph: class {
      destroy() { return hoisted.destroySpy(); }
      on(...a: unknown[]) { return hoisted.onSpy(...a); }
      off(...a: unknown[]) { return hoisted.offSpy(...a); }
      render() { return hoisted.renderSpy(); }
      setOptions(...a: unknown[]) { return hoisted.setOptionsSpy(...a); }
      setSize(...a: unknown[]) { return hoisted.setSizeSpy(...a); }
      zoomTo() { return hoisted.zoomToSpy(); }
      fitView() { return hoisted.fitViewSpy(); }
    },
  };
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
  hoisted.setSizeSpy.mockClear();
});

function makeGraphPayload(nodeCount: number): GraphPayload {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`,
    key: `key${i}`,
    type: i % 3 === 0 ? 'event' : i % 3 === 1 ? 'claim' : 'intervention',
    label: `Node ${i}`,
    round: i,
    payload: null,
  }));
  const edges = nodeCount > 1
    ? [{ id: 'e0', source: 'n0', target: 'n1', type: 'caused', weight: null, label: null }]
    : [];
  return { id: 'graph-1', nodes, edges };
}

function setupGraphData(nodeCount = 5) {
  const payload = makeGraphPayload(nodeCount);
  hoisted.mockScenarioGraphReturn.data = payload;
  hoisted.mockScenarioGraphReturn.loading = false;
  hoisted.mockScenarioGraphReturn.error = null;
  return payload;
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

  it('sr-only table contains all nodes from graphData', () => {
    setupGraphData(4);
    render(<KGGraphBoard scenarioId="s1" />);
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(5);
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
    expect(screen.getByText(/7\s+nodes/)).toBeInTheDocument();
  });

  it('updates search input value', async () => {
    setupGraphData(5);
    const user = userEvent.setup();
    render(<KGGraphBoard scenarioId="s1" />);
    const searchInput = screen.getByTestId('kg-graph-board-search');
    await user.type(searchInput, 'hello');
    expect(searchInput).toHaveValue('hello');
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
});
