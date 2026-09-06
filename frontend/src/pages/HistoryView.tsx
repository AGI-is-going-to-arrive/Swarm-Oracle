/* ═══════════════════════════════════════════════════════════
   SwarmOracle — HistoryView (Experiment List & Management)
   ═══════════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback, useId, useRef, type ReactElement, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { listExperiments, deleteScenario, deleteDebate } from '../api/client';
import { stringifyAutomationPayload } from '../game/automation';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { buildAutomationErrorState, getApiErrorCode, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import { formatUiDateTime } from '../i18n/language';
import type { ExperimentKind, ExperimentListItem, ExperimentStatus } from '../types';
import './HistoryView.css';

const PAGE_SIZE = 12;
const STATUS_FILTERS = ['all', 'running', 'done', 'error', 'cancelled'] as const;
const KIND_FILTERS = ['all', 'scenario', 'debate', 'roundtable'] as const;

type StatusFilter = ExperimentStatus | 'all';
type KindFilter = ExperimentKind | 'all';
type DeleteTarget = { id: string; kind: 'scenario' | 'debate'; question: string };

const STATUS_BADGE_MAP: Record<string, string> = {
  parsing: 'badge-active',
  simulating: 'badge-active',
  narrating: 'badge-active',
  done: 'badge-done',
  error: 'badge-pruned',
  running: 'badge-active',
  cancelled: 'badge-pruned',
};

function experimentPath(item: ExperimentListItem): string | null {
  const id = encodeURIComponent(item.id);
  if (item.kind === 'scenario') return `/${item.status === 'done' ? 'result' : 'sim'}/${id}`;
  if (item.kind === 'debate') return `/debate/${id}${item.status === 'done' ? '/result' : ''}`;
  return item.source_scenario_id
    ? `/roundtable/${encodeURIComponent(item.source_scenario_id)}?room_id=${id}`
    : null;
}

function canDelete(item: ExperimentListItem): boolean {
  return item.kind === 'debate' || (item.kind === 'scenario' && (
    item.status !== 'running' || item.source_status.toLowerCase() === 'parsing'
  ));
}

function statusLabel(item: ExperimentListItem): string {
  const source = item.source_status.toLowerCase();
  if (['draft', 'created'].includes(source)) return 'draft';
  if (['queued', 'pending'].includes(source)) return 'queued';
  if (['parsing', 'simulating', 'narrating'].includes(source)) return source;
  return item.status;
}

export default function HistoryView(): ReactElement {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [items, setItems] = useState<ExperimentListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ code: string | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
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
  const searchId = useId();
  const cursor = cursorHistory[pageIndex] ?? null;
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
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await listExperiments({
          kind, status: filter, q: query, limit: PAGE_SIZE, cursor, signal: controller.signal,
        });
        if (epoch !== requestEpochRef.current) return;
        const nextTotal = data.total ?? 0;
        const lastPage = Math.max(0, Math.ceil(nextTotal / PAGE_SIZE) - 1);
        if ((!data.items.length && pageIndex > 0) || pageIndex > lastPage) {
          requestEpochRef.current += 1;
          const previousPage = Math.min(pageIndex - 1, lastPage);
          setCursorHistory((history) => history.slice(0, previousPage + 1));
          setPageIndex(previousPage);
          return;
        }
        setItems(data.items);
        setTotal(nextTotal);
        setNextCursor(data.next_cursor);
      } catch (err) {
        if (epoch !== requestEpochRef.current) return;
        setLoadError({ code: getApiErrorCode(err) });
        setItems([]);
        setTotal(0);
        setNextCursor(null);
      } finally {
        if (epoch === requestEpochRef.current) setLoading(false);
      }
    };
    void load();
    return () => {
      controller.abort();
      requestEpochRef.current += 1;
    };
  }, [cursor, filter, kind, pageIndex, query, refreshVersion]);

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

  const resetPagination = () => {
    requestEpochRef.current += 1;
    setLoading(true);
    setCursorHistory([null]);
    setPageIndex(0);
    setNextCursor(null);
  };

  const handleFilterChange = (f: StatusFilter) => {
    if (f === filter) return; // no-op
    resetPagination();
    setFilter(f);
  };

  const handleDelete = async () => {
    if (!deleteTarget || deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = deleteTarget.kind === 'debate'
        ? await deleteDebate(deleteTarget.id)
        : await deleteScenario(deleteTarget.id);
      if (!mountedRef.current) return;
      setCleanupPending('cleanup_pending' in result && result.cleanup_pending === true);
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
  const currentPage = pageIndex + 1;

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
        branchCount: items.filter((item) => item.kind === 'scenario').length,
      },
      null,
      {
        route: window.location.pathname,
        kind: 'history',
        loading,
        error: buildAutomationErrorState(loadErrorCode, loadErrorMessage),
        filter,
        experiment_kind: kind,
        query,
        total,
        current_page: currentPage,
        total_pages: totalPages,
        experiment_count: items.length,
        experiments: items.slice(0, 8).map((item) => ({
          id: item.id, kind: item.kind, question: item.question,
          status: item.status, source_status: item.source_status,
        })),
        scenario_count: items.filter((item) => item.kind === 'scenario').length,
        scenarios: items.filter((item) => item.kind === 'scenario').slice(0, 8),
      },
    );

    win.render_game_to_text = render;
    return () => {
      if (win.render_game_to_text === render) {
        delete win.render_game_to_text;
      }
    };
  }, [currentPage, filter, kind, query, loadErrorCode, loadErrorMessage, loading, items, total, totalPages]);

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

      <form className="history-search" onSubmit={(event) => {
        event.preventDefault();
        const nextQuery = searchDraft.trim();
        if (nextQuery === query) return;
        resetPagination();
        setQuery(nextQuery);
      }}>
        <label htmlFor={searchId} className="sr-only">{t('history.search_label')}</label>
        <input id={searchId} type="search" value={searchDraft}
          placeholder={t('history.search_placeholder')}
          onChange={(event) => setSearchDraft(event.target.value)} />
        <button className="btn" type="submit">{t('history.search')}</button>
        {query && <button className="btn btn-ghost" type="button" onClick={() => {
          resetPagination();
          setSearchDraft('');
          setQuery('');
        }}>{t('history.clear_search')}</button>}
        <button className="btn btn-ghost" type="button" onClick={refresh}>{t('history.refresh')}</button>
      </form>

      {/* Filters */}
      <div className="history-filters" role="group" aria-label={t('history.type_filter_label')}>
        {KIND_FILTERS.map((itemKind) => (
          <button key={itemKind} className={`filter-btn ${kind === itemKind ? 'filter-btn--active' : ''}`}
            aria-pressed={kind === itemKind} onClick={() => {
              if (itemKind === kind) return;
              resetPagination();
              setKind(itemKind);
            }}>{t(`history.type_${itemKind}`)}</button>
        ))}
      </div>
      <div className="history-filters" role="group" aria-label={t('history.status_filter_label')}>
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
      {!loading && !loadError && <p className="history-results-count" aria-live="polite">
        {t('history.results_count', { count: total })}
      </p>}

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
      ) : items.length === 0 ? (
        <div className="history-empty">
          <p>{t(query || kind !== 'all' || filter !== 'all' ? 'history.no_matches' : 'history.empty')}</p>
          {query || kind !== 'all' || filter !== 'all' ? (
            <button className="btn" onClick={() => {
              resetPagination(); setKind('all'); setFilter('all'); setQuery(''); setSearchDraft('');
            }}>{t('history.clear_filters')}</button>
          ) : <button className="btn btn-primary" onClick={() => navigate('/')}>
            {t('history.create_new')}
          </button>}
        </div>
      ) : (
        <>
          <div className="history-grid">
            {items.map((item, i) => {
              const path = experimentPath(item);
              const label = statusLabel(item);
              const badgeClass = label === 'draft' || label === 'queued'
                ? 'history-card__pending-status' : STATUS_BADGE_MAP[item.status];
              return (
              <article
                key={`${item.kind}:${item.id}`}
                className="history-card"
                style={{ '--card-delay': `${i * 0.05}s` } as CSSProperties}
              >
                <div className="history-card__top">
                  <div className="history-card__badges">
                    <span className="history-card__kind">{t(`history.type_${item.kind}`)}</span>
                    <span className={`badge ${badgeClass}`}>
                      {t(`history.status_${label}`)}
                    </span>
                  </div>
                  {canDelete(item) && item.kind !== 'roundtable' && <button
                    className="history-card__delete"
                    title={t('history.delete')}
                    aria-label={`${t('history.delete')}: ${item.title || item.question}`}
                    onClick={(e) => {
                      if (item.kind === 'roundtable') return;
                      deleteTriggerRef.current = e.currentTarget;
                      setDeleteTarget({ id: item.id, kind: item.kind, question: item.question });
                      setDeleteError(null);
                    }}
                  >
                    ×
                  </button>}
                </div>
                <h3 className="history-card__question">
                  {path ? <Link className="history-card__link" to={path}>
                    {item.title || item.question}
                  </Link> : item.title || item.question}
                </h3>
                {item.title && item.title !== item.question && <p className="history-card__context">{item.question}</p>}
                {item.models.length > 0 && <ul className="history-card__models">
                  {item.models.map((model, index) => <li key={`${model.role ?? ''}:${index}`}>
                    <span>{model.role && `${t(`history.model_role_${model.role}`)} · `}{model.name}</span>
                    <span className="history-card__model-id">{model.model}</span>
                    {model.binding_status === 'current_profile' && <span>
                      {t('history.currentProfileHistoricalModelUnknown')}
                    </span>}
                  </li>)}
                </ul>}
                {item.kind === 'roundtable' && (item.source_scenario_id ? (
                  <Link className="history-card__source" to={`/sim/${encodeURIComponent(item.source_scenario_id)}`}>
                    {t('history.open_source')}
                  </Link>
                ) : <p className="history-card__context">{t('history.source_unavailable')}</p>)}
                <div className="history-card__meta">
                  <span>
                    {item.created_at
                      ? formatUiDateTime(item.created_at, i18n?.language)
                      : '—'}
                  </span>
                </div>
              </article>
              );
            })}
          </div>

          {/* Pagination */}
          {(pageIndex > 0 || nextCursor) && (
            <div className="history-pagination">
              <button
                className="btn btn-ghost"
                aria-label={t('history.previous_page')}
                disabled={currentPage <= 1}
                onClick={() => {
                  requestEpochRef.current += 1;
                  setLoading(true);
                  setPageIndex(Math.max(0, pageIndex - 1));
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
                disabled={!nextCursor}
                onClick={() => {
                  if (!nextCursor) return;
                  requestEpochRef.current += 1;
                  setLoading(true);
                  setCursorHistory((history) => [...history.slice(0, pageIndex + 1), nextCursor]);
                  setPageIndex(pageIndex + 1);
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
            <p id={deleteDescriptionId} className="delete-confirm-text">
              {t(deleteTarget.kind === 'debate' ? 'history.delete_confirm_debate' : 'history.delete_confirm')}
            </p>
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
