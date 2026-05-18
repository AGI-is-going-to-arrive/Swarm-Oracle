import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface RefreshCountdownProps {
  nextRefreshAt?: string;
}

export const RefreshCountdown: React.FC<RefreshCountdownProps> = ({ nextRefreshAt }) => {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!nextRefreshAt) return;
    const interval = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(interval);
  }, [nextRefreshAt]);

  if (!nextRefreshAt) {
    return (
      <div aria-live="polite" className="text-sm mt-2">
        <span className="text-green-600 dark:text-green-400 font-medium">
          {t('campaign.refresh_available')}
        </span>
      </div>
    );
  }

  const target = new Date(nextRefreshAt).getTime();
  const diff = target - now;

  let content;
  if (diff <= 0) {
    content = (
      <span className="text-green-600 dark:text-green-400 font-medium">
        {t('campaign.refresh_available')}
      </span>
    );
  } else {
    const h = Math.floor(diff / (1000 * 60 * 60));
    const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const time = h > 0
      ? t('campaign.refresh_duration_hours_minutes', {
          defaultValue: '{{hours}}h {{minutes}}m',
          hours: h,
          minutes: m,
        })
      : t('campaign.refresh_duration_minutes', {
          defaultValue: '{{minutes}}m',
          minutes: m,
        });
    content = (
      <span className="text-gray-500 dark:text-gray-400">
        {t('campaign.refresh_countdown', { time })}
      </span>
    );
  }

  return (
    <div aria-live="polite" className="text-sm mt-2">
      {content}
    </div>
  );
};
