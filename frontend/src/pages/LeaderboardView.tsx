/* ═══════════════════════════════════════════════════════════
   SwarmOracle — LeaderboardView (P5-B + Segment Filters)
   ═══════════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  getLeaderboard,
  type LeaderboardScenarioType,
  type LeaderboardSegmentFilters,
  type LeaderboardSegmentMetadata,
  type LeaderboardResponse,
} from '../api/client';
import { stringifyAutomationPayload } from '../game/automation';
import {
  buildAutomationErrorState,
  getApiErrorCode,
  getLocalizedApiErrorMessage,
} from '../lib/apiErrorMessage';
import type { LeaderboardEntry } from '../types';
import './LeaderboardView.css';

const MEDALS = ['🥇', '🥈', '🥉'] as const;

const SCENARIO_TYPES: ReadonlyArray<LeaderboardScenarioType> = [
  'debate',
  'simulation',
  'roundtable',
];

const SCENARIO_TYPE_SET: ReadonlySet<string> = new Set(SCENARIO_TYPES);

interface SegmentState {
  scenarioType: LeaderboardScenarioType | null;
  dateFrom: string;
  dateTo: string;
  minAgents: string;
  maxAgents: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseSegmentFromParams(params: URLSearchParams): SegmentState {
  const rawType = params.get('type');
  const scenarioType =
    rawType && SCENARIO_TYPE_SET.has(rawType)
      ? (rawType as LeaderboardScenarioType)
      : null;
  const dateFromRaw = params.get('from') ?? '';
  const dateToRaw = params.get('to') ?? '';
  const dateFrom = ISO_DATE_RE.test(dateFromRaw) ? dateFromRaw : '';
  const dateTo = ISO_DATE_RE.test(dateToRaw) ? dateToRaw : '';
  const minRaw = params.get('min_agents') ?? '';
  const maxRaw = params.get('max_agents') ?? '';
  const minNum = Number(minRaw);
  const maxNum = Number(maxRaw);
  const minAgents =
    minRaw && Number.isFinite(minNum) && minNum >= 1 && minNum <= 50
      ? String(Math.trunc(minNum))
      : '';
  const maxAgents =
    maxRaw && Number.isFinite(maxNum) && maxNum >= 1 && maxNum <= 50
      ? String(Math.trunc(maxNum))
      : '';
  return { scenarioType, dateFrom, dateTo, minAgents, maxAgents };
}

function segmentToParams(segment: SegmentState): Record<string, string> {
  const out: Record<string, string> = {};
  if (segment.scenarioType) out.type = segment.scenarioType;
  if (segment.dateFrom) out.from = segment.dateFrom;
  if (segment.dateTo) out.to = segment.dateTo;
  if (segment.minAgents) out.min_agents = segment.minAgents;
  if (segment.maxAgents) out.max_agents = segment.maxAgents;
  return out;
}

function segmentToFilters(segment: SegmentState): LeaderboardSegmentFilters {
  const minNum = Number(segment.minAgents);
  const maxNum = Number(segment.maxAgents);
  return {
    scenarioType: segment.scenarioType ?? null,
    dateFrom: segment.dateFrom || null,
    dateTo: segment.dateTo || null,
    minAgents:
      segment.minAgents && Number.isFinite(minNum) ? Math.trunc(minNum) : null,
    maxAgents:
      segment.maxAgents && Number.isFinite(maxNum) ? Math.trunc(maxNum) : null,
  };
}

function countActiveAdvanced(segment: SegmentState): number {
  let count = 0;
  if (segment.minAgents) count += 1;
  if (segment.maxAgents) count += 1;
  return count;
}

function unwrapResponse(
  data: LeaderboardResponse | LeaderboardEntry[] | null | undefined,
): { entries: LeaderboardEntry[]; metadata: LeaderboardSegmentMetadata | null } {
  if (!data) return { entries: [], metadata: null };
  if (Array.isArray(data)) return { entries: data, metadata: null };
  return {
    entries: Array.isArray(data.entries) ? data.entries : [],
    metadata: data.segment_metadata ?? null,
  };
}

export default function LeaderboardView() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const segment = useMemo(
    () => parseSegmentFromParams(searchParams),
    [searchParams],
  );

  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [metadata, setMetadata] = useState<LeaderboardSegmentMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorFallback, setErrorFallback] = useState('');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(
    () => Boolean(segment.minAgents) || Boolean(segment.maxAgents),
  );
  const [filtersOpenMobile, setFiltersOpenMobile] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const loadSeqRef = useRef(0);

  const errorMessage = errorFallback
    ? getLocalizedApiErrorMessage({ code: errorCode }, t, errorFallback)
    : '';

  const advancedCount = countActiveAdvanced(segment);
  const hasAnyFilter =
    Boolean(segment.scenarioType) ||
    Boolean(segment.dateFrom) ||
    Boolean(segment.dateTo) ||
    advancedCount > 0;

  const load = useCallback(async () => {
    const loadSeq = loadSeqRef.current + 1;
    loadSeqRef.current = loadSeq;
    setLoading(true);
    setErrorFallback('');
    setErrorCode(null);
    try {
      const data = await getLeaderboard(50, segmentToFilters(segment));
      if (loadSeq !== loadSeqRef.current) return;
      const { entries: rows, metadata: meta } = unwrapResponse(data);
      setEntries(rows);
      setMetadata(meta);
    } catch (err) {
      if (loadSeq !== loadSeqRef.current) return;
      setErrorCode(getApiErrorCode(err));
      setErrorFallback('Failed to load leaderboard');
    } finally {
      if (loadSeq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [segment]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => () => {
    loadSeqRef.current += 1;
  }, []);

  const updateSegment = useCallback(
    (next: SegmentState) => {
      // Validate min <= max
      if (next.minAgents && next.maxAgents) {
        const minN = Number(next.minAgents);
        const maxN = Number(next.maxAgents);
        if (Number.isFinite(minN) && Number.isFinite(maxN) && minN > maxN) {
          setValidationError(
            t('leaderboard.filter_min_gt_max', 'Min agents cannot exceed max agents'),
          );
          return;
        }
      }
      // Validate date range
      if (next.dateFrom && next.dateTo && next.dateFrom > next.dateTo) {
        setValidationError(
          t('leaderboard.filter_date_invalid', 'Start date must be before end date'),
        );
        return;
      }
      setValidationError(null);
      setSearchParams(segmentToParams(next), { replace: false });
    },
    [setSearchParams, t],
  );

  const handleScenarioType = useCallback(
    (next: LeaderboardScenarioType | null) => {
      updateSegment({ ...segment, scenarioType: next });
    },
    [segment, updateSegment],
  );

  const handleDateFrom = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed && !ISO_DATE_RE.test(trimmed)) return;
      updateSegment({ ...segment, dateFrom: trimmed });
    },
    [segment, updateSegment],
  );

  const handleDateTo = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed && !ISO_DATE_RE.test(trimmed)) return;
      updateSegment({ ...segment, dateTo: trimmed });
    },
    [segment, updateSegment],
  );

  const handleAgentBound = useCallback(
    (key: 'minAgents' | 'maxAgents', value: string) => {
      const trimmed = value.trim();
      if (trimmed === '') {
        updateSegment({ ...segment, [key]: '' });
        return;
      }
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 1 || num > 50) return;
      updateSegment({ ...segment, [key]: String(Math.trunc(num)) });
    },
    [segment, updateSegment],
  );

  const handleReset = useCallback(() => {
    setValidationError(null);
    setAdvancedOpen(false);
    setFiltersOpenMobile(false);
    setSearchParams({}, { replace: false });
  }, [setSearchParams]);

  // Keep advanced section open if URL has advanced filters
  useEffect(() => {
    if (advancedCount > 0) setAdvancedOpen(true);
  }, [advancedCount]);

  useEffect(() => {
    const win = window as Window & { render_game_to_text?: () => string };
    const render = () =>
      stringifyAutomationPayload(
        {
          question: null,
          status: loading ? 'loading' : errorMessage ? 'error' : 'idle',
          currentRound: 0,
          totalRounds: null,
          viewMode: 'classic',
          visualizationEnabled: false,
          isSimulationComplete: false,
          messageCount: 0,
          agentCount: 0,
          branchCount: entries.length,
        },
        null,
        {
          route: window.location.pathname,
          kind: 'leaderboard',
          loading,
          error: buildAutomationErrorState(errorCode, errorMessage),
          entry_count: entries.length,
          segment: {
            scenario_type: segment.scenarioType,
            date_from: segment.dateFrom || null,
            date_to: segment.dateTo || null,
            min_agents: segment.minAgents ? Number(segment.minAgents) : null,
            max_agents: segment.maxAgents ? Number(segment.maxAgents) : null,
          },
          segment_metadata: metadata,
          top_entries: entries.slice(0, 10).map((entry, index) => ({
            rank: index + 1,
            user_name: entry.user_name,
            avg_score: entry.avg_score,
            best_score: entry.best_score,
            total_predictions: entry.total_predictions,
            win_streak: entry.win_streak,
          })),
        },
      );

    win.render_game_to_text = render;
    return () => {
      if (win.render_game_to_text === render) {
        delete win.render_game_to_text;
      }
    };
  }, [entries, errorCode, errorMessage, loading, metadata, segment]);

  const showingLabel =
    metadata && typeof metadata.filtered_count === 'number' && typeof metadata.total_count === 'number'
      ? t('leaderboard.showing_count', {
          filtered: metadata.filtered_count,
          total: metadata.total_count,
          defaultValue: 'Showing {{filtered}} of {{total}}',
        })
      : null;

  return (
    <div className="leaderboard-view">
      <header className="leaderboard-header">
        <button className="btn btn-ghost" onClick={() => navigate('/')}>
          {t('leaderboard.back')}
        </button>
        <h1 className="leaderboard-title">{t('leaderboard.title')}</h1>
        <p className="leaderboard-subtitle">{t('leaderboard.subtitle')}</p>
      </header>

      {/* Mobile filter toggle */}
      <div className="leaderboard-filter-mobile-toggle">
        <button
          type="button"
          className="btn"
          aria-expanded={filtersOpenMobile}
          aria-controls="leaderboard-filter-panel"
          onClick={() => setFiltersOpenMobile((v) => !v)}
        >
          {t('leaderboard.filter_toggle', 'Filters')}
          {hasAnyFilter ? (
            <span className="leaderboard-filter-badge" aria-hidden="true">
              {(segment.scenarioType ? 1 : 0) +
                (segment.dateFrom ? 1 : 0) +
                (segment.dateTo ? 1 : 0) +
                advancedCount}
            </span>
          ) : null}
        </button>
      </div>

      {/* Filter bar */}
      <section
        id="leaderboard-filter-panel"
        className={`leaderboard-filters ${filtersOpenMobile ? 'is-open-mobile' : ''}`}
        aria-label={t('leaderboard.filter_aria', 'Leaderboard filters')}
      >
        <div className="leaderboard-filter-row">
          <div
            className="leaderboard-segmented"
            role="group"
            aria-label={t('leaderboard.filter_type', 'Scenario type')}
          >
            <button
              type="button"
              className={`leaderboard-segment ${segment.scenarioType === null ? 'leaderboard-segment--active' : ''}`}
              aria-current={segment.scenarioType === null ? 'true' : undefined}
              aria-pressed={segment.scenarioType === null}
              onClick={() => handleScenarioType(null)}
            >
              {t('leaderboard.filter_type_all', 'All')}
            </button>
            {SCENARIO_TYPES.map((tp) => (
              <button
                key={tp}
                type="button"
                className={`leaderboard-segment ${segment.scenarioType === tp ? 'leaderboard-segment--active' : ''}`}
                aria-current={segment.scenarioType === tp ? 'true' : undefined}
                aria-pressed={segment.scenarioType === tp}
                onClick={() => handleScenarioType(tp)}
              >
                {t(`leaderboard.filter_type_${tp}`, tp.charAt(0).toUpperCase() + tp.slice(1))}
              </button>
            ))}
          </div>

          <div className="leaderboard-date-range">
            <label className="leaderboard-date-field">
              <span className="leaderboard-date-label">
                {t('leaderboard.filter_date_from', 'From')}
              </span>
              <input
                type="date"
                value={segment.dateFrom}
                max={segment.dateTo || undefined}
                onChange={(e) => handleDateFrom(e.target.value)}
                aria-label={t('leaderboard.filter_date_from', 'From')}
              />
            </label>
            <label className="leaderboard-date-field">
              <span className="leaderboard-date-label">
                {t('leaderboard.filter_date_to', 'To')}
              </span>
              <input
                type="date"
                value={segment.dateTo}
                min={segment.dateFrom || undefined}
                onChange={(e) => handleDateTo(e.target.value)}
                aria-label={t('leaderboard.filter_date_to', 'To')}
              />
            </label>
          </div>

          <button
            type="button"
            className="leaderboard-advanced-toggle"
            aria-expanded={advancedOpen}
            aria-controls="leaderboard-advanced-section"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <span>{t('leaderboard.filter_advanced', 'Advanced')}</span>
            {!advancedOpen && advancedCount > 0 ? (
              <span className="leaderboard-filter-badge" aria-hidden="true">
                {advancedCount}
              </span>
            ) : null}
            <span aria-hidden="true" className="leaderboard-advanced-caret">
              {advancedOpen ? '▾' : '▸'}
            </span>
          </button>

          <button
            type="button"
            className="btn btn-ghost leaderboard-reset"
            onClick={handleReset}
            disabled={!hasAnyFilter}
          >
            {t('leaderboard.filter_reset', 'Reset')}
          </button>
        </div>

        {advancedOpen ? (
          <div
            id="leaderboard-advanced-section"
            className="leaderboard-advanced"
            role="group"
            aria-label={t('leaderboard.filter_advanced', 'Advanced')}
          >
            <label className="leaderboard-number-field">
              <span className="leaderboard-date-label">
                {t('leaderboard.filter_min_agents', 'Min agents')}
              </span>
              <input
                type="number"
                min={1}
                max={50}
                inputMode="numeric"
                value={segment.minAgents}
                onChange={(e) => handleAgentBound('minAgents', e.target.value)}
                aria-label={t('leaderboard.filter_min_agents', 'Min agents')}
              />
            </label>
            <label className="leaderboard-number-field">
              <span className="leaderboard-date-label">
                {t('leaderboard.filter_max_agents', 'Max agents')}
              </span>
              <input
                type="number"
                min={1}
                max={50}
                inputMode="numeric"
                value={segment.maxAgents}
                onChange={(e) => handleAgentBound('maxAgents', e.target.value)}
                aria-label={t('leaderboard.filter_max_agents', 'Max agents')}
              />
            </label>
          </div>
        ) : null}

        {validationError ? (
          <p className="leaderboard-filter-error" role="alert">
            {validationError}
          </p>
        ) : null}
      </section>

      {showingLabel ? (
        <p className="leaderboard-showing" aria-live="polite">
          {showingLabel}
        </p>
      ) : null}

      {loading ? (
        <div className="leaderboard-empty" aria-busy="true">
          <p>{t('sim.status.loading')}</p>
          <div className="leaderboard-skeleton" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <span key={i} className="leaderboard-skeleton-row" />
            ))}
          </div>
        </div>
      ) : errorMessage ? (
        <div className="leaderboard-empty">
          <p className="result-error">{errorMessage}</p>
          <button className="btn" onClick={load}>
            ↺ {t('common.retry')}
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="leaderboard-empty">
          <p>
            {hasAnyFilter
              ? t('leaderboard.empty_segment', 'No results for this segment')
              : t('leaderboard.empty')}
          </p>
          {hasAnyFilter ? (
            <button type="button" className="btn" onClick={handleReset}>
              {t('leaderboard.filter_reset', 'Reset')}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="leaderboard-table-wrap">
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>{t('leaderboard.rank')}</th>
                <th>{t('leaderboard.name')}</th>
                <th>{t('leaderboard.predictions')}</th>
                <th>{t('leaderboard.avg_score')}</th>
                <th>{t('leaderboard.best_score')}</th>
                <th>{t('leaderboard.streak')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr
                  key={entry.user_id}
                  className={`leaderboard-row ${i < 3 ? 'leaderboard-row--top' : ''}`}
                  style={{ '--row-delay': `${i * 0.03}s` } as React.CSSProperties}
                >
                  <td className="rank-cell">
                    {i < 3 ? (
                      <span className="rank-medal">{MEDALS[i]}</span>
                    ) : (
                      <span className="rank-number">{i + 1}</span>
                    )}
                  </td>
                  <td className="name-cell">{entry.user_name}</td>
                  <td>{entry.total_predictions ?? 0}</td>
                  <td className="score-cell">{(entry.avg_score ?? 0).toFixed(1)}</td>
                  <td className="score-cell">{(entry.best_score ?? 0).toFixed(1)}</td>
                  <td>
                    {(entry.win_streak ?? 0) > 0 && (
                      <span className="streak-badge">🔥 {entry.win_streak}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
