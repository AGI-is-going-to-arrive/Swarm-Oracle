import React, { useState, useCallback, useMemo } from 'react';
import { useResultContext } from './ResultContext';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import { generateReport } from '../../api/client';
import { ReportConfidenceBadge } from './ReportConfidenceBadge';
import { ReportToc } from './ReportToc';
import { ReportSection } from './ReportSection';
import { ReportEvidenceDrawer } from './ReportEvidenceDrawer';
import type { FullReport, FullReportTruncatedMarker, ReportEvidence } from '../../types';

interface Props {
  /** `inline` is rendered inside ResultView (page already has an <h1>); `standalone`
   *  is the /result/:id/report route (ResultReportView supplies the page <h1>). */
  variant?: 'inline' | 'standalone';
  /** Optional refresh callback (standalone re-fetches story); falls back to a full reload. */
  onRefresh?: () => void;
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

export const ResultReportPanel = React.memo(function ResultReportPanel({
  variant = 'inline',
  onRefresh,
}: Props) {
  const { storyData, activeScenarioId, isZh } = useResultContext();
  const {
    capabilities,
    loading: capLoading,
    error: capError,
    reload,
  } = useCapabilityCheck('result_report');

  const [evidenceDrawerOpen, setEvidenceDrawerOpen] = useState(false);
  const [currentEvidence, setCurrentEvidence] = useState<ReportEvidence[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);

  const rawReport = storyData?.full_report;
  const isTruncatedReport = isTruncatedReportMarker(rawReport);
  const report = isFullReport(rawReport) ? rawReport : null;
  const isEnabled = capabilities?.result_report?.enabled ?? false;

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

  // Real retry: POST report:generate, drain the SSE stream until the backend closes it
  // (report_complete / report_failed), then refresh so the persisted /story.full_report loads.
  const handleRetry = useCallback(async () => {
    if (!activeScenarioId || retrying) return;
    setRetrying(true);
    setRetryError(false);
    // Bound the operation: abort a hung stream after 3 min so the CTA never sticks on "Generating…".
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180_000);
    try {
      const res = await generateReport(activeScenarioId, undefined, controller.signal);
      const reader = res.body?.getReader();
      if (reader) {
        // Drain until the backend closes the stream (report_complete / report_failed); re-fetching
        // /story then loads the persisted report. The abort signal caps a stream that never ends.
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        reader.releaseLock();
      }
      if (onRefresh) {
        onRefresh();
      } else if (typeof window !== 'undefined') {
        window.location.reload();
      }
    } catch {
      setRetryError(true);
    } finally {
      clearTimeout(timeoutId);
      setRetrying(false);
    }
  }, [activeScenarioId, retrying, onRefresh]);

  // 1) Capability probe still loading.
  //    - `inline` (inside ResultView): render nothing so the feature being OFF never
  //      flashes a skeleton in the main result page.
  //    - `standalone` (/result/:id/report): keep the bounded skeleton (never a permanent spinner).
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

  // 2) Capability probe ERROR → explicit retriable surface (NOT silently treated as disabled).
  if (capError) {
    return (
      <div className="report-panel-container my-8 p-6 bg-[color:var(--bg-elevated)] rounded-xl border border-[color:var(--border-subtle)] flex flex-col items-center text-center forced-colors:border">
        <p className="text-sm text-[color:var(--text-secondary)] mb-4">
          {isZh
            ? '无法确认深读报告是否可用，请重试。'
            : 'Could not confirm whether the deep-read report is available. Please retry.'}
        </p>
        <button
          type="button"
          onClick={() => void reload?.()}
          className="px-5 py-2 rounded border border-[color:var(--border-default)] text-[color:var(--color-primary)] hover:bg-[color:var(--bg-hover)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)] forced-colors:border transition-colors motion-reduce:transition-none"
        >
          {isZh ? '重试' : 'Retry'}
        </button>
      </div>
    );
  }

  // 3) Feature genuinely disabled → render nothing.
  if (!isEnabled) {
    return null;
  }

  const missing = !report || !report.verdict;
  const hasSections = sections.length > 0;
  // A `partial` report that still produced renderable sections is shown in full (with a
  // non-blocking retry banner). Only a genuinely unrenderable report routes to the failure
  // card: `failed`, or `partial`/anything else that lacks sections or a verdict.
  const partialButRenderable =
    report?.status === 'partial' && hasSections && !missing;
  const incomplete =
    !partialButRenderable && (report?.status === 'failed' || report?.status === 'partial');

  // 4) Backend can return a bounded marker when persisted report exceeds the story byte cap.
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
          {isZh ? '深读报告已被截断' : 'Deep-Read Report Truncated'}
        </h2>
        <p className="text-sm text-[color:var(--text-secondary)] mb-6 max-w-md">
          {isZh
            ? '这份报告超过当前响应大小限制，无法完整展示。请重试生成较短报告。'
            : 'This report exceeded the current response-size limit and cannot be shown in full. Retry to generate a shorter report.'}
        </p>
        {retryError && (
          <p className="text-sm text-[color:var(--color-danger)] mb-3" role="alert">
            {isZh ? '重试失败，请稍后再试。' : 'Retry failed. Please try again later.'}
          </p>
        )}
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={retrying}
          aria-busy={retrying}
          className="px-6 py-2 bg-[color:var(--color-primary)] text-white font-medium rounded hover:bg-[color:var(--color-primary-dim)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[color:var(--color-ring)] disabled:opacity-60 forced-colors:border transition-colors motion-reduce:transition-none"
        >
          {retrying ? isZh ? '生成中…' : 'Generating…' : isZh ? '重试生成' : 'Retry Generation'}
        </button>
      </div>
    );
  }

  // 5) Report failed (or partial with nothing to show), or (standalone) not generated yet
  //    → incomplete card + REAL retry.
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
            ? isZh ? '尚未生成深读报告' : 'Deep-Read Report Not Generated'
            : isZh ? '报告生成未完成' : 'Report Generation Incomplete'}
        </h2>
        <p className="text-sm text-[color:var(--text-secondary)] mb-6 max-w-md">
          {missing
            ? isZh
              ? '点击下方按钮，为这条世界线生成深读报告。'
              : 'Generate the deep-read report for this worldline below.'
            : isZh
              ? '深读报告生成可能超时或部分失败，请点击下方按钮重试。'
              : 'The deep-read report may have timed out or partially failed. Please retry below.'}
        </p>
        {retryError && (
          <p className="text-sm text-[color:var(--color-danger)] mb-3" role="alert">
            {isZh ? '重试失败，请稍后再试。' : 'Retry failed. Please try again later.'}
          </p>
        )}
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={retrying}
          aria-busy={retrying}
          className="px-6 py-2 bg-[color:var(--color-primary)] text-white font-medium rounded hover:bg-[color:var(--color-primary-dim)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[color:var(--color-ring)] disabled:opacity-60 forced-colors:border transition-colors motion-reduce:transition-none"
        >
          {retrying
            ? isZh ? '生成中…' : 'Generating…'
            : missing
              ? isZh ? '生成报告' : 'Generate Report'
              : isZh ? '重试生成' : 'Retry Generation'}
        </button>
      </div>
    );
  }

  // 6) Inline + no report yet → stay quiet until the report exists.
  if (missing) {
    return null;
  }

  const title = isZh ? report.title_i18n.zh || report.title : report.title_i18n.en || report.title;

  return (
    <div className="report-panel-container my-8 bg-[color:var(--bg-elevated)] rounded-xl border border-[color:var(--border-subtle)] shadow-sm overflow-hidden forced-colors:border">
      {/* Partial report: show what generated, with a non-blocking retry banner on top. */}
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
                {isZh ? '深读报告部分生成' : 'Deep-read report partially generated'}
              </p>
              <p className="text-xs text-[color:var(--text-secondary)]">
                {isZh
                  ? '部分章节生成失败，以下为已生成内容。可重试以补全报告。'
                  : 'Some sections failed to generate. The content below is what was produced. Retry to complete the report.'}
              </p>
              {retryError && (
                <p className="text-xs text-[color:var(--color-danger)] mt-1" role="alert">
                  {isZh ? '重试失败，请稍后再试。' : 'Retry failed. Please try again later.'}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleRetry()}
            disabled={retrying}
            aria-busy={retrying}
            className="shrink-0 px-4 py-1.5 text-sm rounded border border-[color:var(--border-default)] text-[color:var(--color-primary)] hover:bg-[color:var(--bg-elevated)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] disabled:opacity-60 forced-colors:border transition-colors motion-reduce:transition-none"
          >
            {retrying
              ? isZh ? '生成中…' : 'Generating…'
              : isZh ? '重试生成' : 'Retry Generation'}
          </button>
        </div>
      )}
      <div className="p-6 md:p-8">
        <header className="mb-8 border-b border-[color:var(--border-subtle)] pb-6">
          {/* Always <h2>: ResultView (inline) and ResultReportView (standalone) both own the page <h1>. */}
          <h2 className="text-2xl md:text-3xl font-bold text-[color:var(--text-primary)] mb-4 leading-snug">
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
        </div>

        {(report.indicators_to_watch?.length ?? 0) > 0 && (
          <section
            className="report-indicators mt-2 pt-6 border-t border-[color:var(--border-subtle)]"
            aria-label={isZh ? '后续观察指标' : 'Indicators to watch'}
          >
            <h3 className="text-lg font-bold text-[color:var(--text-primary)] mb-4">
              {isZh ? '后续观察指标' : 'Indicators to Watch'}
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
                      {ind.direction === 'up' ? (isZh ? '上升' : 'rising') : isZh ? '下降' : 'falling'}
                    </span>
                    <div className="flex-1">
                      <div className="flex items-baseline justify-between gap-2 flex-wrap">
                        <span className="font-semibold text-[color:var(--text-primary)]">{ind.signal}</span>
                        {ind.time_horizon && (
                          <span className="text-xs text-[color:var(--text-muted)]">{ind.time_horizon}</span>
                        )}
                      </div>
                      {ind.observation && (
                        <p className="text-sm text-[color:var(--text-secondary)] mt-1">{ind.observation}</p>
                      )}
                      {ind.threshold && (
                        <p className="text-sm text-[color:var(--text-secondary)] mt-1">
                          <span className="text-[color:var(--text-muted)]">{isZh ? '阈值：' : 'Threshold: '}</span>
                          {ind.threshold}
                        </p>
                      )}
                      {ind.note && <p className="text-sm text-[color:var(--text-secondary)] mt-1">{ind.note}</p>}
                      {ind.rationale && (
                        <p className="text-xs italic text-[color:var(--text-muted)] mt-1">{ind.rationale}</p>
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
