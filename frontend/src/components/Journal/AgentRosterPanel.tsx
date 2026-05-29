/* ═══════════════════════════════════════════════════════════
   Personal Prediction Journal — Agent Roster (Growth Timeline)
   Vertical timeline of growth events tied to agents the user
   has interacted with.
   ═══════════════════════════════════════════════════════════ */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export interface AgentRosterEntry {
  id: string;
  agentName: string;
  scenario: string;
  date: string;
  insight?: string;
}

interface Props {
  entries?: AgentRosterEntry[];
  /**
   * When true, render an explicit loading skeleton instead of the empty state.
   * The parent passes `entries === undefined` (still fetching) so that a real
   * empty roster and an in-flight fetch are visually distinguishable.
   */
  loading?: boolean;
  /**
   * When true, render an explicit error state with a retry affordance instead
   * of pretending the fetch produced an empty roster. This keeps a genuine
   * "no agents yet" state distinct from a failed load so the user can tell the
   * difference and recover via `onRetry`.
   */
  error?: boolean;
  /** Invoked when the user activates the retry button in the error state. */
  onRetry?: () => void;
}

/** Number of placeholder rows shown while the roster is loading. */
const SKELETON_ROW_COUNT = 3;

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function AgentRosterPanel({ entries, loading = false, error = false, onRetry }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en';
  const data = useMemo(() => entries ?? [], [entries]);

  // Error takes precedence over loading/empty so a failed fetch is never
  // silently presented as a real empty roster.
  if (error) {
    return (
      <div className="journal-roster journal-roster--error" role="alert">
        <p>{t('journal.roster.error', 'Could not load the agent roster. Please retry.')}</p>
        {onRetry && (
          <button
            type="button"
            className="journal-button journal-button--secondary"
            onClick={onRetry}
          >
            {t('journal.roster.retry', 'Reload roster')}
          </button>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="journal-roster journal-roster--loading"
        role="status"
        aria-busy="true"
        data-testid="journal-roster-skeleton"
      >
        <span className="sr-only">
          {t('journal.roster.loading', 'Loading agent roster…')}
        </span>
        <ul className="journal-roster__skeleton-list" aria-hidden="true">
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
            <li key={i} className="journal-roster__skeleton-item">
              <span className="journal-roster__skeleton-avatar" />
              <span className="journal-roster__skeleton-lines">
                <span className="journal-roster__skeleton-line journal-roster__skeleton-line--name" />
                <span className="journal-roster__skeleton-line journal-roster__skeleton-line--meta" />
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="journal-roster journal-roster--empty" role="status">
        <p>{t('journal.roster.empty', 'No agent interactions yet. Forecast a question to grow your roster.')}</p>
      </div>
    );
  }

  return (
    <ol className="journal-roster" aria-label={t('journal.roster.aria_label', 'Agent growth timeline')}>
      {data.map((entry) => {
        const initials = entry.agentName
          .split(/\s+/)
          .map((part) => part.charAt(0).toUpperCase())
          .slice(0, 2)
          .join('');
        return (
          <li key={entry.id} className="journal-roster__item">
            <span className="journal-roster__avatar" aria-hidden="true">{initials || '?'}</span>
            <div className="journal-roster__body">
              <div className="journal-roster__line">
                <strong className="journal-roster__name">{entry.agentName}</strong>
                <time className="journal-roster__date" dateTime={entry.date}>
                  {formatDate(entry.date, locale)}
                </time>
              </div>
              <p className="journal-roster__scenario">{entry.scenario}</p>
              {entry.insight && (
                <p className="journal-roster__insight">{entry.insight}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default AgentRosterPanel;
