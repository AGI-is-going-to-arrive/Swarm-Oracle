import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { MultiRunDistributionPanel } from './MultiRunDistributionPanel';
import { getRunGroupDistribution } from '../../api/client';

// Mock getRunGroupDistribution
vi.mock('../../api/client', () => ({
  getRunGroupDistribution: vi.fn(),
}));

const useCapabilityCheckMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: useCapabilityCheckMock,
}));

i18n.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        common: {
          error_generic: 'Failed to load data',
          capability_error_title: 'Cannot verify feature',
          capability_error: 'Unable to verify feature availability. Please try again.',
          retry: 'Retry',
        },
        sim: {
          status: {
            loading: 'Loading...',
            done: 'Completed',
            simulating: 'Simulating',
            parsing: 'Parsing',
          },
        },
        multi_run: {
          input_label: 'Worldline Run',
          status_label: 'Status',
          verdict_label: 'Verdict',
          outcome_label: 'Outcome',
          progress_label: 'Running: {{current}} / {{total}} completed',
          histogram_verdicts: 'Verdict Counts ({{count}} worldline counts)',
          histogram_outcomes: 'Outcome Counts ({{count}} worldline counts)',
          worldlines_list_title: 'Worldlines Verdict Ledger',
          run_index: 'Run #{{index}}',
          verdict_unknown: 'unknown',
          outcome_unknown: 'unknown',
          capability_disabled: 'Multi-run simulation is disabled.',
          aria_histogram_bar: '{{label}}: {{count}} runs',
          completed_runs_denominator: 'based on {{completed}} / {{total}} completed runs',
          status_pending_badge: 'Pending',
          status_failed_badge: 'Failed',
          status_completed_badge: 'Completed',
          feeds_distribution: 'Feeds into the distribution',
          feeds_distribution_short: 'Included',
        },
      },
    },
  },
});

