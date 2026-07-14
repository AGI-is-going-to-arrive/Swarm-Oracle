export const ACTION_LEDGER_POLL_INTERVAL_MS = 5_000;

export function isActionsUnavailableError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}
