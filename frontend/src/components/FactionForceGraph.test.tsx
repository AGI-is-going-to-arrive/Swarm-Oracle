import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { ComponentProps } from 'react';
import { FactionForceGraph, transformToG6Data, type FactionForceGraphProps } from './FactionForceGraph';
import type { FactionRelationsResponse } from '../api/client';

vi.mock('../hooks/useG6Graph', () => ({
  useG6Graph: vi.fn(() => ({
    canvasWrapperRef: { current: null },
    graphRef: { current: null },
  })),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getFactionRelations: vi.fn(),
  };
});

vi.mock('./ui/slider', () => ({
  Slider: ({
    value,
    onValueChange,
    ...props
  }: ComponentProps<'input'> & {
    value?: number[];
    onValueChange?: (value: number[]) => void;
  }) => (
    <input
      {...props}
      type="range"
      value={value?.[0] ?? 0}
      onChange={(event) => onValueChange?.([Number(event.currentTarget.value)])}
    />
  ),
}));

const mockGetFactionRelations = vi.mocked(
  (await import('../api/client')).getFactionRelations,
);

const mockUseG6Graph = vi.mocked(
  (await import('../hooks/useG6Graph')).useG6Graph,
);

const MOCK_RESPONSE: FactionRelationsResponse = {
  edges: [
    { id: 'e1', round: 1, source_agent_id: 'a1', target_agent_id: 'a2', relation_type: 'trust', weight: 0.9, trust_score: 0.9, opposition_score: 0.1, evidence_summary: null },
    { id: 'e2', round: 1, source_agent_id: 'a3', target_agent_id: 'a4', relation_type: 'opposition', weight: 0.8, trust_score: 0.2, opposition_score: 0.8, evidence_summary: null },
    { id: 'e3', round: 2, source_agent_id: 'a1', target_agent_id: 'a3', relation_type: 'trust', weight: 0.7, trust_score: 0.7, opposition_score: 0.3, evidence_summary: null },
  ],
  truncated: false,
  threshold: 0.65,
  top_k: 120,
  total_before_filter: 3,
};

const TRUNCATED_RESPONSE: FactionRelationsResponse = {
  ...MOCK_RESPONSE,
  truncated: true,
};

const DEFAULT_FACTIONS = [
  { key: 'faction_0', members: ['a1', 'a2'], label: 'Hawks' },
  { key: 'faction_1', members: ['a3', 'a4'], label: 'Doves' },
];

