import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { listModels } from '../api/client';

export interface ModelSelectProps {
  baseUrl: string;
  apiKey?: string;
  value: string;
  onChange: (model: string) => void;
  provider?: string;
  disabled?: boolean;
}

export function ModelSelect({
  baseUrl,
  apiKey,
  value,
  onChange,
  disabled,
}: ModelSelectProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [isManual, setIsManual] = useState<boolean>(true);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!baseUrl.trim()) {
      const initTimer = setTimeout(() => {
        setModels([]);
        setSupported(false);
        setLoading(false);
        setError(null);
        setIsManual(true);
      }, 0);
      return () => clearTimeout(initTimer);
    }

    const startTimer = setTimeout(() => {
      setLoading(true);
      setError(null);
    }, 0);

    const timer = setTimeout(async () => {
      try {
        const res = await listModels(baseUrl, apiKey);
        const fetchedModels = res.models || [];
        setModels(fetchedModels);
        setSupported(res.supported);
        setLoading(false);

        if (res.supported && fetchedModels.length > 0) {
          // If value matches one of the fetched models, or if it is empty, default to dropdown mode
          const hasMatch = fetchedModels.includes(valueRef.current);
          setIsManual(!hasMatch && valueRef.current !== '');
        } else {
          setIsManual(true);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setModels([]);
        setSupported(false);
        setLoading(false);
        setIsManual(true);
      }
    }, 500);

    return () => {
      clearTimeout(startTimer);
      clearTimeout(timer);
    };
  }, [baseUrl, apiKey]);

  const showDropdown = !isManual && supported && models.length > 0;

  return (
    <div className="model-select">
      <div className="model-select__row">
        <div className="model-select__control">
          {showDropdown ? (
            <select
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="wizard__input"
              style={{ width: '100%' }}
              disabled={disabled}
              aria-label={t('model_profiles.model')}
            >
              <option value="">-- {t('model_select.placeholder')} --</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={t('model_select.placeholder')}
              className="wizard__input"
              style={{ width: '100%' }}
              disabled={disabled}
              spellCheck={false}
              autoComplete="off"
            />
          )}
        </div>

        {supported && models.length > 0 && (
          <button
            type="button"
            className="model-select__toggle-btn"
            onClick={() => setIsManual((prev) => !prev)}
            disabled={disabled}
          >
            {isManual ? t('model_select.use_dropdown') : t('model_select.manual_input')}
          </button>
        )}
      </div>

      {loading && (
        <span className="model-select__hint" role="status" aria-live="polite">
          {t('model_select.loading')}
        </span>
      )}

      {!loading && error && (
        <span className="model-select__hint model-select__hint--error" role="alert">
          {t('model_select.list_failed')}: {error}
        </span>
      )}

      {!loading && !error && supported === false && baseUrl.trim() !== '' && (
        <span className="model-select__hint">
          {t('model_select.fallback_hint')}
        </span>
      )}

      {!loading && !error && supported === true && models.length === 0 && baseUrl.trim() !== '' && (
        <span className="model-select__hint">
          {t('model_select.list_failed')}
        </span>
      )}
    </div>
  );
}

export default ModelSelect;
