import React from 'react';
import { useTranslation } from 'react-i18next';

interface DifficultyBadgeProps {
  difficulty?: 'easy' | 'normal' | 'hard' | 'expert' | string;
}

export const DifficultyBadge: React.FC<DifficultyBadgeProps> = ({ difficulty }) => {
  const { t } = useTranslation();

  if (!difficulty) return null;

  const label = t(`campaign.difficulty_${difficulty}`, { defaultValue: difficulty });

  return (
    <>
      <style>{`
        .diff-badge {
          display: inline-flex;
          align-items: center;
          padding: 0.125rem 0.5rem;
          border-radius: 0.25rem;
          font-size: 0.75rem;
          font-weight: 600;
          border: 1px solid transparent;
        }
        .diff-easy { background-color: #dcfce7; color: #166534; background-color: oklch(0.92 0.08 145); color: oklch(0.35 0.08 145); }
        .diff-normal { background-color: #dbeafe; color: #1e40af; background-color: oklch(0.92 0.06 250); color: oklch(0.35 0.06 250); }
        .diff-hard { background-color: #ffedd5; color: #9a3412; background-color: oklch(0.92 0.1 50); color: oklch(0.4 0.1 50); }
        .diff-expert { background-color: #fee2e2; color: #991b1b; background-color: oklch(0.9 0.12 25); color: oklch(0.4 0.12 25); }
        @media (forced-colors: active) {
          .diff-badge {
            border-color: CanvasText;
            color: CanvasText;
            background-color: Canvas;
          }
        }
      `}</style>
      <span
        className={`diff-badge diff-${difficulty}`}
        aria-label={label}
      >
        {label}
      </span>
    </>
  );
};