function createTestI18n() {
  const instance = i18n.createInstance();
  instance.use(initReactI18next).init({
    lng: 'en',
    resources: {
      en: {
        translation: {
          factions: {
            force_graph_title: 'Faction Force Graph',
            force_graph_slider_label: 'Round',
            force_graph_slider_round: 'Round {{round}}',
            force_graph_empty_few_agents: 'The force graph requires at least 4 agents.',
            force_graph_empty_no_data: 'No faction data available.',
            force_graph_truncated_warning: 'Some weaker relations are hidden.',
            force_graph_relation_trust: 'Trust',
            force_graph_relation_opposition: 'Opposition',
          },
          common: { retry: 'Retry' },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  return instance;
}

function renderGraph(overrides?: Partial<FactionForceGraphProps>) {
  const i18nInstance = createTestI18n();
  const props: FactionForceGraphProps = {
    scenarioId: 'sc1',
    branchId: 'b1',
    factions: DEFAULT_FACTIONS,
    totalRounds: 3,
    ...overrides,
  };
  return render(
    <I18nextProvider i18n={i18nInstance}>
      <FactionForceGraph {...props} />
    </I18nextProvider>,
  );
}

function createMatchMedia(matches = false): typeof window.matchMedia {
  return (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: createMatchMedia(false),
  });
  mockGetFactionRelations.mockResolvedValue(MOCK_RESPONSE);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FactionForceGraph', () => {
  it('renders force graph canvas and calls useG6Graph with correct data', async () => {
    renderGraph();
    await waitFor(() => {
      expect(mockGetFactionRelations).toHaveBeenCalledWith('sc1', 'b1', { roundMax: 3 });
    });
    expect(screen.getByTestId('faction-force-graph-canvas')).toBeInTheDocument();
    expect(screen.getByText('Faction Force Graph')).toBeInTheDocument();
    expect(mockUseG6Graph).toHaveBeenCalled();
  });

  it('slider scrub updates round and re-fetches', async () => {
    renderGraph({ totalRounds: 5 });
    await waitFor(() => {
      expect(mockGetFactionRelations).toHaveBeenCalledWith('sc1', 'b1', { roundMax: 5 });
    });

    vi.useFakeTimers();
    try {
      const slider = screen.getByRole('slider');
      expect(slider).toBeInTheDocument();
      fireEvent.change(slider, { target: { value: '2' } });

      expect(mockGetFactionRelations).not.toHaveBeenCalledWith('sc1', 'b1', { roundMax: 2 });

      await act(async () => {
        vi.advanceTimersByTime(201);
        await Promise.resolve();
      });

      expect(mockGetFactionRelations).toHaveBeenCalledWith('sc1', 'b1', { roundMax: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers-reduced-motion passes animate:false layout', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderGraph();
    await waitFor(() => {
      expect(mockUseG6Graph).toHaveBeenCalled();
    });

    const lastCall = mockUseG6Graph.mock.calls[mockUseG6Graph.mock.calls.length - 1];
    const options = lastCall[0].options;
    expect((options as Record<string, unknown>).layout).toEqual(
      expect.objectContaining({ animate: false, maxIteration: 0 }),
    );

    window.matchMedia = originalMatchMedia;
  });

  it('shows empty state when fewer than 4 agents', () => {
    renderGraph({
      factions: [{ key: 'f0', members: ['a1', 'a2', 'a3'] }],
    });
    expect(screen.getByTestId('faction-force-graph-empty')).toBeInTheDocument();
    expect(screen.getByText(/at least 4 agents/i)).toBeInTheDocument();
    expect(mockGetFactionRelations).not.toHaveBeenCalled();
  });

  it('shows empty state when totalRounds < 1', () => {
    renderGraph({ totalRounds: 0 });
    expect(screen.getByTestId('faction-force-graph-empty')).toBeInTheDocument();
  });

  it('shows empty state when no factions', () => {
    renderGraph({ factions: [] });
    expect(screen.getByTestId('faction-force-graph-empty')).toBeInTheDocument();
  });

  it('shows truncated warning when response.truncated is true', async () => {
    mockGetFactionRelations.mockResolvedValue(TRUNCATED_RESPONSE);
    renderGraph();
    await waitFor(() => {
      expect(screen.getByTestId('faction-truncated-warning')).toBeInTheDocument();
    });
    expect(screen.getByText(/weaker relations are hidden/i)).toBeInTheDocument();
  });

  it('displays trust and opposition legend colors', async () => {
    renderGraph();
    await waitFor(() => {
      expect(screen.getByText('Trust')).toBeInTheDocument();
    });
    expect(screen.getByText('Opposition')).toBeInTheDocument();
  });

  it('shows error state with retry button', async () => {
    mockGetFactionRelations.mockRejectedValueOnce(new Error('network fail'));
    renderGraph();
    await waitFor(() => {
      expect(screen.getByTestId('faction-force-graph-error')).toBeInTheDocument();
    });
    expect(screen.getByText('Retry')).toBeInTheDocument();

    mockGetFactionRelations.mockResolvedValue(MOCK_RESPONSE);
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => {
      expect(screen.queryByTestId('faction-force-graph-error')).not.toBeInTheDocument();
    });
  });

  it('canvas has no CSS transition when prefers-reduced-motion is active', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderGraph();
    await waitFor(() => {
      expect(mockGetFactionRelations).toHaveBeenCalled();
    });

    const canvas = screen.getByTestId('faction-force-graph-canvas');
    expect(canvas.style.transition).toBe('none');

    window.matchMedia = originalMatchMedia;
  });

  it('canvas has opacity transition when prefers-reduced-motion is not active', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderGraph();
    await waitFor(() => {
      expect(mockGetFactionRelations).toHaveBeenCalled();
    });

    const canvas = screen.getByTestId('faction-force-graph-canvas');
    expect(canvas.style.transition).toBe('opacity 0.2s');

    window.matchMedia = originalMatchMedia;
  });

  it('slider has associated label element', async () => {
    renderGraph();
    await waitFor(() => {
      expect(screen.getByRole('slider')).toBeInTheDocument();
    });
    const label = screen.getByText('Round');
    expect(label).toBeInTheDocument();
    expect(label.tagName.toLowerCase()).toBe('label');
    expect(label).toHaveAttribute('for', 'faction-round-slider');
  });
});

describe('transformToG6Data', () => {
  it('filters edges by targetRound (cumulative semantics)', () => {
    const result = transformToG6Data(MOCK_RESPONSE.edges, DEFAULT_FACTIONS, 1);
    expect(result.edges).toHaveLength(2);
    expect(result.edges.every((e) => parseInt(e.id.replace('e', '')) <= 2)).toBe(true);
  });

  it('creates nodes with edge counts', () => {
    const result = transformToG6Data(MOCK_RESPONSE.edges, DEFAULT_FACTIONS, 2);
    const a1Node = result.nodes.find((n) => n.id === 'a1');
    expect(a1Node).toBeDefined();
    expect(a1Node!.data.edgeCount).toBe(2);
  });

  it('assigns faction colors to nodes', () => {
    const result = transformToG6Data(MOCK_RESPONSE.edges, DEFAULT_FACTIONS, 2);
    const a1Node = result.nodes.find((n) => n.id === 'a1');
    expect(a1Node!.data.combo).toBe('faction_0');
  });

  it('uses agentNames when provided', () => {
    const names = { a1: 'Alice', a2: 'Bob' };
    const result = transformToG6Data(MOCK_RESPONSE.edges, DEFAULT_FACTIONS, 1, names);
    const a1Node = result.nodes.find((n) => n.id === 'a1');
    expect(a1Node!.data.label).toBe('Alice');
  });
});
