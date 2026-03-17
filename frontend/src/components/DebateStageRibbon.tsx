import { useTranslation } from 'react-i18next';

import { DEBATE_PHASE_ORDER, getDebatePhaseLabel } from '../lib/debateLabels';

interface DebateStageRibbonProps {
  activePhase: string;
  unlockedPhases?: string[];
  onSelect?: (phase: string) => void;
}

export function DebateStageRibbon({
  activePhase,
  unlockedPhases = [],
  onSelect,
}: DebateStageRibbonProps) {
  const { t } = useTranslation();

  return (
    <div className="debate-stage-ribbon" role="tablist" aria-label={t('debate.stage_ribbon_aria')}>
      {DEBATE_PHASE_ORDER.map((phase) => {
        const isActive = phase === activePhase;
        const isUnlocked = unlockedPhases.includes(phase) || isActive;
        return (
          <button
            key={phase}
            type="button"
            className={`debate-stage-ribbon__chip ${isActive ? 'debate-stage-ribbon__chip--active' : ''}`}
            onClick={() => onSelect?.(phase)}
            disabled={!onSelect || !isUnlocked}
            aria-pressed={isActive}
          >
            <span className="debate-stage-ribbon__index">
              {DEBATE_PHASE_ORDER.indexOf(phase) + 1}
            </span>
            <span>{getDebatePhaseLabel(t, phase)}</span>
          </button>
        );
      })}
    </div>
  );
}
