/* ═══════════════════════════════════════════════════════════
   S1-5 — First-visit Onboarding Guide
   5-step carousel introducing SwarmOracle's core gameplay
   modes plus advanced features. Steps are filtered against
   /api/capabilities so disabled features are skipped.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import './OnboardingGuide.css';

export interface OnboardingGuideProps {
  /** Controls dialog visibility. Parent owns persistence. */
  open: boolean;
  /** Called when the user finishes or skips the guide. */
  onComplete: () => void;
}

/** Static step descriptors — copy lives in i18n, not in this component. */
type StepId =
  | 'welcome'
  | 'roundtable'
  | 'chamber'
  | 'one_move'
  | 'advanced';

interface StepDescriptor {
  id: StepId;
  /** Emoji icon — pure presentational, hidden from a11y tree. */
  icon: string;
  /** i18n key root under `onboarding.*`. */
  titleKey: string;
  descKey: string;
  /**
   * Optional capability gate. When the gate evaluates to disabled, the
   * step is filtered out of the carousel. The welcome step has no gate.
   */
  gate?: 'custom_agents' | 'agent_identity' | 'causal_graph';
}

const ALL_STEPS: ReadonlyArray<StepDescriptor> = [
  { id: 'welcome', icon: '✨', titleKey: 'welcome_title', descKey: 'welcome_desc' },
  { id: 'roundtable', icon: '🪑', titleKey: 'roundtable_title', descKey: 'roundtable_desc' },
  { id: 'chamber', icon: '🔮', titleKey: 'chamber_title', descKey: 'chamber_desc' },
  { id: 'one_move', icon: '🦋', titleKey: 'one_move_title', descKey: 'one_move_desc' },
  // Advanced step is gated on at least one of the advanced capabilities being on.
  // We use `custom_agents` as the representative probe; if it's off, we fall back
  // to causal_graph in the runtime filter below.
  { id: 'advanced', icon: '🛠️', titleKey: 'advanced_title', descKey: 'advanced_desc', gate: 'custom_agents' },
];

export function OnboardingGuide({ open, onComplete }: OnboardingGuideProps) {
  const { t } = useTranslation();
  const [rawIndex, setRawIndex] = useState(0);

  // Probe the three capabilities relevant to the advanced step.
  // If ANY of them is enabled, we keep the advanced step.
  const customAgentsCap = useCapabilityCheck('custom_agents');
  const agentIdentityCap = useCapabilityCheck('agent_identity');
  const causalGraphCap = useCapabilityCheck('causal_graph');

  const advancedAvailable = useMemo(() => {
    // While capabilities are loading we still show the advanced step;
    // worst case the user clicks through to a no-op page, which is the
    // same behaviour as the rest of the app's gated routes.
    if (customAgentsCap.loading && agentIdentityCap.loading && causalGraphCap.loading) {
      return true;
    }
    return (
      customAgentsCap.enabled || agentIdentityCap.enabled || causalGraphCap.enabled
    );
  }, [
    customAgentsCap.loading,
    customAgentsCap.enabled,
    agentIdentityCap.loading,
    agentIdentityCap.enabled,
    causalGraphCap.loading,
    causalGraphCap.enabled,
  ]);

  const steps = useMemo<ReadonlyArray<StepDescriptor>>(() => {
    return ALL_STEPS.filter((step) => {
      if (step.id === 'advanced') return advancedAvailable;
      return true;
    });
  }, [advancedAvailable]);

  // Reset to first step whenever the dialog re-opens. We piggy-back on
  // useState's "previous open value" by storing it as a sibling state slot;
  // mutating during render is the React-recommended pattern for this case
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setRawIndex(0);
  }

  // Derive a clamped index during render so the visible step list and the
  // index never go out of sync (e.g. capabilities resolve and the advanced
  // step is removed mid-flow). No effect required.
  const totalSteps = steps.length;
  const currentIndex = totalSteps === 0 ? 0 : Math.min(rawIndex, totalSteps - 1);
  const currentStep = steps[currentIndex];
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === totalSteps - 1;

  const handleNext = useCallback(() => {
    if (isLast) {
      onComplete();
      return;
    }
    setRawIndex((i) => Math.min(i + 1, totalSteps - 1));
  }, [isLast, onComplete, totalSteps]);

  const handleBack = useCallback(() => {
    setRawIndex((i) => Math.max(i - 1, 0));
  }, []);

  const handleSkip = useCallback(() => {
    onComplete();
  }, [onComplete]);

  const handleDotClick = useCallback((idx: number) => {
    setRawIndex(idx);
  }, []);

  // Defensive: if the gate filter ever produced 0 steps (shouldn't happen because
  // welcome has no gate), bail out quietly so the dialog never traps the user.
  if (!currentStep) {
    return null;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onComplete();
      }}
    >
      <DialogContent
        className="onboarding-guide"
        // The Radix DialogContent already wires aria-labelledby/aria-describedby
        // to the children we render below.
        onEscapeKeyDown={() => onComplete()}
      >
        <div className="onboarding-guide__inner">
          <header className="onboarding-guide__header">
            <span
              className="onboarding-guide__icon"
              role="presentation"
              aria-hidden="true"
            >
              {currentStep.icon}
            </span>
            <DialogTitle className="onboarding-guide__title">
              {t(`onboarding.${currentStep.titleKey}`)}
            </DialogTitle>
          </header>

          <DialogDescription className="onboarding-guide__desc">
            {t(`onboarding.${currentStep.descKey}`)}
          </DialogDescription>

          {/* Step indicator dots */}
          <nav
            className="onboarding-guide__dots"
            aria-label={t('onboarding.step_indicator', {
              current: currentIndex + 1,
              total: totalSteps,
            })}
          >
            {steps.map((s, idx) => {
              const active = idx === currentIndex;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`onboarding-guide__dot ${active ? 'is-active' : ''}`}
                  onClick={() => handleDotClick(idx)}
                  aria-current={active ? 'step' : undefined}
                  aria-label={t('onboarding.step_indicator', {
                    current: idx + 1,
                    total: totalSteps,
                  })}
                />
              );
            })}
          </nav>

          <p className="onboarding-guide__step-count" aria-live="polite">
            {t('onboarding.step_indicator', {
              current: currentIndex + 1,
              total: totalSteps,
            })}
          </p>

          <footer className="onboarding-guide__footer">
            <button
              type="button"
              className="onboarding-guide__btn onboarding-guide__btn--ghost"
              onClick={handleSkip}
              data-testid="onboarding-skip"
            >
              {t('onboarding.skip')}
            </button>
            <div className="onboarding-guide__footer-spacer" />
            <button
              type="button"
              className="onboarding-guide__btn onboarding-guide__btn--secondary"
              onClick={handleBack}
              disabled={isFirst}
              data-testid="onboarding-back"
            >
              {t('onboarding.back')}
            </button>
            <button
              type="button"
              className="onboarding-guide__btn onboarding-guide__btn--primary"
              onClick={handleNext}
              autoFocus
              data-testid="onboarding-next"
            >
              {isLast ? t('onboarding.done') : t('onboarding.next')}
            </button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default OnboardingGuide;
