/* ═══════════════════════════════════════════════════════════
   P1-2 — Memory Timeline
   Vertical chronological timeline of an agent's growth events
   across scenarios, grouped by scenario.
   ═══════════════════════════════════════════════════════════ */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentGrowthEvent, AgentMemoryEntry } from '../types';

interface Props {
  events: AgentGrowthEvent[];
  memories: AgentMemoryEntry[];
}

const EVENT_ICONS: Record<string, string> = {
  stance_shift: '🔄',
  alliance: '🤝',
  alliance_formed: '🤝',
  alliance_broken: '💔',
  betrayal: '⚔️',
};

const EVENT_COLORS: Record<string, string> = {
  stance_shift: '#9b59b6',
  alliance: '#2ecc71',
  alliance_formed: '#2ecc71',
  alliance_broken: '#e67e22',
  betrayal: '#e74c3c',
};

const EVENT_LABEL_I18N: Record<string, [string, string]> = {
  stance_shift: ['agent_profile.event_stance_shift', 'Stance Shift'],
  alliance: ['agent_profile.event_alliance', 'Alliance'],
  alliance_formed: ['agent_profile.event_alliance_formed', 'Alliance Formed'],
  alliance_broken: ['agent_profile.event_alliance_broken', 'Alliance Broken'],
  betrayal: ['agent_profile.event_betrayal', 'Betrayal'],
};

interface TimelineEntry {
  kind: 'event' | 'memory';
  scenarioId: string | null;
  timestamp: string | null;
  event?: AgentGrowthEvent;
  memory?: AgentMemoryEntry;
}

export function MemoryTimeline({ events, memories }: Props) {
  const { t } = useTranslation();

  const entries = useMemo(() => {
    const all: TimelineEntry[] = [];
    for (const e of events) {
      all.push({ kind: 'event', scenarioId: e.scenario_id, timestamp: e.created_at, event: e });
    }
    for (const m of memories) {
      all.push({ kind: 'memory', scenarioId: m.scenario_id, timestamp: m.created_at, memory: m });
    }
    // Sort by timestamp ascending
    all.sort((a, b) => {
      const ta = a.timestamp ?? '';
      const tb = b.timestamp ?? '';
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return all;
  }, [events, memories]);

  // Group by scenarioId
  const groups = useMemo(() => {
    const map = new Map<string, TimelineEntry[]>();
    for (const entry of entries) {
      const key = entry.scenarioId ?? 'unknown';
      const list = map.get(key) ?? [];
      list.push(entry);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [entries]);

  if (entries.length === 0) {
    return (
      <p style={{ fontSize: '0.85rem', color: '#888' }}>
        {t('agent_profile.no_history', 'No history yet.')}
      </p>
    );
  }

  return (
    <div
      role="list"
      aria-label={t('agent_profile.timeline_label', 'Agent growth timeline')}
      style={{ position: 'relative', paddingLeft: 20 }}
    >
      {/* Vertical line */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', left: 8, top: 0, bottom: 0,
          width: 2, background: '#333',
        }}
      />

      {groups.map(([scenarioId, items]) => (
        <div key={scenarioId} style={{ marginBottom: '1rem' }}>
          {/* Scenario segment header */}
          <div
            style={{
              position: 'relative',
              fontSize: '0.7rem', color: '#888',
              marginBottom: 6, paddingLeft: 4,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                position: 'absolute', left: -16, top: 3,
                width: 10, height: 10, borderRadius: '50%',
                background: '#555', border: '2px solid #333',
              }}
            />
            {t('agent_profile.scenario_label', 'Scenario')}: {scenarioId === 'unknown' ? '—' : scenarioId.slice(0, 8)}
          </div>

          {items.map((entry, i) => {
            if (entry.kind === 'event' && entry.event) {
              const ev = entry.event;
              const pair = EVENT_LABEL_I18N[ev.event_type];
              const label = pair ? t(pair[0], pair[1]) : ev.event_type;
              const color = EVENT_COLORS[ev.event_type] ?? '#888';
              const icon = EVENT_ICONS[ev.event_type] ?? '📌';
              return (
                <div
                  key={`e-${ev.id}`}
                  role="listitem"
                  style={{
                    position: 'relative',
                    marginBottom: 8, paddingLeft: 4,
                    fontSize: '0.8rem',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute', left: -14, top: 4,
                      width: 6, height: 6, borderRadius: '50%',
                      background: color,
                    }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>{icon}</span>
                    <strong style={{ color }}>{label}</strong>
                    {ev.round_number != null && (
                      <span style={{ color: '#666', fontSize: '0.7rem' }}>
                        R{ev.round_number}
                      </span>
                    )}
                  </div>
                  <p style={{ margin: '2px 0 0', color: '#ccc', lineHeight: 1.4 }}>
                    {ev.summary}
                  </p>
                </div>
              );
            }
            if (entry.kind === 'memory' && entry.memory) {
              return (
                <div
                  key={`m-${i}`}
                  role="listitem"
                  style={{
                    position: 'relative',
                    marginBottom: 8, paddingLeft: 4,
                    fontSize: '0.8rem',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute', left: -14, top: 4,
                      width: 6, height: 6, borderRadius: '50%',
                      background: '#4a90d9',
                    }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>💭</span>
                    <strong style={{ color: '#4a90d9' }}>
                      {t('agent_profile.memory_entry', 'Memory')}
                    </strong>
                  </div>
                  <p style={{ margin: '2px 0 0', color: '#ccc', lineHeight: 1.4 }}>
                    {entry.memory.summary}
                  </p>
                </div>
              );
            }
            return null;
          })}
        </div>
      ))}
    </div>
  );
}
