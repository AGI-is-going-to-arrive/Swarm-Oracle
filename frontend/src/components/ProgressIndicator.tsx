/* ═══════════════════════════════════════════════════════════
   SwarmOracle — ProgressIndicator (P2-1)
   5-step horizontal pill bar showing the prediction journey.
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';
import './ProgressIndicator.css';

export interface ProgressIndicatorProps {
  /** 1-based current step index (1..5). Out-of-range values are clamped. */
  currentStep: number;
}

type StepState = 'completed' | 'active' | 'pending';

interface StepDef {
  index: number;
  labelKey: string;
}

const STEPS: ReadonlyArray<StepDef> = [
  { index: 1, labelKey: 'progress.step_input' },
  { index: 2, labelKey: 'progress.step_environment' },
  { index: 3, labelKey: 'progress.step_simulation' },
  { index: 4, labelKey: 'progress.step_report' },
  { index: 5, labelKey: 'progress.step_deep_dive' },
];

function resolveState(step: number, current: number): StepState {
  if (step < current) return 'completed';
  if (step === current) return 'active';
  return 'pending';
}

export function ProgressIndicator({ currentStep }: ProgressIndicatorProps) {
  const { t } = useTranslation();
  const clamped = Math.max(1, Math.min(STEPS.length, Math.floor(currentStep) || 1));

  return (
    <section
      className="progress-indicator"
      role="group"
      aria-label={t('progress.aria_label')}
    >
      <ol className="progress-indicator__list" role="list">
        {STEPS.map((step, idx) => {
          const state = resolveState(step.index, clamped);
          const label = t(step.labelKey);
          const isLast = idx === STEPS.length - 1;
          return (
            <li key={step.index} className="progress-indicator__item">
              <div
                className={`progress-indicator__step progress-indicator__step--${state}`}
                aria-current={state === 'active' ? 'step' : undefined}
                data-step={step.index}
              >
                <span className="progress-indicator__bullet" aria-hidden="true">
                  {state === 'completed' ? (
                    <svg
                      className="progress-indicator__check"
                      viewBox="0 0 16 16"
                      width="12"
                      height="12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="3.5,8.5 6.5,11.5 12.5,4.5" />
                    </svg>
                  ) : (
                    <span className="progress-indicator__number">{step.index}</span>
                  )}
                </span>
                <span className="progress-indicator__label">{label}</span>
              </div>
              {!isLast && (
                <span
                  className={`progress-indicator__connector progress-indicator__connector--${
                    step.index < clamped ? 'completed' : 'pending'
                  }`}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default ProgressIndicator;
