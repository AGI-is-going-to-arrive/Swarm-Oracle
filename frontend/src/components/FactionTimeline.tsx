/* ═══════════════════════════════════════════════════════════
   Phase 3 F5 — Faction Timeline
   Displays faction evolution across rounds as colored rows.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getFactionTimeline } from '../api/client';
import { NodeConversationSheet } from './kg/NodeConversationSheet';

interface FactionInfo {
  key: string;
  label: string | null;
  members: string[];
  stance_center?: number;
  confidence?: number;
}

interface FactionEventInfo {
  type?: string | null;
  actor_agent_id?: string | null;
  agent_id?: string | null;
  faction_key: string;
}

interface RoundFactionData {
  round: number;
  factions: FactionInfo[];
  events: FactionEventInfo[];
}

const FACTION_COLORS = ['#4a90d9', '#e74c3c', '#2ecc71', '#9b59b6', '#e67e22', '#1abc9c', '#f1c40f', '#e91e63'];
const FACTION_EVENT_ICONS: Record<string, string> = {
  betrayal: '⚔️',
  alliance_formed: '🤝',
  faction_split: '💔',
};

interface Props {
  scenarioId: string;
  branchId: string;
  branchLabel?: string | null;
  visible: boolean;
}

function normalizeText(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function formatMetric(value?: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—';
}

export function FactionTimeline({ scenarioId, branchId, branchLabel, visible }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.toLowerCase().startsWith('zh');
  const [timeline, setTimeline] = useState<RoundFactionData[]>([]);
  const [loading, setLoading] = useState(false);
  // FE-3-seq: append-only sheet state for NodeConversationSheet trigger.
  const [sheetState, setSheetState] = useState<{
    open: boolean;
    scenarioId: string;
    identityId: string;
    origin: { nodeId: string; nodeType: string; excerpt?: string };
  }>({
    open: false,
    scenarioId: '',
    identityId: '',
    origin: { nodeId: '', nodeType: '' },
  });

  const branchDisplayName = normalizeText(branchLabel) ?? normalizeText(branchId) ?? t('factions.current_branch', 'Current branch');
  const membersLabel = t('factions.members', isZh ? '名成员' : 'members');
  const scopeLabel = t('factions.branch_scope', isZh ? '分支范围' : 'Branch scope');
  const roundSpanLabel = t('factions.round_span', isZh ? '轮次跨度' : 'Round span');
  const factionCountLabel = t('factions.faction_count', isZh ? '阵营数' : 'Factions');
  const stanceLabel = t('factions.stance', isZh ? '立场' : 'Stance');
  const confidenceLabel = t('factions.confidence', isZh ? '置信度' : 'Confidence');
  const actorLabel = t('factions.actor', isZh ? '行动者' : 'Actor');
  const factionLabel = t('factions.faction', isZh ? '阵营' : 'Faction');
  const eventTypeLabel = t('factions.event_type', isZh ? '类型' : 'Type');
  const roundEventsLabel = t('factions.round_events', isZh ? '本轮事件' : 'Round events');
  const unknownEventLabel = t('factions.event_labels.unknown', isZh ? '未知事件' : 'Unknown event');

  const describeEventType = useCallback((eventType?: string | null) => {
    const normalizedEventType = eventType?.trim() || 'unknown';
    const key = `factions.event_labels.${normalizedEventType}`;
    if (normalizedEventType !== 'unknown' && i18n.exists(key)) {
      return {
        label: t(key),
        normalizedEventType,
        isKnown: true,
      };
    }
    return {
      label: unknownEventLabel,
      normalizedEventType,
      isKnown: false,
    };
  }, [i18n, t, unknownEventLabel]);

  const fetchTimeline = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getFactionTimeline(scenarioId, branchId) as RoundFactionData[];
      setTimeline(data);
    } catch {
      setTimeline([]);
    } finally {
      setLoading(false);
    }
  }, [scenarioId, branchId]);

  useEffect(() => {
    if (!visible || !scenarioId || !branchId) return;
    fetchTimeline();
  }, [scenarioId, branchId, visible, fetchTimeline]);

  const factionKeys = [...new Set(timeline.flatMap(r => r.factions.map(f => f.key)))];
  const colorMap = factionKeys.reduce<Record<string, string>>((map, key, index) => {
    map[key] = FACTION_COLORS[index % FACTION_COLORS.length];
    return map;
  }, {});
  const factionLabelMap = useMemo(
    () => timeline.reduce<Record<string, string>>((map, round) => {
      round.factions.forEach((faction) => {
        map[faction.key] = faction.label ?? faction.key;
      });
      return map;
    }, {}),
    [timeline],
  );
  const firstRound = timeline[0]?.round ?? 0;
  const lastRound = timeline[timeline.length - 1]?.round ?? firstRound;
  const roundSpan = firstRound === lastRound
    ? t('factions.round_label', 'Round {{round}}', { round: firstRound })
    : t('factions.round_span_range', isZh ? '第 {{start}} 轮 - 第 {{end}} 轮' : 'Rounds {{start}}-{{end}}', {
        start: firstRound,
        end: lastRound,
      });

  if (!visible) return null;
  if (loading) return <p style={{ fontSize: '0.85rem', color: '#888' }}>{t('common.loading', 'Loading...')}</p>;
  if (timeline.length === 0) {
    return <p style={{ fontSize: '0.85rem', color: '#888' }}>{t('factions.empty', 'No faction data available.')}</p>;
  }

  return (
    <div
      role="list"
      aria-label={t('factions.a11y_label', 'Faction evolution timeline')}
      style={{ display: 'grid', gap: '0.9rem' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>{t('factions.title', 'Faction Timeline')}</h3>
          <p style={{ margin: '0.35rem 0 0', fontSize: '0.78rem', color: '#9aa4b2' }}>
            {scopeLabel}: {branchDisplayName}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }}>
          <span
            style={{
              padding: '0.3rem 0.55rem',
              borderRadius: 999,
              fontSize: '0.72rem',
              border: '1px solid rgba(138, 180, 248, 0.28)',
              background: 'rgba(138, 180, 248, 0.1)',
              color: '#cfe1ff',
            }}
          >
            {roundSpanLabel}: {roundSpan}
          </span>
          <span
            style={{
              padding: '0.3rem 0.55rem',
              borderRadius: 999,
              fontSize: '0.72rem',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              background: 'rgba(255, 255, 255, 0.04)',
              color: '#d8dee9',
            }}
          >
            {factionCountLabel}: {factionKeys.length}
          </span>
        </div>
      </div>

      {timeline.map((round, index) => (
        <article
          key={round.round}
          data-testid="faction-timeline-round"
          role="listitem"
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto minmax(0, 1fr)',
            gap: '0.75rem',
            alignItems: 'stretch',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              minWidth: '2rem',
              paddingTop: '0.15rem',
            }}
          >
            <div
              style={{
                width: '2rem',
                height: '2rem',
                borderRadius: 999,
                border: '1px solid rgba(138, 180, 248, 0.35)',
                background: 'linear-gradient(180deg, rgba(138, 180, 248, 0.24), rgba(138, 180, 248, 0.08))',
                color: '#cfe1ff',
                fontSize: '0.8rem',
                fontWeight: 700,
                display: 'grid',
                placeItems: 'center',
                boxShadow: '0 0 0 4px rgba(15, 23, 42, 0.45)',
              }}
            >
              {round.round}
            </div>
            {index < timeline.length - 1 && (
              <div
                style={{
                  flex: 1,
                  width: 2,
                  minHeight: '2.4rem',
                  marginTop: '0.35rem',
                  borderRadius: 999,
                  background: 'linear-gradient(180deg, rgba(138, 180, 248, 0.5), rgba(138, 180, 248, 0.08))',
                }}
              />
            )}
          </div>

          <div
            style={{
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 14,
              padding: '0.85rem',
              background: 'linear-gradient(180deg, rgba(17, 24, 39, 0.95), rgba(15, 23, 42, 0.92))',
              boxShadow: '0 10px 30px rgba(2, 6, 23, 0.2)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '0.6rem',
                flexWrap: 'wrap',
                marginBottom: '0.8rem',
              }}
            >
              <div>
                <div style={{ fontSize: '0.83rem', fontWeight: 700, color: '#f8fafc' }}>
                  {t('factions.round_label', 'Round {{round}}', { round: round.round })}
                </div>
                <div style={{ marginTop: '0.2rem', fontSize: '0.72rem', color: '#8b98ab' }}>
                  {scopeLabel}: {branchDisplayName}
                </div>
              </div>
              {round.events.length > 0 && (
                <span
                  style={{
                    padding: '0.28rem 0.55rem',
                    borderRadius: 999,
                    fontSize: '0.72rem',
                    background: 'rgba(230, 126, 34, 0.12)',
                    border: '1px solid rgba(230, 126, 34, 0.28)',
                    color: '#ffcb8a',
                  }}
                >
                  {t('factions.round_events_count', isZh ? '本轮事件 {{count}} 条' : '{{count}} round events', {
                    count: round.events.length,
                  })}
                </span>
              )}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '0.55rem',
              }}
            >
              {[...round.factions]
                .sort((left, right) => factionKeys.indexOf(left.key) - factionKeys.indexOf(right.key))
                .map((faction) => {
                const factionName = faction.label ?? faction.key;
                const factionColor = colorMap[faction.key];
                return (
                  <div
                    key={faction.key}
                    style={{
                      borderRadius: 12,
                      border: `1px solid ${factionColor}44`,
                      background: `${factionColor}14`,
                      padding: '0.65rem 0.7rem',
                      color: '#e5edf7',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                        marginBottom: '0.35rem',
                      }}
                    >
                      <strong style={{ color: factionColor, fontSize: '0.84rem' }}>{factionName}</strong>
                      <span style={{ fontSize: '0.72rem', color: '#cbd5e1' }}>
                        {faction.members.length} {membersLabel}
                      </span>
                    </div>
                    <div style={{ display: 'grid', gap: '0.2rem', fontSize: '0.73rem', color: '#9aa4b2' }}>
                      <span>{stanceLabel} {formatMetric(faction.stance_center)}</span>
                      <span>{confidenceLabel} {formatMetric(faction.confidence)}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {round.events.length > 0 && (
              <div style={{ marginTop: '0.8rem' }}>
                <div style={{ marginBottom: '0.45rem', fontSize: '0.72rem', color: '#ffcb8a' }}>
                  {roundEventsLabel}
                </div>
                <div style={{ display: 'grid', gap: '0.45rem' }}>
                  {round.events.map((event, eventIndex) => {
                    const { label, normalizedEventType, isKnown } = describeEventType(event.type);
                    const actorId = normalizeText(event.actor_agent_id ?? event.agent_id);
                    const eventFactionKey = normalizeText(event.faction_key);
                    const eventFactionName = eventFactionKey
                      ? factionLabelMap[eventFactionKey] ?? eventFactionKey
                      : null;
                    // FE-3-seq: open NodeConversationSheet on event row click (append-only).
                    const openSheet = () => {
                      const identity = actorId ?? eventFactionKey ?? `faction-event-${round.round}-${eventIndex}`;
                      setSheetState({
                        open: true,
                        scenarioId,
                        identityId: identity,
                        origin: {
                          nodeId: identity,
                          nodeType: `faction_event:${normalizedEventType}`,
                          excerpt: label,
                        },
                      });
                    };
                    return (
                      <div
                        key={`${round.round}-${eventIndex}-${normalizedEventType}`}
                        data-testid={`faction-event-row-${round.round}-${eventIndex}`}
                        role="button"
                        tabIndex={0}
                        onClick={openSheet}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter' || ev.key === ' ') {
                            ev.preventDefault();
                            openSheet();
                          }
                        }}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'auto minmax(0, 1fr)',
                          gap: '0.55rem',
                          alignItems: 'flex-start',
                          padding: '0.55rem 0.65rem',
                          borderRadius: 12,
                          background: 'rgba(255, 255, 255, 0.03)',
                          border: '1px solid rgba(255, 255, 255, 0.06)',
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{ fontSize: '1rem', lineHeight: 1.2 }}>
                          {FACTION_EVENT_ICONS[normalizedEventType] ?? '❔'}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#f8fafc' }}>
                            {label}
                          </div>
                          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                            {actorId && (
                              <span
                                style={{
                                  fontSize: '0.72rem',
                                  color: '#cbd5e1',
                                  padding: '0.2rem 0.45rem',
                                  borderRadius: 999,
                                  background: 'rgba(138, 180, 248, 0.12)',
                                }}
                              >
                                {actorLabel} {actorId}
                              </span>
                            )}
                            {eventFactionName && (
                              <span
                                style={{
                                  fontSize: '0.72rem',
                                  color: '#d8dee9',
                                  padding: '0.2rem 0.45rem',
                                  borderRadius: 999,
                                  background: 'rgba(46, 204, 113, 0.12)',
                                }}
                              >
                                {factionLabel} {eventFactionName}
                              </span>
                            )}
                            {!isKnown && normalizedEventType !== 'unknown' && (
                              <span
                                style={{
                                  fontSize: '0.72rem',
                                  color: '#f5d0fe',
                                  padding: '0.2rem 0.45rem',
                                  borderRadius: 999,
                                  background: 'rgba(168, 85, 247, 0.12)',
                                }}
                              >
                                {eventTypeLabel} {normalizedEventType.replaceAll('_', ' ')}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </article>
      ))}
      {/* FE-3-seq: NodeConversationSheet (append-only, triggered by event row click). */}
      {sheetState.open && (
        <NodeConversationSheet
          open={sheetState.open}
          onOpenChange={(next) => setSheetState((prev) => ({ ...prev, open: next }))}
          threadId={null}
          scenarioId={sheetState.scenarioId}
          identityId={sheetState.identityId}
          origin={sheetState.origin}
        />
      )}
    </div>
  );
}
