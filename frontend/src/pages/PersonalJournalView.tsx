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
  getIdentityGrowthEvents,
  getJournalCalibration,
  getScenario,
  isApiError,
  listAgentIdentities,
  listJournalEntries,
  resolveJournalEntry,
  getSessionBoundUserId,
  type CalibrationBin,
  type JournalEntry,
} from '../api/client';
import type { AgentIdentityInfo, AgentGrowthEvent, Scenario } from '../types';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import AgentRosterPanel, {
  type AgentRosterEntry,
} from '../components/Journal/AgentRosterPanel';
import CalibrationCurveChart from '../components/Journal/CalibrationCurveChart';
import WorldlineMapMini, {
  type WorldlineBranchSeed,
} from '../components/Journal/WorldlineMapMini';

import './PersonalJournalView.css';

/**
 * Upper bound on how many identities we fan out growth-event fetches to. This
 * only bounds the number of concurrent network requests — it is NOT a recency
 * filter. `listAgentIdentities` returns identities with no ordering guarantee,
 * so we must aggregate events across every fetched identity and sort by
 * `created_at` afterwards; truncating identities before fetching would silently
 * drop the newest events when a recent identity happens to sort late.
 */
const ROSTER_IDENTITY_FANOUT_CAP = 50;
/** Cap how many growth events the roster timeline renders, newest first. */
const ROSTER_EVENT_LIMIT = 24;
/** Cap how many recent scenarios feed the worldline thumbnail. */
const WORLDLINE_SCENARIO_LIMIT = 3;
/** Cap total branch nodes in the worldline thumbnail to keep the SVG legible. */
const WORLDLINE_BRANCH_LIMIT = 40;

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

/** Newest-first ordering for ISO timestamps; nulls sort last. */
function compareIsoDesc(a: string | null, b: string | null): number {
  const ta = a ? new Date(a).getTime() : NaN;
  const tb = b ? new Date(b).getTime() : NaN;
  const va = Number.isNaN(ta) ? -Infinity : ta;
  const vb = Number.isNaN(tb) ? -Infinity : tb;
  return vb - va;
}

/**
 * Flatten growth events from every identity into roster timeline entries.
 * Each event becomes one row tagged with its owning identity's display name.
 * `contextLabel` is a translated, scenario-agnostic caption (growth events do
 * not carry a human-readable scenario title in their payload).
 */
function mapGrowthEventsToRoster(
  pairs: Array<{ identity: AgentIdentityInfo; events: AgentGrowthEvent[] }>,
  contextLabel: string,
): AgentRosterEntry[] {
  const entries: AgentRosterEntry[] = [];
  for (const { identity, events } of pairs) {
    for (const event of events) {
      entries.push({
        id: `${identity.id}:${event.id}`,
        agentName: identity.display_name || identity.role || identity.id,
        scenario: contextLabel,
        date: event.created_at ?? '',
        insight: event.summary || undefined,
      });
    }
  }
  entries.sort((a, b) => compareIsoDesc(a.date || null, b.date || null));
  return entries.slice(0, ROSTER_EVENT_LIMIT);
}

/** Flatten a scenario's branch tree into worldline seeds for the mini map. */
function mapScenariosToBranchSeeds(scenarios: Scenario[]): WorldlineBranchSeed[] {
  const seeds: WorldlineBranchSeed[] = [];
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    const branches = Array.isArray(scenario.branches) ? scenario.branches : [];
    if (branches.length === 0) continue;
    // Scope ids per scenario so branch ids can't collide across scenarios, and
    // so each scenario's tree stays self-rooted in the thumbnail.
    const ids = new Set(branches.map((b) => b.id));
    for (const branch of branches) {
      const scopedId = `${scenario.id}:${branch.id}`;
      if (seen.has(scopedId)) continue;
      seen.add(scopedId);
      // Re-parent only when the parent lives in this same scenario; otherwise
      // treat the branch as a root so orphaned children still render.
      const parentInScope =
        branch.parent_branch_id && ids.has(branch.parent_branch_id)
          ? `${scenario.id}:${branch.parent_branch_id}`
          : null;
      seeds.push({
        id: scopedId,
        parentId: parentInScope,
        label: branch.title || undefined,
        depth: typeof branch.fork_round === 'number' ? branch.fork_round : undefined,
      });
    }
  }
  // Truncate to keep the SVG legible, then repair any child whose parent fell
  // outside the surviving slice. Leaving a dangling parentId would orphan the
  // node and break the tidy-tree layout, so demote such nodes to roots.
  const truncated = seeds.slice(0, WORLDLINE_BRANCH_LIMIT);
  const survivingIds = new Set(truncated.map((seed) => seed.id));
  return truncated.map((seed) =>
    seed.parentId != null && !survivingIds.has(seed.parentId)
      ? { ...seed, parentId: null }
      : seed,
  );
}

