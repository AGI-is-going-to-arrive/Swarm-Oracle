import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  FullReport,
  FullReportTruncatedMarker,
  StoryData,
  ToolTraceSummary,
} from '../../types';

// ── Mocks ─────────────────────────────────────────────────────
vi.mock('./ResultContext', () => ({
  useResultContext: vi.fn(),
}));
vi.mock('../../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: vi.fn(),
}));
vi.mock('../../api/client', () => ({
  generateReport: vi.fn(),
  getStory: vi.fn(),
}));
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
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
import { generateReport, getStory } from '../../api/client';
import { loadLlmProviderPolicy, validateByok } from '../../lib/llmProviderPolicy';
import { ResultReportPanel } from './ResultReportPanel';

const mockedCtx = vi.mocked(useResultContext);
const mockedCap = vi.mocked(useCapabilityCheck);
const mockedGenerateReport = vi.mocked(generateReport);
const mockedGetStory = vi.mocked(getStory);
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

const premortemEvidence = [
  {
    id: 'ev-1',
    branch_id: 'b1',
    round_id: 'r1',
    round_number: 1,
    agent_id: 'a1',
    agent_name: 'Analyst One',
    message_id: 'm1',
    quote: 'Inventories fell below the operating buffer.',
    kind: 'utterance' as const,
  },
  {
    id: 'ev-2',
    branch_id: 'b2',
    round_id: 'r2',
    round_number: 2,
    agent_id: 'a2',
    agent_name: 'Analyst Two',
    message_id: 'm2',
    quote: 'Replacement capacity did not arrive in time.',
    kind: 'causal_fact' as const,
  },
];

function makePremortemReport(
  analysis: unknown,
  evidence: FullReport['evidence'] = premortemEvidence,
): FullReport {
  const report = makeReport({ evidence });
  (report as unknown as { premortem_analysis?: unknown }).premortem_analysis = analysis;
  return report;
}

const availablePremortem = {
  status: 'available',
  reason: null,
  items: [
    {
      id: 'pm_001',
      failure_mode_i18n: { zh: '供应链停摆', en: 'Supply chain stalls' },
      mechanism_i18n: { zh: '缓冲库存耗尽', en: 'Buffer inventory is exhausted' },
      early_warning_i18n: { zh: '库存跌破两周', en: 'Inventory falls below two weeks' },
      uncertainty_i18n: { zh: '替代产能到位时间未知', en: 'Replacement timing remains uncertain' },
      evidence_chain: [
        {
          evidence_ref: 'ev-1',
          role: 'failure_signal',
          rationale_i18n: { zh: '库存提供了早期信号', en: 'Inventory provides the early signal' },
        },
        {
          evidence_ref: 'ev-2',
          role: 'failure_mechanism',
          rationale_i18n: { zh: '产能延迟解释了失效机制', en: 'Capacity delay supports the mechanism' },
        },
      ],
    },
  ],
};

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

function responseFromSse(payload: string): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledSseResponse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  }));

  return {
    response,
    finish(payload: string) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  };
}

const originalReload = window.location.reload;

