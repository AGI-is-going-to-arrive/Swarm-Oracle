import React, { useCallback, useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { WeeklyTrack } from '../../types';

interface WeeklyTrackDialogProps {
  track: WeeklyTrack;
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export const WeeklyTrackDialog: React.FC<WeeklyTrackDialogProps> = ({
  track,
  open,
  onConfirm,
  onCancel,
}) => {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  const isZh = i18n.language?.startsWith('zh') ?? false;
  const title = isZh ? track.title_zh : track.title_en;
  const subtitle = isZh ? track.subtitle_zh : track.subtitle_en;
  const bonusRules = isZh
    ? (track.bonus_rules_zh ?? track.bonus_rules)
    : (track.bonus_rules_en ?? track.bonus_rules);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const frame = window.requestAnimationFrame(() => {
      confirmButtonRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab') return;
      const container = dialogRef.current;
      if (!container) return;
      const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onCancel],
  );

  if (!open) return null;

  return (
    <>
      <style>{`
        .weekly-track-dialog__backdrop {
          position: fixed;
          inset: 0;
          background: rgba(15, 14, 12, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          z-index: 1000;
        }
        .weekly-track-dialog {
          background: #fffaf0;
          border-radius: 1rem;
          padding: 1.5rem;
          max-width: 30rem;
          width: 100%;
          box-shadow: 0 24px 60px rgba(20, 14, 6, 0.35);
          color: #2b1f12;
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
          border: 1px solid rgba(148, 122, 96, 0.35);
        }
        .weekly-track-dialog__eyebrow {
          font-size: 0.75rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #8a6a3a;
          font-weight: 600;
        }
        .weekly-track-dialog__title {
          margin: 0;
          font-size: 1.25rem;
          font-weight: 700;
          color: #2b1f12;
        }
        .weekly-track-dialog__track-title {
          font-size: 1rem;
          font-weight: 600;
          color: #6b4626;
        }
        .weekly-track-dialog__subtitle {
          margin: 0;
          font-size: 0.9rem;
          color: #4b3a26;
          line-height: 1.4;
        }
        .weekly-track-dialog__bonus {
          margin: 0;
          padding: 0.75rem;
          background: rgba(253, 230, 138, 0.4);
          border-radius: 0.5rem;
          font-size: 0.85rem;
          color: #4b3a26;
          border-left: 3px solid #c97f2c;
        }
        .weekly-track-dialog__bonus-label {
          display: block;
          font-weight: 600;
          margin-bottom: 0.25rem;
          color: #6b4626;
        }
        .weekly-track-dialog__actions {
          display: flex;
          gap: 0.75rem;
          justify-content: flex-end;
          margin-top: 0.25rem;
        }
        .weekly-track-dialog__btn {
          min-height: 44px;
          min-width: 44px;
          padding: 0.55rem 1.1rem;
          border-radius: 0.5rem;
          font-weight: 600;
          font-size: 0.9rem;
          border: 1px solid transparent;
          cursor: pointer;
          transition: background-color 0.15s ease, border-color 0.15s ease;
        }
        .weekly-track-dialog__btn--confirm {
          background: linear-gradient(180deg, #fde68a 0%, #f59e0b 100%);
          color: #2b1f12;
        }
        .weekly-track-dialog__btn--confirm:hover {
          filter: brightness(1.05);
        }
        .weekly-track-dialog__btn--cancel {
          background: rgba(255, 255, 255, 0.6);
          color: #4b3a26;
          border-color: rgba(148, 122, 96, 0.45);
        }
        .weekly-track-dialog__btn--cancel:hover {
          background: rgba(255, 250, 240, 0.95);
        }
        .weekly-track-dialog__btn:focus-visible {
          outline: 2px solid #c97f2c;
          outline-offset: 2px;
        }
        @media (forced-colors: active) {
          .weekly-track-dialog {
            border-color: CanvasText;
          }
          .weekly-track-dialog__btn {
            border-color: CanvasText;
          }
          .weekly-track-dialog__btn--confirm {
            background-color: Highlight;
            color: HighlightText;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .weekly-track-dialog__btn {
            transition: none;
          }
        }
        @media (max-width: 480px) {
          .weekly-track-dialog__backdrop {
            padding: 0.75rem;
          }
          .weekly-track-dialog {
            max-width: none;
            max-height: calc(100vh - 1.5rem);
            overflow-y: auto;
          }
          .weekly-track-dialog__actions {
            flex-direction: column-reverse;
          }
          .weekly-track-dialog__btn {
            width: 100%;
          }
        }
      `}</style>
      <div
        className="weekly-track-dialog__backdrop"
        onClick={(event) => {
          if (event.target === event.currentTarget) onCancel();
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          className="weekly-track-dialog"
          onKeyDown={handleKeyDown}
        >
          <span className="weekly-track-dialog__eyebrow">
            {t('campaign.weekly_track_label', { defaultValue: 'Weekly Track' })}
          </span>
          <h2 id={titleId} className="weekly-track-dialog__title">
            {t('campaign.weekly_confirm_title', { defaultValue: 'Join Weekly Track?' })}
          </h2>
          <div id={bodyId}>
            <p className="weekly-track-dialog__track-title">{title}</p>
            <p className="weekly-track-dialog__subtitle">{subtitle}</p>
            <p className="weekly-track-dialog__subtitle" style={{ marginTop: '0.5rem' }}>
              {t('campaign.weekly_confirm_body', {
                defaultValue:
                  'Complete challenges in this track for bonus points and leaderboard ranking.',
              })}
            </p>
            {bonusRules && (
              <p className="weekly-track-dialog__bonus">
                <span className="weekly-track-dialog__bonus-label">
                  {t('campaign.weekly_bonus_rules', { defaultValue: 'Bonus' })}
                </span>
                {bonusRules}
              </p>
            )}
          </div>
          <div className="weekly-track-dialog__actions">
            <button
              type="button"
              className="weekly-track-dialog__btn weekly-track-dialog__btn--cancel"
              onClick={onCancel}
            >
              {t('campaign.weekly_cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              ref={confirmButtonRef}
              type="button"
              className="weekly-track-dialog__btn weekly-track-dialog__btn--confirm"
              onClick={onConfirm}
            >
              {t('campaign.weekly_confirm_action', { defaultValue: 'Join Track' })}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
