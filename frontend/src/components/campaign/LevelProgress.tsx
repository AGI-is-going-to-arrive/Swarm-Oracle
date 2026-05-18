import { useTranslation } from 'react-i18next';

interface LevelProgressProps {
  level: number;
  currentScore: number;
  nextLevelScore: number;
}

export function LevelProgress({ level, currentScore, nextLevelScore }: LevelProgressProps) {
  const { t } = useTranslation();
  const prevLevelScore = 2 * level * level;
  const range = nextLevelScore - prevLevelScore;
  const progress = range > 0 ? Math.min(100, Math.max(0, ((currentScore - prevLevelScore) / range) * 100)) : 0;

  return (
    <div className="level-progress">
      <div className="level-progress__header">
        <span className="level-progress__level">{t('campaign.level_progress', { level })}</span>
        <span className="level-progress__score">
          {t('campaign.score_progress', { current: currentScore, next: nextLevelScore })}
        </span>
      </div>
      <div
        className="level-progress__bar"
        role="progressbar"
        aria-valuenow={currentScore}
        aria-valuemin={prevLevelScore}
        aria-valuemax={nextLevelScore}
        aria-label={t('campaign.level_progress', { level })}
      >
        <div className="level-progress__fill" style={{ width: `${progress}%` }} />
      </div>
      <style>{`
        .level-progress { width: 100%; }
        .level-progress__header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          margin-bottom: 0.5rem;
        }
        .level-progress__level { font-weight: 700; font-size: 1.1rem; }
        .level-progress__score { font-size: 0.85rem; opacity: 0.7; }
        .level-progress__bar {
          height: 0.5rem;
          border-radius: 0.25rem;
          background: var(--progress-bg, #e2e8f0);
          overflow: hidden;
        }
        .level-progress__fill {
          height: 100%;
          border-radius: 0.25rem;
          background: oklch(0.65 0.2 260);
          transition: width 0.3s ease;
        }
        @supports not (color: oklch(0 0 0)) {
          .level-progress__fill { background: #6366f1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .level-progress__fill { transition: none; }
        }
        @media (forced-colors: active) {
          .level-progress__bar { border: 1px solid CanvasText; }
          .level-progress__fill { background: Highlight; }
        }
      `}</style>
    </div>
  );
}
