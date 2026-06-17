import React, {
  useCallback,
  useEffect,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import {
  listModelProfiles,
  createModelProfile,
  patchModelProfile,
  deleteModelProfile,
} from '../api/client';
import type { ModelProfile } from '../types';
import { LLM_PROVIDER_PRESETS } from '../lib/llmProviderPolicy';
import { ConnectionTester } from './Setup/ConnectionTester';
import './ModelProfileManager.css';

const DEFAULT_PROVIDER_ID = 'openai';
const PROVIDER_PRESET_BASE_URLS = LLM_PROVIDER_PRESETS.map((preset) => preset.baseUrl);
// Concurrency must stay a positive, safe integer: the backend coerces <=0 to "no cap"
// (a silent no-op), and values past Number.MAX_SAFE_INTEGER lose precision via parseInt
// before they are sent (silent data corruption). 1024 is a generous upper bound — real
// per-profile LLM fan-out never approaches it.
const MAX_CONCURRENCY = 1024;

function getProviderBaseUrl(providerId: string): string {
  return LLM_PROVIDER_PRESETS.find((preset) => preset.id === providerId)?.baseUrl ?? '';
}

export function ModelProfileManager() {
  const { t } = useTranslation();
  const {
    enabled,
    loading,
    error: capabilityError,
    reload: reloadCapabilities,
  } = useCapabilityCheck('model_profiles');

  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<ModelProfile | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [provider, setProvider] = useState(DEFAULT_PROVIDER_ID);
  const [baseUrl, setBaseUrl] = useState(getProviderBaseUrl(DEFAULT_PROVIDER_ID));
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyCleared, setKeyCleared] = useState(false);
  const [rpm, setRpm] = useState<string>('');
  const [tpm, setTpm] = useState<string>('');
  const [concurrency, setConcurrency] = useState<string>('');
  const [supportsStructuredOutputs, setSupportsStructuredOutputs] = useState<'auto' | 'on' | 'off'>('auto');
  const [nativeSearchUpstream, setNativeSearchUpstream] = useState<'off' | 'auto' | 'xai_responses' | 'openai_responses'>('auto');

  // Feedback states
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [apiError, setApiError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Fetch profiles
  const fetchProfiles = useCallback(async () => {
    setIsLoadingProfiles(true);
    setApiError(null);
    try {
      const res = await listModelProfiles();
      setProfiles(res.profiles || []);
    } catch {
      setApiError(t('model_profiles.error_load'));
    } finally {
      setIsLoadingProfiles(false);
    }
  }, [t]);

  useEffect(() => {
    if (enabled) {
      void fetchProfiles();
    }
  }, [enabled, fetchProfiles]);

  // Handle provider change to suggest base_url
  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    // If base URL matches previous preset or is empty, suggest the new preset URL
    if (!baseUrl || PROVIDER_PRESET_BASE_URLS.includes(baseUrl)) {
      setBaseUrl(getProviderBaseUrl(newProvider));
    }
  };

  // Open create form
  const handleStartCreate = () => {
    setIsCreating(true);
    setIsEditing(false);
    setSelectedProfile(null);
    setFormErrors([]);
    setApiError(null);

    // Reset fields to defaults
    setName('');
    setDescription('');
    setProvider(DEFAULT_PROVIDER_ID);
    setBaseUrl(getProviderBaseUrl(DEFAULT_PROVIDER_ID));
    setModel('');
    setApiKey('');
    setKeyCleared(false);
    setRpm('');
    setTpm('');
    setConcurrency('');
    setSupportsStructuredOutputs('auto');
    setNativeSearchUpstream('auto');
  };

  // Open edit form
  const handleStartEdit = (profile: ModelProfile) => {
    setIsEditing(true);
    setIsCreating(false);
    setSelectedProfile(profile);
    setFormErrors([]);
    setApiError(null);

    // Populate fields
    setName(profile.name);
    setDescription(profile.description || '');
    setProvider(profile.provider);
    setBaseUrl(profile.base_url || '');
    setModel(profile.model);
    setApiKey(''); // Write-only field is initialized to empty
    setKeyCleared(false);
    setRpm(profile.rpm !== null && profile.rpm !== undefined ? String(profile.rpm) : '');
    setTpm(profile.tpm !== null && profile.tpm !== undefined ? String(profile.tpm) : '');
    setConcurrency(profile.concurrency !== null && profile.concurrency !== undefined ? String(profile.concurrency) : '');

    const mapApiToState = (val: boolean | null | undefined): 'auto' | 'on' | 'off' => {
      if (val === true) return 'on';
      if (val === false) return 'off';
      return 'auto';
    };
    setSupportsStructuredOutputs(mapApiToState(profile.supports_structured_outputs));
    setNativeSearchUpstream((profile.native_search_upstream as 'off' | 'auto' | 'xai_responses' | 'openai_responses') || 'auto');
  };

  // Cancel edit/create
  const handleCancel = () => {
    setIsEditing(false);
    setIsCreating(false);
    setSelectedProfile(null);
    setFormErrors([]);
    setApiError(null);
  };

  // Validate form fields
  const validateForm = (): boolean => {
    const errors: string[] = [];
    const trimmedName = name.trim();
    const trimmedModel = model.trim();
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedConcurrency = concurrency.trim();

    if (!trimmedName) {
      errors.push(t('model_profiles.validation_name_required'));
    }

    if (!trimmedModel) {
      errors.push(t('model_profiles.validation_model_required'));
    }

    if (trimmedBaseUrl) {
      // Validate scheme and URL shape
      try {
        const parsedUrl = new URL(trimmedBaseUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          errors.push(t('model_profiles.validation_invalid_base_url'));
        } else if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
          errors.push(t('model_profiles.validation_invalid_base_url'));
        }
      } catch {
        errors.push(t('model_profiles.validation_invalid_base_url'));
      }

      // Profile with base_url must have an api_key (or already have one set and not cleared)
      const hasKey = apiKey.trim().length > 0 || (isEditing && selectedProfile?.has_api_key && !keyCleared);
      if (!hasKey) {
        errors.push(t('model_profiles.validation_base_url_api_key'));
      }
    }

    if (trimmedConcurrency) {
      // Reject 0 / negatives (backend treats <=0 as "no cap" — a silent no-op that
      // looks like the user limited concurrency but did not) and values beyond a safe
      // integer / sane upper bound (parseInt precision loss = silent data corruption).
      const parsedConcurrency = Number(trimmedConcurrency);
      const concurrencyValid =
        /^\d+$/.test(trimmedConcurrency) &&
        Number.isSafeInteger(parsedConcurrency) &&
        parsedConcurrency >= 1 &&
        parsedConcurrency <= MAX_CONCURRENCY;
      if (!concurrencyValid) {
        errors.push(t('model_profiles.validation_concurrency_invalid', { max: MAX_CONCURRENCY }));
      }
    }

    setFormErrors(errors);
    return errors.length === 0;
  };

  // Handle Save
  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm() || isSaving) return;

    setIsSaving(true);
    setApiError(null);

    const parseOptionalNumber = (val: string): number | null => {
      const trimmed = val.trim();
      if (!trimmed || !/^\d+$/.test(trimmed)) return null;
      return parseInt(trimmed, 10);
    };

    const mapStateToApi = (val: 'auto' | 'on' | 'off'): boolean | null => {
      if (val === 'on') return true;
      if (val === 'off') return false;
      return null;
    };

    try {
      if (isCreating) {
        const payload = {
          name: name.trim(),
          description: description.trim() || undefined,
          provider,
          base_url: baseUrl.trim() || undefined,
          model: model.trim(),
          api_key: apiKey.trim() || undefined,
          rpm: parseOptionalNumber(rpm),
          tpm: parseOptionalNumber(tpm),
          concurrency: parseOptionalNumber(concurrency),
          supports_structured_outputs: mapStateToApi(supportsStructuredOutputs),
          native_search_upstream: nativeSearchUpstream,
        };
        await createModelProfile(payload);
      } else if (isEditing && selectedProfile) {
        const payload: Record<string, unknown> = {
          name: name.trim(),
          description: description.trim() || '',
          provider,
          base_url: baseUrl.trim() || '',
          model: model.trim(),
          rpm: parseOptionalNumber(rpm),
          tpm: parseOptionalNumber(tpm),
          concurrency: parseOptionalNumber(concurrency),
          supports_structured_outputs: mapStateToApi(supportsStructuredOutputs),
          native_search_upstream: nativeSearchUpstream,
        };

        if (keyCleared) {
          payload.api_key = ''; // Explicitly clear
        } else if (apiKey.trim()) {
          payload.api_key = apiKey.trim(); // Update key
        }

        await patchModelProfile(selectedProfile.id, payload);
      }

      setIsEditing(false);
      setIsCreating(false);
      setSelectedProfile(null);
      await fetchProfiles();
    } catch {
      setApiError(t('model_profiles.error_save'));
    } finally {
      setIsSaving(false);
    }
  };

  // Handle Delete
  const handleDelete = async (profileId: string) => {
    if (!window.confirm(t('model_profiles.delete_confirm')) || isSaving) return;

    setIsSaving(true);
    setApiError(null);
    try {
      await deleteModelProfile(profileId);
      if (selectedProfile?.id === profileId) {
        setIsEditing(false);
        setSelectedProfile(null);
      }
      await fetchProfiles();
    } catch {
      setApiError(t('model_profiles.error_delete'));
    } finally {
      setIsSaving(false);
    }
  };

  // Render capability gate errors first
  if (loading) {
    return (
      <div className="model-profile-manager model-profile-manager--loading" role="status" aria-busy="true">
        <div className="model-profile-manager__spinner" />
        <p>{t('common.loading')}</p>
      </div>
    );
  }

  if (capabilityError) {
    return (
      <div className="model-profile-manager model-profile-manager--error" role="alert">
        <h3 className="model-profile-manager__error-title">{t('common.capability_error_title')}</h3>
        <p className="model-profile-manager__error-desc">{t('common.capability_error')}</p>
        {reloadCapabilities && (
          <button
            type="button"
            onClick={() => void reloadCapabilities()}
            className="model-profile-manager__retry-btn btn btn--primary"
            aria-label={t('common.retry')}
          >
            {t('common.retry')}
          </button>
        )}
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="model-profile-manager model-profile-manager--disabled" role="alert">
        <p className="model-profile-manager__disabled-message">
          {t('model_profiles.disabled_hint')}
        </p>
      </div>
    );
  }

  return (
    <div className="model-profile-manager" data-testid="model-profile-manager">
      <div className="model-profile-manager__container">

        {/* Left Side: Profile List */}
        <div className="model-profile-manager__list-panel">
          <div className="model-profile-manager__panel-header">
            <h3>{t('model_profiles.title')}</h3>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={handleStartCreate}
              disabled={isSaving}
            >
              {t('model_profiles.add_profile')}
            </button>
          </div>

          {isLoadingProfiles && profiles.length === 0 ? (
            <p className="model-profile-manager__loading-text">{t('common.loading')}</p>
          ) : profiles.length === 0 ? (
            <p className="model-profile-manager__empty-text">{t('model_profiles.no_profiles')}</p>
          ) : (
            <div className="model-profile-manager__profiles-list" role="list">
              {profiles.map((profile) => (
                <div
                  key={profile.id}
                  className={`model-profile-manager__profile-card ${
                    selectedProfile?.id === profile.id ? 'is-selected' : ''
                  }`}
                  role="listitem"
                >
                  <div className="model-profile-manager__card-info">
                    <h4 className="model-profile-manager__card-name">{profile.name}</h4>
                    <p className="model-profile-manager__card-details">
                      <span>{profile.provider}</span> • <span>{profile.model}</span>
                    </p>
                    {profile.description && (
                      <p className="model-profile-manager__card-desc">{profile.description}</p>
                    )}
                  </div>
                  <div className="model-profile-manager__card-actions">
                    <button
                      type="button"
                      className="btn btn--sm btn--secondary"
                      onClick={() => handleStartEdit(profile)}
                      disabled={isSaving}
                    >
                      {t('model_profiles.edit', 'Edit')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      onClick={() => void handleDelete(profile.id)}
                      disabled={isSaving}
                    >
                      {t('model_profiles.delete', 'Delete')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right Side: Form Panel */}
        <div className="model-profile-manager__form-panel">
          {isCreating || isEditing ? (
            <form onSubmit={(e) => void handleSave(e)} className="model-profile-manager__form" noValidate>
              <h4>
                {isCreating ? t('model_profiles.add_profile') : t('model_profiles.edit_profile')}
              </h4>

              {formErrors.length > 0 && (
                <div className="model-profile-manager__form-errors" role="alert">
                  <ul>
                    {formErrors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {apiError && (
                <div className="model-profile-manager__api-error" role="alert">
                  {apiError}
                </div>
              )}

              <div className="form-group">
                <label htmlFor="mp-name">{t('model_profiles.profile_name')}</label>
                <input
                  id="mp-name"
                  type="text"
                  className="form-control"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isSaving}
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="mp-description">{t('model_profiles.description')}</label>
                <textarea
                  id="mp-description"
                  className="form-control"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={isSaving}
                  rows={2}
                />
              </div>

              <div className="form-group">
                <label htmlFor="mp-provider">{t('model_profiles.provider')}</label>
                <select
                  id="mp-provider"
                  className="form-control"
                  value={provider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  disabled={isSaving}
                >
                  {LLM_PROVIDER_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {t(preset.nameKey)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="mp-base-url">{t('model_profiles.base_url')}</label>
                <input
                  id="mp-base-url"
                  type="url"
                  className="form-control"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  disabled={isSaving}
                />
              </div>

              <div className="form-group">
                <label htmlFor="mp-model">{t('model_profiles.model')}</label>
                <input
                  id="mp-model"
                  type="text"
                  className="form-control"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={isSaving}
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="mp-api-key">{t('model_profiles.api_key')}</label>
                <input
                  id="mp-api-key"
                  type="password"
                  className="form-control"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    if (keyCleared) setKeyCleared(false);
                  }}
                  disabled={isSaving || (isEditing && keyCleared)}
                  placeholder={isEditing ? t('model_profiles.api_key_placeholder') : ''}
                />

                {isEditing && selectedProfile?.has_api_key && (
                  <div className="model-profile-manager__key-status">
                    {!keyCleared ? (
                      <>
                        <span className="badge badge--success">{t('model_profiles.api_key_set')}</span>
                        <button
                          type="button"
                          className="btn btn--link btn--sm"
                          onClick={() => {
                            setKeyCleared(true);
                            setApiKey('');
                          }}
                          disabled={isSaving}
                        >
                          {t('model_profiles.clear_key')}
                        </button>
                      </>
                    ) : (
                      <span className="badge badge--warning">{t('model_profiles.key_cleared_on_save')}</span>
                    )}
                  </div>
                )}
              </div>

              <div className="form-row">
                <div className="form-group col">
                  <label htmlFor="mp-rpm">{t('model_profiles.rpm')}</label>
                  <input
                    id="mp-rpm"
                    type="number"
                    min="0"
                    className="form-control"
                    value={rpm}
                    onChange={(e) => setRpm(e.target.value)}
                    disabled={isSaving}
                  />
                </div>
                <div className="form-group col">
                  <label htmlFor="mp-tpm">{t('model_profiles.tpm')}</label>
                  <input
                    id="mp-tpm"
                    type="number"
                    min="0"
                    className="form-control"
                    value={tpm}
                    onChange={(e) => setTpm(e.target.value)}
                    disabled={isSaving}
                  />
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="mp-concurrency">{t('model_profiles.concurrency')}</label>
                <input
                  id="mp-concurrency"
                  type="text"
                  inputMode="numeric"
                  className="form-control"
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value)}
                  placeholder={t('model_profiles.concurrency_placeholder')}
                  aria-describedby="mp-concurrency-helper"
                  disabled={isSaving}
                />
                <p id="mp-concurrency-helper" className="model-profile-manager__helper-text">
                  {t('model_profiles.concurrency_helper')}
                </p>
              </div>

              <div className="form-group">
                <label htmlFor="mp-structured">{t('model_profiles.supports_structured_outputs')}</label>
                <select
                  id="mp-structured"
                  className="form-control"
                  value={supportsStructuredOutputs}
                  onChange={(e) => setSupportsStructuredOutputs(e.target.value as 'auto' | 'on' | 'off')}
                  disabled={isSaving}
                >
                  <option value="auto">{t('model_profiles.option_auto')}</option>
                  <option value="on">{t('model_profiles.option_enabled')}</option>
                  <option value="off">{t('model_profiles.option_disabled')}</option>
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="mp-native-search">{t('model_profiles.supports_native_search')}</label>
                <select
                  id="mp-native-search"
                  className="form-control"
                  value={nativeSearchUpstream}
                  onChange={(e) => setNativeSearchUpstream(e.target.value as 'off' | 'auto' | 'xai_responses' | 'openai_responses')}
                  disabled={isSaving}
                >
                  <option value="off">{t('model_profiles.option_upstream_off')}</option>
                  <option value="auto">{t('model_profiles.option_upstream_auto')}</option>
                  <option value="xai_responses">{t('model_profiles.option_upstream_xai')}</option>
                  <option value="openai_responses">{t('model_profiles.option_upstream_openai')}</option>
                </select>
              </div>

              <div className="form-group">
                <ConnectionTester
                  baseUrl={baseUrl}
                  apiKey={apiKey}
                  model={model}
                  requestsPerMinute={rpm && !isNaN(parseInt(rpm, 10)) ? parseInt(rpm, 10) : undefined}
                  tokensPerMinute={tpm && !isNaN(parseInt(tpm, 10)) ? parseInt(tpm, 10) : undefined}
                  testButtonText={t('model_profiles.test_connection')}
                  testSuccessText={t('model_profiles.test_ok')}
                  testFailureText={t('model_profiles.test_failed')}
                  includeNativeProbe
                  nativeSearchUpstream={nativeSearchUpstream}
                  disabled={Boolean(isEditing && selectedProfile?.has_api_key && !keyCleared && !apiKey.trim())}
                  disabledHint={t('model_profiles.test_needs_key')}
                />
              </div>

              <div className="model-profile-manager__storage-notice">
                <p>{t('model_profiles.storage_notice')}</p>
              </div>

              <div className="model-profile-manager__form-actions">
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={isSaving}
                >
                  {isSaving ? t('common.saving') : t('model_profiles.save')}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={handleCancel}
                  disabled={isSaving}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          ) : (
            <div className="model-profile-manager__form-placeholder">
              <p>{t('model_profiles.placeholder_select')}</p>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
