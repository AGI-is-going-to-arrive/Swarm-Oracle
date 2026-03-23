const WS_DEBUG_STORAGE_KEY = 'swarmoracle.ws-debug';
const WS_DEBUG_QUERY_KEY = 'wsDebug';

function canReadSessionStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage?.getItem === 'function';
}

export function isWsDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const searchParams = new URLSearchParams(window.location.search);
    const queryValue = searchParams.get(WS_DEBUG_QUERY_KEY);
    if (queryValue != null) {
      return queryValue === '1' || queryValue === 'true' || queryValue === 'debug';
    }
  } catch {
    // Ignore invalid location/search access and fall back to sessionStorage.
  }

  if (!canReadSessionStorage()) return false;

  try {
    const raw = window.sessionStorage.getItem(WS_DEBUG_STORAGE_KEY);
    return raw === '1' || raw === 'true' || raw === 'debug';
  } catch {
    return false;
  }
}

export function logWsDebug(scope: string, action: string, details: Record<string, unknown>): void {
  if (!isWsDebugEnabled()) return;
  console.debug(`[${scope}] ${action}`, details);
}
