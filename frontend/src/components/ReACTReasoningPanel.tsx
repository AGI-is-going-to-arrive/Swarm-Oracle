import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { AnalystIteration, AnalystStoppedReason } from '../pages/postVerdictCaches';
import './ReACTReasoningPanel.css';

export type ReACTToolKind = 'causal' | 'identity' | 'web' | 'other';

interface ReACTReasoningPanelProps {
  iterations: AnalystIteration[];
  finalAnswer: string | null;
  streaming: boolean;
  stoppedReason: AnalystStoppedReason | null;
  error: string | null;
  aborted: boolean;
}

const MAX_VISIBLE_HISTORY = 20;

function classifyTool(action: string): ReACTToolKind {
  switch (action) {
    case 'query_causal_graph':
      return 'causal';
    case 'search_identity_memories':
      return 'identity';
    case 'search_web_context':
      return 'web';
    default:
      return 'other';
  }
}

function ToolIcon({ kind }: { kind: ReACTToolKind }): ReactNode {
  if (kind === 'causal') {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" focusable="false" aria-hidden="true">
        <circle cx="6" cy="7" r="2.4" fill="currentColor" />
        <circle cx="18" cy="7" r="2.4" fill="currentColor" />
        <circle cx="12" cy="17" r="2.4" fill="currentColor" />
        <path
          d="M7.4 8.6 L10.8 15.6 M16.6 8.6 L13.2 15.6"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    );
  }
  if (kind === 'identity') {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" focusable="false" aria-hidden="true">
        <path
          d="M12 3 C8 3 6 6 6 9 C6 11 7 12.5 8 13.4 V17 C8 18.5 9.5 20 12 20 C14.5 20 16 18.5 16 17 V13.4 C17 12.5 18 11 18 9 C18 6 16 3 12 3 Z"
          stroke="currentColor"
          strokeWidth="1.6"
          fill="none"
          strokeLinejoin="round"
        />
        <path d="M9.5 9.5 H14.5 M9.5 12 H14.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'web') {
    return (
      <svg viewBox="0 0 24 24" width="14" height="14" focusable="false" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
        <ellipse cx="12" cy="12" rx="4" ry="8.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
        <path d="M3.5 12 H20.5" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" focusable="false" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" fill="none" />
    </svg>
  );
}

function formatParams(params: Record<string, unknown> | undefined): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const truncated = text.length > 80 ? `${text.slice(0, 77)}…` : text;
      return `${key}=${truncated}`;
    })
    .join(' · ');
}

function isLongSummary(summary: string): boolean {
  return summary.length > 220;
}

interface IterationStepProps {
  iteration: AnalystIteration;
  isLatest: boolean;
  streaming: boolean;
  defaultExpanded: boolean;
}

