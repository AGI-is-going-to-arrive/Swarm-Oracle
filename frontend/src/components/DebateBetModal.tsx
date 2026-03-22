import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import {
  type DebatePredictionKind,
  getDebateSideLabel,
  getDebateVerdictToneLabel,
} from '../lib/debateLabels';

interface DebateBetModalProps {
  loading?: boolean;
  initialSelection?: {
    kind: DebatePredictionKind;
    targetValue: string;
    confidence: number;
  } | null;
  strategyHint?: string | null;
  onClose: () => void;
  onSubmit: (payload: { kind: DebatePredictionKind; targetValue: string; confidence: number }) => Promise<void>;
  onAutomationStateChange?: (state: Record<string, unknown> | null) => void;
}

export function DebateBetModal({
  loading = false,
  initialSelection = null,
  strategyHint = null,
  onClose,
  onSubmit,
  onAutomationStateChange,
}: DebateBetModalProps) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<DebatePredictionKind>(initialSelection?.kind ?? 'winner');
  const [targetValue, setTargetValue] = useState<string>(initialSelection?.targetValue ?? 'proposition');
  const [confidence, setConfidence] = useState<number>(initialSelection?.confidence ?? 0.7);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    setKind(initialSelection?.kind ?? 'winner');
    setTargetValue(initialSelection?.targetValue ?? 'proposition');
    setConfidence(initialSelection?.confidence ?? 0.7);
  }, [initialSelection]);

  const options = useMemo(
    () => (kind === 'winner'
      ? ['proposition', 'opposition']
      : ['order', 'balance', 'rupture']),
    [kind],
  );

  useEffect(() => {
    onAutomationStateChange?.({
      kind: 'debate_bet_modal',
      selected_kind: kind,
      selected_target: targetValue,
      target_options: options,
      confidence,
      confidence_percent: Math.round(confidence * 100),
      preset_kind: initialSelection?.kind ?? null,
      preset_target: initialSelection?.targetValue ?? null,
      submit_disabled: loading,
      error: error || null,
    });

    return () => {
      onAutomationStateChange?.(null);
    };
  }, [confidence, error, kind, loading, onAutomationStateChange, options, targetValue]);

  const handleSubmit = async () => {
    setError('');
    try {
      await onSubmit({ kind, targetValue, confidence });
    } catch (nextError) {
      setError(getLocalizedApiErrorMessage(nextError, t, t('debate.bet_error')));
    }
  };

  return (
    <div className="debate-modal-overlay" onClick={onClose}>
      <div className="debate-modal" onClick={(event) => event.stopPropagation()}>
        <header className="debate-modal__header">
          <h2>{t('debate.bet_title')}</h2>
          <button type="button" className="debate-modal__close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="debate-modal__body">
          <div className="debate-modal__group">
            <span className="debate-modal__label">{t('debate.bet_kind')}</span>
            {strategyHint && (
              <p className="debate-rule-copy">{strategyHint}</p>
            )}
            <div className="debate-modal__options">
              <button
                type="button"
                className={`mode-btn ${kind === 'winner' ? 'mode-btn--active' : ''}`}
                onClick={() => {
                  setKind('winner');
                  setTargetValue('proposition');
                }}
              >
                {t('debate.bet_kind_winner')}
              </button>
              <button
                type="button"
                className={`mode-btn ${kind === 'verdict_tone' ? 'mode-btn--active' : ''}`}
                onClick={() => {
                  setKind('verdict_tone');
                  setTargetValue('order');
                }}
              >
                {t('debate.bet_kind_tone')}
              </button>
            </div>
            <p className="debate-rule-copy">
              {kind === 'winner' ? t('debate.bet_kind_winner_hint') : t('debate.bet_kind_tone_hint')}
            </p>
          </div>

          <div className="debate-modal__group">
            <span className="debate-modal__label">{t('debate.bet_target')}</span>
            <div className="debate-modal__options">
              {options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`mode-btn ${targetValue === option ? 'mode-btn--active' : ''}`}
                  onClick={() => setTargetValue(option)}
                >
                  {kind === 'winner'
                    ? getDebateSideLabel(t, option as 'proposition' | 'opposition' | 'judge')
                    : getDebateVerdictToneLabel(t, option)}
                </button>
              ))}
            </div>
          </div>

          <div className="debate-modal__group">
            <label className="debate-modal__label" htmlFor="debate-confidence">
              {t('debate.bet_confidence')}
            </label>
            <input
              id="debate-confidence"
              type="range"
              min={0.1}
              max={1}
              step={0.1}
              value={confidence}
              onChange={(event) => setConfidence(Number(event.target.value))}
            />
            <strong className="debate-modal__confidence">{Math.round(confidence * 100)}%</strong>
          </div>

          {error && (
            <p className="debate-modal__error" role="alert">{error}</p>
          )}
        </div>

        <footer className="debate-modal__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={loading}>
            {loading ? t('debate.bet_submitting') : t('debate.bet_submit')}
          </button>
        </footer>
      </div>
    </div>
  );
}
