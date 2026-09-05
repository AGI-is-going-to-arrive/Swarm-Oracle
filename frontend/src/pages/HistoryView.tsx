/* ═══════════════════════════════════════════════════════════
   SwarmOracle — HistoryView (Scenario List & Management)
   ═══════════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback, useId, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { listScenarios, deleteScenario } from '../api/client';
import { stringifyAutomationPayload } from '../game/automation';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { buildAutomationErrorState, getApiErrorCode, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import type { ScenarioListItem } from '../api/client';
import './HistoryView.css';

const PAGE_SIZE = 12;
const STATUS_FILTERS = ['all', 'simulating', 'done', 'error'] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_BADGE_MAP: Record<string, string> = {
  parsing: 'badge-active',
  simulating: 'badge-active',
  narrating: 'badge-active',
  done: 'badge-done',
  error: 'badge-pruned',
};

export default function HistoryView() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const locale = i18n?.language === 'zh' ? 'zh-CN' : 'en';

  const [scenarios, setScenarios] = useState<ScenarioListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ code: string | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [cleanupPending, setCleanupPending] = useState(false);
  const [deleteError, setDeleteError] = useState<{ code: string | null } | null>(null);
  const mountedRef = useRef(false);
  const requestEpochRef = useRef(0);
  const deleteInFlightRef = useRef(false);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const activeFilterRef = useRef<HTMLButtonElement>(null);
  const deleteTitleId = useId();
  const deleteDescriptionId = useId();
  const loadErrorCode = loadError?.code ?? null;
  const loadErrorMessage = loadError
    ? getLocalizedApiErrorMessage(loadError, t, t('history.load_error'))
    : '';
  const deleteErrorMessage = deleteError
    ? getLocalizedApiErrorMessage(deleteError, t, t('history.delete_error'))
    : '';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const epoch = ++requestEpochRef.current;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const statusParam = filter === 'all' ? undefined : filter;
        const data = await listScenarios(statusParam, PAGE_SIZE, offset);
        if (epoch !== requestEpochRef.current) return;
        const nextTotal = data.total ?? 0;
        const lastOffset = Math.max(0, (Math.ceil(nextTotal / PAGE_SIZE) - 1) * PAGE_SIZE);
        if (offset > lastOffset) {
          requestEpochRef.current += 1;
          setOffset(lastOffset);
          return;
        }
        setScenarios(data.scenarios ?? []);
        setTotal(nextTotal);
      } catch (err) {
        if (epoch !== requestEpochRef.current) return;
        setLoadError({ code: getApiErrorCode(err) });
        setScenarios([]);
        setTotal(0);
      } finally {
        if (epoch === requestEpochRef.current) setLoading(false);
      }
    };
    void load();
    return () => {
      requestEpochRef.current += 1;
    };
  }, [filter, offset, refreshVersion]);

  const refresh = () => {
    requestEpochRef.current += 1;
    setLoading(true);
    setRefreshVersion((version) => version + 1);
  };

  const closeDelete = useCallback(() => {
    if (!deleteInFlightRef.current) setDeleteTarget(null);
  }, []);

  useFocusTrap(deleteDialogRef, deleteTarget !== null, true);

  useEffect(() => {
    if (deleteTarget) {
      cancelDeleteRef.current?.focus({ preventScroll: true });
    } else if (deleteTriggerRef.current) {
      if (!deleteTriggerRef.current.isConnected) {
        activeFilterRef.current?.focus({ preventScroll: true });
      }
      deleteTriggerRef.current = null;
    }
  }, [deleteTarget]);

  useEffect(() => {
    if (!deleteTarget) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      closeDelete();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeDelete, deleteTarget]);

  // Reset to page 1 when filter changes (avoid stale offset)
  const handleFilterChange = (f: StatusFilter) => {
    if (f === filter) return; // no-op
    requestEpochRef.current += 1;
    setFilter(f);
    setOffset(0);
  };

  const handleDelete = async () => {
    if (!deleteTarget || deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await deleteScenario(deleteTarget);
      if (!mountedRef.current) return;
      setCleanupPending(result.cleanup_pending === true);
      setDeleteTarget(null);
      // The effect refreshes the latest filter/page, including changes during deletion.
      refresh();
    } catch (err) {
      if (!mountedRef.current) return;
      setDeleteError({ code: getApiErrorCode(err) });
    } finally {
      deleteInFlightRef.current = false;
      if (mountedRef.current) setDeleting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  useEffect(() => {
    const win = window as Window & { render_game_to_text?: () => string };
    const render = () => stringifyAutomationPayload(
      {
        question: null,
        status: loading ? 'loading' : loadErrorMessage ? 'error' : 'idle',
        currentRound: 0,
        totalRounds: null,
        viewMode: 'classic',
        visualizationEnabled: false,
        isSimulationComplete: false,
        messageCount: 0,
        agentCount: 0,
        branchCount: scenarios.length,
      },
      null,
      {
        route: window.location.pathname,
        kind: 'history',
        loading,
        error: buildAutomationErrorState(loadErrorCode, loadErrorMessage),
        filter,
        total,
        current_page: currentPage,
        total_pages: totalPages,
        scenario_count: scenarios.length,
        scenarios: scenarios.slice(0, 8).map((scenario) => ({
          id: scenario.id,
          question: scenario.question,
          status: scenario.status,
          agent_count: scenario.agent_count,
        })),
      },
    );

    win.render_game_to_text = render;
    return () => {
      if (win.render_game_to_text === render) {
        delete win.render_game_to_text;
      }
    };
  }, [currentPage, filter, loadErrorCode, loadErrorMessage, loading, scenarios, total, totalPages]);

  return (
    <div className="history-view">
      {/* Header */}
      <header className="history-header">
        <button className="btn btn-ghost" onClick={() => navigate('/')}>
          {t('history.back')}
        </button>
        <h1 className="history-title">{t('history.title')}</h1>
        <p className="history-subtitle">{t('history.subtitle')}</p>
      </header>

      {/* Filters */}
      <div className="history-filters">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            ref={filter === f ? activeFilterRef : undefined}
            className={`filter-btn ${filter === f ? 'filter-btn--active' : ''}`}
            onClick={() => handleFilterChange(f)}
            aria-pressed={filter === f}
          >
            {t(`history.filter_${f}`)}
          </button>
        ))}
      </div>

      {cleanupPending && <p role="status">{t('history.delete_cleanup_pending')}</p>}

      {/* Content */}
      {loading ? (
        <div className="history-empty">
          <p>{t('sim.status.loading')}</p>
        </div>
      ) : loadErrorMessage ? (
        <div className="history-empty">
          <p className="result-error" role="alert">{loadErrorMessage}</p>
          <button className="btn" onClick={refresh}>
            {t('common.retry')}
          </button>
        </div>
      ) : scenarios.length === 0 ? (
        <div className="history-empty">
          <p>{t('history.empty')}</p>
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            {t('history.create_new')}
          </button>
        </div>
      ) : (
        <>
          <div className="history-grid">
            {scenarios.map((s, i) => (
              <article
                key={s.id}
                className="history-card"
                style={{ '--card-delay': `${i * 0.05}s` } as React.CSSProperties}
              >
                <div className="history-card__top">
                  <span className={`badge ${STATUS_BADGE_MAP[s.status] || 'badge-active'}`}>
                    {t(`history.status_${s.status}`)}
                  </span>
                  <button
                    className="history-card__delete"
                    title={t('history.delete')}
                    aria-label={`${t('history.delete')}: ${s.question}`}
                    onClick={(e) => {
                      deleteTriggerRef.current = e.currentTarget;
                      setDeleteTarget(s.id);
                      setDeleteError(null);
                    }}
                  >
                    ×
                  </button>
                </div>
                <h3 className="history-card__question">
                  <Link className="history-card__link" to={`/${s.status === 'done' ? 'result' : 'sim'}/${s.id}`}>
                    {s.question}
                  </Link>
                </h3>
                <div className="history-card__meta">
                  <span>{t('history.agents_count', { count: s.agent_count ?? 0 })}</span>
                  <span>
                    {s.created_at
                      ? new Date(s.created_at).toLocaleDateString(locale)
                      : '—'}
                  </span>
                </div>
              </article>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="history-pagination">
              <button
                className="btn btn-ghost"
                aria-label={t('history.previous_page')}
                disabled={currentPage <= 1}
                onClick={() => {
                  requestEpochRef.current += 1;
                  setOffset(Math.max(0, offset - PAGE_SIZE));
                }}
              >
                ←
              </button>
              <span className="pagination-info">
                {currentPage} / {totalPages}
              </span>
              <button
                className="btn btn-ghost"
                aria-label={t('history.next_page')}
                disabled={currentPage >= totalPages}
                onClick={() => {
                  requestEpochRef.current += 1;
                  setOffset(offset + PAGE_SIZE);
                }}
              >
                →
              </button>
            </div>
          )}
        </>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={closeDelete}>
          <div
            ref={deleteDialogRef}
            className="modal-content history-delete-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={deleteTitleId}
            aria-describedby={deleteDescriptionId}
            aria-busy={deleting}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={deleteTitleId} className="sr-only">{t('history.delete')}</h2>
            <p id={deleteDescriptionId} className="delete-confirm-text">{t('history.delete_confirm')}</p>
            {deleteErrorMessage && <p className="modal-error" role="alert">{deleteErrorMessage}</p>}
            <div className="modal-footer">
              <button
                ref={cancelDeleteRef}
                className="btn btn-ghost"
                onClick={closeDelete}
                disabled={deleting}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-danger"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? t('common.submitting') : t('history.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
