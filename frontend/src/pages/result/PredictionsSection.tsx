/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Predictions section (P5-B)
   ═══════════════════════════════════════════════════════════ */

import {
  getBetOutcomeClass,
  getBetOutcomeLabel,
} from './../resultHelpers';
import {
  getPredictionRationale,
  getStructuredBetKindLabel,
  parseStructuredPredictionText,
  resolveStructuredBetOutcome,
} from '../../lib/predictionBetting';
import { useResultContext } from './ResultContext';

interface PredictionsSectionProps {
  betOutcomeContext: Parameters<typeof resolveStructuredBetOutcome>[1];
}

export default function PredictionsSection({ betOutcomeContext }: PredictionsSectionProps) {
  const {
    t,
    predictions,
    hasUnscored,
    isReplayMode,
    handleScore,
    scoring,
    scoreError,
  } = useResultContext();

  if (predictions.length === 0) return null;

  return (
    <section className="result-predictions">
      <h2 className="result-predictions-title">{t('result.predictions_title')}</h2>
      {hasUnscored && !isReplayMode && (
        <button
          className="btn result-score-btn"
          onClick={handleScore}
          disabled={scoring}
        >
          {scoring ? t('result.scoring') : t('result.score_predictions')}
        </button>
      )}
      {scoreError && <p className="result-error">{scoreError}</p>}
      <div className="predictions-grid">
        {predictions.map((p) => (
          <div key={p.id} className="prediction-card">
            {(() => {
              const structuredBet = parseStructuredPredictionText(p.prediction_text);
              const structuredOutcome = structuredBet
                ? resolveStructuredBetOutcome(structuredBet.meta, betOutcomeContext)
                : null;
              return (
                <>
            <div className="prediction-card__header">
              <span className="prediction-card__user">{p.user_name}</span>
              <span className="prediction-card__confidence">
                {Math.round((p.confidence ?? 0) * 100)}%
              </span>
            </div>
            {structuredBet && (
              <div className="prediction-card__bet-row">
                <p className="prediction-card__bet-kind">
                  {getStructuredBetKindLabel(structuredBet.meta.kind, t)}
                  {' · '}
                  {structuredBet.meta.targetLabel}
                </p>
                {structuredOutcome && (
                  <span className={getBetOutcomeClass(structuredOutcome)}>
                    {getBetOutcomeLabel(structuredOutcome, t)}
                  </span>
                )}
              </div>
            )}
            <p className="prediction-card__text">{getPredictionRationale(p.prediction_text)}</p>
            {p.score != null && (
              <div className="prediction-card__score">
                <span className="score-value">{p.score.toFixed(0)}</span>
                <span className="score-label">/ 100</span>
                {p.score_reason && (
                  <p className="score-reason">{p.score_reason}</p>
                )}
              </div>
            )}
                </>
              );
            })()}
          </div>
        ))}
      </div>
    </section>
  );
}
