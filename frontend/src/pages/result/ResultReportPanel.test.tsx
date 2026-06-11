import { act, fireEvent, render, screen } from '@testing-library/react';
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
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
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
vi.mock('../../lib/llmProviderPolicy', () => ({
  loadLlmProviderPolicy: vi.fn(() => ({
    apiKey: 'mock-key',
    baseUrl: 'mock-url',
    model: 'mock-model',
    reasoningEffort: '',
    disableUserQuota: false,
    requestsPerMinute: null,
    tokensPerMinute: null,
  })),
  validateByok: vi.fn(() => ({ valid: true })),
}));

import { useResultContext } from './ResultContext';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import { generateReport } from '../../api/client';
import { loadLlmProviderPolicy, validateByok } from '../../lib/llmProviderPolicy';
import { ResultReportPanel } from './ResultReportPanel';

const mockedCtx = vi.mocked(useResultContext);
const mockedCap = vi.mocked(useCapabilityCheck);
const mockedGenerateReport = vi.mocked(generateReport);
const mockedLoadLlmProviderPolicy = vi.mocked(loadLlmProviderPolicy);
const mockedValidateByok = vi.mocked(validateByok);

function makeReport(overrides: Partial<FullReport> = {}): FullReport {
  return {
    version: '1',
    generated_at: '2026-06-08T00:00:00Z',
    generation_mode: 'generation',
    target_branch_id: 'b1',
    target_branch_sort: ['b1'],
    language: 'en',
    available_languages: ['en'],
    title: 'Full report',
    title_i18n: { zh: '完整报告', en: 'Full report' },
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

const originalReload = window.location.reload;

beforeEach(() => {
  mockedCtx.mockReset();
  mockedCap.mockReset();
  mockedGenerateReport.mockReset();
  mockedLoadLlmProviderPolicy.mockReset();
  mockedValidateByok.mockReset();
  mockedLoadLlmProviderPolicy.mockReturnValue({
    apiKey: 'mock-key',
    baseUrl: 'mock-url',
    model: 'mock-model',
    reasoningEffort: '',
    disableUserQuota: false,
    requestsPerMinute: null,
    tokensPerMinute: null,
  });
  mockedValidateByok.mockReturnValue({ valid: true });
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...window.location, reload: vi.fn() },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...window.location, reload: originalReload },
  });
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

