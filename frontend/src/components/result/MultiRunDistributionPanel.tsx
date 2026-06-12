import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import { getRunGroupDistribution } from '../../api/client';
import type { RunGroupDistributionResponse } from '../../types';
import './MultiRunDistributionPanel.css';

interface MultiRunDistributionPanelProps {
  runGroupId: string;
}

export function MultiRunDistributionPanel({ runGroupId }: MultiRunDistributionPanelProps) {
  const { t } = useTranslation();
  const { enabled, loading: capLoading, error: capError, reload } = useCapabilityCheck('multi_run');
  const [data, setData] = useState<RunGroupDistributionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFinished, setIsFinished] = useState(false);
  const pollCountRef = useRef(0);

  useEffect(() => {
    if (!enabled || capLoading || !runGroupId) return;

    let active = true;
    let timerId: number | undefined;

    const poll = async () => {
      try {
        pollCountRef.current += 1;
        const res = await getRunGroupDistribution(runGroupId);
        if (!active) return;
        setData(res);
        setError(null);

        // Check if all runs are in a terminal state
        const allDone = res.runs && res.runs.length > 0 && res.runs.every((r) => {
          const s = r.status.toLowerCase();
          return s === 'done' || s === 'error' || s === 'cancelled';
        });

        if (allDone) {
          setIsFinished(true);
        } else if (pollCountRef.current >= 100) {
          // Hard cap at 100 polls to prevent infinite loops
          setIsFinished(true);
        } else {
          timerId = window.setTimeout(poll, 2000);
        }
      } catch (err) {
        if (!active) return;
        console.error('Failed to fetch run group distribution:', err);
        setError(t('common.error_generic') || 'Failed to load distribution data');
        timerId = window.setTimeout(poll, 4000); // Backoff on error
      }
    };

    void poll();

    return () => {
      active = false;
      if (timerId) clearTimeout(timerId);
    };
  }, [runGroupId, enabled, capLoading, t]);

  // When all runs complete, we reload the parent view to fetch final scenario state
  useEffect(() => {
    if (isFinished) {
      const reloadTimer = setTimeout(() => {
        window.location.reload();
      }, 1000);
      return () => clearTimeout(reloadTimer);
    }
  }, [isFinished]);

  if (capLoading) return null;

  if (capError) {
    return (
      <div className="multi-run-panel multi-run-panel--error" role="alert">
        <h3 className="multi-run-panel__title">{t('common.capability_error_title')}</h3>
        <p className="multi-run-panel__error-text">{t('common.capability_error')}</p>
        <button
          type="button"
          className="btn btn-ghost multi-run-panel__retry-btn"
          onClick={() => {
            if (reload) {
              void reload();
            }
          }}
          aria-label={t('common.retry')}
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="multi-run-disabled-placeholder">
        {t('multi_run.capability_disabled')}
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="multi-run-panel">
        <p className="result-error">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="multi-run-panel">
        <p>{t('sim.status.loading')}</p>
      </div>
    );
  }

  const totalRuns = data.run_count;
  const finishedRuns = data.run_count - data.pending_count;

  const isAllCompleted = data.pending_count === 0 && data.terminal_count > 0;

  // Calculate histogram max values for proportional bar rendering
  const maxVerdictVal = Math.max(...Object.values(data.histogram.verdict_counts), 1);
  const maxOutcomeVal = Math.max(...Object.values(data.histogram.outcome_counts), 1);

  return (
    <div className="multi-run-panel">
      <h3 className="multi-run-panel__title">{t('multi_run.panel_title')}</h3>

      {/* Progress announcement area with aria-live polite */}
      <div
        className="multi-run-panel__progress"
        role="status"
        aria-live="polite"
      >
        {t('multi_run.progress_label', { current: finishedRuns, total: totalRuns })}
      </div>

      {/* Status summary line */}
      <div className="multi-run-status-summary">
        <span className="multi-run-status-summary__badge multi-run-status-summary__badge--pending">
          {t('multi_run.status_pending_badge')}: {data.pending_count}
        </span>
        <span className="multi-run-status-summary__separator"> · </span>
        <span className="multi-run-status-summary__badge multi-run-status-summary__badge--failed">
          {t('multi_run.status_failed_badge')}: {data.failed_count}
        </span>
        <span className="multi-run-status-summary__separator"> · </span>
        <span className="multi-run-status-summary__badge multi-run-status-summary__badge--completed">
          {t('multi_run.status_completed_badge')}: {data.terminal_count}
        </span>
      </div>

      {/* Only display histograms when all runs are completed */}
      {isAllCompleted ? (
        <div className="multi-run-histograms">
          {/* Verdict Distribution */}
          <div className="multi-run-histogram">
            <h4>
              {t('multi_run.histogram_verdicts', { count: data.terminal_count })}
              <span className="multi-run-histogram-denominator"> ({data.terminal_count} / {data.run_count})</span>
            </h4>
            <div className="multi-run-histogram-denominator-text">
              {t('multi_run.completed_runs_denominator', { completed: data.terminal_count, total: data.run_count })}
            </div>
            {Object.entries(data.histogram.verdict_counts).map(([verdict, count]) => {
              const percentage = (count / maxVerdictVal) * 100;
              const displayVerdict = verdict === 'unknown' ? t('multi_run.verdict_unknown') : verdict;
              return (
                <div key={verdict} className="multi-run-bar-wrapper">
                  <span className="multi-run-bar-label" title={displayVerdict}>
                    {displayVerdict}
                  </span>
                  <div className="multi-run-bar-container">
                    <div
                      className="multi-run-bar"
                      style={{ width: `${percentage}%` }}
                      role="img"
                      aria-label={t('multi_run.aria_histogram_bar', { label: displayVerdict, count })}
                    />
                  </div>
                  <span className="multi-run-bar-value">{count}</span>
                </div>
              );
            })}
          </div>

          {/* Outcome Distribution */}
          <div className="multi-run-histogram">
            <h4>
              {t('multi_run.histogram_outcomes', { count: data.terminal_count })}
              <span className="multi-run-histogram-denominator"> ({data.terminal_count} / {data.run_count})</span>
            </h4>
            <div className="multi-run-histogram-denominator-text">
              {t('multi_run.completed_runs_denominator', { completed: data.terminal_count, total: data.run_count })}
            </div>
            {Object.entries(data.histogram.outcome_counts).map(([outcome, count]) => {
              const percentage = (count / maxOutcomeVal) * 100;
              const displayOutcome = outcome === 'unknown' ? t('multi_run.outcome_unknown') : outcome;
              return (
                <div key={outcome} className="multi-run-bar-wrapper">
                  <span className="multi-run-bar-label" title={displayOutcome}>
                    {displayOutcome}
                  </span>
                  <div className="multi-run-bar-container">
                    <div
                      className="multi-run-bar"
                      style={{ width: `${percentage}%` }}
                      role="img"
                      aria-label={t('multi_run.aria_histogram_bar', { label: displayOutcome, count })}
                    />
                  </div>
                  <span className="multi-run-bar-value">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Runs Verdict Ledger */}
      <div className="multi-run-ledger">
        <h4>{t('multi_run.worldlines_list_title')}</h4>
        <div className="multi-run-table-wrapper">
          <table className="multi-run-table">
            <thead>
              <tr>
                <th>{t('multi_run.input_label')}</th>
                <th>{t('multi_run.status_label')}</th>
                <th>{t('multi_run.verdict_label')}</th>
                <th>{t('multi_run.outcome_label')}</th>
              </tr>
            </thead>
            <tbody>
              {data.runs && data.runs.map((run) => {
                const displayVerdict = run.verdict === null ? '—' : (run.verdict === 'unknown' ? t('multi_run.verdict_unknown') : run.verdict);
                const displayOutcome = run.outcome === null ? '—' : (run.outcome === 'unknown' ? t('multi_run.outcome_unknown') : run.outcome);
                const statusLower = run.status.toLowerCase();
                const displayStatus = t(`sim.status.${statusLower}`) || run.status;
                return (
                  <tr
                    key={run.scenario_id}
                    className={run.is_terminal_distribution_row ? 'multi-run-row--terminal' : 'multi-run-row--non-terminal'}
                  >
                    <td>
                      {t('multi_run.run_index', { index: run.run_index })}
                      {run.is_terminal_distribution_row && (
                        <span className="multi-run-row-indicator" title={t('multi_run.feeds_distribution')}>
                          {t('multi_run.feeds_distribution_short')}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`multi-run-status-badge multi-run-status-badge--${statusLower}`}>
                        {displayStatus}
                      </span>
                    </td>
                    <td>{displayVerdict}</td>
                    <td>{displayOutcome}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
