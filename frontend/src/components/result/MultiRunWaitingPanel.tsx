import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { getRunGroupDistribution } from '../../api/client';
import type { RunGroupDistributionResponse } from '../../types';
import './MultiRunWaitingPanel.css';

interface MultiRunWaitingPanelProps {
  runGroupId: string;
  /** Scenario id of the first (full) worldline — enables the "watch it unfold" entry. */
  firstRunId?: string;
}

const POLL_INTERVAL_MS = 2500;
const POLL_BACKOFF_MS = 5000;
const SLOW_HINT_AFTER_MS = 8000;
const MAX_POLLS = 200;

/**
 * Waiting-state panel for an in-progress multi-run (worldline) group.
 *
 * Replaces the bare "generating ending narratives…" text the result page used to
 * show while a multi-run was still simulating. It self-polls the run-group
 * distribution endpoint to surface live progress (X / N completed) so the user
 * knows the simulation IS running (not stuck), offers an entry to watch the first
 * worldline unfold in the live theater, and warns that local models can be slow.
 *
 * It does NOT drive the result page's own state — ResultView's retryTimer keeps
 * polling the first scenario and exits the loading state on its own once done.
 */
export function MultiRunWaitingPanel({ runGroupId, firstRunId }: MultiRunWaitingPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<RunGroupDistributionResponse | null>(null);
  const [slow, setSlow] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const pollCountRef = useRef(0);

  useEffect(() => {
    if (!runGroupId) return;
    // 每轮（切换 runGroupId / 手动重试）重置轮询计数与提示态——否则切换 group 后 pollCountRef
    // 会带着上一组的计数、可能立刻判定耗尽。codex 审查 L2。
    pollCountRef.current = 0;
    let active = true;
    let timer: number | undefined;
    // 提示态重置放进 0ms timer——避免在 effect body 同步 setState（react-hooks/set-state-in-effect）。
    const resetTimer = window.setTimeout(() => {
      if (active) {
        setSlow(false);
        setExhausted(false);
      }
    }, 0);

    const poll = async () => {
      try {
        pollCountRef.current += 1;
        const res = await getRunGroupDistribution(runGroupId);
        if (!active) return;
        setData(res);
        const allTerminal =
          Array.isArray(res.runs) &&
          res.runs.length > 0 &&
          res.runs.every((r) => {
            const s = r.status.toLowerCase();
            return s === 'done' || s === 'error' || s === 'cancelled';
          });
        // Keep polling until every worldline is terminal (ResultView will swap us
        // out for the full result once the first scenario reaches "done").
        if (allTerminal) return;
        if (pollCountRef.current < MAX_POLLS) {
          timer = window.setTimeout(poll, POLL_INTERVAL_MS);
        } else if (active) {
          // 达到轮询上限仍未收束：停止轮询并给出显式“仍在运行 / 可刷新”态，不再静默冻结。
          setExhausted(true);
        }
      } catch {
        if (!active) return;
        if (pollCountRef.current < MAX_POLLS) {
          timer = window.setTimeout(poll, POLL_BACKOFF_MS);
        } else {
          setExhausted(true);
        }
      }
    };

    void poll();
    const slowTimer = window.setTimeout(() => {
      if (active) setSlow(true);
    }, SLOW_HINT_AFTER_MS);

    return () => {
      active = false;
      clearTimeout(resetTimer);
      if (timer) clearTimeout(timer);
      clearTimeout(slowTimer);
    };
  }, [runGroupId, retryNonce]);

  const total = data?.run_count ?? 0;
  const pending = data?.pending_count ?? total;
  const finished = Math.max(0, total - pending);
  const failed = data?.failed_count ?? 0;
  const pct = total > 0 ? Math.round((finished / total) * 100) : 0;
  // Returning from any worldline we navigate into should land back on THIS
  // run-group result page (the waiting hub), not the home page.
  const backToResult = firstRunId ? `/result/${firstRunId}` : undefined;

  return (
    <div className="multi-run-waiting" role="status" aria-live="polite">
      <div className="multi-run-waiting__spinner" aria-hidden="true" />
      <h2 className="multi-run-waiting__title">
        {total > 0
          ? t('multi_run.waiting_title', { total })
          : t('multi_run.waiting_title_generic')}
      </h2>
      <p className="multi-run-waiting__subtitle">{t('multi_run.waiting_subtitle')}</p>

      <div className="multi-run-waiting__progress">
        <div
          className="multi-run-waiting__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className="multi-run-waiting__bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="multi-run-waiting__count">
          {t('multi_run.waiting_progress', { finished, total: total || '…' })}
          {failed > 0 && (
            <span className="multi-run-waiting__failed">
              {' '}· {t('multi_run.status_failed_badge')}: {failed}
            </span>
          )}
        </div>
      </div>

      {Array.isArray(data?.runs) && data.runs.length > 0 && (
        <div className="multi-run-waiting__worldlines-section">
          <h3 className="multi-run-waiting__worldlines-title">
            {t('multi_run.worldlines_list_title')}
          </h3>
          <ul className="multi-run-waiting__worldlines">
            {data.runs.map((r) => {
              const s = r.status.toLowerCase();
              const isFirst = r.run_index === 1;
              const isDone = s === 'done';
              const isFailed = s === 'error' || s === 'cancelled';
              const dotCls = isDone ? 'done' : isFailed ? 'failed' : 'pending';
              return (
                <li key={r.scenario_id} className="multi-run-waiting__worldline">
                  <span
                    className={`multi-run-waiting__dot multi-run-waiting__dot--${dotCls}`}
                    aria-hidden="true"
                  />
                  <span className="multi-run-waiting__worldline-label">
                    {t('multi_run.run_index', { index: r.run_index })}
                    <span className="multi-run-waiting__worldline-kind">
                      {isFirst
                        ? t('multi_run.run_full_sim_badge')
                        : t('multi_run.run_quick_verdict_badge')}
                    </span>
                  </span>
                  {!isFirst && isDone ? (
                    <button
                      type="button"
                      className="btn btn-ghost multi-run-waiting__worldline-action"
                      onClick={() => navigate(`/result/${r.scenario_id}`)}
                    >
                      {t('multi_run.view_worldline_result')}
                    </button>
                  ) : (
                    <span className="multi-run-waiting__worldline-status">
                      {isFailed
                        ? t('multi_run.status_failed_badge')
                        : isDone
                          ? t('multi_run.worldline_done')
                          : t('multi_run.worldline_simulating')}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {firstRunId && (
        <div className="multi-run-waiting__actions">
          <button
            type="button"
            className="btn btn-ghost multi-run-waiting__watch"
            onClick={() =>
              navigate(
                `/sim/${firstRunId}`,
                backToResult ? { state: { backTo: backToResult } } : undefined,
              )
            }
          >
            {t('multi_run.watch_first_run')}
          </button>
        </div>
      )}

      {slow && !exhausted && (
        <p className="multi-run-waiting__slow-hint">{t('multi_run.waiting_slow_hint')}</p>
      )}

      {exhausted && (
        <div className="multi-run-waiting__exhausted">
          <p className="multi-run-waiting__slow-hint">{t('multi_run.waiting_exhausted')}</p>
          <button
            type="button"
            className="btn btn-ghost multi-run-waiting__retry"
            onClick={() => setRetryNonce((n) => n + 1)}
          >
            {t('common.retry')}
          </button>
        </div>
      )}
    </div>
  );
}
