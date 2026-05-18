import React from 'react';
import { useTranslation } from 'react-i18next';

interface DifficultyBadgeProps {
  difficulty?: 'easy' | 'normal' | 'hard' | 'expert' | string;
}

export const DifficultyBadge: React.FC<DifficultyBadgeProps> = ({ difficulty }) => {
  const { t } = useTranslation();

  const normalizedDifficulty = difficulty?.trim().toLowerCase();

  if (!normalizedDifficulty) return null;

  const visualDifficulty = (
    normalizedDifficulty === 'easy'
    || normalizedDifficulty === 'normal'
    || normalizedDifficulty === 'hard'
    || normalizedDifficulty === 'expert'
  )
    ? normalizedDifficulty
    : 'normal';
  const label = visualDifficulty === normalizedDifficulty
    ? t(`campaign.difficulty_${normalizedDifficulty}`, { defaultValue: normalizedDifficulty })
    : t('campaign.difficulty_unknown', {
        difficulty: normalizedDifficulty,
        defaultValue: normalizedDifficulty,
      });

  return (
    <>
      <style>{`
        .diff-badge {
          display: inline-flex;
          align-items: center;
          padding: 0.18rem 0.5rem;
          border-radius: 6px;
          font-family: 'Instrument Sans', 'Noto Sans SC', sans-serif;
          font-size: 0.72rem;
          font-weight: 500;
          letter-spacing: 0.03em;
          border: 1px solid transparent;
        }
        .diff-easy {
          background-color: #e8f5e8;
          color: #2d6a2d;
          border-color: rgba(45, 106, 45, 0.15);
        }
        @supports (background-color: oklch(96% 0.02 145)) {
          .diff-easy {
            background-color: oklch(96% 0.02 145);
            color: oklch(40% 0.06 145);
            border-color: oklch(40% 0.06 145 / 0.15);
          }
        }
        .diff-normal {
          background-color: #f0ece6;
          color: #58554f;
          border-color: rgba(88, 85, 79, 0.15);
        }
        @supports (background-color: oklch(96% 0.005 80)) {
          .diff-normal {
            background-color: oklch(96% 0.005 80);
            color: oklch(40% 0.01 80);
            border-color: oklch(40% 0.01 80 / 0.15);
          }
        }
        .diff-hard {
          background-color: #f5eed8;
          color: #72540d;
          border-color: rgba(114, 84, 13, 0.18);
        }
        @supports (background-color: oklch(95% 0.03 75)) {
          .diff-hard {
            background-color: oklch(95% 0.03 75);
            color: oklch(42% 0.08 75);
            border-color: oklch(42% 0.08 75 / 0.15);
          }
        }
        .diff-expert {
          background-color: #f5e8ef;
          color: #a0295a;
          border-color: rgba(160, 41, 90, 0.15);
        }
        @supports (background-color: oklch(95% 0.02 350)) {
          .diff-expert {
            background-color: oklch(95% 0.02 350);
            color: oklch(42% 0.1 350);
            border-color: oklch(42% 0.1 350 / 0.15);
          }
        }
        @media (forced-colors: active) {
          .diff-badge {
            border-color: CanvasText;
            color: CanvasText;
            background-color: Canvas;
          }
        }
      `}</style>
      <span
        className={`diff-badge diff-${visualDifficulty}`}
        aria-label={label}
      >
        {label}
      </span>
    </>
  );
};
