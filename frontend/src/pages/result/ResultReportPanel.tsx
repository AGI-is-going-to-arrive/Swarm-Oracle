import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import { useResultContext } from './ResultContext';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import { generateReport, getStory } from '../../api/client';
import { ReportConfidenceBadge } from './ReportConfidenceBadge';
import { ReportToc } from './ReportToc';
import { ReportSection } from './ReportSection';
import { ReportEvidenceDrawer } from './ReportEvidenceDrawer';
import { loadLlmProviderPolicy, validateByok } from '../../lib/llmProviderPolicy';
import { getLocalizedApiErrorMessage } from '../../lib/apiErrorMessage';
import type { FullReport, FullReportTruncatedMarker, ReportEvidence, StoryData, ToolTraceSummary, InterviewEvidenceEntry } from '../../types';
// The .report-doc editorial skin lives in ResultReportView.css. Import it here (not only in
// the standalone /report page) so the inline embed on /result/:id is fully styled too —
// otherwise the panel renders unskinned (+ zeroed padding) on a direct /result/:id load.
import '../ResultReportView.css';

interface Props {
  /** `inline` is rendered inside ResultView (page already has an <h1>); `standalone`
   *  is the /result/:id/report route (ResultReportView supplies the page <h1>). */
  variant?: 'inline' | 'standalone';
  /** Optional refresh callback (standalone re-fetches story); falls back to a full reload. */
  onRefresh?: () => void;
  storyData?: StoryData | null;
  activeScenarioId?: string | null;
  isZh?: boolean;
  isReplayMode?: boolean;
}

function isTruncatedReportMarker(
  report: FullReport | FullReportTruncatedMarker | null | undefined,
): report is FullReportTruncatedMarker {
  return Boolean(report && 'truncated' in report && report.truncated === true);
}

function isFullReport(
  report: FullReport | FullReportTruncatedMarker | null | undefined,
): report is FullReport {
  return Boolean(report && 'verdict' in report && report.verdict);
}

function splitSentencesDecimalSafe(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  const len = text.length;

  const isAsciiLetter = (char: string | undefined) => Boolean(char && /[A-Za-z]/.test(char));
  const isAbbreviationPeriod = (index: number) => {
    const prev = text[index - 1];
    const prevPrev = text[index - 2];
    return isAsciiLetter(prev) && prevPrev === '.';
  };

  for (let i = 0; i < len; i++) {
    const char = text[i];

    // CJK termination characters: 。 ！？
    if (char === '。' || char === '！' || char === '？') {
      const sentence = text.slice(start, i + 1).trim();
      if (sentence) {
        sentences.push(sentence);
      }
      start = i + 1;
      continue;
    }

    // Latin punctuation: . ! ?
    if (char === '.' || char === '!' || char === '?') {
      const isDigitPrev = i > 0 && text[i - 1] >= '0' && text[i - 1] <= '9';
      const isDigitNext = i < len - 1 && text[i + 1] >= '0' && text[i + 1] <= '9';
      const isDecimal = isDigitPrev && isDigitNext;

      if (!isDecimal && !isAbbreviationPeriod(i)) {
        const isFollowedByWhitespaceOrEnd =
          i === len - 1 ||
          /\s/.test(text[i + 1]);

        if (isFollowedByWhitespaceOrEnd) {
          const sentence = text.slice(start, i + 1).trim();
          if (sentence) {
            sentences.push(sentence);
          }
          start = i + 1;
        }
      }
    }
  }

  if (start < len) {
    const sentence = text.slice(start).trim();
    if (sentence) {
      sentences.push(sentence);
    }
  }

  return sentences;
}

