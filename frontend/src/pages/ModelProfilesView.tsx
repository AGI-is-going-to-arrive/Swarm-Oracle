import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { ModelProfileManager } from '../components/ModelProfileManager';

export default function ModelProfilesView() {
  const { t } = useTranslation();
  const {
    loading,
    enabled,
    error: capabilityError,
    reload: reloadCapability,
  } = useCapabilityCheck('model_profiles');

  if (loading) {
    return (
      <div className="agent-page agent-page--centered" role="status" aria-busy="true">
        <div className="model-profile-manager__spinner" />
        <p>{t('common.loading', 'Loading...')}</p>
      </div>
    );
  }

  if (capabilityError) {
    return (
      <div className="agent-page agent-page--centered agent-page--narrow" role="alert">
        <p className="agent-form__error" style={{ color: '#721c24', backgroundColor: '#fdf3f4', border: '1px solid #f5c6cb', padding: '0.75rem', borderRadius: '6px', marginBottom: '1rem' }}>
          {t('model_profiles.capability_error', 'Could not check model profile availability. Please retry.')}
        </p>
        <button
          type="button"
          className="agent-button agent-button--primary"
          style={{ marginBottom: '1rem' }}
          onClick={() => void reloadCapability?.()}
        >
          {t('common.retry', 'Retry')}
        </button>
        <Link to="/" className="agent-link">{t('common.back_home', 'Back to Home')}</Link>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="agent-page agent-page--centered" role="alert">
        <p className="agent-page__muted" style={{ marginBottom: '1rem' }}>
          {t('model_profiles.disabled_hint', 'Model profiles capability is disabled.')}
        </p>
        <Link to="/" className="agent-link">{t('common.back_home', 'Back to Home')}</Link>
      </div>
    );
  }

  return (
    <div className="agent-page">
      <div className="agent-page__header">
        <div className="agent-page__title-row">
          <Link
            to="/"
            className="agent-button agent-button--back"
            aria-label={t('common.back_home', 'Back to Home')}
          >
            ← {t('common.back', 'Back')}
          </Link>
          <h1>{t('model_profiles.title_page', 'Model Profiles')}</h1>
        </div>
      </div>
      <ModelProfileManager />
    </div>
  );
}
