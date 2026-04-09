/* ═══════════════════════════════════════════════════════════
   Phase 3 F1 — Returning Badge ("老面孔" indicator)
   Shows when an agent has cross-scenario history.
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';

interface Props {
  isReturning: boolean;
  displayName?: string;
}

export function ReturningBadge({ isReturning, displayName }: Props) {
  const { t } = useTranslation();
  if (!isReturning) return null;

  return (
    <span
      title={t('agents.returning_tooltip', { name: displayName ?? '' })}
      aria-label={t('agents.returning_label', 'Returning agent')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '2px 7px',
        borderRadius: 10,
        fontSize: '0.7rem',
        fontWeight: 600,
        background: 'rgba(74,144,217,0.18)',
        color: '#8ab4f8',
        border: '1px solid rgba(74,144,217,0.3)',
      }}
    >
      &#x21BB; {t('agents.returning', 'Returning')}
    </span>
  );
}
