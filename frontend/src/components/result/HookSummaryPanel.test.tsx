import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HookSummaryPanel } from './HookSummaryPanel';
import type { HookSummaryItem, UseHookSummaryResult } from '../../hooks/useHookSummary';

const refetchMock = vi.fn();

let hookResult: UseHookSummaryResult = {
  items: [],
  loading: false,
  refetch: refetchMock,
};

vi.mock('../../hooks/useHookSummary', () => ({
  useHookSummary: () => hookResult,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultOrOpts?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      const options = typeof defaultOrOpts === 'object' ? defaultOrOpts : opts;
      let text = typeof defaultOrOpts === 'string' ? defaultOrOpts : key;
      if (options && typeof text === 'string') {
        text = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
          options[k] !== undefined ? String(options[k]) : `{{${k}}}`,
        );
      }
      return text;
    },
    i18n: { language: 'en' },
  }),
}));

function makeItem(key: HookSummaryItem['key'], overrides: Partial<HookSummaryItem> = {}): HookSummaryItem {
  return {
    key,
    enabled: true,
    loading: false,
    error: null,
    data: { count: 5 },
    ...overrides,
  };
}

beforeEach(() => {
  refetchMock.mockReset();
  hookResult = { items: [], loading: false, refetch: refetchMock };
});

describe('HookSummaryPanel', () => {
  it('renders 5 hook cards when all enabled', () => {
    hookResult = {
      items: [
        makeItem('causal_graph'),
        makeItem('factions', { data: { count: 3, eventCount: 7 } }),
        makeItem('checkpoints', { data: { count: 2, latestRound: 4 } }),
        makeItem('identity'),
        makeItem('argument_map'),
      ],
      loading: false,
      refetch: refetchMock,
    };

    render(<HookSummaryPanel scenarioId="s1" />);

    const cards = screen.getAllByText(/items|events|round/);
    expect(cards.length).toBeGreaterThanOrEqual(5);
  });

  it('shows skeleton placeholders during loading', () => {
    hookResult = { items: [], loading: true, refetch: refetchMock };

    const { container } = render(<HookSummaryPanel scenarioId="s1" />);

    const skeletons = container.querySelectorAll('.hook-summary-card--skeleton');
    expect(skeletons.length).toBe(5);
  });

  it('shows count for ready items', () => {
    hookResult = {
      items: [makeItem('causal_graph', { data: { count: 12 } })],
      loading: false,
      refetch: refetchMock,
    };

    render(<HookSummaryPanel scenarioId="s1" />);

    expect(screen.getByText('12 items')).toBeTruthy();
  });

  it('shows retry button on error', async () => {
    hookResult = {
      items: [makeItem('causal_graph', { error: new Error('fail'), data: null })],
      loading: false,
      refetch: refetchMock,
    };

    render(<HookSummaryPanel scenarioId="s1" />);

    const retryBtn = screen.getByRole('button', { name: /retry/i });
    expect(retryBtn).toBeTruthy();

    await userEvent.click(retryBtn);
    expect(refetchMock).toHaveBeenCalled();
  });

  it('shows disabled placeholder for disabled hooks', () => {
    hookResult = {
      items: [
        makeItem('causal_graph', { enabled: false, data: null }),
        makeItem('factions'),
      ],
      loading: false,
      refetch: refetchMock,
    };

    render(<HookSummaryPanel scenarioId="s1" />);

    expect(screen.getByText('Not enabled')).toBeTruthy();
  });

  it('renders grid layout with region role', () => {
    hookResult = {
      items: [makeItem('causal_graph'), makeItem('factions')],
      loading: false,
      refetch: refetchMock,
    };

    render(<HookSummaryPanel scenarioId="s1" />);

    const region = screen.getByRole('region');
    expect(region).toBeTruthy();
    expect(region.querySelector('.hook-summary-panel__grid')).toBeTruthy();
  });

  it('returns null when scenarioId is null', () => {
    const { container } = render(<HookSummaryPanel scenarioId={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('returns null when no hooks are enabled', () => {
    hookResult = {
      items: [
        makeItem('causal_graph', { enabled: false, data: null }),
        makeItem('factions', { enabled: false, data: null }),
      ],
      loading: false,
      refetch: refetchMock,
    };

    const { container } = render(<HookSummaryPanel scenarioId="s1" />);
    expect(container.innerHTML).toBe('');
  });

  it('shows latestRound detail for checkpoints', () => {
    hookResult = {
      items: [makeItem('checkpoints', { data: { count: 3, latestRound: 5 } })],
      loading: false,
      refetch: refetchMock,
    };

    render(<HookSummaryPanel scenarioId="s1" />);

    expect(screen.getByText('Latest: round 5')).toBeTruthy();
  });

  it('shows eventCount detail for factions', () => {
    hookResult = {
      items: [makeItem('factions', { data: { count: 2, eventCount: 9 } })],
      loading: false,
      refetch: refetchMock,
    };

    render(<HookSummaryPanel scenarioId="s1" />);

    expect(screen.getByText('9 events')).toBeTruthy();
  });

  it('renders enabled item with null data gracefully (no-data boundary)', () => {
    hookResult = {
      items: [makeItem('causal_graph', { enabled: true, data: null })],
      loading: false,
      refetch: refetchMock,
    };

    const { container } = render(<HookSummaryPanel scenarioId="s1" />);

    // Panel should render (hasAnyEnabled = true) with the region role
    expect(screen.getByRole('region')).toBeTruthy();

    // The card should show the "No data" empty state (hook-summary-card__empty)
    const emptyEl = container.querySelector('.hook-summary-card__empty');
    expect(emptyEl).toBeTruthy();
    expect(emptyEl?.textContent).toBe('No data');

    // Should NOT show error or disabled states
    expect(container.querySelector('.hook-summary-card__error')).toBeNull();
    expect(container.querySelector('.hook-summary-card__disabled')).toBeNull();
  });
});
