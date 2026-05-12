import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const TOUR_STORAGE_KEY = 'swarm.argmap.tour_seen';

interface TourStep {
  target: string; // CSS selector
  i18nKey: string;
  fallback: string;
}

const STEPS: TourStep[] = [
  {
    target: '[data-node-type="verdict"]',
    i18nKey: 'argument.tour_step_verdict',
    fallback: 'This is the verdict — the starting point of the argument map.',
  },
  {
    target: '[aria-pressed]',
    i18nKey: 'argument.tour_step_filter',
    fallback: 'Filter by status to focus on specific arguments.',
  },
  {
    target: '.react-flow__node',
    i18nKey: 'argument.tour_step_node',
    fallback: 'Click any node to see its argument chain and details.',
  },
];

interface Props {
  active?: boolean;
}

export function ArgumentMapTour({ active = true }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    try {
      if (localStorage.getItem(TOUR_STORAGE_KEY)) return;
    } catch { /* localStorage unavailable */ }
    // Delay tour start to let the graph render first
    const timer = window.setTimeout(() => setStep(0), 1500);
    return () => window.clearTimeout(timer);
  }, [active]);

  const handleNext = useCallback(() => {
    setStep(prev => {
      if (prev === null) return null;
      const next = prev + 1;
      if (next >= STEPS.length) {
        try { localStorage.setItem(TOUR_STORAGE_KEY, '1'); } catch { /* */ }
        return null;
      }
      return next;
    });
  }, []);

  const handleSkip = useCallback(() => {
    try { localStorage.setItem(TOUR_STORAGE_KEY, '1'); } catch { /* */ }
    setStep(null);
  }, []);

  if (step === null || step >= STEPS.length) return null;

  const current = STEPS[step];

  return (
    <div className="argmap-tour-overlay" role="dialog" aria-modal="false" aria-label={t('argument.tour_label', 'Argument map guide')}>
      <div className="argmap-tour-backdrop" onClick={handleSkip} />
      <div className="argmap-tour-card">
        <p className="argmap-tour-card__step">
          {step + 1} / {STEPS.length}
        </p>
        <p className="argmap-tour-card__text">
          {t(current.i18nKey, current.fallback)}
        </p>
        <div className="argmap-tour-card__actions">
          <button
            className="argmap-tour-card__skip"
            onClick={handleSkip}
          >
            {t('common.skip', 'Skip')}
          </button>
          <button
            className="argmap-tour-card__next"
            onClick={handleNext}
            autoFocus
          >
            {step < STEPS.length - 1
              ? t('common.next', 'Next')
              : t('common.done', 'Done')}
          </button>
        </div>
      </div>
    </div>
  );
}
