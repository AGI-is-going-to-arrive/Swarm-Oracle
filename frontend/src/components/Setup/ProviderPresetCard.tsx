/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Setup Wizard Provider Preset Card (S0-1)
   ═══════════════════════════════════════════════════════════
   Single radio-card that shows a provider preset on Step 1.
   - role="radio" + aria-checked for screen readers
   - keyboard activation: Enter / Space
   - selected state lives in the parent state machine
*/

import { useTranslation } from 'react-i18next';
import type { KeyboardEvent } from 'react';
import type { LlmProviderPreset } from '../../lib/llmProviderPolicy';

export interface ProviderPresetCardProps {
  preset: LlmProviderPreset;
  selected: boolean;
  tabbable?: boolean;
  onSelect: (preset: LlmProviderPreset) => void;
}

export function ProviderPresetCard({
  preset,
  selected,
  tabbable,
  onSelect,
}: ProviderPresetCardProps) {
  const { t } = useTranslation();

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(preset);
    }
  };

  const className = selected
    ? 'provider-card provider-card--selected'
    : 'provider-card';

  const subText = preset.baseUrl
    ? preset.baseUrl
    : t('setup.provider_custom_hint');
  const isTabbable = tabbable ?? selected;

  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={isTabbable ? 0 : -1}
      className={className}
      onClick={() => onSelect(preset)}
      onKeyDown={handleKeyDown}
      data-preset-id={preset.id}
    >
      <div className="provider-card__logo" aria-hidden="true">
        {preset.logoPlaceholder}
      </div>
      <div className="provider-card__body">
        <span className="provider-card__name">{t(preset.nameKey)}</span>
        <span className="provider-card__sub">{subText}</span>
      </div>
      {selected ? (
        <span className="provider-card__check" aria-hidden="true">
          ✓
        </span>
      ) : null}
    </div>
  );
}

export default ProviderPresetCard;
