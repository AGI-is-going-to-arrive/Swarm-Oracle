/* ═══════════════════════════════════════════════════════════
   Phase 3 F5 — Faction Timeline
   Displays faction evolution across rounds as colored rows.
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface FactionInfo {
  key: string;
  label: string | null;
  members: string[];
  stance_center: number;
  confidence: number;
}

interface FactionEventInfo {
  event_type: string;
  actor_agent_id: string;
  faction_key: string;
}

interface RoundFactionData {
  round: number;
  factions: FactionInfo[];
  events: FactionEventInfo[];
}

const FACTION_COLORS = ['#4a90d9', '#e74c3c', '#2ecc71', '#9b59b6', '#e67e22', '#1abc9c', '#f1c40f', '#e91e63'];

interface Props {
  scenarioId: string;
  branchId: string;
  visible: boolean;
}

export function FactionTimeline({ scenarioId, branchId, visible }: Props) {
  const { t } = useTranslation();
  const [timeline, setTimeline] = useState<RoundFactionData[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !scenarioId) return;
    setLoading(true);
    fetch(`/api/scenario/${scenarioId}/faction-timeline?branch_id=${branchId}`)
      .then(res => {
        if (res.status === 501) return [];
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => { setTimeline(data); setLoading(false); })
      .catch(() => { setTimeline([]); setLoading(false); });
  }, [scenarioId, branchId, visible]);

  if (!visible) return null;
  if (loading) return <p style={{ fontSize: '0.85rem', color: '#888' }}>{t('common.loading', 'Loading...')}</p>;
  if (timeline.length === 0) {
    return <p style={{ fontSize: '0.85rem', color: '#888' }}>{t('factions.empty', 'No faction data available.')}</p>;
  }

  // Collect unique faction keys for consistent coloring
  const factionKeys = [...new Set(timeline.flatMap(r => r.factions.map(f => f.key)))];
  const colorMap = Object.fromEntries(factionKeys.map((k, i) => [k, FACTION_COLORS[i % FACTION_COLORS.length]]));

  return (
    <div role="list" aria-label={t('factions.a11y_label', 'Faction evolution timeline')}>
      <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>{t('factions.title', 'Faction Timeline')}</h3>
      {timeline.map(round => (
        <div
          key={round.round}
          role="listitem"
          style={{ marginBottom: '0.5rem', padding: '0.5rem', border: '1px solid #333', borderRadius: 6 }}
        >
          <div style={{ fontSize: '0.75rem', color: '#888', marginBottom: 4 }}>
            Round {round.round}
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {round.factions.map(f => (
              <span
                key={f.key}
                style={{
                  padding: '3px 8px', borderRadius: 4,
                  background: `${colorMap[f.key]}22`,
                  color: colorMap[f.key],
                  border: `1px solid ${colorMap[f.key]}44`,
                  fontSize: '0.75rem',
                }}
                title={`${f.label ?? f.key}: ${f.members.length} members, stance ${f.stance_center.toFixed(2)}`}
              >
                {f.label ?? f.key} ({f.members.length})
              </span>
            ))}
          </div>
          {round.events.length > 0 && (
            <div style={{ marginTop: 4, fontSize: '0.7rem', color: '#e67e22' }}>
              {round.events.map((ev, i) => (
                <span key={i}>
                  {ev.event_type === 'betrayal' ? '⚔️' : ev.event_type === 'alliance_formed' ? '🤝' : '💔'}{' '}
                  {ev.event_type.replace('_', ' ')}
                  {i < round.events.length - 1 ? ' · ' : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
