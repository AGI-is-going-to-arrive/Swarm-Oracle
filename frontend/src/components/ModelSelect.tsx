import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { listModels } from '../api/client';
import './ModelSelect.css';
import { captureApiError, getApiErrorDiagnostic, getLocalizedApiErrorMessage, type ApiErrorState } from '../lib/apiErrorMessage';

export interface ModelSelectProps {
  baseUrl: string;
  apiKey?: string;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
  /** Applies this id to the rendered <input>/<select> so an external <label htmlFor> can associate with it. */
  inputId?: string;
  /** Overrides the default `wizard__input` class on the rendered control (e.g. to reuse host-page input styling). */
  inputClassName?: string;
}

export function ModelSelect({
  baseUrl,
  apiKey,
  value,
  onChange,
  disabled,
  inputId,
  inputClassName,
}: ModelSelectProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiErrorState | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [isManual, setIsManual] = useState<boolean>(true);
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    // request-id guard: cleanup flips `active` so a slow in-flight listModels()
    // resolving after baseUrl/apiKey changed (or after unmount) can never apply a
    // stale provider's model list. (codex Gate3 MEDIUM ModelSelect.tsx:58)
    // setState stays wrapped in setTimeout to satisfy react-hooks/set-state-in-effect.
    let active = true;

    if (!baseUrl.trim()) {
      const resetTimer = setTimeout(() => {
        if (!active) return;
        setModels([]);
        setSupported(false);
        setLoading(false);
        setError(null);
        setIsManual(true);
      }, 0);
      return () => {
        active = false;
        clearTimeout(resetTimer);
      };
    }

    const startTimer = setTimeout(() => {
      if (!active) return;
      setLoading(true);
      setError(null);
    }, 0);

    const timer = setTimeout(async () => {
      try {
        const res = await listModels(baseUrl, apiKey);
        if (!active) return;
        const fetchedModels = res.models || [];
        setModels(fetchedModels);
        setSupported(res.supported);
        setLoading(false);

        if (res.supported && fetchedModels.length > 0) {
          // value matches a fetched model (or is empty) → default to dropdown mode
          const hasMatch = fetchedModels.includes(valueRef.current);
          setIsManual(!hasMatch && valueRef.current !== '');
        } else {
          setIsManual(true);
        }
      } catch (err) {
        if (!active) return;
        setError(captureApiError(err));
        setModels([]);
        setSupported(false);
        setLoading(false);
        setIsManual(true);
      }
    }, 500);

    return () => {
      active = false;
      clearTimeout(startTimer);
      clearTimeout(timer);
    };
  }, [baseUrl, apiKey]);

  const showDropdown = !isManual && supported && models.length > 0;
  const errorDiagnostic = getApiErrorDiagnostic(error);

  return (
    <div className="model-select">
      <div className="model-select__row">
        <div className="model-select__control">
          {showDropdown ? (
            <select
              id={inputId}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className={inputClassName ?? 'wizard__input'}
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
              id={inputId}
              type="text"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={t('model_select.placeholder')}
              className={inputClassName ?? 'wizard__input'}
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
        <div className="model-select__hint model-select__hint--error" role="alert">
          {getLocalizedApiErrorMessage(error, t, t('model_select.list_failed'))}
          {errorDiagnostic && <details><summary>{t('common.error_details')}</summary><code>{errorDiagnostic}</code></details>}
        </div>
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
