/* ═══════════════════════════════════════════════════════════
   GlobalOfflineBanner — FE-5:
   Triggered by navigator.onLine === false OR WS 1006 > 10s.

   Note: this task only creates the component. The App.tsx mount
   is the orchestrator's responsibility (see plan §FE-5).
   ═══════════════════════════════════════════════════════════ */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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
const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;
const OFFLINE_RETRY_EVENT = 'swarmoracle:offline-retry';
const visibleRecoveryInstances = new Set<symbol>();
const recoveryVisibilitySubscribers = new Set<() => void>();

function subscribeToRecoveryVisibility(callback: () => void): () => void {
  recoveryVisibilitySubscribers.add(callback);
  return () => recoveryVisibilitySubscribers.delete(callback);
}

function getRecoveryVisibility(): boolean {
  return visibleRecoveryInstances.size > 0;
}

function updateRecoveryVisibility(instanceId: symbol, visible: boolean): void {
  const wasVisible = getRecoveryVisibility();
  if (visible) {
    visibleRecoveryInstances.add(instanceId);
  } else {
    visibleRecoveryInstances.delete(instanceId);
  }
  if (wasVisible !== getRecoveryVisibility()) {
    recoveryVisibilitySubscribers.forEach((subscriber) => subscriber());
  }
}

function hasWsGraceElapsed(
  wsDisconnectedAt: number | null | undefined,
  wsDisconnectedGraceMs: number,
): boolean {
  if (!wsDisconnectedAt) {
    return false;
  }

  return Date.now() - wsDisconnectedAt >= wsDisconnectedGraceMs;
}

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
  const [wsGraceElapsed, setWsGraceElapsed] = useState(() =>
    hasWsGraceElapsed(wsDisconnectedAt, wsDisconnectedGraceMs),
  );
  const timerRef = useRef<number | null>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const recoveryInstanceIdRef = useRef(Symbol('global-offline-recovery'));

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
  useIsomorphicLayoutEffect(() => {
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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleRecoveryRetry = () => handleRetry();
    window.addEventListener(OFFLINE_RETRY_EVENT, handleRecoveryRetry);
    return () => window.removeEventListener(OFFLINE_RETRY_EVENT, handleRecoveryRetry);
  }, [handleRetry]);

  useEffect(() => {
    const instanceId = recoveryInstanceIdRef.current;
    updateRecoveryVisibility(instanceId, visible);
    return () => updateRecoveryVisibility(instanceId, false);
  }, [visible]);

  // This recovery control must remain reachable above modal focus traps. Some
  // dialogs isolate pre-existing root siblings with inert/aria-hidden; remove
  // those attributes if they are applied to the global connectivity banner.
  useEffect(() => {
    const banner = bannerRef.current;
    if (!visible || !banner || typeof MutationObserver === 'undefined') return;

    const keepRecoveryControlInteractive = () => {
      banner.removeAttribute('inert');
      if (banner.getAttribute('aria-hidden') === 'true') {
        banner.removeAttribute('aria-hidden');
      }
    };
    keepRecoveryControlInteractive();

    const observer = new MutationObserver(keepRecoveryControlInteractive);
    observer.observe(banner, {
      attributes: true,
      attributeFilter: ['inert', 'aria-hidden'],
    });
    return () => observer.disconnect();
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      ref={bannerRef}
      data-testid="global-offline-banner"
      role="alert"
      aria-live="assertive"
      className="pointer-events-auto fixed left-0 right-0 top-0 z-[10000] flex items-center justify-between gap-3 bg-rose-600 px-4 py-2 text-sm text-white shadow-md"
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
        data-focus-trap-exempt="true"
        onClick={handleRetry}
        className="pointer-events-auto rounded-md bg-white/10 px-3 py-1 text-xs font-medium hover:bg-white/20"
      >
        {t('offline_banner.retry_cta', { defaultValue: 'Retry' })}
      </button>
    </div>
  );
}

/**
 * A compact recovery control rendered inside Radix modal focus scopes.
 * Radix intentionally hides and traps focus away from root siblings, so the
 * fixed global banner alone cannot provide a keyboard-reachable Retry action.
 */
export function GlobalOfflineRecoveryAction() {
  const { t } = useTranslation();
  const visible = useSyncExternalStore(
    subscribeToRecoveryVisibility,
    getRecoveryVisibility,
    () => false,
  );

  if (!visible) return null;

  return (
    <div
      data-testid="global-offline-recovery-action"
      role="group"
      aria-label={t('offline_banner.title', { defaultValue: 'You are offline' })}
      className="flex items-center justify-between gap-3 rounded-md border border-rose-300/50 bg-rose-600 px-3 py-2 text-sm text-white shadow-md"
    >
      <strong>
        {t('offline_banner.title', { defaultValue: 'You are offline' })}
      </strong>
      <button
        type="button"
        onClick={() => {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event(OFFLINE_RETRY_EVENT));
          }
        }}
        className="rounded-md bg-white/10 px-3 py-1 text-xs font-medium hover:bg-white/20"
      >
        {t('offline_banner.retry_cta', { defaultValue: 'Retry' })}
      </button>
    </div>
  );
}

export default GlobalOfflineBanner;
