import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import './LlmNotConfiguredBanner.css';

interface LlmNotConfiguredBannerProps {
  onClose?: () => void;
}

export function LlmNotConfiguredBanner({ onClose }: LlmNotConfiguredBannerProps) {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(() => {
    return sessionStorage.getItem('llm_banner_dismissed') !== 'true';
  });

  if (!isVisible) return null;

  const handleDismiss = () => {
    sessionStorage.setItem('llm_banner_dismissed', 'true');
    setIsVisible(false);
    if (onClose) onClose();
  };

  return (
    <div
      className="llm-not-configured-banner"
      role="status"
      aria-live="polite"
    >
      <div className="llm-banner-content">
        <span className="llm-banner-icon" aria-hidden="true">⚠️</span>
        <div className="llm-banner-text">
          <p className="llm-banner-message">
            {t('llm_banner.not_configured')}
          </p>
        </div>
        <div className="llm-banner-actions">
          <Link
            to="/admin/setup"
            className="btn btn-primary llm-banner-cta"
          >
            {t('llm_banner.configure_cta')}
          </Link>
          <button
            onClick={handleDismiss}
            className="llm-banner-close"
            aria-label={t('llm_banner.dismiss_aria')}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