beforeEach(() => {
  mockNavigate.mockClear();
  mockedCtx.mockReset();
  mockedCap.mockReset();
  mockedGenerateReport.mockReset();
  mockedGetStory.mockReset();
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

    // The retry immediately shows the honest generating card (poll armed).
    expect(screen.getByText(/Building your report/i)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35 * 60_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    // Client-side stream timeout aborts the SSE request; the backend ties the
    // report task to that generator, so the user must see a retryable failure.
    expect(reader.cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalled();
    expect(screen.getByText(/Retry failed/i)).toBeInTheDocument();
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
    expect(screen.getByText(/The provider rejected this request/i)).toBeInTheDocument();
  });

  it('accumulates tool_trace from SSE stream, renders collapsed chip, and expands on click', async () => {
    setCtx({ full_report: makeReport({ status: 'partial' }) });
    setCap({});

    const encoder = new TextEncoder();
    const frameContent1 = 'event: report_section_complete\ndata: {"status":"complete","section_id":"timeline","tool_trace": [{"tool": "web_search", "query": "Find things", "item_count": 3, "elapsed_ms": 45}]}\n\n';
    const frameContent2 = 'event: report_section_complete\ndata: {"status":"complete","section_id":"factions","tool_trace": [{"tool": "vector_lookup", "query": "lookup embedding", "item_count": 5, "elapsed_ms": 120}]}\n\nevent: report_complete\ndata: {"status":"complete","tool_trace":[]}\n\n';
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
    mockedGetStory.mockResolvedValueOnce({
      full_report: makeReport({
        generated_at: '2026-07-11T00:01:00Z',
        status: 'partial',
      }),
    } as Awaited<ReturnType<typeof getStory>>);

    render(<ResultReportPanel variant="standalone" />);

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

  it('restores persisted tool activity when a completed report is reopened', async () => {
    const report = makeReport();
    (report as FullReport & { tool_trace: ToolTraceSummary[] }).tool_trace = [
      {
        section_id: 'timeline',
        tool: 'query_branch_messages',
        query: 'timeline',
        item_count: 2,
        elapsed_ms: 17,
      } as ToolTraceSummary,
    ];
    setCtx({ full_report: report });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    const trigger = await screen.findByRole('button', { name: /Show tool activity/i });
    expect(trigger).toHaveTextContent(/Tool activity \(1\)/);
    fireEvent.click(trigger);
    expect(screen.getByText('query_branch_messages')).toBeInTheDocument();
    expect(screen.getByText('timeline')).toBeInTheDocument();
  });
});

describe('ResultReportPanel — SSE section progress', () => {
  it('shows section and tool progress before the first completed section is persisted', async () => {
    let resolveAuthority!: (story: Awaited<ReturnType<typeof getStory>>) => void;
    mockedGetStory.mockImplementationOnce(() => new Promise((resolve) => {
      resolveAuthority = resolve;
    }));
    mockedGenerateReport.mockResolvedValue(responseFromSse(
      'event: report_section_complete\ndata: {"status":"complete","section_id":"timeline","tier":"generation","tool_trace":[{"tool":"web_search","query":"evidence","item_count":1,"elapsed_ms":10}]}\n\n'
        + 'event: report_complete\ndata: {"status":"failed","tool_trace":[]}\n\n',
    ));
    setCtx({ full_report: makeReport({ status: 'partial', sections: [] }) });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedGetStory).toHaveBeenCalledOnce();
    expect(screen.getByText(/section timeline completed/i)).toBeInTheDocument();
    expect(screen.getByText('Generated')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show tool activity/i })).toHaveTextContent('Tool activity (1)');

    await act(async () => {
      resolveAuthority({
        full_report: makeReport({ status: 'generating' }),
      } as Awaited<ReturnType<typeof getStory>>);
      await Promise.resolve();
    });
  });

  it('keeps section failures non-terminal and exposes section, tier, fallback, and tool progress', async () => {
    const onRefresh = vi.fn();
    setCtx({ full_report: makeReport({ status: 'partial', sections: [] }) });
    setCap({});
    mockedGenerateReport.mockResolvedValue(responseFromSse(
      'event: report_failed\ndata: {"status":"failed","section_id":"factions","error_code":"SECTION_FAILED","failure_reason":"timeout","tool_trace":[]}\n\n'
        + 'event: report_section_complete\ndata: {"status":"complete","section_id":"timeline","tier":"rewrite","failure_reason":null,"tool_trace":[{"tool":"web_search","query":"evidence","item_count":2,"elapsed_ms":25}]}\n\n'
        + 'event: report_complete\ndata: {"status":"failed","tool_trace":[]}\n\n',
    ));
    mockedGetStory.mockResolvedValue({
      full_report: makeReport({ status: 'generating' }),
    } as Awaited<ReturnType<typeof getStory>>);

    render(<ResultReportPanel variant="standalone" onRefresh={onRefresh} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/section factions failed/i)).toBeInTheDocument();
    expect(screen.getByText(/section timeline completed/i)).toBeInTheDocument();
    expect(screen.getByText('Rewritten')).toBeInTheDocument();
    expect(screen.getByText(/section generation timed out/i)).toBeInTheDocument();
    expect(screen.getByText(/current section: timeline/i)).toBeInTheDocument();
    expect(screen.getByText(/2 sections available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show tool activity/i })).toHaveTextContent('Tool activity (1)');
    expect(mockedGetStory).toHaveBeenCalledOnce();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('keeps polling when the stream reports REPORT_ALREADY_RUNNING', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    setCtx({ full_report: makeReport({ status: 'partial' }) });
    setCap({});
    mockedGenerateReport.mockResolvedValue(responseFromSse(
      'event: report_failed\ndata: {"status":"failed","error_code":"REPORT_ALREADY_RUNNING","tool_trace":[]}\n\n'
        + 'event: report_complete\ndata: {"status":"failed","tool_trace":[]}\n\n',
    ));
    mockedGetStory.mockResolvedValue({
      full_report: makeReport({ status: 'generating' }),
    } as Awaited<ReturnType<typeof getStory>>);

    render(<ResultReportPanel variant="standalone" onRefresh={onRefresh} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedGetStory).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledOnce();
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe('ResultReportPanel — persisted report authority', () => {
  it('keeps a terminal stream authority result when an earlier poll resolves generating late', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const pollAuthority = deferred<Awaited<ReturnType<typeof getStory>>>();
    const streamAuthority = deferred<Awaited<ReturnType<typeof getStory>>>();
    const stream = controlledSseResponse();
    const terminalReport = makeReport({
      status: 'complete',
      sections: [{
        id: 'terminal-authority',
        title: 'Terminal authority',
        title_i18n: { zh: '终态权威', en: 'Terminal authority' },
        intent: '',
        body_md_i18n: { zh: '', en: 'terminal' },
        evidence_refs: [],
        charts: [],
      }],
    });
    const lateGeneratingReport = makeReport({
      status: 'generating',
      sections: [{
        id: 'late-poll',
        title: 'Late poll',
        title_i18n: { zh: '迟到轮询', en: 'Late poll' },
        intent: '',
        body_md_i18n: { zh: '', en: 'late' },
        evidence_refs: [],
        charts: [],
      }],
    });
    setCtx({ full_report: makeReport({ status: 'partial' }) });
    setCap({});
    mockedGenerateReport.mockResolvedValue(stream.response);
    mockedGetStory
      .mockImplementationOnce(() => pollAuthority.promise)
      .mockImplementationOnce(() => streamAuthority.promise);

    render(<ResultReportPanel variant="standalone" onRefresh={onRefresh} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledOnce();

    await act(async () => {
      stream.finish('event: report_complete\ndata: {"status":"complete","tool_trace":[]}\n\n');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedGetStory).toHaveBeenCalledTimes(2);

    await act(async () => {
      streamAuthority.resolve({ full_report: terminalReport } as Awaited<ReturnType<typeof getStory>>);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('report-section-terminal-authority')).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledOnce();

    await act(async () => {
      pollAuthority.resolve({ full_report: lateGeneratingReport } as Awaited<ReturnType<typeof getStory>>);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('report-section-terminal-authority')).toBeInTheDocument();
    expect(screen.queryByTestId('report-section-late-poll')).not.toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockedGetStory).toHaveBeenCalledTimes(2);
  });

  it('does not refetch or refresh when polling reaches terminal authority before the stream', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const pollAuthority = deferred<Awaited<ReturnType<typeof getStory>>>();
    const stream = controlledSseResponse();
    const pollTerminalReport = makeReport({
      status: 'complete',
      sections: [{
        id: 'poll-terminal',
        title: 'Poll terminal',
        title_i18n: { zh: '轮询终态', en: 'Poll terminal' },
        intent: '',
        body_md_i18n: { zh: '', en: 'terminal' },
        evidence_refs: [],
        charts: [],
      }],
    });
    setCtx({ full_report: makeReport({ status: 'partial' }) });
    setCap({});
    mockedGenerateReport.mockResolvedValue(stream.response);
    mockedGetStory
      .mockImplementationOnce(() => pollAuthority.promise)
      .mockResolvedValue({
        full_report: makeReport({ status: 'complete' }),
      } as Awaited<ReturnType<typeof getStory>>);

    render(<ResultReportPanel variant="standalone" onRefresh={onRefresh} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledOnce();

    await act(async () => {
      pollAuthority.resolve({ full_report: pollTerminalReport } as Awaited<ReturnType<typeof getStory>>);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('report-section-poll-terminal')).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledOnce();

    await act(async () => {
      stream.finish('event: report_complete\ndata: {"status":"complete","tool_trace":[]}\n\n');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedGetStory).toHaveBeenCalledOnce();
    expect(screen.getByTestId('report-section-poll-terminal')).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('ignores the pre-attempt terminal snapshot after REPORT_ALREADY_RUNNING', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const initialReport = makeReport({
      generated_at: '2026-07-11T00:00:00Z',
      status: 'failed',
      target_branch_id: 'b1',
    });
    const completedReport = makeReport({
      generated_at: '2026-07-11T00:01:00Z',
      status: 'complete',
      target_branch_id: 'b1',
    });
    setCtx({ full_report: initialReport });
    setCap({});
    mockedGenerateReport.mockResolvedValue(responseFromSse(
      'event: report_failed\ndata: {"status":"failed","error_code":"REPORT_ALREADY_RUNNING","tool_trace":[]}\n\n'
        + 'event: report_complete\ndata: {"status":"failed","tool_trace":[]}\n\n',
    ));
    mockedGetStory
      .mockResolvedValueOnce({ full_report: initialReport } as Awaited<ReturnType<typeof getStory>>)
      .mockResolvedValueOnce({ full_report: completedReport } as Awaited<ReturnType<typeof getStory>>);

    render(<ResultReportPanel variant="standalone" onRefresh={onRefresh} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledOnce();
    expect(screen.getByText(/Report generation in progress/i)).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockedGetStory).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('ignores the pre-attempt terminal snapshot while an accepted stream is still open', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const stream = controlledSseResponse();
    const initialReport = makeReport({
      generated_at: '2026-07-11T00:00:00Z',
      status: 'failed',
      target_branch_id: 'b1',
    });
    const completedReport = makeReport({
      generated_at: '2026-07-11T00:01:00Z',
      status: 'complete',
      target_branch_id: 'b1',
      sections: [{
        id: 'fresh-terminal',
        title: 'Fresh terminal',
        title_i18n: { zh: '新终态', en: 'Fresh terminal' },
        intent: '',
        body_md_i18n: { zh: '', en: 'fresh' },
        evidence_refs: [],
        charts: [],
      }],
    });
    setCtx({ full_report: initialReport });
    setCap({});
    mockedGenerateReport.mockResolvedValue(stream.response);
    mockedGetStory
      .mockResolvedValueOnce({ full_report: initialReport } as Awaited<ReturnType<typeof getStory>>)
      .mockResolvedValueOnce({ full_report: completedReport } as Awaited<ReturnType<typeof getStory>>);

    render(<ResultReportPanel variant="standalone" onRefresh={onRefresh} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledOnce();
    expect(screen.getByText(/Report generation in progress/i)).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => {
      stream.finish('event: report_complete\ndata: {"status":"complete","tool_trace":[]}\n\n');
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedGetStory).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('report-section-fresh-terminal')).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('preserves the pre-attempt baseline after stream interruption until authority changes', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const initialReport = makeReport({
      generated_at: '2026-07-11T00:00:00Z',
      status: 'failed',
      target_branch_id: 'b1',
    });
    const cancelledReport = makeReport({
      generated_at: '2026-07-11T00:01:00Z',
      status: 'cancelled',
      target_branch_id: 'b1',
    });
    setCtx({ full_report: initialReport });
    setCap({});
    mockedGenerateReport.mockResolvedValue(responseFromSse(
      'event: report_started\ndata: {"status":"generating","tool_trace":[]}\n\n',
    ));
    mockedGetStory
      .mockResolvedValueOnce({ full_report: initialReport } as Awaited<ReturnType<typeof getStory>>)
      .mockResolvedValueOnce({ full_report: cancelledReport } as Awaited<ReturnType<typeof getStory>>);

    render(<ResultReportPanel variant="standalone" onRefresh={onRefresh} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/stream interrupted/i)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledOnce();
    expect(screen.getByText(/Report generation in progress/i)).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/report generation cancelled/i)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'REPORT_ALREADY_RUNNING',
      'event: report_failed\ndata: {"status":"failed","error_code":"REPORT_ALREADY_RUNNING","tool_trace":[]}\n\n'
        + 'event: report_complete\ndata: {"status":"failed","tool_trace":[]}\n\n',
    ],
    [
      'an interrupted stream',
      'event: report_started\ndata: {"status":"generating","tool_trace":[]}\n\n',
    ],
  ])('clears terminal authority for a new retry followed by %s', async (_label, payload) => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const retryableTerminal = makeReport({
      generated_at: '2026-07-11T00:01:00Z',
      status: 'partial',
    });
    setCtx({ full_report: makeReport({ status: 'generating' }) });
    setCap({});
    mockedGetStory
      .mockResolvedValueOnce({ full_report: retryableTerminal } as Awaited<ReturnType<typeof getStory>>)
      .mockResolvedValueOnce({
        full_report: makeReport({
          generated_at: '2026-07-11T00:02:00Z',
          status: 'generating',
        }),
      } as Awaited<ReturnType<typeof getStory>>);
    mockedGenerateReport.mockResolvedValue(responseFromSse(payload));

    render(<ResultReportPanel variant="standalone" onRefresh={onRefresh} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledOnce();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockedGetStory).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Report generation in progress/i)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('clears terminal authority when story data resets and rearms polling', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const initialStory = {
      full_report: makeReport({ status: 'generating' }),
    } as StoryData;
    const resetStory = {
      full_report: makeReport({
        generated_at: '2026-07-11T00:01:00Z',
        status: 'generating',
      }),
    } as StoryData;
    setCtx(null);
    setCap({});
    mockedGetStory
      .mockResolvedValueOnce({
        full_report: makeReport({ status: 'complete' }),
      } as Awaited<ReturnType<typeof getStory>>)
      .mockResolvedValueOnce({ full_report: resetStory.full_report } as Awaited<ReturnType<typeof getStory>>);

    const { rerender } = render(
      <ResultReportPanel
        variant="standalone"
        onRefresh={onRefresh}
        storyData={initialStory}
        activeScenarioId="sc-1"
        isZh={false}
        isReplayMode={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledOnce();

    await act(async () => {
      rerender(
        <ResultReportPanel
          variant="standalone"
          onRefresh={onRefresh}
          storyData={resetStory}
          activeScenarioId="sc-1"
          isZh={false}
          isReplayMode={false}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('surfaces an interrupted stream without refreshing and keeps polling story authority', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const polledReport = makeReport({
      status: 'generating',
      sections: [
        ...makeReport().sections,
        {
          id: 's3',
          title: 'Three',
          title_i18n: { zh: '三', en: 'Three' },
          intent: '',
          body_md_i18n: { zh: '', en: 'b' },
          evidence_refs: [],
          charts: [],
        },
      ],
    });
    setCtx({ full_report: makeReport({ status: 'partial', sections: [] }) });
    setCap({});
    mockedGenerateReport.mockResolvedValue(responseFromSse(
      'event: report_started\ndata: {"status":"generating","tool_trace":[]}\n\n',
    ));
    mockedGetStory.mockResolvedValue({
      full_report: polledReport,
    } as Awaited<ReturnType<typeof getStory>>);

    render(<ResultReportPanel variant="standalone" onRefresh={onRefresh} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/stream interrupted/i)).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(mockedGetStory).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('report-section-s3')).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('publishes each generating poll and refreshes exactly once after persisted terminal state', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    const reportWithThreeSections = makeReport({
      status: 'generating',
      sections: [
        ...makeReport().sections,
        {
          id: 's3',
          title: 'Three',
          title_i18n: { zh: '三', en: 'Three' },
          intent: '',
          body_md_i18n: { zh: '', en: 'b' },
          evidence_refs: [],
          charts: [],
        },
      ],
    });
    setCtx({ full_report: makeReport({ status: 'generating' }) });
    setCap({});
    mockedGetStory
      .mockResolvedValueOnce({ full_report: reportWithThreeSections } as Awaited<ReturnType<typeof getStory>>)
      .mockResolvedValueOnce({
        full_report: makeReport({ status: 'complete', sections: reportWithThreeSections.sections }),
      } as Awaited<ReturnType<typeof getStory>>);

    render(<ResultReportPanel variant="standalone" onRefresh={onRefresh} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('report-section-s3')).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mockedGetStory).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockedGetStory).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it.each([
    ['failed', /report generation failed/i],
    ['cancelled', /report generation cancelled/i],
    ['skipped', /report generation skipped/i],
    ['partial', /partially generated/i],
  ] as const)(
    'waits for story authority before applying a stream terminal status of %s',
    async (status, title) => {
      const onRefresh = vi.fn();
      let resolveAuthority!: (story: Awaited<ReturnType<typeof getStory>>) => void;
      mockedGetStory.mockImplementationOnce(() => new Promise((resolve) => {
        resolveAuthority = resolve;
      }));
      mockedGenerateReport.mockResolvedValue(responseFromSse(
        `event: report_complete\ndata: {"status":"${status}","tool_trace":[]}\n\n`,
      ));
      setCtx({ full_report: makeReport({ status: 'partial' }) });
      setCap({});

      render(<ResultReportPanel variant="standalone" onRefresh={onRefresh} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Retry Generation/i }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockedGetStory).toHaveBeenCalledOnce();
      expect(onRefresh).not.toHaveBeenCalled();

      await act(async () => {
        resolveAuthority({
          full_report: makeReport({
            generated_at: '2026-07-11T00:01:00Z',
            status,
          }),
        } as Awaited<ReturnType<typeof getStory>>);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(screen.getByText(title)).toBeInTheDocument();
      expect(onRefresh).toHaveBeenCalledOnce();
      expect(screen.queryByText(/Key takeaways/i)).toBeNull();
    },
  );

  it.each(['partial', 'failed', 'cancelled', 'skipped'] as const)(
    'does not poll a persisted legacy %s report',
    async (status) => {
      vi.useFakeTimers();
      setCtx({ full_report: makeReport({ status }) });
      setCap({});

      render(<ResultReportPanel variant="standalone" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(mockedGetStory).not.toHaveBeenCalled();
    },
  );

  it('does not poll a truncated legacy marker', async () => {
    vi.useFakeTimers();
    setCtx({ full_report: { status: 'partial', truncated: true } });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(mockedGetStory).not.toHaveBeenCalled();
  });

  it('shows a retryable stalled state when generating authority polling exceeds its deadline', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-07-11T00:00:00Z');
    vi.setSystemTime(startedAt);
    setCtx({ full_report: makeReport({ status: 'generating' }) });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);
    vi.setSystemTime(new Date(startedAt.getTime() + 35 * 60_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.getByText(/status check stalled/i)).toBeInTheDocument();
    expect(screen.getByTestId('report-section-s1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry Generation/i })).toBeInTheDocument();
  });
});

describe('ResultReportPanel — partial report rendering', () => {
  it('renders the full report + a non-blocking retry banner when partial WITH sections', () => {
    setCtx({ full_report: makeReport({ status: 'partial' }) });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);

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

  it('preserves a failed report document and shows a failure banner when sections exist', () => {
    setCtx({ full_report: makeReport({ status: 'failed' }) });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByTestId('report-section-s1')).toBeInTheDocument();
    expect(screen.getByText(/report generation failed/i)).toBeInTheDocument();
  });

  it('preserves a generating report document and shows progress when sections exist', () => {
    setCtx({ full_report: makeReport({ status: 'generating' }) });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByTestId('report-section-s1')).toBeInTheDocument();
    expect(screen.getByText(/report generation in progress/i)).toBeInTheDocument();
  });

  it('uses the full generating state only when no sections exist', () => {
    setCtx({ full_report: makeReport({ status: 'generating', sections: [] }) });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText('Building your report')).toBeInTheDocument();
    expect(screen.queryByTestId('report-confidence-badge')).toBeNull();
  });

  it('preserves a cancelled report document and shows a cancellation banner when sections exist', () => {
    setCtx({ full_report: makeReport({ status: 'cancelled' }) });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByTestId('report-section-s1')).toBeInTheDocument();
    expect(screen.getByText(/report generation cancelled/i)).toBeInTheDocument();
  });

  it.each([
    ['failed', /report generation failed/i],
    ['cancelled', /report generation cancelled/i],
    ['skipped', /report generation skipped/i],
  ] as const)('shows an explicit %s card when no sections exist', (status, title) => {
    setCtx({ full_report: makeReport({ status, sections: [] }) });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.queryByTestId('report-section-s1')).toBeNull();
  });

  it('does not show a live report generation CTA for replay payloads without full_report', () => {
    setCtx({ full_report: null });
    setCap({});

    const { container } = render(<ResultReportPanel variant="inline" isReplayMode />);

    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('button', { name: /Generate Report/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /Read full report/i })).toBeNull();
  });

  it('renders a complete report with no retry banner', () => {
    setCtx({ full_report: makeReport({ status: 'complete' }) });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByTestId('report-section-s1')).toBeInTheDocument();
    expect(screen.queryByText(/partially generated/i)).toBeNull();
  });

  it('omits the report masthead for the inline embed but keeps it standalone', () => {
    // Inline (/result/:id) already shows the page header + verdict card, so the
    // panel masthead would duplicate it — it must be suppressed for inline only.
    setCtx({ full_report: makeReport({ status: 'complete' }) });
    setCap({});
    const { container, unmount } = render(<ResultReportPanel variant="inline" />);
    expect(container.querySelector('.report-masthead')).toBeNull();
    unmount();

    setCtx({ full_report: makeReport({ status: 'complete' }) });
    setCap({});
    const { container: standaloneContainer } = render(<ResultReportPanel variant="standalone" />);
    expect(standaloneContainer.querySelector('.report-masthead')).not.toBeNull();
  });
});

describe('ResultReportPanel — structured premortem analysis', () => {
  it('renders available failure modes and opens the existing evidence drawer', async () => {
    setCtx({ full_report: makePremortemReport(availablePremortem) });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByRole('heading', { name: 'Premortem analysis' })).toBeInTheDocument();
    expect(screen.getByText('Supply chain stalls')).toBeInTheDocument();
    expect(screen.getByText('Buffer inventory is exhausted')).toBeInTheDocument();
    expect(screen.getByText('Inventory falls below two weeks')).toBeInTheDocument();
    expect(screen.getByText('Replacement timing remains uncertain')).toBeInTheDocument();
    expect(screen.getByText('Inventory provides the early signal')).toBeInTheDocument();
    expect(screen.getByText(/simulation evidence does not establish statistical independence/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /ev-1/i }));

    expect(await screen.findByRole('dialog', { name: /cited evidence/i })).toBeInTheDocument();
    expect(screen.getByText(/Inventories fell below the operating buffer\./)).toBeInTheDocument();
  });

  it('renders partial status, its reason, and item uncertainty without overstating evidence', () => {
    setCtx({
      full_report: makePremortemReport({
        ...availablePremortem,
        status: 'partial',
        reason: 'insufficient_source_diversity',
      }),
    });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText('Partial analysis')).toBeInTheDocument();
    expect(screen.getByText(/source diversity was insufficient/i)).toBeInTheDocument();
    expect(screen.getByText('Replacement timing remains uncertain')).toBeInTheDocument();
    expect(screen.queryByText(/independent sources/i)).toBeNull();
  });

  it('renders the honest localized reason when structured premortem is missing', () => {
    setCtx({
      full_report: makePremortemReport({
        status: 'missing',
        reason: 'lineage_unavailable',
        items: [],
      }),
    });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText('Analysis unavailable')).toBeInTheDocument();
    expect(screen.getByText(/branch lineage evidence was unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no risks/i)).toBeNull();
  });

  it.each([null, undefined])(
    'treats legacy premortem_analysis=%s as unavailable rather than risk-free',
    (analysis) => {
      const report = analysis === undefined ? makeReport() : makePremortemReport(analysis);
      setCtx({ full_report: report });
      setCap({});

      render(<ResultReportPanel variant="standalone" />);

      expect(screen.getByRole('heading', { name: 'Premortem analysis' })).toBeInTheDocument();
      expect(screen.getByText(/not available for this legacy or unimplemented report/i)).toBeInTheDocument();
      expect(screen.queryByText(/no risks/i)).toBeNull();
    },
  );

  it('uses the report language for failure-mode fields', () => {
    setCtx({ full_report: makePremortemReport(availablePremortem) });
    setCap({});

    render(<ResultReportPanel variant="standalone" isZh />);

    expect(screen.getByText('供应链停摆')).toBeInTheDocument();
    expect(screen.getByText('缓冲库存耗尽')).toBeInTheDocument();
    expect(screen.getByText('库存跌破两周')).toBeInTheDocument();
    expect(screen.getByText('替代产能到位时间未知')).toBeInTheDocument();
    expect(screen.queryByText('Supply chain stalls')).toBeNull();
  });

  it('does not render the detailed premortem block in inline mode', () => {
    setCtx({ full_report: makePremortemReport(availablePremortem) });
    setCap({});

    render(<ResultReportPanel variant="inline" />);

    expect(screen.queryByRole('heading', { name: 'Premortem analysis' })).toBeNull();
    expect(screen.queryByText('Supply chain stalls')).toBeNull();
  });

  it('fails safe for malformed runtime payloads without exposing raw values', () => {
    setCtx({
      full_report: makePremortemReport({
        status: 'available',
        reason: null,
        items: 'TOP-SECRET-RAW-JSON',
      }),
    });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText(/structured premortem could not be displayed/i)).toBeInTheDocument();
    expect(screen.queryByText('TOP-SECRET-RAW-JSON')).toBeNull();
  });

  it.each([
    [
      'analysis',
      'RAW-ANALYSIS-EXTRA',
      { ...availablePremortem, unexpected: 'RAW-ANALYSIS-EXTRA' },
    ],
    [
      'failure mode',
      'RAW-ITEM-EXTRA',
      {
        ...availablePremortem,
        items: [{ ...availablePremortem.items[0], unexpected: 'RAW-ITEM-EXTRA' }],
      },
    ],
    [
      'evidence link',
      'RAW-LINK-EXTRA',
      {
        ...availablePremortem,
        items: [{
          ...availablePremortem.items[0],
          evidence_chain: [
            {
              ...availablePremortem.items[0].evidence_chain[0],
              unexpected: 'RAW-LINK-EXTRA',
            },
            availablePremortem.items[0].evidence_chain[1],
          ],
        }],
      },
    ],
    [
      'localized text',
      'RAW-I18N-EXTRA',
      {
        ...availablePremortem,
        items: [{
          ...availablePremortem.items[0],
          failure_mode_i18n: {
            ...availablePremortem.items[0].failure_mode_i18n,
            fr: 'RAW-I18N-EXTRA',
          },
        }],
      },
    ],
  ] as const)('rejects extra keys at the %s level without exposing them', (_level, marker, payload) => {
    setCtx({ full_report: makePremortemReport(payload) });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText(/structured premortem could not be displayed/i)).toBeInTheDocument();
    expect(screen.queryByText(marker)).toBeNull();
    expect(screen.queryByText('Supply chain stalls')).toBeNull();
    expect(screen.queryByText('Available')).toBeNull();
  });

  it('downgrades available analysis to missing when every evidence link is dangling', () => {
    const availableWithOnlyDanglingEvidence = {
      ...availablePremortem,
      items: [
        {
          ...availablePremortem.items[0],
          evidence_chain: availablePremortem.items[0].evidence_chain.map((link, index) => ({
            ...link,
            evidence_ref: `ev-missing-${index + 1}`,
          })),
        },
      ],
    };
    setCtx({ full_report: makePremortemReport(availableWithOnlyDanglingEvidence) });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText('Analysis unavailable')).toBeInTheDocument();
    expect(screen.getByText(/branch lineage evidence was unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('Available')).toBeNull();
    expect(screen.queryByText('Supply chain stalls')).toBeNull();
    expect(screen.queryByRole('button', { name: /ev-missing/i })).toBeNull();
  });

  it('downgrades available analysis when a valid item survives but another item is all dangling', async () => {
    const mixedAnalysis = {
      ...availablePremortem,
      items: [
        availablePremortem.items[0],
        {
          ...availablePremortem.items[0],
          id: 'pm_002',
          failure_mode_i18n: { zh: 'RAW-DANGLING-ITEM', en: 'RAW-DANGLING-ITEM' },
          evidence_chain: availablePremortem.items[0].evidence_chain.map((link, index) => ({
            ...link,
            evidence_ref: `ev-missing-${index + 1}`,
          })),
        },
      ],
    };
    setCtx({ full_report: makePremortemReport(mixedAnalysis) });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText('Partial analysis')).toBeInTheDocument();
    expect(screen.getByText(/source diversity was insufficient/i)).toBeInTheDocument();
    expect(screen.queryByText('Available')).toBeNull();
    expect(screen.getByText('Supply chain stalls')).toBeInTheDocument();
    expect(screen.queryByText('RAW-DANGLING-ITEM')).toBeNull();
    expect(screen.queryByRole('button', { name: /ev-missing/i })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Open evidence ev-/i })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /ev-1/i }));
    expect(await screen.findByRole('dialog', { name: /cited evidence/i })).toBeInTheDocument();
    expect(screen.getByText(/Inventories fell below the operating buffer\./)).toBeInTheDocument();
  });

  it('fails safe before filtering when an all-dangling item duplicates a valid item id', () => {
    const duplicateItemAnalysis = {
      ...availablePremortem,
      items: [
        availablePremortem.items[0],
        {
          ...availablePremortem.items[0],
          failure_mode_i18n: { zh: 'RAW-DUPLICATE-ITEM', en: 'RAW-DUPLICATE-ITEM' },
          evidence_chain: availablePremortem.items[0].evidence_chain.map((link, index) => ({
            ...link,
            evidence_ref: `ev-missing-${index + 1}`,
          })),
        },
      ],
    };
    setCtx({ full_report: makePremortemReport(duplicateItemAnalysis) });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText(/structured premortem could not be displayed/i)).toBeInTheDocument();
    expect(screen.queryByText('Available')).toBeNull();
    expect(screen.queryByText('Supply chain stalls')).toBeNull();
    expect(screen.queryByText('RAW-DUPLICATE-ITEM')).toBeNull();
    expect(screen.queryByRole('button', { name: /ev-missing/i })).toBeNull();
  });

  it('filters dangling links from partial analysis while keeping valid evidence clickable', async () => {
    const partialWithMixedEvidence = {
      ...availablePremortem,
      status: 'partial',
      reason: 'no_distinct_evidence',
      items: [
        {
          ...availablePremortem.items[0],
          evidence_chain: [
            availablePremortem.items[0].evidence_chain[0],
            {
              evidence_ref: 'ev-missing',
              role: 'failure_signal',
              rationale_i18n: { zh: '引用已丢失', en: 'The cited signal is missing' },
            },
          ],
        },
      ],
    };
    setCtx({ full_report: makePremortemReport(partialWithMixedEvidence) });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText('Partial analysis')).toBeInTheDocument();
    expect(screen.getByText('Inventory provides the early signal')).toBeInTheDocument();
    expect(screen.queryByText('The cited signal is missing')).toBeNull();
    expect(screen.queryByText(/ev-missing/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /ev-missing/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /ev-1/i }));
    expect(await screen.findByRole('dialog', { name: /cited evidence/i })).toBeInTheDocument();
    expect(screen.getByText(/Inventories fell below the operating buffer\./)).toBeInTheDocument();
  });

  it.each([
    [
      'duplicate top-level evidence ids',
      [
        premortemEvidence[0],
        {
          ...premortemEvidence[0],
          branch_id: 'duplicate-branch',
          round_id: 'duplicate-round',
          agent_id: 'duplicate-agent',
          message_id: 'duplicate-message',
          quote: 'A conflicting duplicate evidence record.',
        },
        premortemEvidence[1],
      ],
    ],
    [
      'two evidence ids with the same source coordinate',
      [
        premortemEvidence[0],
        {
          ...premortemEvidence[0],
          id: 'ev-2',
          quote: 'The same source coordinate under another evidence id.',
          kind: 'causal_fact' as const,
        },
      ],
    ],
  ] as const)('downgrades available analysis for %s', (_label, evidence) => {
    setCtx({
      full_report: makePremortemReport(
        availablePremortem,
        [...evidence] as FullReport['evidence'],
      ),
    });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText('Partial analysis')).toBeInTheDocument();
    expect(screen.getByText(/source diversity was insufficient/i)).toBeInTheDocument();
    expect(screen.queryByText('Available')).toBeNull();
    expect(screen.getByText('Replacement timing remains uncertain')).toBeInTheDocument();
  });

  it('keeps available status when evidence has distinct coordinates and agent diversity', () => {
    const validEvidence = [
      premortemEvidence[0],
      {
        ...premortemEvidence[1],
        branch_id: premortemEvidence[0].branch_id,
      },
    ];
    setCtx({ full_report: makePremortemReport(availablePremortem, validEvidence) });
    setCap({});

    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.queryByText('Partial analysis')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Open evidence ev-/i })).toHaveLength(2);
  });
});

