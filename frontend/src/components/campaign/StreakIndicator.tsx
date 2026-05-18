import React from 'react';
import { useTranslation } from 'react-i18next';

interface StreakIndicatorProps {
  streak: number;
}

export const StreakIndicator: React.FC<StreakIndicatorProps> = ({ streak }) => {
  const { t } = useTranslation();

  return (
    <div
      className="inline-flex items-center gap-2 font-medium"
      aria-label={streak > 0 ? t('campaign.streak_count', { count: streak }) : t('campaign.streak_zero')}
    >
      <div
        className={`w-4 h-4 rounded-tl-[50%] rounded-tr-none rounded-b-[50%] -rotate-45 shadow-[inset_0_0_4px_rgba(255,255,255,0.5)] ${streak > 0 ? 'bg-gradient-to-t from-orange-600 via-orange-500 to-yellow-400 motion-safe:animate-pulse' : 'bg-gray-300 dark:bg-gray-600'}`}
        aria-hidden="true"
      />
      <span className={streak > 0 ? 'text-orange-600 dark:text-orange-500' : 'text-gray-500'}>
        {streak > 0 ? t('campaign.streak_count', { count: streak }) : t('campaign.streak_zero')}
      </span>
    </div>
  );
};
