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
import './ModelProfileManager.css';

// Default base URLs mapped by provider IDs
const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1',
  custom: '',
};

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
  const [provider, setProvider] = useState('openai');
  const [baseUrl, setBaseUrl] = useState(PROVIDER_BASE_URLS.openai);
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyCleared, setKeyCleared] = useState(false);
  const [rpm, setRpm] = useState<string>('');
  const [tpm, setTpm] = useState<string>('');
  const [concurrency, setConcurrency] = useState<string>('');
  const [supportsStructuredOutputs, setSupportsStructuredOutputs] = useState(false);
  const [supportsNativeSearch, setSupportsNativeSearch] = useState(false);

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
    const currentPresetUrls = Object.values(PROVIDER_BASE_URLS);
    if (!baseUrl || currentPresetUrls.includes(baseUrl)) {
      setBaseUrl(PROVIDER_BASE_URLS[newProvider] || '');
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
    setProvider('openai');
    setBaseUrl(PROVIDER_BASE_URLS.openai);
    setModel('');
    setApiKey('');
    setKeyCleared(false);
    setRpm('');
    setTpm('');
    setConcurrency('');
    setSupportsStructuredOutputs(false);
    setSupportsNativeSearch(false);
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
    setSupportsStructuredOutputs(profile.supports_structured_outputs);
    setSupportsNativeSearch(profile.supports_native_search);
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
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? null : parsed;
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
          supports_structured_outputs: supportsStructuredOutputs,
          supports_native_search: supportsNativeSearch,
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
          supports_structured_outputs: supportsStructuredOutputs,
          supports_native_search: supportsNativeSearch,
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
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="ollama">Ollama</option>
                  <option value="lmstudio">LM Studio</option>
                  <option value="custom">Custom</option>
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
                  type="number"
                  min="1"
                  className="form-control"
                  value={concurrency}
                  onChange={(e) => setConcurrency(e.target.value)}
                  disabled={isSaving}
                />
              </div>

              <div className="form-group form-check">
                <input
                  id="mp-structured"
                  type="checkbox"
                  className="form-check-input"
                  checked={supportsStructuredOutputs}
                  onChange={(e) => setSupportsStructuredOutputs(e.target.checked)}
                  disabled={isSaving}
                />
                <label htmlFor="mp-structured" className="form-check-label">
                  {t('model_profiles.supports_structured_outputs')}
                </label>
              </div>

              <div className="form-group form-check">
                <input
                  id="mp-native-search"
                  type="checkbox"
                  className="form-check-input"
                  checked={supportsNativeSearch}
                  onChange={(e) => setSupportsNativeSearch(e.target.checked)}
                  disabled={isSaving}
                />
                <label htmlFor="mp-native-search" className="form-check-label">
                  {t('model_profiles.supports_native_search')}
                </label>
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
