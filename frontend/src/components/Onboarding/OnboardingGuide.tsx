/* A saved-sample walkthrough. Opening and reading the sample never starts an LLM run. */

import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog';
import './OnboardingGuide.css';

export type SampleCapabilityState = 'loading' | 'enabled' | 'disabled' | 'error' | 'unknown';

export interface OnboardingGuideProps {
  open: boolean;
  onComplete: () => void;
  onOpenSample: () => void;
  sampleCapabilityState: SampleCapabilityState;
  importing?: boolean;
  importError?: string | null;
  onRetryCapability?: () => void;
}

export function OnboardingGuide({
  open,
  onComplete,
  onOpenSample,
  sampleCapabilityState,
  importing = false,
  importError,
  onRetryCapability,
}: OnboardingGuideProps) {
  const { t } = useTranslation();
  const capabilityFailed = sampleCapabilityState === 'error' || sampleCapabilityState === 'unknown';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onComplete(); }}>
      <DialogContent className="onboarding-guide">
        <div className="onboarding-guide__inner">
          <header className="onboarding-guide__header">
            <DialogTitle className="onboarding-guide__title">
              {t('onboarding.sample_title')}
            </DialogTitle>
          </header>
          <DialogDescription className="onboarding-guide__desc">
            {t('onboarding.sample_intro')}
          </DialogDescription>
          <ol className="onboarding-guide__steps">
            {(['endings', 'divergence', 'evidence'] as const).map((step) => (
              <li key={step}>{t(`onboarding.sample_${step}_title`)}</li>
            ))}
          </ol>
          <p className="onboarding-guide__note">{t('onboarding.sample_no_llm')}</p>
          {sampleCapabilityState !== 'enabled' && (
            <div className="onboarding-guide__availability" role="status">
              <p>{t(sampleCapabilityState === 'loading'
                ? 'snapshot.capability_loading'
                : sampleCapabilityState === 'disabled'
                  ? 'snapshot.capability_disabled'
                  : 'snapshot.capability_error')}
              </p>
              {capabilityFailed && onRetryCapability && (
                <button type="button" className="btn btn-secondary" onClick={onRetryCapability}>
                  {t('snapshot.capability_retry')}
                </button>
              )}
            </div>
          )}
          {importError && <p className="onboarding-guide__error" role="alert">{importError}</p>}
          <footer className="onboarding-guide__footer">
            <button
              type="button"
              className="onboarding-guide__btn onboarding-guide__btn--ghost"
              onClick={onComplete}
              data-testid="onboarding-skip"
            >
              {t('onboarding.skip')}
            </button>
            <div className="onboarding-guide__footer-spacer" />
            <button
              type="button"
              className="onboarding-guide__btn onboarding-guide__btn--primary"
              onClick={onOpenSample}
              disabled={sampleCapabilityState !== 'enabled' || importing}
              aria-busy={importing}
              data-testid="onboarding-open-sample"
            >
              {t(importing ? 'snapshot.sample_quick_start_loading' : 'onboarding.sample_open')}
            </button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type SampleOnboardingStep = 'endings' | 'divergence' | 'evidence';

export interface SampleOnboardingGuideProps {
  step: SampleOnboardingStep;
  onAction: () => void;
  onSkip: () => void;
  /** Only supplied after the evidence action reached real, saved evidence. */
  onComplete?: () => void;
  /** A real result may lack the data needed for the current action. */
  unavailableReason?: string | null;
}

/** Non-modal so the user can inspect the actual result controls between steps. */
export function SampleOnboardingGuide({
  step,
  onAction,
  onSkip,
  onComplete,
  unavailableReason,
}: SampleOnboardingGuideProps) {
  const { t } = useTranslation();
  const steps: SampleOnboardingStep[] = ['endings', 'divergence', 'evidence'];
  return (
    <section className="sample-onboarding" aria-labelledby="sample-onboarding-title">
      <div className="sample-onboarding__copy" aria-live="polite">
        <p className="sample-onboarding__progress">
          {t('onboarding.step_indicator', { current: steps.indexOf(step) + 1, total: steps.length })}
          {' · '}{t('onboarding.sample_no_llm_short')}
        </p>
        <h2 id="sample-onboarding-title">{t(`onboarding.sample_${step}_title`)}</h2>
        <p>{t(`onboarding.sample_${step}_desc`)}</p>
        {unavailableReason && <p role="status">{unavailableReason}</p>}
        {onComplete && <p>{t('onboarding.sample_run_later')}</p>}
      </div>
      <div className="sample-onboarding__actions">
        <button type="button" className="btn btn-ghost" onClick={onSkip}>{t('onboarding.skip')}</button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onComplete ?? onAction}
          disabled={Boolean(unavailableReason) && !onComplete}
        >
          {t(onComplete ? 'onboarding.done' : `onboarding.sample_${step}_action`)}
        </button>
      </div>
    </section>
  );
}

export default OnboardingGuide;
