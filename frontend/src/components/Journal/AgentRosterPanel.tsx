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
}

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export function AgentRosterPanel({ entries }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en';
  const data = useMemo(() => entries ?? [], [entries]);

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
