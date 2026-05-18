import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { WeeklyTrack } from '../../types';

interface WeeklyTrackChipProps {
  track: WeeklyTrack;
  active?: boolean;
  onClick: () => void;
}

export const WeeklyTrackChip: React.FC<WeeklyTrackChipProps> = ({
  track,
  active = false,
  onClick,
}) => {
  const { t, i18n } = useTranslation();
  const subtitleId = useId();
  const isZh = i18n.language?.startsWith('zh') ?? false;
  const title = isZh ? track.title_zh : track.title_en;
  const subtitle = isZh ? track.subtitle_zh : track.subtitle_en;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <>
      <style>{`
        .weekly-track-chip {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          min-height: 44px;
          min-width: 44px;
          padding: 0.5rem 0.875rem;
          border-radius: 999px;
          border: 1px solid rgba(148, 122, 96, 0.35);
          background: rgba(255, 250, 240, 0.7);
          color: #4b3a26;
          font-size: 0.85rem;
          font-weight: 500;
          cursor: pointer;
          line-height: 1.2;
          transition: background-color 0.15s ease, border-color 0.15s ease,
            box-shadow 0.15s ease, transform 0.15s ease;
        }
        .weekly-track-chip:hover {
          background: rgba(255, 244, 220, 0.95);
          border-color: rgba(148, 122, 96, 0.6);
        }
        .weekly-track-chip:focus-visible {
          outline: 2px solid #c97f2c;
          outline-offset: 2px;
        }
        .weekly-track-chip--active {
          background: linear-gradient(180deg, #fde68a 0%, #f59e0b 100%);
          border-color: #c97f2c;
          color: #3b2415;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
        }
        .weekly-track-chip__dot {
          width: 0.5rem;
          height: 0.5rem;
          border-radius: 999px;
          background: rgba(148, 122, 96, 0.45);
          flex-shrink: 0;
        }
        .weekly-track-chip--active .weekly-track-chip__dot {
          background: #c97f2c;
        }
        .weekly-track-chip__active-label {
          font-size: 0.7rem;
          padding: 0.1rem 0.45rem;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.55);
          color: #4b3a26;
          font-weight: 600;
        }
        @media (forced-colors: active) {
          .weekly-track-chip {
            border-color: CanvasText;
            background-color: Canvas;
            color: CanvasText;
          }
          .weekly-track-chip--active {
            background-color: Highlight;
            color: HighlightText;
            border-color: HighlightText;
          }
          .weekly-track-chip__dot,
          .weekly-track-chip__active-label {
            background-color: HighlightText;
            color: Highlight;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .weekly-track-chip {
            transition: none;
          }
        }
      `}</style>
      <button
        type="button"
        className={`weekly-track-chip ${active ? 'weekly-track-chip--active' : ''}`}
        onClick={onClick}
        onKeyDown={handleKeyDown}
        aria-pressed={active}
        aria-describedby={subtitleId}
        aria-label={t('campaign.weekly_track_label', { defaultValue: 'Weekly Track' }) + ': ' + title}
      >
        <span className="weekly-track-chip__dot" aria-hidden="true" />
        <span className="weekly-track-chip__title">{title}</span>
        {active && (
          <span className="weekly-track-chip__active-label">
            {t('campaign.weekly_track_active', { defaultValue: 'Active this week' })}
          </span>
        )}
        <span id={subtitleId} className="sr-only">
          {subtitle}
        </span>
      </button>
    </>
  );
};