function deriveTakeaways(report: FullReport, lang: 'zh' | 'en'): string[] {
  const items: string[] = [];

  // 1. verdict.headline_answer
  const headline = report.verdict?.headline_answer?.trim() ?? '';
  if (headline) {
    items.push(headline);
  }

  // 2. summary_i18n[lang] 首 1-2 句(按小数安全切句)
  const summaryText = (
    report.summary_i18n?.[lang] ||
    report.summary_i18n?.en ||
    report.summary_i18n?.zh ||
    ''
  ).trim();
  if (summaryText) {
    const sentences = splitSentencesDecimalSafe(summaryText);
    const summarySentences = sentences.slice(0, 2);
    for (const sent of summarySentences) {
      items.push(sent);
    }
  }

  // 3. follow_ups[] 取 1-2
  const followUps = report.follow_ups || [];
  for (const fu of followUps.slice(0, 2)) {
    const trimmed = fu?.trim() ?? '';
    if (trimmed) {
      items.push(trimmed);
    }
  }

  // 4. indicators_to_watch[].signal 取 1-2
  const indicators = report.indicators_to_watch || [];
  for (const ind of indicators.slice(0, 2)) {
    const signal = ind?.signal?.trim() ?? '';
    if (signal) {
      items.push(signal);
    }
  }

  // 去重且最多3条
  const uniqueItems: string[] = [];
  for (const item of items) {
    if (!uniqueItems.includes(item)) {
      uniqueItems.push(item);
    }
  }

  return uniqueItems.slice(0, 3);
}

const ALLOWED_SECTION_IDS = ['timeline', 'factions', 'conflicts', 'premortem', 'indicators', 'sources'];
const REPORT_GENERATE_TIMEOUT_MS = 35 * 60_000;

async function drainReportStreamAndDetectAlreadyRunning(
  res: Response,
  signal: AbortSignal,
  onToolTraceUpdate?: (trace: ToolTraceSummary[]) => void
): Promise<boolean> {
  const reader = res.body?.getReader();
  if (!reader) return false;

  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };

  if (signal.aborted) {
    cancelReader();
    throw new DOMException('Report generation aborted', 'AbortError');
  }

  let isAlreadyRunning = false;
  const decoder = new TextDecoder();
  let buffer = '';

  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const dataLines: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.length === 0 || line.startsWith(':')) continue;
          const separatorIndex = line.indexOf(':');
          const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
          let val = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
          if (val.startsWith(' ')) val = val.slice(1);
          if (field === 'data') dataLines.push(val);
        }
        const dataText = dataLines.join('\n');
        if (dataText) {
          try {
            const data = JSON.parse(dataText);
            if (data && data.error_code === 'REPORT_ALREADY_RUNNING') {
              isAlreadyRunning = true;
            }
            if (data && Array.isArray(data.tool_trace) && data.tool_trace.length > 0) {
              onToolTraceUpdate?.(data.tool_trace);
            }
          } catch {
            // ignore
          }
        }
      }
    }
    if (signal.aborted) {
      throw new DOMException('Report generation aborted', 'AbortError');
    }
  } finally {
    signal.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }

  return isAlreadyRunning;
}

interface ToolTraceChipProps {
  trace: ToolTraceSummary[];
}

