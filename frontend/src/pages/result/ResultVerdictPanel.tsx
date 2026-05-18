/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Result Verdict Panel
   Displays the LLM-produced verdict that answers the original
   user question, with confidence badge and accessible region.
   When no verdict is available (older scenarios completed before
   FEATURE_RESULT_VERDICT, or verdict generation failed), renders
   a neutral fallback that still anchors the user to the original
   question and points to the endings below.
   ═══════════════════════════════════════════════════════════ */

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import './ResultVerdictPanel.css';

export type VerdictConfidence = 'high' | 'medium' | 'low';

export interface ResultVerdictPanelProps {
  verdict: string | null | undefined;
  confidence: VerdictConfidence | null | undefined;
  question: string;
}

function isValidConfidence(value: unknown): value is VerdictConfidence {
  return value === 'high' || value === 'medium' || value === 'low';
}

export default function ResultVerdictPanel({
  verdict,
  confidence,
  question,
}: ResultVerdictPanelProps) {
  const { t } = useTranslation();
  const labelId = useId();

  const verdictText = typeof verdict === 'string' ? verdict.trim() : '';
  const questionText = typeof question === 'string' ? question.trim() : '';
  const hasVerdict = verdictText.length > 0;

  // Unavailable fallback: panel is mounted (capability enabled) but the
  // scenario has no verdict — either it pre-dates FEATURE_RESULT_VERDICT
  // or verdict generation failed. By the time the user reaches ResultView
  // the simulation is always completed, so the messaging is neutral
  // ("no verdict available") rather than implying ongoing analysis. The
  // CSS class keeps the legacy `--pending` suffix for style continuity.
  if (!hasVerdict) {
    return (
      <section
        className="result-verdict-panel result-verdict-panel--pending"
        role="region"
        aria-labelledby={labelId}
        aria-live="polite"
        data-testid="result-verdict-panel-pending"
      >
        <header className="result-verdict-panel__header">
          <span id={labelId} className="result-verdict-panel__label">
            {t('result.verdict_label', { defaultValue: 'Prediction Verdict' })}
          </span>
        </header>

        {questionText && (
          <p className="result-verdict-panel__question" data-testid="result-verdict-question">
            {questionText}
          </p>
        )}

        <p
          className="result-verdict-panel__pending"
          data-testid="result-verdict-pending"
        >
          {t('result.verdict_pending', {
            defaultValue:
              'No prediction verdict is available — explore the endings below for insights.',
          })}
        </p>
      </section>
    );
  }

  const safeConfidence = isValidConfidence(confidence) ? confidence : null;

  const confidenceLabel = safeConfidence
    ? t(`result.verdict_confidence_${safeConfidence}`, {
        defaultValue:
          safeConfidence === 'high'
            ? 'High Confidence'
            : safeConfidence === 'medium'
              ? 'Medium Confidence'
              : 'Low Confidence',
      })
    : null;

  return (
    <section
      className="result-verdict-panel"
      role="region"
      aria-labelledby={labelId}
      aria-live="polite"
    >
      <header className="result-verdict-panel__header">
        <span id={labelId} className="result-verdict-panel__label">
          {t('result.verdict_label', { defaultValue: 'Prediction Verdict' })}
        </span>
        {confidenceLabel && safeConfidence && (
          <span
            className={`result-verdict-panel__badge result-verdict-panel__badge--${safeConfidence}`}
            data-testid="result-verdict-confidence-badge"
          >
            <span className="result-verdict-panel__badge-dot" aria-hidden="true" />
            {confidenceLabel}
          </span>
        )}
      </header>

      {questionText && (
        <p className="result-verdict-panel__question" data-testid="result-verdict-question">
          {questionText}
        </p>
      )}

      <p className="result-verdict-panel__text" data-testid="result-verdict-text">
        {verdictText}
      </p>
    </section>
  );
}