describe('MultiRunDistributionPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders disabled placeholder when capability is disabled', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: false,
      capabilities: null,
      error: null,
    });

    render(
      <I18nextProvider i18n={i18n}>
        <MultiRunDistributionPanel runGroupId="rg-123" />
      </I18nextProvider>,
    );

    expect(screen.getByText('Multi-run simulation is disabled.')).toBeInTheDocument();
  });

  it('renders loading state when first loading run group data', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: { multi_run: { enabled: true, default_count: 5, max_count: 10 } },
      error: null,
    });

    vi.mocked(getRunGroupDistribution).mockImplementation(() => new Promise(() => {})); // Never resolves

    render(
      <I18nextProvider i18n={i18n}>
        <MultiRunDistributionPanel runGroupId="rg-123" />
      </I18nextProvider>,
    );

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders in-progress status and ledger, but no histograms', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: { multi_run: { enabled: true, default_count: 5, max_count: 10 } },
      error: null,
    });

    vi.mocked(getRunGroupDistribution).mockResolvedValue({
      run_group_id: 'rg-123',
      run_count: 3,
      terminal_count: 1,
      pending_count: 2,
      failed_count: 0,
      status_counts: { 'done': 1, 'simulating': 1, 'parsing': 1 },
      histogram: {
        verdict_counts: {},
        outcome_counts: {},
      },
      runs: [
        { scenario_id: 's1', run_index: 1, status: 'done', verdict: 'OK', outcome: 'Outcome A', is_terminal_distribution_row: true },
        { scenario_id: 's2', run_index: 2, status: 'simulating', verdict: null, outcome: null, is_terminal_distribution_row: false },
        { scenario_id: 's3', run_index: 3, status: 'parsing', verdict: null, outcome: null, is_terminal_distribution_row: false },
      ],
    });

    render(
      <I18nextProvider i18n={i18n}>
        <MultiRunDistributionPanel runGroupId="rg-123" />
      </I18nextProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Running: 1 / 3 completed')).toBeInTheDocument();
    });

    expect(screen.getByText('Worldlines Verdict Ledger')).toBeInTheDocument();
    expect(screen.getByText('Run #1')).toBeInTheDocument();
    expect(screen.getByText('Run #2')).toBeInTheDocument();
    expect(screen.getByText('Run #3')).toBeInTheDocument();

    // Verify pending counts and completed count badges are rendered
    expect(screen.getByText('Pending: 2')).toBeInTheDocument();
    expect(screen.getByText('Failed: 0')).toBeInTheDocument();
    expect(screen.getByText('Completed: 1')).toBeInTheDocument();

    // Verify null verdict/outcome renders as em-dash
    const cells = screen.getAllByRole('cell');
    const dashes = cells.filter(cell => cell.textContent === '—');
    expect(dashes.length).toBeGreaterThanOrEqual(4); // verdict and outcome for both run 2 and 3 are null

    expect(screen.queryByText('Verdict Counts')).not.toBeInTheDocument();
  });

  it('renders histograms and full ledger when completed, with correct labels and no forbidden words', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: { multi_run: { enabled: true, default_count: 5, max_count: 10 } },
      error: null,
    });

    vi.mocked(getRunGroupDistribution).mockResolvedValue({
      run_group_id: 'rg-123',
      run_count: 3,
      terminal_count: 2,
      pending_count: 0,
      failed_count: 1,
      status_counts: { 'done': 2, 'error': 1 },
      histogram: {
        verdict_counts: { 'OK': 2 },
        outcome_counts: { 'Outcome A': 2 },
      },
      runs: [
        { scenario_id: 's1', run_index: 1, status: 'done', verdict: 'OK', outcome: 'Outcome A', is_terminal_distribution_row: true },
        { scenario_id: 's2', run_index: 2, status: 'done', verdict: 'OK', outcome: 'Outcome A', is_terminal_distribution_row: true },
        { scenario_id: 's3', run_index: 3, status: 'error', verdict: null, outcome: null, is_terminal_distribution_row: false },
      ],
    });

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <MultiRunDistributionPanel runGroupId="rg-123" />
      </I18nextProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Running: 3 / 3 completed')).toBeInTheDocument();
    });

    // Denominator uses terminal_count (2) and run_count (3)
    expect(screen.getByText('Verdict Counts (2 worldline counts)')).toBeInTheDocument();
    expect(screen.getByText('Outcome Counts (2 worldline counts)')).toBeInTheDocument();
    expect(screen.getAllByText('based on 2 / 3 completed runs')[0]).toBeInTheDocument();

    // Badges
    expect(screen.getByText('Pending: 0')).toBeInTheDocument();
    expect(screen.getByText('Failed: 1')).toBeInTheDocument();
    expect(screen.getByText('Completed: 2')).toBeInTheDocument();

    expect(screen.getAllByText('OK')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Outcome A')[0]).toBeInTheDocument();

    // Verify row styling/indicator
    expect(screen.getAllByText('Included').length).toBe(2);

    const innerHtml = container.innerHTML;
    expect(innerHtml).not.toContain('probability');
    expect(innerHtml).not.toContain('calibrated');
    expect(innerHtml).not.toContain('probability cal');
    expect(innerHtml).not.toContain('概率');
    expect(innerHtml).not.toContain('校准');
  });

  it('renders retry button and triggers reload on capability probe failure', () => {
    const reloadMock = vi.fn();
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: false,
      capabilities: null,
      error: new Error('Capability probe failed'),
      reload: reloadMock,
    });

    render(
      <I18nextProvider i18n={i18n}>
        <MultiRunDistributionPanel runGroupId="rg-123" />
      </I18nextProvider>,
    );

    expect(screen.getByText('Cannot verify feature')).toBeInTheDocument();
    expect(screen.getByText('Unable to verify feature availability. Please try again.')).toBeInTheDocument();

    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    expect(retryBtn).toBeInTheDocument();
    retryBtn.click();
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });
});
