/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Result Verdict Panel
   Displays the LLM-produced verdict that answers the original
   user question, with confidence badge and accessible region.
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

  // Hide completely when there's no verdict text.
  const verdictText = typeof verdict === 'string' ? verdict.trim() : '';
  if (!verdictText) {
    return null;
  }

  const safeConfidence = isValidConfidence(confidence) ? confidence : null;
  const questionText = typeof question === 'string' ? question.trim() : '';

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
