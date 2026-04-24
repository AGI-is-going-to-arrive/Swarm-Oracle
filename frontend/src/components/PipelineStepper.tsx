/* ═══════════════════════════════════════════════════════════
   PipelineStepper — Fixed-bottom pipeline progress bar
   Shows simulation pipeline stages during /sim/:id and /result/:id
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSimulationStore } from '../stores/simulationStore';
import './PipelineStepper.css';

type PipelineStage = 'parsing' | 'simulating' | 'narrating' | 'done';

const PIPELINE_STAGES: PipelineStage[] = ['parsing', 'simulating', 'narrating', 'done'];

const STAGE_I18N_KEYS: Record<PipelineStage, string> = {
  parsing: 'pipeline.parsing',
  simulating: 'pipeline.simulating',
  narrating: 'pipeline.narrating',
  done: 'pipeline.done',
};

/** Auto-fade delay on result page after done (ms). */
const RESULT_DONE_FADE_MS = 2000;

/** Route whitelist: only render on /sim/:id and /result/:id */
function isWhitelistedRoute(pathname: string): 'sim' | 'result' | null {
  if (/^\/sim\/[^/]+$/.test(pathname) && pathname !== '/sim/replay') return 'sim';
  if (/^\/result\/[^/]+$/.test(pathname) && pathname !== '/result/replay') return 'result';
  return null;
}

function getStageIndex(status: string): number {
  switch (status) {
    case 'parsing': return 0;
    case 'simulating': return 1;
    case 'narrating': return 2;
    case 'done': return 3;
    default: return -1;
  }
}

export function PipelineStepper() {
  const { t } = useTranslation();
  const location = useLocation();
  const status = useSimulationStore((s) => s.status);
  const [fadedOut, setFadedOut] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const routeKind = isWhitelistedRoute(location.pathname);
  const isError = status === 'error';
  const currentIndex = getStageIndex(status);
  const safeCurrentIndex = Math.max(0, currentIndex);
  const shouldShow = routeKind !== null && status !== 'idle' && !fadedOut;

  // Auto-fade on result page after done
  useEffect(() => {
    if (routeKind === 'result' && status === 'done') {
      fadeTimerRef.current = setTimeout(() => {
        setFadedOut(true);
      }, RESULT_DONE_FADE_MS);
    }
    return () => {
      if (fadeTimerRef.current) {
        clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = null;
      }
    };
  }, [routeKind, status]);

  // Reset fade state when leaving result route
  useEffect(() => {
    if (routeKind !== 'result') {
      setFadedOut(false);
    }
  }, [routeKind]);

  if (routeKind === null) return null;

  const containerClass = [
    'pipeline-stepper',
    !shouldShow && 'pipeline-stepper--hidden',
    isError && 'pipeline-stepper--error',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={containerClass}
      role="progressbar"
      aria-valuenow={safeCurrentIndex}
      aria-valuemin={0}
      aria-valuemax={PIPELINE_STAGES.length - 1}
      aria-label={t('pipeline.aria_label', { defaultValue: 'Simulation pipeline progress' })}
      data-testid="pipeline-stepper"
    >
      {PIPELINE_STAGES.map((stage, index) => {
        const isActive = !isError && currentIndex === index;
        const isCompleted = !isError && currentIndex > index;
        const isErrorStage = isError && currentIndex === index;

        const stepClass = [
          'pipeline-stepper__step',
          isActive && 'pipeline-stepper__step--active',
          isCompleted && 'pipeline-stepper__step--completed',
          isErrorStage && 'pipeline-stepper__step--error',
        ].filter(Boolean).join(' ');

        return (
          <span key={stage}>
            {index > 0 && (
              <span
                className={`pipeline-stepper__connector${isCompleted || isActive ? ' pipeline-stepper__connector--completed' : ''}`}
                aria-hidden="true"
              />
            )}
            <span className={stepClass} data-testid={`pipeline-step-${stage}`}>
              <span className="pipeline-stepper__dot" aria-hidden="true" />
              {t(STAGE_I18N_KEYS[stage], { defaultValue: stage })}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export default PipelineStepper;