describe('ResultReportPanel — manual retry stream handling', () => {
  it('times out an open SSE body after the response headers arrive', async () => {
    vi.useFakeTimers();
    setCtx({ full_report: makeReport({ status: 'partial', sections: [] }) });
    setCap({});
    let finishRead: ((value: ReadableStreamReadResult<Uint8Array>) => void) | null = null;
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: new Uint8Array([1]),
        } as ReadableStreamReadResult<Uint8Array>)
        .mockImplementationOnce(() => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          finishRead = resolve;
        })),
      cancel: vi.fn(() => {
        finishRead?.({ done: true, value: undefined } as ReadableStreamReadResult<Uint8Array>);
        return Promise.resolve();
      }),
      releaseLock: vi.fn(),
    };
    mockedGenerateReport.mockResolvedValue({
      body: {
        getReader: () => reader,
      },
    } as unknown as Response);

    render(<ResultReportPanel variant="inline" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /Generating/i })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35 * 60_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/Retry failed/i)).toBeInTheDocument();
    expect(reader.cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Retry Generation/i })).not.toBeDisabled();
  });

  it('blocks the retry and sets retryError when validateByok fails', async () => {
    mockedValidateByok.mockReturnValue({ valid: false, errorCode: 'BYOK_INVALID' });
    setCtx({ full_report: makeReport({ status: 'partial', sections: [] }) });
    setCap({});

    render(<ResultReportPanel variant="inline" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
    });

    expect(mockedGenerateReport).not.toHaveBeenCalled();
    expect(screen.getByText(/Your API key is invalid or rejected by the provider/i)).toBeInTheDocument();
  });

  it('accumulates tool_trace from SSE stream, renders collapsed chip, and expands on click', async () => {
    setCtx({ full_report: makeReport({ status: 'partial' }) });
    setCap({});

    const encoder = new TextEncoder();
    const frameContent1 = 'data: {"tool_trace": [{"tool": "web_search", "query": "Find things", "item_count": 3, "elapsed_ms": 45}]}\n\n';
    const frameContent2 = 'data: {"tool_trace": [{"tool": "vector_lookup", "query": "lookup embedding", "item_count": 5, "elapsed_ms": 120}]}\n\n';
    const sseBytes1 = encoder.encode(frameContent1);
    const sseBytes2 = encoder.encode(frameContent2);

    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({
          done: false,
          value: sseBytes1,
        } as ReadableStreamReadResult<Uint8Array>)
        .mockResolvedValueOnce({
          done: false,
          value: sseBytes2,
        } as ReadableStreamReadResult<Uint8Array>)
        .mockResolvedValueOnce({
          done: true,
          value: undefined,
        } as ReadableStreamReadResult<Uint8Array>),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };

    mockedGenerateReport.mockResolvedValue({
      body: {
        getReader: () => reader,
      },
    } as unknown as Response);

    render(<ResultReportPanel variant="inline" />);

    // Click Retry Generation to trigger stream reading
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // Check that tool trace chip trigger button is visible and collapsed (aria-expanded="false")
    const trigger = screen.getByRole('button', { name: /Show tool activity/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent(/Tool activity \(2\)/);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-controls');

    // Click the trigger to expand
    await act(async () => {
      fireEvent.click(trigger);
    });

    // Expect trigger to update to aria-expanded="true" and show tool details
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', 'report-tool-trace-details');
    expect(document.getElementById('report-tool-trace-details')).toBeInTheDocument();
    expect(screen.getByText('web_search')).toBeInTheDocument();
    expect(screen.getByText('Find things')).toBeInTheDocument();
    expect(screen.getByText('vector_lookup')).toBeInTheDocument();
    expect(screen.getByText('lookup embedding')).toBeInTheDocument();
    expect(screen.getByText(/3 items/i)).toBeInTheDocument();
    expect(screen.getByText(/45 ms/i)).toBeInTheDocument();
    expect(screen.getByText(/5 items/i)).toBeInTheDocument();
    expect(screen.getByText(/120 ms/i)).toBeInTheDocument();

    // Now test that a new retry clears the accumulated trace before the new run.
    const reader2 = {
      read: vi.fn().mockResolvedValueOnce({
        done: true,
        value: undefined,
      } as ReadableStreamReadResult<Uint8Array>),
      cancel: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn(),
    };
    mockedGenerateReport.mockResolvedValueOnce({
      body: {
        getReader: () => reader2,
      },
    } as unknown as Response);

    // Click Retry Generation again
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // The tool trace chip should now be absent because the trace was reset to []
    expect(screen.queryByRole('button', { name: /Tool activity/i })).not.toBeInTheDocument();
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
    expect(screen.queryByText(/深读/)).toBeNull();
    expect(screen.queryByText(/Deep-read/i)).toBeNull();
  });

  it('shows a truncated report state for metadata-only partial markers', () => {
    setCtx({ full_report: { status: 'partial', truncated: true } });
    setCap({});
    render(<ResultReportPanel variant="inline" />);

    expect(screen.getByText('Full Report Truncated')).toBeInTheDocument();
    expect(screen.queryByText('Full Report Not Generated')).toBeNull();
    expect(screen.getByRole('button', { name: /Retry Generation/i })).toBeInTheDocument();
  });

  it('shows the failure card for a failed report even when sections exist', () => {
    setCtx({ full_report: makeReport({ status: 'failed' }) });
    setCap({});
    render(<ResultReportPanel variant="inline" />);

    expect(screen.queryByTestId('report-section-s1')).toBeNull();
    expect(screen.getByText('Report Generation Incomplete')).toBeInTheDocument();
    expect(screen.queryByText(/深读/)).toBeNull();
    expect(screen.queryByText(/Deep-read/i)).toBeNull();
  });

  it('renders a complete report with no retry banner', () => {
    setCtx({ full_report: makeReport({ status: 'complete' }) });
    setCap({});
    render(<ResultReportPanel variant="inline" />);

    expect(screen.getByTestId('report-section-s1')).toBeInTheDocument();
    expect(screen.queryByText(/partially generated/i)).toBeNull();
  });
});
