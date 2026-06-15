import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { MultiRunWaitingPanel } from './MultiRunWaitingPanel';
import { getRunGroupDistribution } from '../../api/client';

vi.mock('../../api/client', () => ({
  getRunGroupDistribution: vi.fn(),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

i18n.use(initReactI18next).init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        multi_run: {
          waiting_title: 'Simulating {{total}} worldlines…',
          waiting_title_generic: 'Simulating worldlines…',
          waiting_subtitle: 'Multiple parallel worldlines are running.',
          waiting_progress: 'Completed {{finished}} / {{total}}',
          watch_first_run: 'Watch the first worldline unfold',
          waiting_slow_hint: 'Multiple runs on a local model can take a few minutes.',
          status_failed_badge: 'Failed',
          worldlines_list_title: 'Worldlines',
          run_index: 'Run #{{index}}',
          run_full_sim_badge: 'Full simulation',
          run_quick_verdict_badge: 'Quick verdict',
          view_worldline_result: 'View result',
          worldline_simulating: 'Simulating…',
          worldline_done: 'Done',
        },
      },
    },
  },
});

const makeData = (overrides = {}) => ({
  run_group_id: 'g1',
  run_count: 5,
  pending_count: 3,
  failed_count: 0,
  terminal_count: 2,
  runs: [
    { scenario_id: 's1', run_index: 1, status: 'done', verdict: null, outcome: null, is_terminal_distribution_row: true },
    { scenario_id: 's2', run_index: 2, status: 'done', verdict: null, outcome: null, is_terminal_distribution_row: true },
    { scenario_id: 's3', run_index: 3, status: 'simulating', verdict: null, outcome: null, is_terminal_distribution_row: false },
    { scenario_id: 's4', run_index: 4, status: 'simulating', verdict: null, outcome: null, is_terminal_distribution_row: false },
    { scenario_id: 's5', run_index: 5, status: 'simulating', verdict: null, outcome: null, is_terminal_distribution_row: false },
  ],
  histogram: { verdict_counts: {}, outcome_counts: {} },
  ...overrides,
});

const renderPanel = (props: { runGroupId: string; firstRunId?: string }) =>
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <MultiRunWaitingPanel {...props} />
      </MemoryRouter>
    </I18nextProvider>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MultiRunWaitingPanel', () => {
  it('shows worldline progress (finished / total) and the in-progress title', async () => {
    vi.mocked(getRunGroupDistribution).mockResolvedValue(makeData() as never);
    renderPanel({ runGroupId: 'g1', firstRunId: 's1' });

    expect(await screen.findByText('Simulating 5 worldlines…')).toBeInTheDocument();
    // 2 done out of 5 → finished = run_count - pending_count = 5 - 3 = 2
    expect(screen.getByText('Completed 2 / 5')).toBeInTheDocument();
  });

  it('renders the watch-first-run entry and navigates to /sim/<firstRunId>', async () => {
    vi.mocked(getRunGroupDistribution).mockResolvedValue(makeData() as never);
    const user = userEvent.setup();
    renderPanel({ runGroupId: 'g1', firstRunId: 's1' });

    const btn = await screen.findByRole('button', { name: 'Watch the first worldline unfold' });
    await user.click(btn);
    // Carries an explicit backTo so the sim page's "back" returns to this
    // run-group result page instead of the home page.
    expect(navigateMock).toHaveBeenCalledWith('/sim/s1', {
      state: { backTo: '/result/s1' },
    });
  });

  it('navigates to a completed non-first worldline result via "View result"', async () => {
    vi.mocked(getRunGroupDistribution).mockResolvedValue(makeData() as never);
    const user = userEvent.setup();
    renderPanel({ runGroupId: 'g1', firstRunId: 's1' });

    // run #2 is done (non-first) → exposes a "View result" action to /result/<id>.
    const viewButtons = await screen.findAllByRole('button', { name: 'View result' });
    expect(viewButtons.length).toBeGreaterThanOrEqual(1);
    await user.click(viewButtons[0]);
    expect(navigateMock).toHaveBeenCalledWith('/result/s2');
  });

  it('omits the watch entry when no firstRunId is provided', async () => {
    vi.mocked(getRunGroupDistribution).mockResolvedValue(makeData() as never);
    renderPanel({ runGroupId: 'g1' });

    await screen.findByText('Simulating 5 worldlines…');
    expect(
      screen.queryByRole('button', { name: 'Watch the first worldline unfold' }),
    ).toBeNull();
  });

  it('stops polling once every worldline is terminal', async () => {
    const allDone = makeData({
      pending_count: 0,
      terminal_count: 5,
      runs: makeData().runs.map((r) => ({ ...r, status: 'done' })),
    });
    vi.mocked(getRunGroupDistribution).mockResolvedValue(allDone as never);
    renderPanel({ runGroupId: 'g1', firstRunId: 's1' });

    expect(await screen.findByText('Completed 5 / 5')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 80));
    // All runs terminal on the first poll → must not schedule another poll.
    expect(vi.mocked(getRunGroupDistribution).mock.calls.length).toBe(1);
  });
});
