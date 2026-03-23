/* ═══════════════════════════════════════════════════════════
   SwarmOracle — HistoryView (Scenario List & Management)
   ═══════════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { listScenarios, deleteScenario } from '../api/client';
import { stringifyAutomationPayload } from '../game/automation';
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

  const [scenarios, setScenarios] = useState<ScenarioListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setLoadErrorCode(null);
    try {
      const statusParam = filter === 'all' ? undefined : filter;
      const data = await listScenarios(statusParam, PAGE_SIZE, offset);
      setScenarios(data.scenarios ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setLoadErrorCode(getApiErrorCode(err));
      setLoadError(getLocalizedApiErrorMessage(err, t, 'Failed to load scenarios'));
      setScenarios([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [filter, offset, i18n.language]);

  useEffect(() => {
    load();
  }, [load]);

  // Reset to page 1 when filter changes (avoid stale offset)
  const handleFilterChange = (f: StatusFilter) => {
    if (f === filter) return; // no-op
    setFilter(f);
    setOffset(0);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteScenario(deleteTarget);
      setDeleteTarget(null);
      // If we just deleted the last item on the current page, go back one page
      if (scenarios.length === 1 && offset > 0) {
        setOffset(Math.max(0, offset - PAGE_SIZE));
      } else {
        await load(); // refresh list
      }
    } catch (err) {
      setDeleteError(getLocalizedApiErrorMessage(err, t, 'Delete failed'));
    } finally {
      setDeleting(false);
    }
  };

  const handleCardClick = (s: ScenarioListItem) => {
    if (s.status === 'done') {
      navigate(`/result/${s.id}`);
    } else {
      navigate(`/sim/${s.id}`);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  useEffect(() => {
    const win = window as Window & { render_game_to_text?: () => string };
    const render = () => stringifyAutomationPayload(
      {
        question: null,
        status: loading ? 'loading' : loadError ? 'error' : 'idle',
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
        error: buildAutomationErrorState(loadErrorCode, loadError),
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
  }, [currentPage, filter, loadError, loadErrorCode, loading, scenarios, total, totalPages]);

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
            className={`filter-btn ${filter === f ? 'filter-btn--active' : ''}`}
            onClick={() => handleFilterChange(f)}
          >
            {t(`history.filter_${f}`)}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="history-empty">
          <p>{t('sim.status.loading')}</p>
        </div>
      ) : loadError ? (
        <div className="history-empty">
          <p className="result-error">{loadError}</p>
          <button className="btn" onClick={load}>
            ↺ Retry
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
                onClick={() => handleCardClick(s)}
              >
                <div className="history-card__top">
                  <span className={`badge ${STATUS_BADGE_MAP[s.status] || 'badge-active'}`}>
                    {s.status}
                  </span>
                  <button
                    className="history-card__delete"
                    title={t('history.delete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(s.id);
                      setDeleteError('');
                    }}
                  >
                    ×
                  </button>
                </div>
                <h3 className="history-card__question">{s.question}</h3>
                <div className="history-card__meta">
                  <span>{t('history.agents_count', { count: s.agent_count ?? 0 })}</span>
                  <span>
                    {s.created_at
                      ? new Date(s.created_at).toLocaleDateString()
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
                disabled={currentPage <= 1}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                ←
              </button>
              <span className="pagination-info">
                {currentPage} / {totalPages}
              </span>
              <button
                className="btn btn-ghost"
                disabled={currentPage >= totalPages}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                →
              </button>
            </div>
          )}
        </>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="modal-overlay" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="modal-content history-delete-modal" onClick={(e) => e.stopPropagation()}>
            <p className="delete-confirm-text">{t('history.delete_confirm')}</p>
            {deleteError && <p className="modal-error">{deleteError}</p>}
            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                {t('intervention.cancel')}
              </button>
              <button
                className="btn btn-danger"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? '...' : t('history.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
