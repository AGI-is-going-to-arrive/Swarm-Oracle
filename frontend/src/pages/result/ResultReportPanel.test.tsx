import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FullReport, FullReportTruncatedMarker } from '../../types';

// ── Mocks ─────────────────────────────────────────────────────
vi.mock('./ResultContext', () => ({
  useResultContext: vi.fn(),
}));
vi.mock('../../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: vi.fn(),
}));
vi.mock('../../api/client', () => ({
  generateReport: vi.fn(),
}));
// Keep child components light; assert the panel's own gating/render decisions only.
vi.mock('./ReportConfidenceBadge', () => ({
  ReportConfidenceBadge: () => <div data-testid="report-confidence-badge" />,
}));
vi.mock('./ReportToc', () => ({
  ReportToc: ({ sections }: { sections: unknown[] }) => (
    <nav data-testid="report-toc" data-count={sections.length} />
  ),
}));
vi.mock('./ReportSection', () => ({
  ReportSection: ({ section }: { section: { id: string } }) => (
    <section data-testid={`report-section-${section.id}`} />
  ),
}));
vi.mock('./ReportEvidenceDrawer', () => ({
  ReportEvidenceDrawer: () => null,
}));

import { useResultContext } from './ResultContext';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import { ResultReportPanel } from './ResultReportPanel';

const mockedCtx = vi.mocked(useResultContext);
const mockedCap = vi.mocked(useCapabilityCheck);

function makeReport(overrides: Partial<FullReport> = {}): FullReport {
  return {
    version: '1',
    generated_at: '2026-06-08T00:00:00Z',
    generation_mode: 'generation',
    target_branch_id: 'b1',
    target_branch_sort: ['b1'],
    language: 'en',
    available_languages: ['en'],
    title: 'Deep-Read Report',
    title_i18n: { zh: '深读报告', en: 'Deep-Read Report' },
    summary: 'summary',
    summary_i18n: { zh: '摘要', en: 'summary' },
    status: 'complete',
    tier: 'generation',
    verdict: {
      headline_answer: 'Yes.',
      likelihood: { probability: 0.6, interval: [0.5, 0.7], wep: 'Likely' },
      analytic_confidence: { level: 'medium', basis: 'basis' },
      disclaimer: '',
    },
    sections: [
      { id: 's1', title: 'One', title_i18n: { zh: '一', en: 'One' }, intent: '', body_md_i18n: { zh: '', en: 'b' } },
      { id: 's2', title: 'Two', title_i18n: { zh: '二', en: 'Two' }, intent: '', body_md_i18n: { zh: '', en: 'b' } },
    ] as FullReport['sections'],
    evidence: [],
    indicators_to_watch: [],
    dissenting: null,
    key_participants: [],
    follow_ups: [],
    limitations: '',
    interview_evidence: [],
    premortem: [],
    language_status: null,
    ...overrides,
  };
}

function setCtx(storyData: { full_report?: FullReport | FullReportTruncatedMarker | null } | null) {
  mockedCtx.mockReturnValue({
    storyData,
    activeScenarioId: 'sc-1',
    isZh: false,
  } as unknown as ReturnType<typeof useResultContext>);
}

function setCap(over: Partial<ReturnType<typeof useCapabilityCheck>>) {
  mockedCap.mockReturnValue({
    capabilities: { result_report: { enabled: true } },
    loading: false,
    error: null,
    enabled: true,
    reload: vi.fn(),
    ...over,
  } as unknown as ReturnType<typeof useCapabilityCheck>);
}

beforeEach(() => {
  mockedCtx.mockReset();
  mockedCap.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('ResultReportPanel — inline capability loading', () => {
  it('returns null (no skeleton flash) for the inline variant while capability is loading', () => {
    setCtx({ full_report: null });
    setCap({ loading: true, capabilities: null, enabled: false });
    const { container } = render(<ResultReportPanel variant="inline" />);
    expect(container.firstChild).toBeNull();
  });

  it('keeps the skeleton for the standalone variant while capability is loading', () => {
    setCtx({ full_report: null });
    setCap({ loading: true, capabilities: null, enabled: false });
    const { container } = render(<ResultReportPanel variant="standalone" />);
    expect(container.querySelector('.report-panel-container')).not.toBeNull();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });
});

describe('ResultReportPanel — partial report rendering', () => {
  it('renders the full report + a non-blocking retry banner when partial WITH sections', () => {
    setCtx({ full_report: makeReport({ status: 'partial' }) });
    setCap({});
    render(<ResultReportPanel variant="inline" />);

    // Sections + indicators surface (the full report renders).
    expect(screen.getByTestId('report-section-s1')).toBeInTheDocument();
    expect(screen.getByTestId('report-section-s2')).toBeInTheDocument();
    expect(screen.getByTestId('report-confidence-badge')).toBeInTheDocument();
    // Non-blocking retry banner on top, with a working Retry button.
    expect(screen.getByText(/partially generated/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry Generation/i })).toBeInTheDocument();
  });

  it('shows the failure card (no sections) when partial WITHOUT sections', () => {
    setCtx({ full_report: makeReport({ status: 'partial', sections: [] }) });
    setCap({});
    render(<ResultReportPanel variant="inline" />);

    expect(screen.queryByTestId('report-section-s1')).toBeNull();
    expect(screen.getByText('Report Generation Incomplete')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry Generation/i })).toBeInTheDocument();
  });

  it('shows a truncated report state for metadata-only partial markers', () => {
    setCtx({ full_report: { status: 'partial', truncated: true } });
    setCap({});
    render(<ResultReportPanel variant="inline" />);

    expect(screen.getByText('Deep-Read Report Truncated')).toBeInTheDocument();
    expect(screen.queryByText('Deep-Read Report Not Generated')).toBeNull();
    expect(screen.getByRole('button', { name: /Retry Generation/i })).toBeInTheDocument();
  });

  it('shows the failure card for a failed report even when sections exist', () => {
    setCtx({ full_report: makeReport({ status: 'failed' }) });
    setCap({});
    render(<ResultReportPanel variant="inline" />);

    expect(screen.queryByTestId('report-section-s1')).toBeNull();
    expect(screen.getByText('Report Generation Incomplete')).toBeInTheDocument();
  });

  it('renders a complete report with no retry banner', () => {
    setCtx({ full_report: makeReport({ status: 'complete' }) });
    setCap({});
    render(<ResultReportPanel variant="inline" />);

    expect(screen.getByTestId('report-section-s1')).toBeInTheDocument();
    expect(screen.queryByText(/partially generated/i)).toBeNull();
  });
});
