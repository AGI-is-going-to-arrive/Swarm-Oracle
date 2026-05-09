/* ═══════════════════════════════════════════════════════════
   P1-2 — Memory Timeline
   Vertical chronological timeline of an agent's growth events
   across scenarios, grouped by scenario.

   P2-3 — De-inlined to BEM classes; added knowledge-domain
   color categories and time markers per scenario group.
   ═══════════════════════════════════════════════════════════ */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentGrowthEvent, AgentMemoryEntry } from '../types';
import './MemoryTimeline.css';

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


function formatTimeMarker(iso: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

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

  // Group by scenarioId, preserving insertion order (which is timestamp-ascending)
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
      <p className="memory-timeline__empty">
        {t('agent_profile.no_history', 'No history yet.')}
      </p>
    );
  }

  return (
    <div
      className="memory-timeline"
      role="list"
      aria-label={t('agent_profile.timeline_label', 'Agent growth timeline')}
    >
      {/* Vertical axis line */}
      <div className="memory-timeline__axis" aria-hidden="true" />

      {groups.map(([scenarioId, items]) => {
        // Earliest timestamp in this group as the visual time marker
        const firstTs = items.find(it => it.timestamp)?.timestamp ?? null;
        const timeMarker = formatTimeMarker(firstTs);
        return (
          <div key={scenarioId} className="memory-timeline__group">
            {/* Scenario segment header */}
            <div className="memory-timeline__scenario-label">
              <span className="memory-timeline__scenario-marker" aria-hidden="true" />
              {t('agent_profile.scenario_label', 'Scenario')}:{' '}
              {scenarioId === 'unknown' ? '—' : scenarioId.slice(0, 8)}
              {timeMarker && (
                <span className="memory-timeline__time-marker">· {timeMarker}</span>
              )}
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
                    className="memory-timeline__event"
                  >
                    <span
                      className="memory-timeline__event-dot"
                      style={{ background: color }}
                      aria-hidden="true"
                    />
                    <div className="memory-timeline__event-header">
                      <span className="memory-timeline__event-icon" aria-hidden="true">
                        {icon}
                      </span>
                      <strong className="memory-timeline__event-label" style={{ color }}>
                        {label}
                      </strong>
                      {ev.round_number != null && (
                        <span className="memory-timeline__event-round">
                          R{ev.round_number}
                        </span>
                      )}
                    </div>
                    <p className="memory-timeline__event-summary">
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
                    className="memory-timeline__event"
                  >
                    <span
                      className="memory-timeline__event-dot memory-timeline__memory-dot"
                      aria-hidden="true"
                    />
                    <div className="memory-timeline__event-header">
                      <span className="memory-timeline__event-icon" aria-hidden="true">💭</span>
                      <strong className="memory-timeline__memory-label">
                        {t('agent_profile.memory_entry', 'Memory')}
                      </strong>
                    </div>
                    <p className="memory-timeline__event-summary">
                      {entry.memory.summary}
                    </p>
                  </div>
                );
              }
              return null;
            })}
          </div>
        );
      })}
    </div>
  );
}