export function PersonalJournalView() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en';

  // i18next recreates `t` on every render, so reading it directly inside the
  // side-panel data effects would re-trigger them on every render. Keep the
  // latest `t` in a ref and depend only on capability state in those effects.
  const tRef = useRef(t);
  tRef.current = t;

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

  // Side panels. `undefined` means "still loading / not yet fetched" so the
  // panels show their own neutral state; an empty array is a real empty state.
  // A separate `*Error` flag lets the panels distinguish a failed fetch from a
  // genuine empty result so the user can tell them apart and retry.
  const [rosterEntries, setRosterEntries] = useState<AgentRosterEntry[] | undefined>(undefined);
  const [rosterError, setRosterError] = useState(false);
  const [worldlineBranches, setWorldlineBranches] = useState<
    WorldlineBranchSeed[] | undefined
  >(undefined);
  const [worldlineError, setWorldlineError] = useState(false);
  // Sequence guards so a retry's response can't be clobbered by a slower,
  // superseded fetch (mirrors the journal-list fetchSeqRef pattern).
  const rosterSeqRef = useRef(0);
  const worldlineSeqRef = useRef(0);

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

  // ── Agent Roster: aggregate the user's identities, fan out growth events ──
  // Best-effort: a per-identity growth-event failure is swallowed, but a hard
  // failure (identity list rejects) surfaces an explicit error state with retry
  // rather than masquerading as a real empty roster.
  const loadRoster = useCallback(async () => {
    const requestSeq = rosterSeqRef.current + 1;
    rosterSeqRef.current = requestSeq;
    const isStale = () => requestSeq !== rosterSeqRef.current;
    // Reuse the inspector's existing growth-event label as the per-row caption.
    const contextLabel = tRef.current('identity_inspector.type_growth', 'Growth event');

    setRosterError(false);
    setRosterEntries(undefined);
    try {
      const userId = getSessionBoundUserId();
      const identities = await listAgentIdentities<AgentIdentityInfo[]>(userId);
      if (isStale()) return;
      // `listAgentIdentities` has no ordering guarantee. If identities carry a
      // `created_at`, sort newest-first BEFORE the fanout cap so a >50-identity
      // user keeps their most recent identities (older ones drop off the tail)
      // rather than losing whichever the server happened to return last. When
      // no usable timestamp exists we cannot establish a stable recency key, so
      // we keep the server order and rely solely on the cap.
      const all = Array.isArray(identities) ? identities : [];
      const hasTimestamps = all.some(
        (identity) => identity?.created_at && !Number.isNaN(new Date(identity.created_at).getTime()),
      );
      const ordered = hasTimestamps
        ? [...all].sort((a, b) => compareIsoDesc(a?.created_at ?? null, b?.created_at ?? null))
        : all;
      // Bound the network fanout only; per-event recency is still decided after
      // aggregating every fetched identity's events (see mapGrowthEventsToRoster).
      const list = ordered.slice(0, ROSTER_IDENTITY_FANOUT_CAP);
      if (list.length === 0) {
        setRosterEntries([]);
        return;
      }
      // Fan out growth-event fetches; one failing identity must not nuke the
      // whole roster, so swallow per-identity rejections into empty events.
      // All events are aggregated then sorted newest-first before truncation.
      const settled = await Promise.all(
        list.map(async (identity) => {
          try {
            const res = await getIdentityGrowthEvents(identity.id, userId);
            return {
              identity,
              events: Array.isArray(res?.events) ? res.events : [],
            };
          } catch (err) {
            logUnexpectedJournalError(`Roster growth events (${identity.id})`, err);
            return { identity, events: [] as AgentGrowthEvent[] };
          }
        }),
      );
      if (isStale()) return;
      setRosterEntries(mapGrowthEventsToRoster(settled, contextLabel));
    } catch (err) {
      if (isStale()) return;
      logUnexpectedJournalError('Roster identities', err);
      // Surface an explicit error (with retry) instead of a fake empty state.
      setRosterEntries(undefined);
      setRosterError(true);
    }
  }, []);

  useEffect(() => {
    if (capLoading || featureGated) return;
    void loadRoster();
    return () => {
      // Invalidate any in-flight roster fetch so a late response can't write
      // into a unmounted / superseded view.
      rosterSeqRef.current += 1;
    };
  }, [capLoading, featureGated, loadRoster]);

  // Distinct scenario ids drawn from the user's most recent journal entries,
  // newest first. Drives which scenarios feed the worldline thumbnail.
  const recentScenarioIds = useMemo(() => {
    const ordered = [...entries].sort((a, b) => compareIsoDesc(a.created_at, b.created_at));
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const entry of ordered) {
      const sid = entry.scenario_id?.trim();
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      ids.push(sid);
      if (ids.length >= WORLDLINE_SCENARIO_LIMIT) break;
    }
    return ids;
  }, [entries]);

  // Stable key so the worldline effect only refetches when the actual set of
  // recent scenario ids changes, not on every entries array identity change.
  const recentScenarioKey = recentScenarioIds.join('|');

  // ── Worldline Map: flatten recent scenarios' branch trees into seeds ──
  // `recentScenarioIdsRef` lets the stable `loadWorldline` callback read the
  // latest ids without being re-created (and re-triggering the effect) every
  // time the derived ids array identity changes.
  const recentScenarioIdsRef = useRef(recentScenarioIds);
  recentScenarioIdsRef.current = recentScenarioIds;

  const loadWorldline = useCallback(async () => {
    const ids = recentScenarioIdsRef.current;
    const requestSeq = worldlineSeqRef.current + 1;
    worldlineSeqRef.current = requestSeq;
    const isStale = () => requestSeq !== worldlineSeqRef.current;

    setWorldlineError(false);
    // No scenario-linked forecasts yet → real empty state for the map.
    if (ids.length === 0) {
      setWorldlineBranches([]);
      return;
    }
    // A fetch is starting (e.g. journal entries just loaded and surfaced new
    // scenario ids). Return to the loading state so the panel shows its
    // skeleton rather than briefly keeping a prior empty/stale thumbnail.
    setWorldlineBranches(undefined);

    try {
      let anyFailed = false;
      const scenarios = await Promise.all(
        ids.map(async (sid) => {
          try {
            return await getScenario(sid);
          } catch (err) {
            // Deleted / inaccessible scenarios simply contribute no branches.
            anyFailed = true;
            logUnexpectedJournalError(`Worldline scenario (${sid})`, err);
            return null;
          }
        }),
      );
      if (isStale()) return;
      const resolved = scenarios.filter((s): s is Scenario => s != null);
      // If we had scenarios to fetch but none resolved, the fetch genuinely
      // failed — surface an error + retry instead of an indistinguishable
      // empty thumbnail. A partial failure still renders the survivors.
      if (resolved.length === 0 && anyFailed) {
        setWorldlineBranches(undefined);
        setWorldlineError(true);
        return;
      }
      setWorldlineBranches(mapScenariosToBranchSeeds(resolved));
    } catch (err) {
      if (isStale()) return;
      logUnexpectedJournalError('Worldline', err);
      setWorldlineBranches(undefined);
      setWorldlineError(true);
    }
  }, []);

  useEffect(() => {
    if (capLoading || featureGated) return;
    void loadWorldline();
    return () => {
      // Invalidate any in-flight worldline fetch so a late response can't write
      // into a superseded view.
      worldlineSeqRef.current += 1;
    };
    // recentScenarioKey captures the meaningful change; the ids array itself is
    // derived and read via ref inside loadWorldline (which has stable identity).
  }, [capLoading, featureGated, recentScenarioKey, loadWorldline]);

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
            <AgentRosterPanel
              entries={rosterEntries}
              loading={rosterEntries === undefined && !rosterError}
              error={rosterError}
              onRetry={() => void loadRoster()}
            />
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
            <WorldlineMapMini
              branches={worldlineBranches}
              loading={worldlineBranches === undefined && !worldlineError}
              error={worldlineError}
              onRetry={() => void loadWorldline()}
            />
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
