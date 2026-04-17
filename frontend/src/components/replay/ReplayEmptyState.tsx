/* ═══════════════════════════════════════════════════════════
   FE-4 — ReplayEmptyState (replay-trace zero-data state)
   Shown when `/api/scenario/:id/replay-trace` returns no nodes
   OR network is offline. Triggers `onRetry` automatically when
   the browser comes back online (FE-4 v2 — closes R2 FRMi5
   partial: offline banner resync).
   ═══════════════════════════════════════════════════════════ */

import { useEffect } from 'react';

export interface ReplayEmptyStateProps {
  /** Human-readable explanation shown in the card body. */
  message?: string;
  /** Called on button click AND when `window.online` fires. */
  onRetry?: () => void;
  /** Optional localized label for the retry button. */
  retryLabel?: string;
  /** Optional title override. */
  title?: string;
}

export function ReplayEmptyState({
  message,
  onRetry,
  retryLabel,
  title,
}: ReplayEmptyStateProps) {
  // FE-4 v2 — Auto-refetch when browser transitions from offline -> online.
  useEffect(() => {
    if (typeof window === 'undefined' || !onRetry) return;
    const handler = () => onRetry();
    window.addEventListener('online', handler);
    return () => window.removeEventListener('online', handler);
  }, [onRetry]);

  const resolvedMessage =
    message ?? 'No replay lineage yet. Create a counterfactual or resume to populate the trace.';
  const resolvedTitle = title ?? 'No replay trace available';

  return (
    <div
      data-testid="replay-empty"
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-3 p-8 rounded-lg border border-dashed border-border bg-surface/40 text-center"
    >
      <h3 className="text-base font-semibold text-foreground">{resolvedTitle}</h3>
      <p className="text-sm text-muted-foreground max-w-sm">{resolvedMessage}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex items-center justify-center h-8 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {retryLabel ?? 'Retry'}
        </button>
      )}
    </div>
  );
}

export default ReplayEmptyState;
