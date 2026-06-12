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
      histogram: {
        verdict_counts: {},
        outcome_counts: {},
      },
      runs: [
        { scenario_id: 's1', run_index: 1, status: 'done', verdict: 'OK', outcome: 'Outcome A' },
        { scenario_id: 's2', run_index: 2, status: 'simulating', verdict: 'unknown', outcome: 'unknown' },
        { scenario_id: 's3', run_index: 3, status: 'parsing', verdict: 'unknown', outcome: 'unknown' },
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

    expect(screen.queryByText('Verdict Counts (3 worldline counts)')).not.toBeInTheDocument();
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
      histogram: {
        verdict_counts: { 'OK': 2, 'NO': 1 },
        outcome_counts: { 'Outcome A': 2, 'Outcome B': 1 },
      },
      runs: [
        { scenario_id: 's1', run_index: 1, status: 'done', verdict: 'OK', outcome: 'Outcome A' },
        { scenario_id: 's2', run_index: 2, status: 'done', verdict: 'OK', outcome: 'Outcome A' },
        { scenario_id: 's3', run_index: 3, status: 'done', verdict: 'NO', outcome: 'Outcome B' },
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

    expect(screen.getByText('Verdict Counts (3 worldline counts)')).toBeInTheDocument();
    expect(screen.getByText('Outcome Counts (3 worldline counts)')).toBeInTheDocument();

    expect(screen.getAllByText('OK')[0]).toBeInTheDocument();
    expect(screen.getAllByText('NO')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Outcome A')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Outcome B')[0]).toBeInTheDocument();

    const innerHtml = container.innerHTML;
    expect(innerHtml).not.toContain('probability');
    expect(innerHtml).not.toContain('calibrated');
    expect(innerHtml).not.toContain('probability cal');
    expect(innerHtml).not.toContain('概率');
    expect(innerHtml).not.toContain('校准');
  });
});
