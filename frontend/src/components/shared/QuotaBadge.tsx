/* ═══════════════════════════════════════════════════════════
   QuotaBadge — S2-3:
   Pill-style display of remaining quota for conversation or
   replay buckets, fed by GET /api/quota/summary.
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getQuotaSummary, type QuotaBucket, type QuotaSummaryResponse } from '../../api/client';

export type QuotaBadgeType = 'conversation' | 'replay';

export interface QuotaBadgeProps {
  /** Optional scenario id; when omitted the global summary is fetched. */
  scenarioId?: string;
  /** Which bucket to display. */
  type: QuotaBadgeType;
  /**
   * Optional override of the fetcher (test seam). Defaults to `getQuotaSummary`.
   */
  fetcher?: (scenarioId?: string) => Promise<QuotaSummaryResponse>;
}

type Status = 'loading' | 'ready' | 'error';
interface LoadState {
  requestKey: string;
  status: Status;
  bucket: QuotaBucket | null;
}

const LABEL_KEY: Record<QuotaBadgeType, string> = {
  conversation: 'quota.conversation_label',
  replay: 'quota.replay_label',
};

export function QuotaBadge({ scenarioId, type, fetcher }: QuotaBadgeProps) {
  const { t } = useTranslation();
  const requestKey = useMemo(
    () => JSON.stringify([scenarioId ?? null, type]),
    [scenarioId, type],
  );
  const [loadState, setLoadState] = useState<LoadState>(() => ({
    requestKey,
    status: 'loading',
    bucket: null,
  }));

  useEffect(() => {
    let active = true;

    const load = fetcher ?? getQuotaSummary;
    load(scenarioId)
      .then((summary) => {
        if (!active) return;
        setLoadState({
          requestKey,
          status: 'ready',
          bucket: summary[type],
        });
      })
      .catch(() => {
        if (!active) return;
        setLoadState({
          requestKey,
          status: 'error',
          bucket: null,
        });
      });

    return () => {
      active = false;
    };
  }, [scenarioId, type, fetcher, requestKey]);

  const label = t(LABEL_KEY[type]);
  const status = loadState.requestKey === requestKey ? loadState.status : 'loading';
  const bucket = loadState.requestKey === requestKey ? loadState.bucket : null;

  if (status === 'loading') {
    return (
      <span
        className="quota-badge quota-badge--loading"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        {label}
      </span>
    );
  }

  if (status === 'error' || !bucket) {
    return (
      <span
        className="quota-badge quota-badge--error"
        role="status"
        aria-live="polite"
        title={t('quota.load_failed')}
      >
        {label} · {t('quota.load_failed')}
      </span>
    );
  }

  const exhausted = bucket.remaining <= 0;

  return (
    <span
      className={`quota-badge${exhausted ? ' quota-badge--disabled' : ''}`}
      role="status"
      aria-live="polite"
      aria-disabled={exhausted}
      title={exhausted ? t('quota.exhausted') : undefined}
      data-quota-type={type}
      data-quota-remaining={bucket.remaining}
      data-quota-limit={bucket.limit}
    >
      {label} ·{' '}
      {exhausted ? t('quota.exhausted') : t('quota.remaining', { count: bucket.remaining })}
    </span>
  );
}

export default QuotaBadge;
