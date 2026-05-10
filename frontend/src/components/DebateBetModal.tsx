import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import {
  type DebatePredictionKind,
  getDebateSideLabel,
  getDebateVerdictToneLabel,
} from '../lib/debateLabels';

const DEFAULT_AVAILABLE_OPTIONS: Record<DebatePredictionKind, string[]> = {
  winner: ['proposition', 'opposition'],
  verdict_tone: ['order', 'balance', 'rupture'],
};

function normalizeAvailableOptions(
  availableOptions?: Partial<Record<DebatePredictionKind, string[]>> | null,
): Record<DebatePredictionKind, string[]> {
  const winner = Array.isArray(availableOptions?.winner)
    ? availableOptions.winner.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : [];
  const verdictTone = Array.isArray(availableOptions?.verdict_tone)
    ? availableOptions.verdict_tone.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : [];
  return {
    winner: winner.length > 0 ? winner : DEFAULT_AVAILABLE_OPTIONS.winner,
    verdict_tone: verdictTone.length > 0 ? verdictTone : DEFAULT_AVAILABLE_OPTIONS.verdict_tone,
  };
}

function resolveSupportedKind(
  preferredKind: DebatePredictionKind,
  availableOptions: Record<DebatePredictionKind, string[]>,
): DebatePredictionKind {
  if (availableOptions[preferredKind].length > 0) {
    return preferredKind;
  }
  return availableOptions.winner.length > 0 ? 'winner' : 'verdict_tone';
}

function resolveSupportedTarget(
  kind: DebatePredictionKind,
  preferredTarget: string | undefined,
  availableOptions: Record<DebatePredictionKind, string[]>,
): string {
  if (preferredTarget && availableOptions[kind].includes(preferredTarget)) {
    return preferredTarget;
  }
  return availableOptions[kind][0] ?? '';
}

interface DebateBetModalProps {
  loading?: boolean;
  availableOptions?: Partial<Record<DebatePredictionKind, string[]>> | null;
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
  availableOptions = null,
  initialSelection = null,
  strategyHint = null,
  onClose,
  onSubmit,
  onAutomationStateChange,
}: DebateBetModalProps) {
  const { t } = useTranslation();
  const normalizedOptions = useMemo(
    () => normalizeAvailableOptions(availableOptions),
    [availableOptions],
  );
  const availableKinds = useMemo(
    () => (Object.entries(normalizedOptions)
      .filter(([, options]) => options.length > 0)
      .map(([optionKind]) => optionKind as DebatePredictionKind)),
    [normalizedOptions],
  );
  const [kind, setKind] = useState<DebatePredictionKind>(() => resolveSupportedKind(
    initialSelection?.kind ?? 'winner',
    normalizedOptions,
  ));
  const [targetValue, setTargetValue] = useState<string>(() => resolveSupportedTarget(
    resolveSupportedKind(initialSelection?.kind ?? 'winner', normalizedOptions),
    initialSelection?.targetValue,
    normalizedOptions,
  ));
  const [confidence, setConfidence] = useState<number>(initialSelection?.confidence ?? 0.7);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const nextKind = resolveSupportedKind(initialSelection?.kind ?? 'winner', normalizedOptions);
    const timeoutId = window.setTimeout(() => {
      setKind(nextKind);
      setTargetValue(resolveSupportedTarget(nextKind, initialSelection?.targetValue, normalizedOptions));
      setConfidence(initialSelection?.confidence ?? 0.7);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [initialSelection, normalizedOptions]);

  const options = useMemo(
    () => normalizedOptions[kind],
    [kind, normalizedOptions],
  );

  useEffect(() => {
    const supportedKind = resolveSupportedKind(kind, normalizedOptions);
    if (supportedKind !== kind) {
      const timeoutId = window.setTimeout(() => {
        setKind(supportedKind);
        setTargetValue(resolveSupportedTarget(supportedKind, targetValue, normalizedOptions));
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
    if (!options.includes(targetValue)) {
      const timeoutId = window.setTimeout(() => {
        setTargetValue(resolveSupportedTarget(kind, targetValue, normalizedOptions));
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [kind, normalizedOptions, options, targetValue]);

  const submitDisabled = loading || !targetValue || !options.includes(targetValue);

  useEffect(() => {
    onAutomationStateChange?.({
      kind: 'debate_bet_modal',
      available_kinds: availableKinds,
      selected_kind: kind,
      selected_target: targetValue,
      target_options: options,
      confidence,
      confidence_percent: Math.round(confidence * 100),
      preset_kind: initialSelection?.kind ?? null,
      preset_target: initialSelection?.targetValue ?? null,
      submit_disabled: submitDisabled,
      error: error || null,
    });

    return () => {
      onAutomationStateChange?.(null);
    };
  }, [availableKinds, confidence, error, initialSelection?.kind, initialSelection?.targetValue, kind, onAutomationStateChange, options, submitDisabled, targetValue]);

  const handleSubmit = async () => {
    if (submitDisabled) return;
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
          <button
            type="button"
            className="debate-modal__close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
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
              {availableKinds.map((optionKind) => (
                <button
                  key={optionKind}
                  type="button"
                  className={`mode-btn ${kind === optionKind ? 'mode-btn--active' : ''}`}
                  onClick={() => {
                    setKind(optionKind);
                    setTargetValue(resolveSupportedTarget(optionKind, undefined, normalizedOptions));
                  }}
                >
                  {optionKind === 'winner'
                    ? t('debate.bet_kind_winner')
                    : t('debate.bet_kind_tone')}
                </button>
              ))}
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
          <button type="button" className="btn btn-primary" onClick={handleSubmit} disabled={submitDisabled}>
            {loading ? t('debate.bet_submitting') : t('debate.bet_submit')}
          </button>
        </footer>
      </div>
    </div>
  );
}
