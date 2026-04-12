import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { DEBATE_PHASE_ORDER, getDebatePhaseLabel } from '../lib/debateLabels';

type DebateStagePhase = (typeof DEBATE_PHASE_ORDER)[number];

interface DebateStageRibbonProps {
  activePhase: DebateStagePhase;
  unlockedPhases?: DebateStagePhase[];
  onSelect?: (phase: DebateStagePhase) => void;
}

export function DebateStageRibbon({
  activePhase,
  unlockedPhases = [],
  onSelect,
}: DebateStageRibbonProps) {
  const { t } = useTranslation();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const pendingFocusPhaseRef = useRef<string | null>(null);

  const enabledPhases = DEBATE_PHASE_ORDER.filter((phase) => unlockedPhases.includes(phase) || phase === activePhase);

  useEffect(() => {
    if (pendingFocusPhaseRef.current !== activePhase) return;
    tabRefs.current[activePhase]?.focus();
    pendingFocusPhaseRef.current = null;
  }, [activePhase]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, phase: DebateStagePhase) => {
    if (!onSelect) return;
    const currentIndex = enabledPhases.indexOf(phase);
    if (currentIndex === -1) return;

    let nextPhase: DebateStagePhase | null = null;
    if (event.key === 'ArrowRight') {
      nextPhase = enabledPhases[(currentIndex + 1) % enabledPhases.length] ?? null;
    } else if (event.key === 'ArrowLeft') {
      nextPhase = enabledPhases[(currentIndex - 1 + enabledPhases.length) % enabledPhases.length] ?? null;
    } else if (event.key === 'Home') {
      nextPhase = enabledPhases[0] ?? null;
    } else if (event.key === 'End') {
      nextPhase = enabledPhases.at(-1) ?? null;
    }

    if (!nextPhase || nextPhase === phase) return;
    event.preventDefault();
    pendingFocusPhaseRef.current = nextPhase;
    onSelect(nextPhase);
  };

  return (
    <div className="debate-stage-ribbon" role="tablist" aria-label={t('debate.stage_ribbon_aria')}>
      {DEBATE_PHASE_ORDER.map((phase) => {
        const isActive = phase === activePhase;
        const isUnlocked = unlockedPhases.includes(phase) || isActive;
        return (
          <button
            key={phase}
            type="button"
            id={`debate-stage-tab-${phase}`}
            ref={(node) => {
              tabRefs.current[phase] = node;
            }}
            role="tab"
            className={`debate-stage-ribbon__chip ${isActive ? 'debate-stage-ribbon__chip--active' : ''}`}
            onClick={() => onSelect?.(phase)}
            onKeyDown={(event) => handleKeyDown(event, phase)}
            disabled={!onSelect || !isUnlocked}
            aria-selected={isActive}
            aria-controls="debate-stage-panel"
            tabIndex={isActive ? 0 : -1}
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
