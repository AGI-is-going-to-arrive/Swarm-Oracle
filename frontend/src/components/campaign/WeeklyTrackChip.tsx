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

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClick();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
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
          border-radius: 12px;
          border: 1px solid #e1ddd7;
          background: #fcfcfa;
          color: #181611;
          font-family: 'Instrument Sans', 'Noto Sans SC', sans-serif;
          font-size: 0.85rem;
          font-weight: 500;
          cursor: pointer;
          line-height: 1.3;
          transition: background-color 0.15s ease, border-color 0.15s ease,
            box-shadow 0.15s ease, transform 0.15s ease;
        }
        @supports (background: oklch(99% 0.002 80)) {
          .weekly-track-chip {
            border-color: oklch(90% 0.01 80);
            background: oklch(99% 0.002 80);
            color: oklch(20% 0.01 80);
          }
        }
        .weekly-track-chip:hover {
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03);
          transform: translateY(-1px);
        }
        @supports (box-shadow: 0 4px 20px oklch(0% 0 0 / 0.03)) {
          .weekly-track-chip:hover {
            box-shadow: 0 4px 20px oklch(0% 0 0 / 0.03);
          }
        }
        .weekly-track-chip:focus-visible {
          outline: 2px solid #c61583;
          outline-offset: 2px;
        }
        @supports (outline-color: oklch(55% 0.22 350)) {
          .weekly-track-chip:focus-visible {
            outline-color: oklch(55% 0.22 350);
          }
        }
        .weekly-track-chip--active {
          background: rgba(184, 134, 11, 0.06);
          border-color: rgba(184, 134, 11, 0.2);
          border-left: 3px solid #b8860b;
          padding-left: calc(0.875rem - 2px);
          color: #181611;
        }
        @supports (background: oklch(72% 0.14 75 / 0.06)) {
          .weekly-track-chip--active {
            background: oklch(72% 0.14 75 / 0.06);
            border-color: oklch(72% 0.14 75 / 0.2);
            border-left-color: oklch(72% 0.14 75);
            color: oklch(20% 0.01 80);
          }
        }
        .weekly-track-chip__dot {
          width: 0.375rem;
          height: 0.375rem;
          border-radius: 999px;
          background: #928f88;
          flex-shrink: 0;
        }
        @supports (background: oklch(65% 0.01 80)) {
          .weekly-track-chip__dot {
            background: oklch(65% 0.01 80);
          }
        }
        .weekly-track-chip--active .weekly-track-chip__dot {
          background: #b8860b;
        }
        @supports (background: oklch(72% 0.14 75)) {
          .weekly-track-chip--active .weekly-track-chip__dot {
            background: oklch(72% 0.14 75);
          }
        }
        .weekly-track-chip__active-label {
          font-family: 'Instrument Sans', 'Noto Sans SC', sans-serif;
          font-size: 0.7rem;
          font-weight: 500;
          letter-spacing: 0.02em;
          color: #8b6914;
          text-transform: uppercase;
        }
        @supports (color: oklch(42% 0.08 75)) {
          .weekly-track-chip__active-label {
            color: oklch(42% 0.08 75);
          }
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
          .weekly-track-chip:hover {
            transform: none;
          }
        }
      `}</style>
      <button
        type="button"
        className={`weekly-track-chip ${active ? 'weekly-track-chip--active' : ''}`}
        onClick={handleClick}
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
