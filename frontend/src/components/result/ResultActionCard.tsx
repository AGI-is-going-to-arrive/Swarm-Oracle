/* ═══════════════════════════════════════════════════════════
   ResultActionCard — FE-5:
   - Tailwind v4 gradient (purple→pink)
   - Desktop: sticky bottom-24 right-8
   - Mobile (max-width:640): Sheet trigger button that opens MobileSourceSheet
   - Click → deep-link `#agent_profile=<id>&tab=memory` to open
     AgentProfileModal + MemoryTimeline tab highlighted (P4)

   R1 FM4: useMediaQuery SSR-safe via useEffect + matchMedia.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';

export interface ResultActionCardProps {
  /** Optional agent identity id to deep-link to AgentProfileModal + memory tab. */
  agentIdentityId?: string | null;
  /** When set, renders the mobile sheet trigger and forwards click. */
  onMobileTriggerClick?: () => void;
  /** Optional extra class for the outer element. */
  className?: string;
}

/** R1 FM4: SSR-safe media query hook using useEffect + matchMedia. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia('(max-width: 640px)');
    const handler = () => setMobile(mql.matches);
    handler();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
    // Safari < 14 fallback
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, []);
  return mobile;
}

export function ResultActionCard({
  agentIdentityId,
  onMobileTriggerClick,
  className,
}: ResultActionCardProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  const cta = t('result_action.continue_conversation_cta', {
    defaultValue: 'Continue conversation',
  });
  const subtitle = t('result_action.subtitle', {
    defaultValue: 'Jump into this agent and keep the what-if dialogue.',
  });
  const aria = t('result_action.aria', {
    defaultValue: 'Open agent profile and memory timeline',
  });

  const handleDesktopClick = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (!agentIdentityId) return;
    // P4 deep-link: URL hash → AgentProfileModal + MemoryTimeline tab
    const hash = `#agent_profile=${encodeURIComponent(agentIdentityId)}&tab=memory`;
    try {
      window.history.replaceState(null, '', hash);
    } catch {
      window.location.hash = hash;
    }
    // Notify listeners (App root / modal) that hash changed programmatically.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, [agentIdentityId]);

  const handleMobileClick = useCallback(() => {
    if (onMobileTriggerClick) {
      onMobileTriggerClick();
      return;
    }
    handleDesktopClick();
  }, [handleDesktopClick, onMobileTriggerClick]);

  const gradientClasses =
    'bg-gradient-to-br from-purple-500 to-pink-500 text-white shadow-lg shadow-purple-500/30 hover:from-purple-400 hover:to-pink-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pink-300';

  if (isMobile) {
    return (
      <button
        type="button"
        data-testid="result-action-conversation"
        data-variant="mobile-trigger"
        aria-label={aria}
        onClick={handleMobileClick}
        className={cn(
          'fixed bottom-4 right-4 z-40 rounded-full px-5 py-3 text-sm font-semibold',
          gradientClasses,
          className,
        )}
      >
        {cta}
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid="result-action-conversation"
      data-variant="desktop-sticky"
      aria-label={aria}
      onClick={handleDesktopClick}
      className={cn(
        'sticky bottom-24 right-8 ml-auto flex flex-col items-end gap-0.5 self-end rounded-2xl px-5 py-3 text-left',
        gradientClasses,
        className,
      )}
    >
      <span className="text-base font-semibold">{cta}</span>
      <span className="text-xs opacity-90">{subtitle}</span>
    </button>
  );
}

export default ResultActionCard;
