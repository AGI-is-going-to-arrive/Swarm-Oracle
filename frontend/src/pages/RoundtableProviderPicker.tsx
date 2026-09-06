import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getRoundtableProvider, listModelProfiles } from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import type { ModelProfile, RoundtableProviderSelection } from '../types';

interface RoundtableProviderPickerProps {
  scenarioId: string;
  roomId?: string | null;
  role: 'analyst' | 'survey';
  value: string;
  onChange: (profileId: string) => void;
  onReadyChange: (ready: boolean) => void;
  disabled: boolean;
}

export default function RoundtableProviderPicker({
  scenarioId, roomId, role, value, onChange, onReadyChange, disabled,
}: RoundtableProviderPickerProps): React.JSX.Element {
  const { t } = useTranslation();
  const { enabled, error: capabilityError, reload } = useCapabilityCheck('model_profiles');
  const [provider, setProvider] = useState<RoundtableProviderSelection | null>(null);
  const [providerError, setProviderError] = useState(false);
  const [providerLoading, setProviderLoading] = useState(true);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [profilesError, setProfilesError] = useState(false);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const providerEpochRef = useRef(0);
  const profilesEpochRef = useRef(0);

  const loadProvider = useCallback(async (): Promise<void> => {
    const epoch = ++providerEpochRef.current;
    setProviderLoading(true);
    setProviderError(false);
    try {
      const result = await getRoundtableProvider(scenarioId, roomId);
      if (epoch === providerEpochRef.current) setProvider(result);
    } catch {
      if (epoch === providerEpochRef.current) {
        setProvider(null);
        setProviderError(true);
      }
    } finally {
      if (epoch === providerEpochRef.current) setProviderLoading(false);
    }
  }, [roomId, scenarioId]);

  const loadProfiles = useCallback(async (): Promise<void> => {
    const epoch = ++profilesEpochRef.current;
    setProfilesLoading(true);
    setProfilesError(false);
    try {
      const result = await listModelProfiles();
      if (epoch === profilesEpochRef.current) setProfiles(result.profiles);
    } catch {
      if (epoch === profilesEpochRef.current) setProfilesError(true);
    } finally {
      if (epoch === profilesEpochRef.current) setProfilesLoading(false);
    }
  }, []);

  useEffect(() => {
    setProvider(null);
    void loadProvider();
    return () => { providerEpochRef.current += 1; };
  }, [loadProvider]);
  useEffect(() => {
    if (enabled) void loadProfiles();
    return () => { profilesEpochRef.current += 1; };
  }, [enabled, loadProfiles]);

  const selectedProfile = profiles.find((profile) => profile.id === value);
  const ready = value ? Boolean(selectedProfile && enabled) : Boolean(provider && !providerLoading && !providerError);
  useEffect(() => { onReadyChange(ready); }, [onReadyChange, ready]);

  return (
    <div className={`${role}-profile-selector`} style={{ marginBottom: '0.75rem' }}>
      <p role="status">
        {value ? (
          <>{t('roundtable.provider_source_role_override')}: {selectedProfile?.name ?? t('roundtable.provider_unavailable')} {selectedProfile ? `(${selectedProfile.model})` : ''}</>
        ) : providerLoading ? t('roundtable.provider_loading') : provider ? (
          <>{t(`roundtable.provider_source_${provider.source}`)}: {provider.name}{provider.name !== provider.model ? ` (${provider.model})` : ''}</>
        ) : t('roundtable.provider_unavailable')}
      </p>
      {providerError && !value && (
        <div role="status">
          <p>{t('roundtable.provider_load_failed')}</p>
          <button type="button" className="btn btn--sm" disabled={disabled || providerLoading} onClick={() => void loadProvider()}>{t('common.retry')}</button>
        </div>
      )}
      {capabilityError && (
        <div role="status">
          <p>{t('roundtable.profile_list_failed')}</p>
          <button type="button" className="btn btn--sm" disabled={disabled} onClick={() => void reload?.()}>{t('common.retry')}</button>
        </div>
      )}
      {enabled && (
        <details>
          <summary>{t('roundtable.provider_change')}</summary>
          <label htmlFor={`${role}-profile-select`}>{t('model_profiles.placeholder_select')}</label>
          <select id={`${role}-profile-select`} className="form-control" value={value}
            onChange={(event) => onChange(event.target.value)} disabled={disabled || profilesLoading}
            style={{ display: 'block', width: '100%', maxWidth: '100%', marginTop: '0.25rem' }}>
            <option value="">{t('roundtable.provider_inherit')}</option>
            {value && !selectedProfile && <option value={value}>{t('roundtable.provider_unavailable')}</option>}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name} ({profile.provider} - {profile.model})</option>
            ))}
          </select>
          {profilesLoading && <p role="status">{t('common.loading')}</p>}
          {profilesError && (
            <div role="status">
              <p>{t('roundtable.profile_list_failed')}</p>
              <button type="button" className="btn btn--sm" disabled={disabled || profilesLoading} onClick={() => void loadProfiles()}>{t('common.retry')}</button>
            </div>
          )}
        </details>
      )}
    </div>
  );
}