describe('ResultReportPanel — interview evidence rendering', () => {
  it('renders interview cards with coordinate badges and excerpts when evidence is present', () => {
    const report = makeReport({
      status: 'complete',
      interview_evidence: [
        {
          branch_index: 2,
          round: 4,
          agent_name: 'Privacy Advocate',
          excerpt: 'Privacy safeguards are essential.',
        },
      ],
    });
    setCtx({ full_report: report });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText('Model-synthesized simulation history excerpts')).toBeInTheDocument();
    expect(screen.getByText(/Not verbatim source evidence or real persons' words/)).toBeInTheDocument();
    expect(screen.getByText('Privacy Advocate')).toBeInTheDocument();
    expect(screen.getByText('Branch 2 · Round 4')).toBeInTheDocument();
    expect(screen.getByText('Privacy safeguards are essential.')).toBeInTheDocument();
  });

  it('renders nothing for interviews block when interview_evidence is empty', () => {
    const report = makeReport({
      status: 'complete',
      interview_evidence: [],
    });
    setCtx({ full_report: report });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);
    expect(screen.queryByText('Model-synthesized simulation history excerpts')).toBeNull();
  });

  it('renders nothing for interviews block when interview_evidence is missing entirely', () => {
    const report = makeReport({});
    delete (report as Partial<FullReport>).interview_evidence;
    setCtx({ full_report: report });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);
    expect(screen.queryByText('Model-synthesized simulation history excerpts')).toBeNull();
  });

  it('renders failed interview status message', () => {
    const report = makeReport({
      status: 'complete',
      interview_status: {
        status: 'failed',
        requested_agents: 3,
        completed_agents: 0,
        truncated_agents: 0,
        error_code: 'INTERVIEW_LLM_FAILED',
        message: 'LLM failed to respond.',
      },
      interview_evidence: [],
    });
    setCtx({ full_report: report });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);

    expect(screen.getByText('Model-synthesized simulation history excerpts')).toBeInTheDocument();
    expect(screen.getByText(/Interview generation failed: LLM failed to respond. \(error code: INTERVIEW_LLM_FAILED\)/i)).toBeInTheDocument();
  });

  it('renders skipped interview status message', () => {
    const report = makeReport({
      status: 'complete',
      interview_status: {
        status: 'skipped',
        requested_agents: 2,
        completed_agents: 0,
        truncated_agents: 0,
        error_code: null,
        message: 'No agents matching criteria.',
      },
      interview_evidence: [],
    });
    setCtx({ full_report: report });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);
    expect(screen.getByText(/Interview generation skipped: No agents matching criteria./i)).toBeInTheDocument();
  });

  it('renders partial interview status message', () => {
    const report = makeReport({
      status: 'complete',
      interview_status: {
        status: 'partial',
        requested_agents: 4,
        completed_agents: 2,
        truncated_agents: 1,
        error_code: null,
        message: 'Completed with truncation.',
      },
      interview_evidence: [],
    });
    setCtx({ full_report: report });
    setCap({});
    render(<ResultReportPanel variant="standalone" />);
    expect(screen.getByText(/Interview partially complete \(completed 2 out of 4, 1 truncated\): Completed with truncation./i)).toBeInTheDocument();
  });

  describe('ResultReportPanel — Teaser + Digest Redesign', () => {
    it('renders CTA and no ReportSection when variant is inline and report is complete, rendering takeaways if headline_answer is present', () => {
      const report = makeReport({
        status: 'complete',
        verdict: {
          headline_answer: 'My specific headline takeaway',
          likelihood: { probability: 1.0, interval: [1.0, 1.0], wep: 'Almost Certain' },
          analytic_confidence: { level: 'high', basis: 'basis' },
          disclaimer: null
        }
      });
      setCtx({ full_report: report });
      setCap({});

      render(<ResultReportPanel variant="inline" />);

      // CTA check
      expect(screen.getByRole('link', { name: /Read full report/i })).toBeInTheDocument();
      expect(screen.getByText(/Want the full reasoning?/i)).toBeInTheDocument();

      // No ReportSection check
      expect(screen.queryByTestId('report-section-s1')).toBeNull();
      expect(screen.queryByTestId('report-section-s2')).toBeNull();

      // Takeaway check
      expect(screen.getByText('My specific headline takeaway')).toBeInTheDocument();
    });

    it('renders no takeaways block when all takeaways fields are empty', () => {
      const report = makeReport({
        status: 'complete',
        verdict: {
          headline_answer: '',
          likelihood: { probability: 1.0, interval: [1.0, 1.0], wep: 'Almost Certain' },
          analytic_confidence: { level: 'high', basis: 'basis' },
          disclaimer: null
        },
        summary_i18n: { zh: '', en: '' },
        follow_ups: [],
        indicators_to_watch: []
      });
      setCtx({ full_report: report });
      setCap({});

      render(<ResultReportPanel variant="inline" />);

      // Key takeaways title should not be rendered
      expect(screen.queryByText(/Key takeaways/i)).toBeNull();
    });

    it('calls navigate to full report path when CTA button is clicked', () => {
      const report = makeReport({ status: 'complete' });
      setCtx({ full_report: report });
      setCap({});

      render(<ResultReportPanel variant="inline" />);

      const link = screen.getByRole('link', { name: /Read full report/i });
      expect(link).toHaveAttribute('href', '/result/sc-1/report');
    });

    it('handles decimal numbers without splitting them in takeaways', () => {
      const report = makeReport({
        status: 'complete',
        verdict: {
          headline_answer: 'Headline',
          likelihood: { probability: 1.0, interval: [1.0, 1.0], wep: 'Almost Certain' },
          analytic_confidence: { level: 'high', basis: 'basis' },
          disclaimer: null
        },
        summary_i18n: {
          en: 'The value increased by 3.5. This is 0.65 higher than before.',
          zh: '数值增长了 3.5。这比以前高出 0.65。'
        }
      });
      setCtx({ full_report: report });
      setCap({});

      render(<ResultReportPanel variant="inline" />);

      expect(screen.getByText('The value increased by 3.5.')).toBeInTheDocument();
      expect(screen.getByText('This is 0.65 higher than before.')).toBeInTheDocument();
    });

    it('does not split U.S. abbreviations when deriving summary takeaways', () => {
      const report = makeReport({
        status: 'complete',
        verdict: {
          headline_answer: '',
          likelihood: { probability: 1.0, interval: [1.0, 1.0], wep: 'Almost Certain' },
          analytic_confidence: { level: 'high', basis: 'basis' },
          disclaimer: null
        },
        summary_i18n: {
          en: 'U.S. policy changed. The value increased by 3.5.',
          zh: ''
        },
        follow_ups: [],
        indicators_to_watch: []
      });
      setCtx({ full_report: report });
      setCap({});

      render(<ResultReportPanel variant="inline" />);

      expect(screen.getByText('U.S. policy changed.')).toBeInTheDocument();
      expect(screen.queryByText('U.S.')).toBeNull();
    });

    it('filters whitespace-only digest sources before rendering bullets', () => {
      const report = makeReport({
        status: 'complete',
        verdict: {
          headline_answer: '   ',
          likelihood: { probability: 1.0, interval: [1.0, 1.0], wep: 'Almost Certain' },
          analytic_confidence: { level: 'high', basis: 'basis' },
          disclaimer: null
        },
        summary_i18n: { zh: '  ', en: '  ' },
        follow_ups: ['  ', 'Follow this real signal.'],
        indicators_to_watch: [
          { signal: '   ', direction: 'up', time_horizon: '', threshold: '', note: '' },
          { signal: 'Watch this real indicator.', direction: 'down', time_horizon: '', threshold: '', note: '' }
        ]
      });
      setCtx({ full_report: report });
      setCap({});

      const { container } = render(<ResultReportPanel variant="inline" />);

      const bullets = Array.from(container.querySelectorAll('.report-digest__item')).map((node) => node.textContent);
      expect(bullets).toEqual(['Follow this real signal.', 'Watch this real indicator.']);
    });

    it('renders inline partial report showing retry banner and no digest takeaways', () => {
      const report = makeReport({ status: 'partial' });
      setCtx({ full_report: report });
      setCap({});

      const { container } = render(<ResultReportPanel variant="inline" />);

      expect(screen.getByText(/partially generated/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Retry Generation/i })).toBeInTheDocument();
      expect(screen.queryByText(/Key takeaways/i)).toBeNull();
      expect(container.querySelector('.report-digest')).toBeNull();
    });
  });
});
