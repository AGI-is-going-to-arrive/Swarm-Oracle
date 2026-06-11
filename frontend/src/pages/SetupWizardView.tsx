/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Setup Wizard (S0-1)
   ═══════════════════════════════════════════════════════════
   3-step state machine:
     1) provider_select  → pick a preset card (radiogroup)
     2) api_config       → fill API key + base URL
     3) connection_test  → POST /api/admin/test-llm

   State lives entirely in this component (per task spec — no new store).
   On finish, persists to the existing llmProviderPolicy session storage
   so downstream BYOK paths (InputView etc.) can pick it up.
*/

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  LLM_PROVIDER_PRESETS,
  loadLlmProviderPolicy,
  saveLlmProviderPolicy,
  type LlmProviderPreset,
} from '../lib/llmProviderPolicy';
import { ProviderPresetCard } from '../components/Setup/ProviderPresetCard';
import { ConnectionTester } from '../components/Setup/ConnectionTester';
import './SetupWizardView.css';

type WizardStep = 'provider_select' | 'api_config' | 'connection_test';

const STEP_ORDER: WizardStep[] = [
  'provider_select',
  'api_config',
  'connection_test',
];

export default function SetupWizardView() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const initialPolicy = useMemo(() => loadLlmProviderPolicy(), []);

  const [step, setStep] = useState<WizardStep>('provider_select');
  const [selectedPreset, setSelectedPreset] = useState<LlmProviderPreset | null>(
    null,
  );
  const [apiKey, setApiKey] = useState<string>(initialPolicy.apiKey);
  const [baseUrl, setBaseUrl] = useState<string>(initialPolicy.baseUrl);

  const stepIndex = STEP_ORDER.indexOf(step);
  const stepNumber = stepIndex + 1;
  const totalSteps = STEP_ORDER.length;

  const handleSelectPreset = (preset: LlmProviderPreset) => {
    setSelectedPreset(preset);
    if (preset.baseUrl) {
      setBaseUrl(preset.baseUrl);
    } else if (preset.id === 'custom') {
      setBaseUrl('');
    }
    if (!preset.requiresApiKey) {
      // Local stacks (Ollama / LM Studio) don't need a key — clear stale one.
      setApiKey('');
    }
  };

  const requiresApiKey = selectedPreset?.requiresApiKey ?? true;
  const apiConfigValid = useMemo(() => {
    if (!baseUrl.trim()) return false;
    if (requiresApiKey && !apiKey.trim()) return false;
    return true;
  }, [baseUrl, apiKey, requiresApiKey]);

  const goNext = () => {
    if (step === 'provider_select' && selectedPreset) {
      setStep('api_config');
    } else if (step === 'api_config' && apiConfigValid) {
      setStep('connection_test');
    }
  };

  const goBack = () => {
    if (step === 'api_config') setStep('provider_select');
    else if (step === 'connection_test') setStep('api_config');
  };

  const handleFinish = () => {
    saveLlmProviderPolicy({
      ...initialPolicy,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
    });
    navigate('/');
  };

  const handleSkip = () => {
    navigate('/');
  };

  const stepTitleKey: Record<WizardStep, string> = {
    provider_select: 'setup.step1_title',
    api_config: 'setup.step2_title',
    connection_test: 'setup.step3_title',
  };

  return (
    <main className="wizard">
      <header className="wizard__header">
        <h1 className="wizard__title">{t('setup.title')}</h1>
        <div className="wizard__progress" aria-label={t('setup.progress_aria')}>
          {STEP_ORDER.map((s, idx) => {
            const isActive = idx === stepIndex;
            const isDone = idx < stepIndex;
            const dotClass = isActive
              ? 'wizard__dot wizard__dot--active'
              : isDone
                ? 'wizard__dot wizard__dot--done'
                : 'wizard__dot';
            return <span key={s} className={dotClass} aria-hidden="true" />;
          })}
          <span className="wizard__step-label">
            {t('setup.step_count', { current: stepNumber, total: totalSteps })}
          </span>
        </div>
        <h2 className="wizard__subtitle">{t(stepTitleKey[step])}</h2>
      </header>

      <section className="wizard__body" aria-live="polite">
        {step === 'provider_select' ? (
          <div
            role="radiogroup"
            aria-label={t('setup.step1_title')}
            className="provider-grid"
          >
            {LLM_PROVIDER_PRESETS.map((preset, index) => {
              const selected = selectedPreset?.id === preset.id;
              return (
                <ProviderPresetCard
                  key={preset.id}
                  preset={preset}
                  selected={selected}
                  tabbable={selectedPreset === null ? index === 0 : selected}
                  onSelect={handleSelectPreset}
                />
              );
            })}
          </div>
        ) : null}

        {step === 'api_config' ? (
          <div className="wizard__form">
            <label className="wizard__field">
              <span className="wizard__field-label">
                {t('setup.base_url_label')}
              </span>
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className="wizard__input"
                spellCheck={false}
                autoComplete="off"
              />
            </label>

            <label className="wizard__field">
              <span className="wizard__field-label">
                {t('setup.api_key_label')}
                {!requiresApiKey ? (
                  <span className="wizard__field-optional">
                    {' '}
                    ({t('setup.optional_label')})
                  </span>
                ) : null}
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('setup.api_key_placeholder')}
                className="wizard__input"
                spellCheck={false}
                autoComplete="off"
                disabled={!requiresApiKey && selectedPreset?.id !== 'custom'}
              />
              {!requiresApiKey ? (
                <span className="wizard__hint">{t('setup.no_key_hint')}</span>
              ) : null}
            </label>
          </div>
        ) : null}

        {step === 'connection_test' ? (
          <div className="wizard__test">
            <p className="wizard__test-intro">{t('setup.step3_intro')}</p>
            <div className="wizard__summary">
              <div className="wizard__summary-row">
                <span className="wizard__summary-key">
                  {t('setup.summary_provider')}
                </span>
                <span className="wizard__summary-val">
                  {selectedPreset ? t(selectedPreset.nameKey) : '—'}
                </span>
              </div>
              <div className="wizard__summary-row">
                <span className="wizard__summary-key">
                  {t('setup.summary_base_url')}
                </span>
                <span className="wizard__summary-val">{baseUrl || '—'}</span>
              </div>
              <div className="wizard__summary-row">
                <span className="wizard__summary-key">
                  {t('setup.summary_api_key')}
                </span>
                <span className="wizard__summary-val">
                  {apiKey ? '••••••••' : t('setup.summary_no_key')}
                </span>
              </div>
            </div>
            <ConnectionTester baseUrl={baseUrl} apiKey={apiKey} />
          </div>
        ) : null}
      </section>

      <footer className="wizard__footer">
        <div className="wizard__footer-left">
          <button
            type="button"
            className="wizard__btn wizard__btn--ghost"
            onClick={handleSkip}
          >
            {t('setup.skip')}
          </button>
        </div>
        <div className="wizard__footer-right">
          {step !== 'provider_select' ? (
            <button
              type="button"
              className="wizard__btn wizard__btn--secondary"
              onClick={goBack}
            >
              {t('setup.back')}
            </button>
          ) : null}
          {step !== 'connection_test' ? (
            <button
              type="button"
              className="wizard__btn wizard__btn--primary"
              onClick={goNext}
              disabled={
                (step === 'provider_select' && !selectedPreset) ||
                (step === 'api_config' && !apiConfigValid)
              }
            >
              {t('setup.next')}
            </button>
          ) : (
            <button
              type="button"
              className="wizard__btn wizard__btn--primary"
              onClick={handleFinish}
            >
              {t('setup.finish')}
            </button>
          )}
        </div>
      </footer>
    </main>
  );
}
