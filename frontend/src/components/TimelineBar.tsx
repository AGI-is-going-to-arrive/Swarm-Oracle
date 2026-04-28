
/* ═══════════════════════════════════════════════════════════
   SwarmOracle — TimelineBar (Simulation Progress + ETA)
   ═══════════════════════════════════════════════════════════ */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSimulationStore } from '../stores/simulationStore';
import type { Scenario } from '../types';
import './TimelineBar.css';

type ScenarioStatus = Scenario['status'] | 'idle';

type StageDef = {
  key: ScenarioStatus;
  label: string;
  icon: string;
};

interface TimelineRoundMarker {
  round: number;
  isAvailable: boolean;
  isSelected?: boolean;
  forkCount?: number;
  cardCount?: number;
  betCount?: number;
  resultCount?: number;
  forkTitles?: string[];
  cardSummaries?: string[];
  betSummaries?: string[];
  resultSummaries?: string[];
}

interface TimelineBarProps {
  interactive?: boolean;
  compact?: boolean;
  selectedRound?: number | null;
  roundMarkers?: TimelineRoundMarker[];
  onRoundSelect?: (round: number) => void;
}

const MARKER_ICONS = {
  fork: '/assets/ui/generated/timeline_marker_fork.svg',
  card: '/assets/ui/generated/timeline_marker_card.svg',
  bet: '/assets/ui/generated/timeline_marker_bet.svg',
  result: '/assets/ui/generated/timeline_marker_result.svg',
} as const;

function getStageIndex(stages: StageDef[], status: ScenarioStatus): number {
  const idx = stages.findIndex((stage) => stage.key === status);
  return idx === -1 ? -1 : idx;
}

function formatETA(seconds: number): string {
  if (seconds <= 0) return '--';
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  return secs > 0 ? `~${mins}m${secs}s` : `~${mins}m`;
}

function getModeMultiplier(mode: string | null | undefined): number {
  if (mode === 'raw') return 1.0;
  return 1.3;
}

function buildRoundSummary(marker: TimelineRoundMarker): string {
  const bits = [`R${marker.round}`];
  if (marker.forkCount) bits.push(`fork ${marker.forkCount}`);
  if (marker.cardCount) bits.push(`cards ${marker.cardCount}`);
  if (marker.betCount) bits.push(`bets ${marker.betCount}`);
  if (marker.resultCount) bits.push(`results ${marker.resultCount}`);
  return bits.join(' · ');
}

function buildRoundTooltipLines(
  marker: TimelineRoundMarker,
  t: (key: string, options?: Record<string, unknown>) => string,
): string[] {
  const lines = [buildRoundSummary(marker)];

  if (marker.forkTitles?.length) {
    lines.push(`${t('sim.timeline.tooltip_forks')}：${marker.forkTitles.join(' / ')}`);
  }
  if (marker.cardSummaries?.length) {
    lines.push(`${t('sim.timeline.tooltip_cards')}：${marker.cardSummaries.join(' / ')}`);
  }
  if (marker.betSummaries?.length) {
    lines.push(`${t('sim.timeline.tooltip_bets')}：${marker.betSummaries.join(' / ')}`);
  }
  if (marker.resultSummaries?.length) {
    lines.push(`${t('sim.timeline.tooltip_results')}：${marker.resultSummaries.join(' / ')}`);
  }

  if (lines.length === 1) {
    lines.push(t('sim.timeline.tooltip_no_events'));
  }

  return lines;
}

function buildTooltipStats(
  marker: TimelineRoundMarker,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  const stats: Array<{
    key: keyof typeof MARKER_ICONS;
    label: string;
    count: number;
  }> = [];

  if (marker.forkCount) {
    stats.push({ key: 'fork', label: t('sim.timeline.tooltip_forks'), count: marker.forkCount });
  }
  if (marker.cardCount) {
    stats.push({ key: 'card', label: t('sim.timeline.tooltip_cards'), count: marker.cardCount });
  }
  if (marker.betCount) {
    stats.push({ key: 'bet', label: t('sim.timeline.tooltip_bets'), count: marker.betCount });
  }
  if (marker.resultCount) {
    stats.push({ key: 'result', label: t('sim.timeline.tooltip_results'), count: marker.resultCount });
  }

  return stats;
}