function IterationStep({ iteration, isLatest, streaming, defaultExpanded }: IterationStepProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultExpanded);
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  const kind = classifyTool(iteration.action);
  const paramsLine = useMemo(() => formatParams(iteration.params), [iteration.params]);
  const summary = iteration.summary?.trim() ?? '';
  const hasSummary = summary.length > 0;
  const summaryTruncatable = hasSummary && isLongSummary(summary);
  const visibleSummary = summaryTruncatable && !summaryExpanded ? `${summary.slice(0, 217)}…` : summary;

  const toolKindLabel = (() => {
    switch (kind) {
      case 'causal':
        return t('react_panel.tool_causal_graph');
      case 'identity':
        return t('react_panel.tool_identity');
      case 'web':
        return t('react_panel.tool_web');
      default:
        return iteration.action;
    }
  })();

  const stepInProgress = streaming && isLatest && !hasSummary;
  const stepStatusLabel = stepInProgress
    ? t('react_panel.tool_running')
    : hasSummary
      ? t('react_panel.tool_complete')
      : t('react_panel.tool_pending');

  const headerId = `react-step-${iteration.iteration}-header`;
  const bodyId = `react-step-${iteration.iteration}-body`;

  return (
    <li
      className={`react-step react-step--${kind}${isLatest ? ' is-latest' : ''}${stepInProgress ? ' is-running' : ''}`}
      aria-current={isLatest ? 'step' : undefined}
    >
      <div className="react-step__rail" aria-hidden="true">
        <span className={`react-step__rail-marker react-step__rail-marker--${kind}`}>
          <ToolIcon kind={kind} />
        </span>
        <span className="react-step__rail-line" />
      </div>

      <div className="react-step__body">
        <button
          type="button"
          id={headerId}
          className="react-step__header"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span className="react-step__iteration-tag">
            {t('react_panel.iteration_label', { n: iteration.iteration })}
          </span>
          <span className={`react-step__tool-chip react-step__tool-chip--${kind}`}>
            <span className="react-step__tool-chip-icon" aria-hidden="true">
              <ToolIcon kind={kind} />
            </span>
            <span className="react-step__tool-chip-label">{toolKindLabel}</span>
          </span>
          <span
            className={`react-step__status react-step__status--${stepInProgress ? 'running' : hasSummary ? 'done' : 'pending'}`}
          >
            <span className="react-step__status-dot" aria-hidden="true" />
            {stepStatusLabel}
          </span>
          {iteration.elapsed_ms != null && (
            <span className="react-step__elapsed" aria-label={t('react_panel.elapsed_label')}>
              {(iteration.elapsed_ms / 1000).toFixed(1)}s
            </span>
          )}
          <span className="react-step__chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        </button>

        <div
          id={bodyId}
          role="region"
          aria-labelledby={headerId}
          className="react-step__panel"
          hidden={!open}
        >
          {paramsLine && (
            <div className="react-step__section react-step__section--params">
              <span className="react-step__section-label">{t('react_panel.tool_call')}</span>
              <code className="react-step__params">{paramsLine}</code>
            </div>
          )}

          {hasSummary ? (
            <div className="react-step__section react-step__section--result">
              <span className="react-step__section-label">{t('react_panel.tool_result')}</span>
              <p className="react-step__summary">{visibleSummary}</p>
              {summaryTruncatable && (
                <button
                  type="button"
                  className="react-step__expand"
                  onClick={() => setSummaryExpanded((prev) => !prev)}
                  aria-expanded={summaryExpanded}
                >
                  {summaryExpanded ? t('react_panel.collapse_result') : t('react_panel.expand_result')}
                </button>
              )}
            </div>
          ) : stepInProgress ? (
            <div className="react-step__section react-step__section--running">
              <span className="react-step__section-label">{t('react_panel.tool_result')}</span>
              <div className="react-step__pending" aria-live="polite">
                <span className="react-step__pending-dot" />
                <span className="react-step__pending-dot" />
                <span className="react-step__pending-dot" />
                <span className="react-step__pending-text">{t('react_panel.awaiting_result')}</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function StoppedReasonNote({ reason }: { reason: AnalystStoppedReason }) {
  const { t } = useTranslation();
  if (reason === 'final_response') return null;
  const text = (() => {
    switch (reason) {
      case 'llm_error':
        return t('react_panel.stopped_llm_error');
      case 'unexpected_action':
        return t('react_panel.stopped_unexpected_action');
      case 'max_iterations':
        return t('react_panel.stopped_max_iterations');
      case 'stream_failure':
        return t('react_panel.stopped_stream_failure');
      default:
        return '';
    }
  })();
  if (!text) return null;
  return (
    <p className="react-panel__stopped-note" role="status">
      {text}
    </p>
  );
}

export default function ReACTReasoningPanel({
  iterations,
  finalAnswer,
  streaming,
  stoppedReason,
  error,
  aborted,
}: ReACTReasoningPanelProps) {
  const { t } = useTranslation();

  const visibleIterations = useMemo(() => {
    if (iterations.length <= MAX_VISIBLE_HISTORY) return iterations;
    return iterations.slice(iterations.length - MAX_VISIBLE_HISTORY);
  }, [iterations]);
  const truncatedCount = iterations.length - visibleIterations.length;

  const latestIterationNumber = visibleIterations.length > 0
    ? visibleIterations[visibleIterations.length - 1].iteration
    : null;

  const isStepDefaultExpanded = useCallback(
    (iterNumber: number, index: number, list: AnalystIteration[]) => {
      if (iterNumber === latestIterationNumber) return true;
      return index >= list.length - 2;
    },
    [latestIterationNumber],
  );

  const showEmptyState = !streaming
    && iterations.length === 0
    && !finalAnswer
    && !error
    && !aborted;

  if (showEmptyState) {
    return (
      <div className="react-panel react-panel--empty" data-testid="react-panel-empty">
        <p className="react-panel__empty-text">{t('react_panel.empty_hint')}</p>
      </div>
    );
  }

  return (
    <div className="react-panel" data-testid="react-panel">
      {iterations.length > 0 && (
        <div className="react-panel__chain" aria-live="polite" aria-relevant="additions text">
          {truncatedCount > 0 && (
            <p className="react-panel__truncated-note">
              {t('react_panel.truncated_note', { count: truncatedCount })}
            </p>
          )}
          <ol
            className="react-panel__steps"
            role="list"
            aria-label={t('react_panel.chain_aria')}
          >
            {visibleIterations.map((iteration, index) => (
              <IterationStep
                key={iteration.iteration}
                iteration={iteration}
                isLatest={iteration.iteration === latestIterationNumber}
                streaming={streaming}
                defaultExpanded={isStepDefaultExpanded(iteration.iteration, index, visibleIterations)}
              />
            ))}
          </ol>

          {streaming && (
            <p className="react-panel__thinking" aria-live="polite">
              <span className="react-panel__thinking-dot" />
              <span className="react-panel__thinking-dot" />
              <span className="react-panel__thinking-dot" />
              <span className="react-panel__thinking-text">{t('react_panel.thinking')}</span>
            </p>
          )}
        </div>
      )}

      {finalAnswer && (
        <div className="react-panel__answer" role="region" aria-label={t('react_panel.final_answer_aria')}>
          <header className="react-panel__answer-header">
            <span className="react-panel__answer-badge">{t('react_panel.final_answer_label')}</span>
            <span className="react-panel__answer-meta">
              {t('react_panel.iterations_used', { n: iterations.length })}
            </span>
          </header>
          <p className="react-panel__answer-text">{finalAnswer}</p>
        </div>
      )}

      {stoppedReason && stoppedReason !== 'final_response' && (
        <StoppedReasonNote reason={stoppedReason} />
      )}
    </div>
  );
}
