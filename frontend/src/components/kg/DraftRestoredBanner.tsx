/**
 * FE-3 (HC-29) — Draft restored banner.
 *
 * Two visual states:
 *   - `blue` (restored) — sessionStorage hydrated a previous draft; show a
 *     polite "Draft restored" notice with discard CTA.
 *   - `amber` (unavailable) — sessionStorage write failed (Safari Private
 *     Mode / quota); show "Your drafts won't be saved this session" amber
 *     notice with NO discard CTA (nothing to discard).
 */

import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';

export interface DraftRestoredBannerProps {
  /**
   * `restored` → blue; `unavailable` → amber.
   */
  variant: 'restored' | 'unavailable';
  /** Discard handler. Ignored when variant = unavailable. */
  onDiscard?: () => void;
  className?: string;
}

export function DraftRestoredBanner(props: DraftRestoredBannerProps) {
  const { variant, onDiscard, className } = props;
  const { t } = useTranslation();

  const isAmber = variant === 'unavailable';
  const testId = isAmber ? 'conversation-draft-unavailable' : 'conversation-draft-restored';

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      data-variant={variant}
      className={cn(
        'flex items-center justify-between gap-3 rounded-md border p-2 text-xs',
        isAmber
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
          : 'border-sky-500/40 bg-sky-500/10 text-sky-100',
        className,
      )}
    >
      <span className="leading-snug">
        {t(isAmber ? 'conversation.draft.unavailable_safari' : 'conversation.draft.restored')}
      </span>
      {!isAmber && onDiscard ? (
        <button
          type="button"
          onClick={onDiscard}
          className="min-h-[44px] min-w-[44px] rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:bg-white/10"
        >
          {t('conversation.draft.discard')}
        </button>
      ) : null}
    </div>
  );
}
