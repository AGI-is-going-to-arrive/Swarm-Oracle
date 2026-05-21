/* ═══════════════════════════════════════════════════════════
   SwarmOracle — TheaterStatusChips
   Compact status pill row (scene/theme/round/agents/bubbles/
   weather/time/message count) extracted from SimulationView.
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';

export type TheaterStatusChipsProps = {
  theaterSceneLabel: string | null;
  theaterThemeLabel: string | null;
  displayedReplayRound: number | string;
  totalRounds: number | null | undefined;
  theaterAgentCount: number;
  theaterBubbleCount: number;
  theaterWeatherLabel: string | null;
  theaterTimeLabel: string | null;
  messageCount: number;
};

export function TheaterStatusChips({
  theaterSceneLabel,
  theaterThemeLabel,
  displayedReplayRound,
  totalRounds,
  theaterAgentCount,
  theaterBubbleCount,
  theaterWeatherLabel,
  theaterTimeLabel,
  messageCount,
}: TheaterStatusChipsProps) {
  const { t } = useTranslation();
  const totalRoundsLabel = totalRounds == null ? '--' : String(totalRounds);

  return (
    <div className="theater-panel__status" aria-label={t('sim.theater_status_aria')}>
      {theaterSceneLabel && (
        <span className="theater-chip theater-chip--primary">
          🎬 {theaterSceneLabel}
        </span>
      )}
      {theaterThemeLabel && (
        <span className="theater-chip">
          🗺 {theaterThemeLabel}
        </span>
      )}
      <span className="theater-chip">
        🔁 R{displayedReplayRound}/{totalRoundsLabel}
      </span>
      <span className="theater-chip">
        👥 {theaterAgentCount}
      </span>
      <span className="theater-chip">
        💬 {theaterBubbleCount}
      </span>
      {theaterWeatherLabel && (
        <span className="theater-chip">
          🌦 {theaterWeatherLabel}
        </span>
      )}
      {theaterTimeLabel && (
        <span className="theater-chip">
          🕒 {theaterTimeLabel}
        </span>
      )}
      <span className="theater-chip">
        ✉ {messageCount}
      </span>
    </div>
  );
}

export default TheaterStatusChips;
