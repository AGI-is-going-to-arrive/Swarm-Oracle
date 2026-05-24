import { useTranslation } from 'react-i18next';
import type { RoundtableDiscussionFormat, RoundtableCastMode } from '../../types';

interface FormatSelectorProps {
  discussionFormat: RoundtableDiscussionFormat;
  castMode: RoundtableCastMode;
  onFormatChange: (format: RoundtableDiscussionFormat) => void;
  onCastModeChange: (mode: RoundtableCastMode) => void;
  disabled?: boolean;
}

const FORMAT_OPTIONS: RoundtableDiscussionFormat[] = ['deep_dive', 'quick_review', 'clash_mode'];
const CAST_OPTIONS: RoundtableCastMode[] = ['smart_pick', 'custom'];

export function FormatSelector({ discussionFormat, castMode, onFormatChange, onCastModeChange, disabled }: FormatSelectorProps) {
  const { t } = useTranslation();

  return (
    <div className="roundtable-format-selector" role="group" aria-label={t('roundtable.format_selector_label', 'Discussion format')}>
      <fieldset className="roundtable-format-selector__formats" disabled={disabled}>
        <legend className="sr-only">{t('roundtable.format_label', 'Format')}</legend>
        {FORMAT_OPTIONS.map(fmt => (
          <label key={fmt} className={`roundtable-format-option${discussionFormat === fmt ? ' roundtable-format-option--active' : ''}`}>
            <input
              type="radio"
              name="roundtable-format"
              value={fmt}
              checked={discussionFormat === fmt}
              onChange={() => onFormatChange(fmt)}
            />
            <span>{t(`roundtable.format_${fmt}`)}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="roundtable-format-selector__cast" disabled={disabled}>
        <legend className="sr-only">{t('roundtable.cast_label', 'Cast mode')}</legend>
        {CAST_OPTIONS.map(mode => (
          <label key={mode} className={`roundtable-cast-option${castMode === mode ? ' roundtable-cast-option--active' : ''}`}>
            <input
              type="radio"
              name="roundtable-cast"
              value={mode}
              checked={castMode === mode}
              onChange={() => onCastModeChange(mode)}
            />
            <span>{t(`roundtable.cast_${mode}`)}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