export const ToolTraceChip = React.memo(function ToolTraceChip({ trace }: ToolTraceChipProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const regionId = 'report-tool-trace-details';

  if (!trace || trace.length === 0) {
    return null;
  }

  return (
    <div className="report-tool-trace">
      <button
        type="button"
        id="report-tool-trace-trigger"
        aria-expanded={expanded}
        aria-controls={expanded ? regionId : undefined}
        aria-label={expanded ? t('result.report.toolTraceCollapse') : t('result.report.toolTraceExpand')}
        onClick={() => setExpanded(!expanded)}
        className="report-tool-trace__trigger"
      >
        <span>🛠️ {t('result.report.toolTraceLabel', { count: trace.length })}</span>
        <svg
          className={`report-tool-trace__chevron${expanded ? ' is-open' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="3"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div
          id={regionId}
          className="report-tool-trace__details"
          role="region"
          aria-labelledby="report-tool-trace-trigger"
        >
          <ul className="report-tool-trace__list">
            {trace.map((item, index) => (
              <li key={index} className="report-tool-trace__item">
                <div className="report-tool-trace__row">
                  <span className="report-tool-trace__tool">{item.tool}</span>
                  <span className="report-tool-trace__elapsed">
                    {t('result.report.toolTraceElapsed', { ms: item.elapsed_ms })}
                  </span>
                </div>
                <div className="report-tool-trace__row report-tool-trace__row--meta">
                  <span className="report-tool-trace__query" title={item.query || undefined}>
                    {item.query ? item.query : t('result.report.toolTraceEmptyQuery')}
                  </span>
                  <span className="report-tool-trace__count">
                    {t('result.report.toolTraceItemCount', { count: item.item_count })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});

// Inner component memoized to narrow context subscription.
// Re-renders ONLY when these specific props change.
const ResultReportPanelInner = React.memo(function ResultReportPanelInner({
  variant = 'inline',
  onRefresh,
  storyData,
  activeScenarioId,
  isZh,
  isReplayMode,
}: Props & { isZh: boolean; isReplayMode: boolean }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const {
    capabilities,
    loading: capLoading,
    error: capError,
    reload,
  } = useCapabilityCheck('result_report');

  const [evidenceDrawerOpen, setEvidenceDrawerOpen] = useState(false);
  const [currentEvidence, setCurrentEvidence] = useState<ReportEvidence[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | boolean>(false);

  const [localStoryData, setLocalStoryData] = useState<StoryData | null>(null);
  const [localGenerating, setLocalGenerating] = useState(false);
  const [toolTrace, setToolTrace] = useState<ToolTraceSummary[]>([]);

  const activeStoryData = localStoryData || storyData;
  const rawReport = activeStoryData?.full_report;
  const isTruncatedReport = isTruncatedReportMarker(rawReport);
  const report = isFullReport(rawReport) ? rawReport : null;
  const isEnabled = capabilities?.result_report?.enabled ?? false;

  const isGenerating = report?.status === 'generating' || localGenerating;

  // Reset local overrides when props change
  useEffect(() => {
    setLocalStoryData(null);
    setLocalGenerating(false);
    setRetryError(false);
  }, [storyData]);

  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Poll effect when generating
  useEffect(() => {
    if (!isGenerating || !activeScenarioId || isReplayMode) return;

    let timerId: number | undefined;
    const startTime = Date.now();
    const maxPollTime = 35 * 60 * 1000; // 35 minutes

    const poll = async () => {
      if (Date.now() - startTime >= maxPollTime) {
        if (isMountedRef.current) {
          setLocalGenerating(false);
        }
        return;
      }
      try {
        const updatedStory = await getStory(activeScenarioId);
        if (!isMountedRef.current) return;
        const newReport = updatedStory?.full_report;
        if (newReport && newReport.status !== 'generating') {
          setLocalStoryData(updatedStory);
          setLocalGenerating(false);
          setRetryError(false);
          if (onRefresh) {
            onRefresh();
          }
        } else {
          timerId = window.setTimeout(poll, 15000);
        }
      } catch (err) {
        console.error('Error polling report status', err);
        if (isMountedRef.current) {
          timerId = window.setTimeout(poll, 15000);
        }
      }
    };

    timerId = window.setTimeout(poll, 15000);

    return () => {
      if (timerId) {
        clearTimeout(timerId);
      }
    };
  }, [isGenerating, activeScenarioId, isReplayMode, onRefresh]);

  const takeaways = useMemo(() => {
    if (!report) return [];
    const rawLang = i18n.language || 'en';
    const lang = rawLang.startsWith('zh') ? 'zh' : 'en';
    return deriveTakeaways(report, lang);
  }, [report, i18n.language]);

  const sections = useMemo(() => report?.sections || [], [report]);
  const evidenceDict = useMemo(() => {
    const map = new Map<string, ReportEvidence>();
    if (report?.evidence) {
      for (const ev of report.evidence) map.set(ev.id, ev);
    }
    return map;
  }, [report]);

  const interviewStatus = report?.interview_status;
  const interviewEvidence = useMemo(() => report?.interview_evidence || [], [report]);
  const hasInterviews = useMemo(() => {
    return (interviewEvidence.length > 0) || Boolean(interviewStatus && interviewStatus.status !== 'complete');
  }, [interviewEvidence, interviewStatus]);

  const handleOpenEvidence = useCallback(
    (refs: string[]) => {
      const evs = refs
        .map((ref) => evidenceDict.get(ref))
        .filter((ev): ev is ReportEvidence => ev !== undefined);
      setCurrentEvidence(evs);
      setEvidenceDrawerOpen(true);
    },
    [evidenceDict],
  );

  const handleCloseEvidence = useCallback(() => setEvidenceDrawerOpen(false), []);

  const handleRetry = useCallback(async () => {
    if (isReplayMode) return;
    if (!activeScenarioId || retrying) return;

    const providerPolicy = loadLlmProviderPolicy();
    const validation = validateByok({
      apiKey: providerPolicy.apiKey,
      baseUrl: providerPolicy.baseUrl,
    });
    if (!validation.valid) {
      setRetryError(
        getLocalizedApiErrorMessage(
          { code: validation.errorCode },
          t,
          t('conversation.error.byok_invalid'),
        ),
      );
      return;
    }

    setRetrying(true);
    setRetryError(false);
    setToolTrace([]);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const timeoutId = setTimeout(() => controller.abort(), REPORT_GENERATE_TIMEOUT_MS);

    // Show the honest "generating" state (and arm the status poll) for the whole
    // attempt — if the stream times out below while the backend keeps generating,
    // the poll is what eventually clears the stale partial banner.
    setLocalGenerating(true);

    try {
      const providerPolicy = loadLlmProviderPolicy();
      const res = await generateReport(
        activeScenarioId,
        {
          llmApiKey: providerPolicy.apiKey || undefined,
          llmBaseUrl: providerPolicy.baseUrl || undefined,
          llmModel: providerPolicy.model || undefined,
          llmRequestsPerMinute: providerPolicy.requestsPerMinute ?? undefined,
          llmTokensPerMinute: providerPolicy.tokensPerMinute ?? undefined,
        },
        controller.signal
      );

      const isAlreadyRunning = await drainReportStreamAndDetectAlreadyRunning(
        res,
        controller.signal,
        (newTrace) => {
          if (isMountedRef.current) {
            setToolTrace((prev) => [...prev, ...newTrace]);
          }
        }
      );
      if (!isMountedRef.current) return;
      if (isAlreadyRunning) {
        setLocalGenerating(true);
      } else {
        // Stream completed: drop the local generating flag so the freshly fetched
        // report renders immediately instead of waiting for the next poll tick.
        setLocalGenerating(false);
        setRetryError(false);
        if (onRefresh) {
          onRefresh();
        } else if (typeof window !== 'undefined') {
          window.location.reload();
        }
      }
    } catch (err) {
      const error = err as { code?: string; message?: string; name?: string } | null;
      if (isMountedRef.current) {
        if (error && (error.code === 'REPORT_ALREADY_RUNNING' || error.message?.includes('REPORT_ALREADY_RUNNING'))) {
          setLocalGenerating(true);
        } else if (error?.name === 'AbortError') {
          // The backend ties report generation to the SSE generator; aborting the
          // reader can cancel the in-flight build, so surface a retryable failure.
          setLocalGenerating(false);
          setRetryError(true);
        } else {
          setLocalGenerating(false);
          setRetryError(true);
        }
      }
    } finally {
      clearTimeout(timeoutId);
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      if (isMountedRef.current) {
        setRetrying(false);
      }
    }
  }, [activeScenarioId, retrying, onRefresh, isReplayMode, t]);

  const currentIds = useMemo(() => new Set(sections.map((s) => s.id)), [sections]);
  const missingSections = useMemo(() => {
    if (report?.status !== 'partial') return [];
    return ALLOWED_SECTION_IDS.filter((id) => !currentIds.has(id));
  }, [report?.status, currentIds]);

  if (capLoading) {
    if (variant === 'inline') {
      return null;
    }
    return (
      <div className="report-panel-container report-state-card report-state-card--loading animate-pulse motion-reduce:animate-none">
        <div className="report-state-skeleton report-state-skeleton--title" />
        <div className="report-state-skeleton report-state-skeleton--medium" />
        <div className="report-state-skeleton report-state-skeleton--wide" />
      </div>
    );
  }

  if (capError) {
    return (
      <div className="report-panel-container report-state-card">
        <p className="report-state-card__desc">
          {t('result.report.couldNotConfirmAvailability')}
        </p>
        <button
          type="button"
          onClick={() => void reload?.()}
          className="report-state-card__button"
        >
          {t('result.report.retry')}
        </button>
      </div>
    );
  }

  if (!isEnabled) {
    return null;
  }

  const missing = !report || !report.verdict;
  const hasSections = sections.length > 0;
  const partialButRenderable = report?.status === 'partial' && hasSections && !missing;
  const incomplete = !partialButRenderable && (report?.status === 'failed' || report?.status === 'partial');

  if (isGenerating) {
    return (
      <div className="report-panel-container report-state-card">
        <div
          className="report-state-card__icon report-state-card__icon--primary"
          aria-hidden="true"
        >
          <svg className="animate-spin h-6 w-6 text-[color:var(--color-primary)]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
        <h2 className="report-state-card__title">
          {t('result.report.generatingTitle')}
        </h2>
        <p className="report-state-card__desc">
          {t('result.report.generatingDesc')}
        </p>
      </div>
    );
  }

  if (isTruncatedReport) {
    return (
      <div className="report-panel-container report-state-card">
        <div
          className="report-state-card__icon report-state-card__icon--warning"
          aria-hidden="true"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <h2 className="report-state-card__title">
          {t('result.report.reportTruncated')}
        </h2>
        <p className="report-state-card__desc">
          {t('result.report.reportTruncatedDesc')}
        </p>
        {retryError && (
          <p className="report-state-card__error" role="alert">
            {typeof retryError === 'string' ? retryError : t('result.report.retryFailed')}
          </p>
        )}
        {!isReplayMode && (
          <button
            type="button"
            onClick={() => void handleRetry()}
            disabled={retrying}
            aria-busy={retrying}
            className="report-state-card__button report-state-card__button--primary"
          >
            {retrying ? t('result.report.generating') : t('result.report.retryGeneration')}
          </button>
        )}
      </div>
    );
  }

  if (incomplete || (missing && variant === 'standalone')) {
    return (
      <div className="report-panel-container report-state-card">
        <div
          className="report-state-card__icon report-state-card__icon--danger"
          aria-hidden="true"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h2 className="report-state-card__title">
          {missing
            ? t('result.report.reportNotGenerated')
            : t('result.report.reportIncomplete')}
        </h2>
        <p className="report-state-card__desc">
          {missing
            ? t('result.report.generateReportDesc')
            : t('result.report.reportIncompleteDesc')}
        </p>
        {retryError && (
          <p className="report-state-card__error" role="alert">
            {typeof retryError === 'string' ? retryError : t('result.report.retryFailed')}
          </p>
        )}
        {!isReplayMode && (
          <button
            type="button"
            onClick={() => void handleRetry()}
            disabled={retrying}
            aria-busy={retrying}
            className="report-state-card__button report-state-card__button--primary"
          >
            {retrying
              ? t('result.report.generating')
              : missing
                ? t('result.report.generateReport')
                : t('result.report.retryGeneration')}
          </button>
        )}
      </div>
    );
  }

  if (missing) {
    if (variant === 'inline') {
      if (isReplayMode) {
        return null;
      }
      return (
        <div className="report-panel-container report-missing-inline-card">
          <div>
            <p className="text-sm font-semibold text-[color:var(--text-primary)]">📊 {t('result.report.fullReport')}</p>
            <p className="text-xs text-[color:var(--text-secondary)]">{t('result.report.generateReportDesc')}</p>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/result/${activeScenarioId}/report`)}
            className="report-missing-inline-card__button"
          >
            {t('result.report.generateReport')}
          </button>
        </div>
      );
    }
    return null;
  }

  const title = isZh ? report.title_i18n.zh || report.title : report.title_i18n.en || report.title;

  return (
    <div className="report-doc report-panel-container report-panel-container--rendered">
      {partialButRenderable && (
        <div
          className="report-partial-banner"
          role="status"
        >
          <div className="report-partial-banner__content">
            <span className="report-partial-banner__icon" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </span>
            <div className="report-partial-banner__copy">
              <p className="report-partial-banner__title">
                {t('result.report.reportPartiallyGenerated')}
              </p>
              <p className="report-partial-banner__desc">
                {t('result.report.reportPartiallyGeneratedDesc')}
              </p>
              {retryError && (
                <p className="report-partial-banner__error" role="alert">
                  {typeof retryError === 'string' ? retryError : t('result.report.retryFailed')}
                </p>
              )}
            </div>
          </div>
          {!isReplayMode && (
            <button
              type="button"
              onClick={() => void handleRetry()}
              disabled={retrying}
              aria-busy={retrying}
              className="report-partial-banner__retry"
            >
              {retrying
                ? t('result.report.generating')
                : t('result.report.retryGeneration')}
            </button>
          )}
        </div>
      )}
      <div className="report-panel-body">
        {variant === 'inline' ? (
          <>
            <ReportConfidenceBadge verdict={report.verdict} />

            {report.status === 'complete' && takeaways.length > 0 && (
              <div className="report-digest">
                <h3 className="report-digest__title">{t('result.report.takeawaysLabel')}</h3>
                <ul className="report-digest__list">
                  {takeaways.map((item, idx) => (
                    <li key={idx} className="report-digest__item">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.status === 'complete' && (
              <ReportToc sections={sections} hrefBase={`/result/${activeScenarioId}/report`} />
            )}

            <div className="report-cta">
              <p className="report-cta__lead">{t('result.report.readFullReportLead')}</p>
              <Link
                to={`/result/${activeScenarioId}/report`}
                className="report-cta__btn"
              >
                {t('result.report.readFullReport')}
              </Link>
            </div>
          </>
        ) : (
          <>
            {/* MASTHEAD — serif title + deck rule. Standalone /report only: the inline
                /result/:id embed already renders the page header + verdict card, so the
                report headline here would read as a duplicate stacked serif title (D1). */}
            {variant === 'standalone' && (
              <header className="report-masthead report-reveal">
                <h2 className="report-masthead__title">{title}</h2>
                <p className="report-masthead__deck">{t('result.report.deck')}</p>
                <hr className="report-masthead__rule" />
              </header>
            )}

            {/* HERO STAT BAND — probability / confidence / consensus / disclaimer band */}
            <ReportConfidenceBadge verdict={report.verdict} />

            <ReportToc sections={sections} />

            <div className="report-content">
              {sections.map((section, idx) => (
                <ReportSection
                  key={section.id}
                  section={section}
                  index={idx}
                  onOpenEvidence={handleOpenEvidence}
                />
              ))}
              {retrying &&
                missingSections.map((id) => (
                  <section
                    key={`skeleton-${id}`}
                    className="report-section report-section--skeleton animate-pulse motion-reduce:animate-none"
                  >
                    <div className="report-section-skeleton__head">
                      <div className="h-6 bg-[color:var(--bg-hover)] rounded w-1/3" />
                      <div className="h-8 bg-[color:var(--bg-hover)] rounded w-24" />
                    </div>
                    <div className="report-section-skeleton__body">
                      <div className="h-4 bg-[color:var(--bg-hover)] rounded w-full" />
                      <div className="h-4 bg-[color:var(--bg-hover)] rounded w-5/6" />
                      <div className="h-4 bg-[color:var(--bg-hover)] rounded w-3/4" />
                    </div>
                  </section>
                ))}
            </div>

            {hasInterviews && (
              <section
                className="report-personas"
                aria-label={t('result.report.interviewsTitle')}
              >
                <div className="report-block-head">
                  <span className="report-block-head__bid" aria-hidden="true">A</span>
                  <h3 className="report-block-head__title">
                    {t('result.report.interviewsTitle')}
                  </h3>
                  {interviewEvidence.length > 0 && (
                    <span className="report-block-head__meta">
                      {t('result.report.sourcesCount', { count: interviewEvidence.length })}
                    </span>
                  )}
                </div>

                {/* §F: honesty intro — these are AI-played roles, not real persons */}
                <p className="report-personas__intro">{t('result.report.personas_intro')}</p>

                {/* Interview Status Message */}
                {interviewStatus && interviewStatus.status !== 'complete' && (
                  <div className="report-personas__notice">
                    {interviewStatus.status === 'skipped' && (
                      <p>{t('result.report.interviewStatus_skipped', { message: interviewStatus.message || '' })}</p>
                    )}
                    {interviewStatus.status === 'failed' && (
                      <p>
                        {t('result.report.interviewStatus_failed', {
                          message: interviewStatus.message || '',
                          error_code: interviewStatus.error_code || 'UNKNOWN',
                        })}
                      </p>
                    )}
                    {interviewStatus.status === 'partial' && (
                      <p>
                        {t('result.report.interviewStatus_partial', {
                          message: interviewStatus.message || '',
                          completed: interviewStatus.completed_agents ?? 0,
                          requested: interviewStatus.requested_agents ?? 0,
                          truncated: interviewStatus.truncated_agents ?? 0,
                        })}
                      </p>
                    )}
                  </div>
                )}

                {/* Persona Cards */}
                {interviewEvidence.length > 0 && (
                  <div className="report-personas__grid">
                    {interviewEvidence.map((rawEntry, i) => {
                      if (!rawEntry) return null;
                      const entry = rawEntry as Partial<InterviewEvidenceEntry>;
                      const agentName = entry.agent_name || t('result.report.evidenceKind.default', 'Agent');
                      const branchIndex = entry.branch_index ?? 0;
                      const round = entry.round ?? 0;
                      const excerpt = entry.excerpt || '';

                      return (
                        <article key={i} className="report-persona-card">
                          <div className="report-persona-card__top">
                            <span className="report-persona-card__name">{agentName}</span>
                            <span className="report-persona-card__coord">
                              {t('result.report.interviewCoordinate', {
                                branch_index: branchIndex,
                                round: round,
                              })}
                            </span>
                          </div>
                          {excerpt && (
                            <blockquote className="report-persona-card__quote">{excerpt}</blockquote>
                          )}
                          <span className="report-persona-card__badge">
                            {t('result.report.persona_badge')}
                          </span>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {(report.indicators_to_watch?.length ?? 0) > 0 && (
              <section
                className="report-indicators"
                aria-label={t('result.report.indicatorsToWatch')}
              >
                <div className="report-block-head">
                  <span className="report-block-head__bid" aria-hidden="true">B</span>
                  <h3 className="report-block-head__title">
                    {t('result.report.indicatorsToWatch')}
                  </h3>
                  <span className="report-block-head__meta">
                    {t('result.report.watchlistCount', { count: report.indicators_to_watch.length })}
                  </span>
                </div>
                <div className="report-watch">
                  {report.indicators_to_watch.map((ind, i) => (
                    <div key={i} className="report-watch__row">
                      <div className="report-watch__signal">
                        {ind.signal}
                        {ind.observation && (
                          <span className="report-watch__signal-note">{ind.observation}</span>
                        )}
                        {ind.note && (
                          <span className="report-watch__signal-note">{ind.note}</span>
                        )}
                        {ind.rationale && (
                          <span className="report-watch__signal-rationale">{ind.rationale}</span>
                        )}
                      </div>
                      <div>
                        <span
                          className={`report-watch__dir ${ind.direction === 'up' ? 'is-up' : 'is-down'}`}
                        >
                          <span aria-hidden="true">{ind.direction === 'up' ? '↑' : '↓'}</span>
                          {ind.direction === 'up' ? t('result.report.rising') : t('result.report.falling')}
                        </span>
                      </div>
                      <div className="report-watch__horizon">
                        {ind.time_horizon ? ind.time_horizon : ''}
                      </div>
                      <div className="report-watch__threshold">
                        {ind.threshold && (
                          <>
                            <span className="report-watch__threshold-lbl">{t('result.report.threshold')}</span>
                            {ind.threshold}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* CONSOLE — real tool-trace summary; collapses to nothing when empty */}
            <ToolTraceChip trace={toolTrace} />

            {/* FOOTER */}
            <footer className="report-footer">
              <span>{t('result.report.footerBrand')}</span>
              <span>{t('result.report.footerTagline')}</span>
            </footer>
          </>
        )}
      </div>

      <ReportEvidenceDrawer
        isOpen={evidenceDrawerOpen}
        onClose={handleCloseEvidence}
        scenarioId={activeScenarioId || ''}
        evidence={currentEvidence}
      />
    </div>
  );
});

// Main exported component subscribing to ResultContext, but passing props
// to the memoized ResultReportPanelInner to narrow subscription.
export const ResultReportPanel = React.memo(function ResultReportPanel(props: Props) {
  const context = useResultContext();
  const storyData = props.storyData !== undefined ? props.storyData : context.storyData;
  const activeScenarioId = props.activeScenarioId !== undefined ? props.activeScenarioId : context.activeScenarioId;
  const isZh = props.isZh !== undefined ? props.isZh : context.isZh;
  const isReplayMode = props.isReplayMode !== undefined ? props.isReplayMode : context.isReplayMode;

  return (
    <ResultReportPanelInner
      {...props}
      storyData={storyData}
      activeScenarioId={activeScenarioId}
      isZh={isZh}
      isReplayMode={isReplayMode}
    />
  );
});
