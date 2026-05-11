/* ═══════════════════════════════════════════════════════════
   Personal Prediction Journal — Page
   Bento-box layout: Forecast Lab (left), Agent Roster
   (right-top), Worldline Map (right-bottom). Mobile collapses
   to a single-column stack.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  createJournalEntry,
  getJournalCalibration,
  isApiError,
  listJournalEntries,
  resolveJournalEntry,
  type CalibrationBin,
  type JournalEntry,
} from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import AgentRosterPanel from '../components/Journal/AgentRosterPanel';
import CalibrationCurveChart from '../components/Journal/CalibrationCurveChart';
import WorldlineMapMini from '../components/Journal/WorldlineMapMini';

import './PersonalJournalView.css';

interface FormState {
  question: string;
  predictedProbability: string;
  scenarioId: string;
}

const INITIAL_FORM: FormState = {
  question: '',
  predictedProbability: '0.5',
  scenarioId: '',
};

function formatProbability(value: number, locale: string): string {
  if (!Number.isFinite(value)) return '—';
  try {
    return value.toLocaleString(locale, {
      style: 'percent',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    });
  } catch {
    return `${Math.round(value * 100)}%`;
  }
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function logUnexpectedJournalError(context: string, err: unknown) {
  if (err instanceof Error) {
    console.debug(`[PersonalJournalView] ${context} failed`, err);
  }
}

export function PersonalJournalView() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en';

  // Journal capability is optional — if the backend exposes a flag we honour
  // it, otherwise we render unconditionally. Falling back to truthy when the
  // server hasn't added the key yet keeps the page usable in dev.
  const capability = useCapabilityCheck('prediction_journal');
  const { loading: capLoading, enabled: capEnabled, error: capError } = capability;
  // Treat capability probe failures as "open" rather than blocking the page
  // outright — the journal endpoints have their own auth gate.
  const featureGated = !capLoading && !capEnabled && !capError;

  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [bins, setBins] = useState<CalibrationBin[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const fetchSeqRef = useRef(0);
  const activeFetchControllerRef = useRef<AbortController | null>(null);

  const fetchAll = useCallback(
    async () => {
      const requestSeq = fetchSeqRef.current + 1;
      fetchSeqRef.current = requestSeq;
      activeFetchControllerRef.current?.abort();
      const controller = new AbortController();
      activeFetchControllerRef.current = controller;
      const isStaleRequest = () =>
        requestSeq !== fetchSeqRef.current || controller.signal.aborted;

      setLoadError(null);
      try {
        const [list, calibration] = await Promise.all([
          listJournalEntries({ signal: controller.signal }),
          getJournalCalibration({ signal: controller.signal }),
        ]);
        if (isStaleRequest()) return;
        setEntries(Array.isArray(list?.items) ? list.items : []);
        setBins(Array.isArray(calibration?.bins) ? calibration.bins : []);
      } catch (err) {
        if (isStaleRequest()) return;
        logUnexpectedJournalError('Load', err);
        setLoadError('journal.entries.load_failed');
      } finally {
        if (requestSeq === fetchSeqRef.current) {
          activeFetchControllerRef.current = null;
          setLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (capLoading || featureGated) return;
    setLoading(true);
    void fetchAll();
    return () => {
      fetchSeqRef.current += 1;
      activeFetchControllerRef.current?.abort();
      activeFetchControllerRef.current = null;
    };
  }, [capLoading, featureGated, fetchAll]);

  const stats = useMemo(() => {
    const resolved = entries.filter(
      (e) => e.actual_outcome !== null && Number.isFinite(e.brier_score),
    );
    const brier =
      resolved.length === 0
        ? null
        : resolved.reduce((sum, e) => sum + (e.brier_score ?? 0), 0) / resolved.length;
    return {
      total: entries.length,
      resolved: resolved.length,
      pending: entries.length - resolved.length,
      brier,
    };
  }, [entries]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const probability = Number.parseFloat(form.predictedProbability);
      if (
        !form.question.trim() ||
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1
      ) {
        setError(t('journal.form.invalid', 'Question and a probability between 0 and 1 are required.'));
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        await createJournalEntry({
          question: form.question.trim(),
          predicted_probability: probability,
          scenario_id: form.scenarioId.trim() || null,
        });
        setForm(INITIAL_FORM);
        setRefreshing(true);
        await fetchAll();
      } catch (err) {
        logUnexpectedJournalError('Create entry', err);
        setError(t('journal.form.create_failed', 'Could not log forecast. Please retry.'));
      } finally {
        setSubmitting(false);
        setRefreshing(false);
      }
    },
    [fetchAll, form, t],
  );

  const handleResolve = useCallback(
    async (entry: JournalEntry, outcome: boolean) => {
      setResolvingId(entry.id);
      setError(null);
      try {
        await resolveJournalEntry(entry.id, { actual_outcome: outcome });
        await fetchAll();
      } catch (err) {
        logUnexpectedJournalError('Resolve entry', err);
        setError(
          isApiError(err) && err.code === 'JOURNAL_ENTRY_ALREADY_RESOLVED'
            ? t('journal.entry.already_resolved', 'This forecast has already been resolved.')
            : t('journal.entry.resolve_failed', 'Could not resolve forecast. Please retry.'),
        );
      } finally {
        setResolvingId(null);
      }
    },
    [fetchAll, t],
  );

  const handleRetryLoad = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchAll();
    } finally {
      setRefreshing(false);
    }
  }, [fetchAll]);

  if (capLoading) {
    return (
      <main className="journal-view journal-view--centered" aria-busy="true">
        <p>{t('journal.loading_capability', 'Checking journal access…')}</p>
      </main>
    );
  }

  if (featureGated) {
    return (
      <main className="journal-view journal-view--centered">
        <p className="journal-view__muted">
          {t(
            'journal.feature_disabled',
            'Personal Prediction Journal is not enabled on this server.',
          )}
        </p>
        <Link to="/" className="journal-link">
          {t('common.back_home', 'Back to Home')}
        </Link>
      </main>
    );
  }

  return (
    <main className="journal-view" aria-labelledby="journal-page-title">
      <header className="journal-view__header">
        <div>
          <h1 id="journal-page-title">
            {t('journal.title', 'Prediction Journal')}
          </h1>
          <p className="journal-view__subtitle">
            {t(
              'journal.subtitle',
              'Track your forecasts, score them when reality lands, and watch your calibration drift.',
            )}
          </p>
        </div>
        <Link to="/" className="journal-link journal-link--ghost">
          {t('common.back_home', 'Back to Home')}
        </Link>
      </header>

      {error && (
        <div role="alert" className="journal-alert journal-alert--error">
          {error}
        </div>
      )}

      <div className="journal-grid">
        {/* ── Forecast Lab (left) ───────────────────── */}
        <section
          className="journal-card journal-card--lab"
          aria-labelledby="journal-lab-title"
        >
          <header className="journal-card__head">
            <h2 id="journal-lab-title">{t('journal.lab.title', 'Forecast Lab')}</h2>
            {refreshing && (
              <span className="journal-card__hint" aria-live="polite">
                {t('common.refreshing', 'Refreshing…')}
              </span>
            )}
          </header>

          <div className="journal-stats" role="list">
            <div className="journal-stat" role="listitem">
              <span className="journal-stat__value">{stats.total}</span>
              <span className="journal-stat__label">
                {t('journal.stats.total', 'Total forecasts')}
              </span>
            </div>
            <div className="journal-stat" role="listitem">
              <span className="journal-stat__value">{stats.resolved}</span>
              <span className="journal-stat__label">
                {t('journal.stats.resolved', 'Resolved')}
              </span>
            </div>
            <div className="journal-stat" role="listitem">
              <span className="journal-stat__value">{stats.pending}</span>
              <span className="journal-stat__label">
                {t('journal.stats.pending', 'Pending')}
              </span>
            </div>
            <div className="journal-stat" role="listitem">
              <span className="journal-stat__value">
                {stats.brier == null ? '—' : stats.brier.toFixed(3)}
              </span>
              <span className="journal-stat__label">
                {t('journal.stats.brier', 'Avg Brier')}
              </span>
            </div>
          </div>

          <CalibrationCurveChart bins={bins} />

          <form className="journal-form" onSubmit={handleSubmit} aria-label={t('journal.form.aria', 'Log a new forecast')}>
            <div className="journal-form__field">
              <label className="journal-form__label" htmlFor="journal-question">
                {t('journal.form.question', 'Question')}
              </label>
              <textarea
                id="journal-question"
                className="journal-form__textarea"
                rows={2}
                maxLength={400}
                value={form.question}
                onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))}
                required
              />
            </div>
            <div className="journal-form__row">
              <div className="journal-form__field">
                <label className="journal-form__label" htmlFor="journal-probability">
                  {t('journal.form.probability', 'Predicted probability (0–1)')}
                </label>
                <input
                  id="journal-probability"
                  className="journal-form__input"
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.predictedProbability}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, predictedProbability: e.target.value }))
                  }
                  required
                />
              </div>
              <div className="journal-form__field">
                <label className="journal-form__label" htmlFor="journal-scenario">
                  {t('journal.form.scenario_optional', 'Scenario ID (optional)')}
                </label>
                <input
                  id="journal-scenario"
                  className="journal-form__input"
                  type="text"
                  maxLength={64}
                  value={form.scenarioId}
                  onChange={(e) => setForm((f) => ({ ...f, scenarioId: e.target.value }))}
                />
              </div>
            </div>
            <button
              type="submit"
              className="journal-button journal-button--primary"
              disabled={submitting}
            >
              {submitting
                ? t('common.saving', 'Saving…')
                : t('journal.form.submit', 'Log forecast')}
            </button>
          </form>

          <section
            className="journal-entries"
            aria-labelledby="journal-entries-title"
          >
            <h3 id="journal-entries-title" className="journal-entries__title">
              {t('journal.entries.title', 'Recent forecasts')}
            </h3>
            {loading ? (
              <p>{t('common.loading', 'Loading…')}</p>
            ) : loadError ? (
              <div role="alert" className="journal-alert journal-alert--error">
                <p>
                  {loadError === 'journal.entries.load_failed'
                    ? t(loadError, 'Could not load forecasts. Please retry.')
                    : loadError}
                </p>
                <button
                  type="button"
                  className="journal-button journal-button--secondary"
                  disabled={refreshing}
                  onClick={() => void handleRetryLoad()}
                >
                  {refreshing
                    ? t('common.refreshing', 'Refreshing…')
                    : t('common.retry', 'Retry')}
                </button>
              </div>
            ) : entries.length === 0 ? (
              <p className="journal-view__muted">
                {t(
                  'journal.entries.empty',
                  'No forecasts yet. Log your first prediction above.',
                )}
              </p>
            ) : (
              <ul className="journal-entries__list">
                {entries.map((entry) => {
                  const resolved = entry.actual_outcome !== null;
                  const isResolving = resolvingId === entry.id;
                  return (
                    <li key={entry.id} className="journal-entry">
                      <div className="journal-entry__head">
                        <p className="journal-entry__question">{entry.question}</p>
                        <span
                          className={`journal-entry__badge journal-entry__badge--${
                            resolved ? 'resolved' : 'pending'
                          }`}
                        >
                          {resolved
                            ? t('journal.entry.resolved', 'Resolved')
                            : t('journal.entry.pending', 'Pending')}
                        </span>
                      </div>
                      <dl className="journal-entry__meta">
                        <div>
                          <dt>{t('journal.entry.predicted', 'Predicted')}</dt>
                          <dd>{formatProbability(entry.predicted_probability, locale)}</dd>
                        </div>
                        <div>
                          <dt>{t('journal.entry.created', 'Logged')}</dt>
                          <dd>{formatDate(entry.created_at, locale)}</dd>
                        </div>
                        {resolved && (
                          <>
                            <div>
                              <dt>{t('journal.entry.outcome', 'Outcome')}</dt>
                              <dd>
                                {entry.actual_outcome
                                  ? t('journal.entry.outcome_yes', 'Happened')
                                  : t('journal.entry.outcome_no', 'Did not happen')}
                              </dd>
                            </div>
                            <div>
                              <dt>{t('journal.entry.brier', 'Brier')}</dt>
                              <dd>
                                {entry.brier_score == null
                                  ? '—'
                                  : entry.brier_score.toFixed(3)}
                              </dd>
                            </div>
                          </>
                        )}
                      </dl>
                      {!resolved && (
                        <div className="journal-entry__actions">
                          <button
                            type="button"
                            className="journal-button journal-button--secondary"
                            disabled={isResolving}
                            onClick={() => handleResolve(entry, true)}
                          >
                            {t('journal.entry.mark_yes', 'Mark as happened')}
                          </button>
                          <button
                            type="button"
                            className="journal-button journal-button--secondary"
                            disabled={isResolving}
                            onClick={() => handleResolve(entry, false)}
                          >
                            {t('journal.entry.mark_no', 'Mark as did not happen')}
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </section>

        {/* ── Right column: Agent Roster + Worldline Map ─────── */}
        <aside className="journal-side" aria-label={t('journal.side.aria', 'Roster and worldline panels')}>
          <section
            className="journal-card journal-card--roster"
            aria-labelledby="journal-roster-title"
          >
            <header className="journal-card__head">
              <h2 id="journal-roster-title">
                {t('journal.roster.title', 'Agent Roster')}
              </h2>
            </header>
            {/*
              TODO(sprint-7): wire AgentRosterPanel to real data.
              Needs: per-identity growth events from
              `GET /api/agents/identities/{id}/growth-events`
              (see backend/app/api/agents.py). The panel currently
              renders an empty state because no `events` / `identities`
              props are passed. Owner of `agent_identity` capability
              should aggregate the user's favorite/attached identities,
              fan out the growth-events fetch, and pass them in.
            */}
            <AgentRosterPanel />
          </section>

          <section
            className="journal-card journal-card--worldline"
            aria-labelledby="journal-worldline-title"
          >
            <header className="journal-card__head">
              <h2 id="journal-worldline-title">
                {t('journal.worldline.title', 'Worldline Map')}
              </h2>
            </header>
            {/*
              TODO(sprint-7): wire WorldlineMapMini to real data.
              Needs: branch seeds for the user's recent scenarios.
              Source = `Scenario.branches` (see backend/app/models)
              flattened into `WorldlineBranchSeed[]`
              ({ id, parentId, label?, depth? }). No journal-scoped
              endpoint exists yet — either reuse `getScenario` per
              recent scenario (N small fetches) or add a thin
              `/api/journal/branches` aggregate. Until then this is
              a placeholder thumbnail.
            */}
            <WorldlineMapMini />
            <p className="journal-card__caption">
              {t(
                'journal.worldline.caption',
                'Branch thumbnail of the latest scenarios you have explored.',
              )}
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}

export default PersonalJournalView;
