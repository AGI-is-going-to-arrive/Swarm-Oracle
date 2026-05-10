/* ═══════════════════════════════════════════════════════════
   S2-4 — Decision Bias Slider Editor (Agent Workshop)
   ═══════════════════════════════════════════════════════════ */

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Slider } from '../ui/slider';
import {
  DECISION_BIAS_KEYS,
  type DecisionBiasKey,
  clampBias,
  DECISION_BIAS_DEFAULT,
} from './decisionBias';
import './DecisionBiasSlider.css';

const LABEL_KEYS: Record<DecisionBiasKey, string> = {
  caution: 'agent_workshop.bias_caution',
  optimism: 'agent_workshop.bias_optimism',
  conservatism: 'agent_workshop.bias_conservatism',
  risk_tolerance: 'agent_workshop.bias_risk_tolerance',
  creativity: 'agent_workshop.bias_creativity',
};

const FALLBACK_LABELS: Record<DecisionBiasKey, string> = {
  caution: 'Caution',
  optimism: 'Optimism',
  conservatism: 'Conservatism',
  risk_tolerance: 'Risk Tolerance',
  creativity: 'Creativity',
};

export interface DecisionBiasSliderProps {
  values: Record<string, number>;
  onChange: (key: DecisionBiasKey, value: number) => void;
  disabled?: boolean;
}

/**
 * Vertical stack of 5 sliders, each with label + value badge + cool→neutral→warm
 * gradient track. Driven by parent state; no internal state.
 */
export function DecisionBiasSlider({ values, onChange, disabled }: DecisionBiasSliderProps) {
  const { t } = useTranslation();

  const handleChange = useCallback(
    (key: DecisionBiasKey) => (next: number[]) => {
      if (!next.length) return;
      const raw = next[0];
      const normalized = typeof raw === 'number' && Number.isFinite(raw)
        ? Math.min(1, Math.max(0, raw / 100))
        : DECISION_BIAS_DEFAULT;
      onChange(key, normalized);
    },
    [onChange],
  );

  return (
    <div className="decision-bias">
      <div className="decision-bias__title">
        {t('agent_workshop.bias_title', 'Decision Bias Profile')}
      </div>
      <p className="decision-bias__hint">
        {t('agent_workshop.bias_hint', 'Adjust how this agent makes decisions')}
      </p>
      <div className="decision-bias__list" role="group" aria-label={t('agent_workshop.bias_title', 'Decision Bias Profile')}>
        {DECISION_BIAS_KEYS.map((key) => {
          const value = clampBias(values[key]);
          const sliderValue = Math.round(value * 100);
          const label = t(LABEL_KEYS[key], FALLBACK_LABELS[key]);
          return (
            <div key={key} className="decision-bias__row">
              <div className="decision-bias__label-row">
                <label htmlFor={`bias-${key}`} className="decision-bias__label">
                  {label}
                </label>
                <span
                  className="decision-bias__value"
                  data-testid={`bias-value-${key}`}
                  aria-hidden="true"
                >
                  {sliderValue}%
                </span>
              </div>
              <Slider
                id={`bias-${key}`}
                className="decision-bias__slider"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={sliderValue}
                value={[sliderValue]}
                min={0}
                max={100}
                step={1}
                disabled={disabled}
                onValueChange={handleChange(key)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default DecisionBiasSlider;
