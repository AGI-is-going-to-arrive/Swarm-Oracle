/**
 * FE-3 — Conversation recovery banner.
 *
 * Renders one of six UI variants keyed off the 6 turn_error codes in plan
 * §11 / §11.9:
 *   - rate_limit | quota_exceeded | network | ws_lost | byok_invalid | server_error
 *
 * Layout: inline warning card with message + retry + discard CTAs.
 * A11y: `role="alert"` + `aria-live="assertive"`. data-testid is
 * `conversation-recovery-banner`, retry is `conversation-retry`, discard
 * is `conversation-discard`.
 */

import { useTranslation } from 'react-i18next';

import type { RecoveryCode } from '../../lib/conversationStateMachine';
import { i18nKeyForRecoveryCode } from '../../lib/conversationStateMachine';
import { cn } from '../../lib/utils';

export interface ConversationRecoveryBannerProps {
  code: RecoveryCode;
  /** Optional pre-formatted message override. */
  message?: string;
  /** Retry handler. Button hidden if omitted. */
  onRetry?: () => void;
  /** Discard / dismiss handler. Button hidden if omitted. */
  onDiscard?: () => void;
  className?: string;
}

export function ConversationRecoveryBanner(props: ConversationRecoveryBannerProps) {
  const { code, message, onRetry, onDiscard, className } = props;
  const { t } = useTranslation();
  const i18nKey = i18nKeyForRecoveryCode(code);
  const text = message ?? t(i18nKey);

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="conversation-recovery-banner"
      data-code={code}
      className={cn(
        'flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100',
        className,
      )}
    >
      <p className="leading-snug">{text}</p>
      <div className="flex gap-2">
        {onRetry ? (
          <button
            type="button"
            data-testid="conversation-retry"
            onClick={onRetry}
            className="min-h-[44px] min-w-[44px] rounded border border-amber-400/60 px-3 py-1.5 text-xs text-amber-50 hover:bg-amber-500/20"
          >
            {t('conversation.error.retry_cta')}
          </button>
        ) : null}
        {onDiscard ? (
          <button
            type="button"
            data-testid="conversation-discard"
            onClick={onDiscard}
            className="min-h-[44px] min-w-[44px] rounded border border-white/20 px-3 py-1.5 text-xs text-white/80 hover:bg-white/10"
          >
            {t('conversation.error.discard_cta')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