export function TimelineBar({
  interactive = false,
  compact = false,
  selectedRound = null,
  roundMarkers = [],
  onRoundSelect,
}: TimelineBarProps) {
  const { t } = useTranslation();
  const status = useSimulationStore((s) => s.status);
  const branches = useSimulationStore((s) => s.branches);
  const scenario = useSimulationStore((s) => s.scenario);
  const currentRound = useSimulationStore((s) => s.currentRound);
  const simStartTime = useSimulationStore((s) => s.simStartTime);
  const roundCompleteTimes = useSimulationStore((s) => s.roundCompleteTimes);
  const messages = useSimulationStore((s) => s.messages);

  const totalRounds = scenario?.total_rounds ?? 10;
  const mode = scenario?.mode ?? 'blackboard';
  const displayStatus: ScenarioStatus = useMemo(() => {
    if (
      status === 'simulating'
      && currentRound >= totalRounds
      && messages.length > 0
    ) {
      return 'narrating';
    }
    return status;
  }, [currentRound, messages.length, status, totalRounds]);
  const isSimulating = displayStatus === 'simulating';

  const { progressPercent, eta, avgRoundTime } = useMemo(() => {
    if (!isSimulating || currentRound === 0) {
      return { progressPercent: 0, eta: '', avgRoundTime: 0 };
    }

    const pct = Math.min(100, Math.round((currentRound / totalRounds) * 100));

    let avgTime = 0;
    if (roundCompleteTimes.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < roundCompleteTimes.length; i += 1) {
        intervals.push(roundCompleteTimes[i] - roundCompleteTimes[i - 1]);
      }
      avgTime = intervals.reduce((sum, value) => sum + value, 0) / intervals.length / 1000;
    } else if (roundCompleteTimes.length === 1 && simStartTime) {
      avgTime = (roundCompleteTimes[0] - simStartTime) / 1000;
    }

    const remainingRounds = Math.max(0, totalRounds - currentRound);
    const multiplier = roundCompleteTimes.length < 2 ? getModeMultiplier(mode) : 1.0;
    const etaSeconds = avgTime > 0 ? remainingRounds * avgTime * multiplier : 0;

    return {
      progressPercent: pct,
      eta: formatETA(etaSeconds),
      avgRoundTime: Math.round(avgTime),
    };
  }, [currentRound, isSimulating, mode, roundCompleteTimes, simStartTime, totalRounds]);

  const stages: StageDef[] = [
    { key: 'parsing', label: t('sim.timeline.parsing'), icon: '🔍' },
    { key: 'simulating', label: t('sim.timeline.simulating'), icon: '⚡' },
    { key: 'narrating', label: t('sim.timeline.narrating'), icon: '📖' },
    { key: 'done', label: t('sim.timeline.done'), icon: '✨' },
  ];

  const currentIdx = getStageIndex(stages, displayStatus);
  const visibleRoundMarkers = useMemo(() => {
    if (roundMarkers.length > 0) {
      return roundMarkers;
    }
    return Array.from({ length: totalRounds }, (_, index) => ({
      round: index + 1,
      isAvailable: false,
      isSelected: selectedRound === index + 1,
      forkCount: 0,
      cardCount: 0,
      betCount: 0,
      resultCount: 0,
    }));
  }, [roundMarkers, selectedRound, totalRounds]);

  return (
    <div className={`timeline-bar ${compact ? 'timeline-bar--compact' : ''}`}>
      {!compact && (
        <div className="timeline-stages">
          {stages.map((stage, index) => {
            const isActive = index === currentIdx;
            const isDone = index < currentIdx;
            const cls = isActive ? 'stage--active' : isDone ? 'stage--done' : 'stage--pending';

            return (
              <div key={stage.key} className={`stage ${cls}`}>
                <span className="stage__icon">{stage.icon}</span>
                <span className="stage__label">{stage.label}</span>
                {index < stages.length - 1 && <div className={`stage__connector ${isDone ? 'connector--done' : ''}`} />}
              </div>
            );
          })}
        </div>
      )}

      {isSimulating && (
        <div className="timeline-progress">
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill"
              ref={(el) => { if (el) el.style.width = `${progressPercent}%`; }}
            />
          </div>
          <div className="progress-info">
            <span className="progress-round">
              {currentRound > 0 ? `R${currentRound}/${totalRounds}` : t('sim.timeline.preparing')}
            </span>
            <span className="progress-pct">{progressPercent}%</span>
            {eta && eta !== '--' && (
              <span className="progress-eta">
                {t('sim.timeline.eta')} {eta}
              </span>
            )}
            {avgRoundTime > 0 && (
              <span className="progress-speed">
                ~{avgRoundTime}{t('sim.timeline.per_round')}
              </span>
            )}
          </div>
        </div>
      )}

      {interactive && visibleRoundMarkers.length > 0 && (
        <div className="timeline-rounds" aria-label={t('sim.timeline.round_label')}>
          {visibleRoundMarkers.map((marker) => {
            const isSelected = marker.isSelected || selectedRound === marker.round;
            const className = [
              'timeline-round',
              marker.isAvailable ? 'timeline-round--available' : 'timeline-round--disabled',
              isSelected ? 'timeline-round--selected' : '',
            ].filter(Boolean).join(' ');
            const summary = buildRoundSummary(marker);
            const tooltipLines = buildRoundTooltipLines(marker, t);
            const tooltipStats = buildTooltipStats(marker, t);
            const content = (
              <>
                <span className="timeline-round__label">R{marker.round}</span>
                {(marker.forkCount || marker.cardCount || marker.betCount || marker.resultCount) ? (
                  <span className="timeline-round__markers" aria-hidden="true">
                    {marker.forkCount ? (
                      <span className="timeline-round__marker timeline-round__marker--fork" data-marker-type="fork">
                        <img className="timeline-round__marker-icon" src={MARKER_ICONS.fork} alt="" />
                        <span>{marker.forkCount}</span>
                      </span>
                    ) : null}
                    {marker.cardCount ? (
                      <span className="timeline-round__marker timeline-round__marker--card" data-marker-type="card">
                        <img className="timeline-round__marker-icon" src={MARKER_ICONS.card} alt="" />
                        <span>{marker.cardCount}</span>
                      </span>
                    ) : null}
                    {marker.betCount ? (
                      <span className="timeline-round__marker timeline-round__marker--bet" data-marker-type="bet">
                        <img className="timeline-round__marker-icon" src={MARKER_ICONS.bet} alt="" />
                        <span>{marker.betCount}</span>
                      </span>
                    ) : null}
                    {marker.resultCount ? (
                      <span className="timeline-round__marker timeline-round__marker--result" data-marker-type="result">
                        <img className="timeline-round__marker-icon" src={MARKER_ICONS.result} alt="" />
                        <span>{marker.resultCount}</span>
                      </span>
                    ) : null}
                  </span>
                ) : null}
                <span className="timeline-round__tooltip" role="tooltip">
                  {tooltipStats.length > 0 ? (
                    <span className="timeline-round__tooltip-stats">
                      {tooltipStats.map((stat) => (
                        <span key={stat.key} className="timeline-round__tooltip-stat">
                          <img className="timeline-round__marker-icon" src={MARKER_ICONS[stat.key]} alt="" />
                          <span className="timeline-round__tooltip-stat-label">{stat.label}</span>
                          <strong>{stat.count}</strong>
                        </span>
                      ))}
                    </span>
                  ) : null}
                  {tooltipLines.map((line) => (
                    <span key={line} className="timeline-round__tooltip-line">{line}</span>
                  ))}
                </span>
              </>
            );

            if (marker.isAvailable && onRoundSelect) {
              return (
                <button
                  key={marker.round}
                  type="button"
                  className={className}
                  onClick={() => onRoundSelect(marker.round)}
                  title={summary}
                  aria-label={`Jump to replay round ${marker.round}`}
                  aria-pressed={isSelected}
                >
                  {content}
                </button>
              );
            }

            return (
              <span key={marker.round} className={className} title={summary}>
                {content}
              </span>
            );
          })}
        </div>
      )}

      <div className="timeline-stats">
        <span className="stat">
          <span className="stat__label">{t('sim.timeline.mode_label')}</span>
          <span className={`stat__value stat__mode stat__mode--${mode}`}>
            {mode === 'raw' ? 'RAW' : 'BB'}
          </span>
        </span>

        <span className="stat">
          <span className="stat__label">{t('sim.timeline.round_label')}</span>
          <span className="stat__value">
            {currentRound > 0 ? `${currentRound}/${totalRounds}` : `0/${totalRounds}`}
          </span>
        </span>

        <span className="stat">
          <span className="stat__label">{t('sim.timeline.branches')}</span>
          <span className="stat__value">{branches.filter((branch) => branch.status === 'ACTIVE').length}</span>
        </span>

        <span className="stat">
          <span className="stat__label">{t('sim.timeline.total')}</span>
          <span className="stat__value">{branches.length}</span>
        </span>

        {isSimulating && (
          <span className="stat">
            <span className="stat__label">{t('sim.timeline.messages_count')}</span>
            <span className="stat__value">{messages.length}</span>
          </span>
        )}
      </div>
    </div>
  );
}
