/* ═══════════════════════════════════════════════════════════
   GlobalOfflineBanner — FE-5:
   Triggered by navigator.onLine === false OR WS 1006 > 10s.

   Note: this task only creates the component. The App.tsx mount
   is the orchestrator's responsibility (see plan §FE-5).
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface GlobalOfflineBannerProps {
  /** Optional callback fired when the user clicks the retry button. */
  onRetry?: () => void;
  /**
   * Observe an external WS-disconnect signal (e.g., emitter of 1006 event).
   * When set to a truthy timestamp (ms) and persists ≥ 10 s, the banner
   * becomes visible even if navigator.onLine is true (connectivity is
   * "working" at the OS level but the WS session is stuck).
   */
  wsDisconnectedAt?: number | null;
  /** Override the 10s threshold (for tests). */
  wsDisconnectedGraceMs?: number;
}

const DEFAULT_GRACE_MS = 10_000;

export function GlobalOfflineBanner({
  onRetry,
  wsDisconnectedAt = null,
  wsDisconnectedGraceMs = DEFAULT_GRACE_MS,
}: GlobalOfflineBannerProps) {
  const { t } = useTranslation();
  const [online, setOnline] = useState<boolean>(() => {
    if (typeof navigator === 'undefined') return true;
    return typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
  });
  const [wsGraceElapsed, setWsGraceElapsed] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Track navigator.onLine transitions.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Track WS disconnect timer: only show after grace period elapses.
  useEffect(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!wsDisconnectedAt) {
      setWsGraceElapsed(false);
      return;
    }
    const elapsedSoFar = Date.now() - wsDisconnectedAt;
    const remaining = Math.max(0, wsDisconnectedGraceMs - elapsedSoFar);
    if (remaining === 0) {
      setWsGraceElapsed(true);
      return;
    }
    setWsGraceElapsed(false);
    timerRef.current = window.setTimeout(() => {
      setWsGraceElapsed(true);
      timerRef.current = null;
    }, remaining);
    return () => {
      if (timerRef.current != null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [wsDisconnectedAt, wsDisconnectedGraceMs]);

  const visible = !online || wsGraceElapsed;

  const handleRetry = useCallback(() => {
    onRetry?.();
  }, [onRetry]);

  if (!visible) return null;

  return (
    <div
      data-testid="global-offline-banner"
      role="alert"
      aria-live="assertive"
      className="fixed left-0 right-0 top-0 z-50 flex items-center justify-between gap-3 bg-rose-600 px-4 py-2 text-sm text-white shadow-md"
    >
      <div className="flex flex-col">
        <strong>
          {t('offline_banner.title', { defaultValue: 'You are offline' })}
        </strong>
        <span className="opacity-90">
          {t('offline_banner.subtitle', {
            defaultValue: 'Some features will be limited until connection returns.',
          })}
        </span>
      </div>
      <button
        type="button"
        onClick={handleRetry}
        className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium hover:bg-white/20"
      >
        {t('offline_banner.retry_cta', { defaultValue: 'Retry' })}
      </button>
    </div>
  );
}

export default GlobalOfflineBanner;
