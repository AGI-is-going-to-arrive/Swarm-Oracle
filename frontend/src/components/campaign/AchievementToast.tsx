import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface AchievementToastProps {
  badgeName: string;
  onDismiss: () => void;
  autoDismissMs?: number;
}

export function AchievementToast({ badgeName, onDismiss, autoDismissMs = 5000 }: AchievementToastProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const timer = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(timer);
  }, [onDismiss, autoDismissMs]);

  return (
    <div className="achievement-toast" role="status" aria-live="polite">
      <span className="achievement-toast__icon" aria-hidden="true">🏆</span>
      <div className="achievement-toast__content">
        <strong>{t('campaign.achievement_unlocked')}</strong>
        <span>{badgeName}</span>
      </div>
      <button
        className="achievement-toast__close"
        onClick={onDismiss}
        aria-label={t('campaign.achievement_dismiss')}
        type="button"
      >
        ×
      </button>
      <style>{`
        .achievement-toast {
          position: fixed;
          top: 1rem;
          right: 1rem;
          z-index: 9999;
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.75rem 1rem;
          border-radius: 0.5rem;
          background: var(--toast-bg, #fff);
          border: 1px solid var(--border-color, #e2e8f0);
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          animation: toast-slide-in 0.3s ease;
          max-width: 320px;
        }
        @keyframes toast-slide-in {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .achievement-toast { animation: none; }
        }
        @media (forced-colors: active) {
          .achievement-toast { border: 2px solid CanvasText; }
        }
        .achievement-toast__icon { font-size: 1.5rem; }
        .achievement-toast__content {
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
          font-size: 0.85rem;
        }
        .achievement-toast__close {
          min-width: 44px;
          min-height: 44px;
          background: none;
          border: none;
          font-size: 1.25rem;
          cursor: pointer;
          padding: 0.25rem;
          line-height: 1;
          opacity: 0.6;
        }
        .achievement-toast__close:hover { opacity: 1; }
        .achievement-toast__close:focus-visible {
          outline: 2px solid currentColor;
          outline-offset: 2px;
        }
      `}</style>
    </div>
  );
}
