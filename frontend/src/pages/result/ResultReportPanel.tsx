import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useResultContext } from './ResultContext';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import { generateReport, getStory } from '../../api/client';
import { ReportConfidenceBadge } from './ReportConfidenceBadge';
import { ReportToc } from './ReportToc';
import { ReportSection } from './ReportSection';
import { ReportEvidenceDrawer } from './ReportEvidenceDrawer';
import { loadLlmProviderPolicy, validateByok } from '../../lib/llmProviderPolicy';
import { getLocalizedApiErrorMessage } from '../../lib/apiErrorMessage';
import type { FullReport, FullReportTruncatedMarker, ReportEvidence, StoryData } from '../../types';

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

const ALLOWED_SECTION_IDS = ['timeline', 'factions', 'conflicts', 'premortem', 'indicators', 'sources'];
const REPORT_GENERATE_TIMEOUT_MS = 35 * 60_000;

async function drainReportStreamAndDetectAlreadyRunning(res: Response, signal: AbortSignal): Promise<boolean> {
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
  const { t } = useTranslation();
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
  }, [storyData]);

  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
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
        setLocalGenerating(false);
        return;
      }
      try {
        const updatedStory = await getStory(activeScenarioId);
        const newReport = updatedStory?.full_report;
        if (newReport && newReport.status !== 'generating') {
          setLocalStoryData(updatedStory);
          setLocalGenerating(false);
          if (onRefresh) {
            onRefresh();
          }
        } else {
          timerId = window.setTimeout(poll, 15000);
        }
      } catch (err) {
        console.error('Error polling report status', err);
        timerId = window.setTimeout(poll, 15000);
      }
    };

    timerId = window.setTimeout(poll, 15000);

    return () => {
      if (timerId) {
        clearTimeout(timerId);
      }
    };
  }, [isGenerating, activeScenarioId, isReplayMode, onRefresh]);

  const sections = useMemo(() => report?.sections || [], [report]);
  const evidenceDict = useMemo(() => {
    const map = new Map<string, ReportEvidence>();
    if (report?.evidence) {
      for (const ev of report.evidence) map.set(ev.id, ev);
    }
    return map;
  }, [report]);

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

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const timeoutId = setTimeout(() => controller.abort(), REPORT_GENERATE_TIMEOUT_MS);

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

      const isAlreadyRunning = await drainReportStreamAndDetectAlreadyRunning(res, controller.signal);
      if (isAlreadyRunning) {
        setLocalGenerating(true);
      } else {
        if (onRefresh) {
          onRefresh();
        } else if (typeof window !== 'undefined') {
          window.location.reload();
        }
      }
    } catch (err) {
      const error = err as { code?: string; message?: string } | null;
      if (error && (error.code === 'REPORT_ALREADY_RUNNING' || error.message?.includes('REPORT_ALREADY_RUNNING'))) {
        setLocalGenerating(true);
      } else {
        setRetryError(true);
      }
    } finally {
      clearTimeout(timeoutId);
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setRetrying(false);
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
      <div className="report-panel-container my-8 p-6 bg-[color:var(--bg-elevated)] rounded-xl border border-[color:var(--border-subtle)] animate-pulse motion-reduce:animate-none forced-colors:border">
        <div className="h-6 w-1/4 bg-[color:var(--bg-hover)] rounded mb-4" />
        <div className="h-4 w-1/2 bg-[color:var(--bg-hover)] rounded mb-2" />
        <div className="h-4 w-3/4 bg-[color:var(--bg-hover)] rounded" />
      </div>
    );
  }

  if (capError) {
    return (
      <div className="report-panel-container my-8 p-6 bg-[color:var(--bg-elevated)] rounded-xl border border-[color:var(--border-subtle)] flex flex-col items-center text-center forced-colors:border">
        <p className="text-sm text-[color:var(--text-secondary)] mb-4">
          {t('result.report.couldNotConfirmAvailability')}
        </p>
        <button
          type="button"
          onClick={() => void reload?.()}
          className="px-5 py-2 rounded border border-[color:var(--border-default)] text-[color:var(--color-primary)] hover:bg-[color:var(--bg-hover)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)] forced-colors:border transition-colors motion-reduce:transition-none"
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
      <div className="report-panel-container my-8 p-6 bg-[color:var(--bg-elevated)] rounded-xl border border-[color:var(--border-subtle)] flex flex-col items-center justify-center text-center forced-colors:border">
        <div
          className="w-12 h-12 rounded-full bg-[color:var(--bg-hover)] text-[color:var(--color-primary)] flex items-center justify-center mb-4 forced-colors:border"
          aria-hidden="true"
        >
          <svg className="animate-spin h-6 w-6 text-[color:var(--color-primary)]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)] mb-2">
          {t('result.report.generatingTitle')}
        </h2>
        <p className="text-sm text-[color:var(--text-secondary)] max-w-md">
          {t('result.report.generatingDesc')}
        </p>
      </div>
    );
  }

  if (isTruncatedReport) {
    return (
      <div className="report-panel-container my-8 p-6 bg-[color:var(--bg-elevated)] rounded-xl border border-[color:var(--border-subtle)] flex flex-col items-center justify-center text-center forced-colors:border">
        <div
          className="w-12 h-12 rounded-full bg-[color:var(--bg-hover)] text-[color:var(--color-warning,var(--color-primary))] flex items-center justify-center mb-4 forced-colors:border"
          aria-hidden="true"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)] mb-2">
          {t('result.report.reportTruncated')}
        </h2>
        <p className="text-sm text-[color:var(--text-secondary)] mb-6 max-w-md">
          {t('result.report.reportTruncatedDesc')}
        </p>
        {retryError && (
          <p className="text-sm text-[color:var(--color-danger)] mb-3" role="alert">
            {typeof retryError === 'string' ? retryError : t('result.report.retryFailed')}
          </p>
        )}
        {!isReplayMode && (
          <button
            type="button"
            onClick={() => void handleRetry()}
            disabled={retrying}
            aria-busy={retrying}
            className="px-6 py-2 bg-[color:var(--color-primary)] text-white font-medium rounded hover:bg-[color:var(--color-primary-dim)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[color:var(--color-ring)] disabled:opacity-60 forced-colors:border transition-colors motion-reduce:transition-none"
          >
            {retrying ? t('result.report.generating') : t('result.report.retryGeneration')}
          </button>
        )}
      </div>
    );
  }

  if (incomplete || (missing && variant === 'standalone')) {
    return (
      <div className="report-panel-container my-8 p-6 bg-[color:var(--bg-elevated)] rounded-xl border border-[color:var(--border-subtle)] flex flex-col items-center justify-center text-center forced-colors:border">
        <div
          className="w-12 h-12 rounded-full bg-[color:var(--bg-hover)] text-[color:var(--color-danger)] flex items-center justify-center mb-4 forced-colors:border"
          aria-hidden="true"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)] mb-2">
          {missing
            ? t('result.report.reportNotGenerated')
            : t('result.report.reportIncomplete')}
        </h2>
        <p className="text-sm text-[color:var(--text-secondary)] mb-6 max-w-md">
          {missing
            ? t('result.report.generateReportDesc')
            : t('result.report.reportIncompleteDesc')}
        </p>
        {retryError && (
          <p className="text-sm text-[color:var(--color-danger)] mb-3" role="alert">
            {typeof retryError === 'string' ? retryError : t('result.report.retryFailed')}
          </p>
        )}
        {!isReplayMode && (
          <button
            type="button"
            onClick={() => void handleRetry()}
            disabled={retrying}
            aria-busy={retrying}
            className="px-6 py-2 bg-[color:var(--color-primary)] text-white font-medium rounded hover:bg-[color:var(--color-primary-dim)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[color:var(--color-ring)] disabled:opacity-60 forced-colors:border transition-colors motion-reduce:transition-none"
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
      return (
        <div className="report-panel-container my-8 p-5 bg-[color:var(--bg-hover)] rounded-xl border border-dashed border-[color:var(--border-default)] flex justify-between items-center flex-wrap gap-3">
          <div>
            <p className="text-sm font-semibold text-[color:var(--text-primary)]">📊 {t('result.report.fullReport')}</p>
            <p className="text-xs text-[color:var(--text-secondary)]">{t('result.report.generateReportDesc')}</p>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/result/${activeScenarioId}/report`)}
            className="px-4 py-1.5 text-xs bg-[color:var(--color-primary)] hover:bg-[color:var(--color-primary-dim)] text-white rounded font-medium transition-colors"
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
    <div className="report-panel-container my-8 bg-[color:var(--bg-elevated)] rounded-xl border border-[color:var(--border-subtle)] shadow-sm overflow-hidden forced-colors:border">
      {partialButRenderable && (
        <div
          className="report-partial-banner flex flex-wrap items-center justify-between gap-3 px-6 py-3 bg-[color:var(--bg-hover)] border-b border-[color:var(--border-subtle)] forced-colors:border"
          role="status"
        >
          <div className="flex items-start gap-2 min-w-0">
            <span className="mt-0.5 text-[color:var(--color-warning,var(--color-primary))]" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-[color:var(--text-primary)]">
                {t('result.report.reportPartiallyGenerated')}
              </p>
              <p className="text-xs text-[color:var(--text-secondary)]">
                {t('result.report.reportPartiallyGeneratedDesc')}
              </p>
              {retryError && (
                <p className="text-xs text-[color:var(--color-danger)] mt-1" role="alert">
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
              className="shrink-0 px-4 py-1.5 text-sm rounded border border-[color:var(--border-default)] text-[color:var(--color-primary)] hover:bg-[color:var(--bg-elevated)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] disabled:opacity-60 forced-colors:border transition-colors motion-reduce:transition-none"
            >
              {retrying
                ? t('result.report.generating')
                : t('result.report.retryGeneration')}
            </button>
          )}
        </div>
      )}
      <div className="p-4 sm:p-6 md:p-8">
        <header className="mb-8 border-b border-[color:var(--border-subtle)] pb-6">
          <h2 className="text-2xl md:text-3xl font-bold text-[color:var(--text-primary)] mb-4 leading-snug break-words [overflow-wrap:anywhere]">
            {title}
          </h2>
          <ReportConfidenceBadge verdict={report.verdict} />
        </header>

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
                className="report-section mb-10 pb-6 border-b border-[color:var(--border-subtle)] last:border-b-0 animate-pulse motion-reduce:animate-none"
              >
                <div className="flex justify-between items-end mb-4">
                  <div className="h-6 bg-[color:var(--bg-hover)] rounded w-1/3" />
                  <div className="h-8 bg-[color:var(--bg-hover)] rounded w-24" />
                </div>
                <div className="space-y-3">
                  <div className="h-4 bg-[color:var(--bg-hover)] rounded w-full" />
                  <div className="h-4 bg-[color:var(--bg-hover)] rounded w-5/6" />
                  <div className="h-4 bg-[color:var(--bg-hover)] rounded w-3/4" />
                </div>
              </section>
            ))}
        </div>

        {(report.indicators_to_watch?.length ?? 0) > 0 && (
          <section
            className="report-indicators mt-2 pt-6 border-t border-[color:var(--border-subtle)]"
            aria-label={t('result.report.indicatorsToWatch')}
          >
            <h3 className="text-lg font-bold text-[color:var(--text-primary)] mb-4">
              {t('result.report.indicatorsToWatch')}
            </h3>
            <ul className="space-y-4">
              {report.indicators_to_watch.map((ind, i) => (
                <li
                  key={i}
                  className="p-4 rounded-lg bg-[color:var(--bg-hover)] border border-[color:var(--border-subtle)] forced-colors:border"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 text-sm font-bold text-[color:var(--color-primary)]" aria-hidden="true">
                      {ind.direction === 'up' ? '↑' : '↓'}
                    </span>
                    <span className="sr-only">
                      {ind.direction === 'up' ? t('result.report.rising') : t('result.report.falling')}
                    </span>
                    <div className="flex-1">
                      <div className="flex items-baseline justify-between gap-2 flex-wrap">
                        <span className="font-semibold text-[color:var(--text-primary)] break-words [overflow-wrap:anywhere]">{ind.signal}</span>
                        {ind.time_horizon && (
                          <span className="text-xs text-[color:var(--text-muted)] break-words [overflow-wrap:anywhere]">{ind.time_horizon}</span>
                        )}
                      </div>
                      {ind.observation && (
                        <p className="text-sm text-[color:var(--text-secondary)] mt-1 break-words [overflow-wrap:anywhere]">{ind.observation}</p>
                      )}
                      {ind.threshold && (
                        <p className="text-sm text-[color:var(--text-secondary)] mt-1 break-words [overflow-wrap:anywhere]">
                          <span className="text-[color:var(--text-muted)]">{t('result.report.threshold')}</span>
                          {ind.threshold}
                        </p>
                      )}
                      {ind.note && <p className="text-sm text-[color:var(--text-secondary)] mt-1 break-words [overflow-wrap:anywhere]">{ind.note}</p>}
                      {ind.rationale && (
                        <p className="text-xs italic text-[color:var(--text-muted)] mt-1 break-words [overflow-wrap:anywhere]">{ind.rationale}</p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
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
