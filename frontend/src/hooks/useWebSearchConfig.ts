import { useCallback, useEffect, useRef, useState } from 'react';

import { getCapabilities } from '../api/client';

export type WebSearchProviderOption = 'tavily' | 'exa' | 'xai' | 'searxng';
export type WebSearchMode = 'server_default' | 'custom_override';
export type WebSearchStatus = 'idle' | 'searching' | 'success' | 'skipped' | 'error';

export interface UseWebSearchConfigResult {
  webSearchEnabled: boolean;
  setWebSearchEnabled: (next: boolean) => void;
  webSearchServerEnabled: boolean;
  setWebSearchServerEnabled: (next: boolean) => void;
  webSearchServerProvider: string | null;
  webSearchMode: WebSearchMode;
  setWebSearchMode: (next: WebSearchMode) => void;
  webSearchProvider: WebSearchProviderOption;
  setWebSearchProvider: (next: WebSearchProviderOption) => void;
  webSearchApiKey: string;
  setWebSearchApiKey: (next: string) => void;
  webSearchBaseUrl: string;
  setWebSearchBaseUrl: (next: string) => void;
  webSearchStatus: WebSearchStatus;
  setWebSearchStatus: (next: WebSearchStatus) => void;
  webSearchAvailable: boolean;
}

/**
 * Web Search Enhancement state hook.
 *
 * Visibility = compile-time flag (`VITE_ENABLE_WEB_SEARCH`) + server hint.
 * Decoupled from BYOK config so callers can test/recompose independently.
 *
 * The `setWebSearchServerEnabled` setter is exposed so the BYOK
 * `handleTestConnection` flow can refresh the server hint after a probe.
 */
export function useWebSearchConfig(): UseWebSearchConfigResult {
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [webSearchServerEnabled, setWebSearchServerEnabled] = useState(false);
  const [webSearchServerProvider, setWebSearchServerProvider] = useState<string | null>(null);
  const [webSearchModePreference, setWebSearchModePreference] = useState<WebSearchMode>('server_default');
  const [webSearchProvider, setWebSearchProvider] = useState<WebSearchProviderOption>('tavily');
  const [webSearchApiKey, setWebSearchApiKey] = useState('');
  const [webSearchBaseUrl, setWebSearchBaseUrl] = useState('');
  const webSearchApiKeyRef = useRef(webSearchApiKey);
  const webSearchBaseUrlRef = useRef(webSearchBaseUrl);
  const [webSearchStatus, setWebSearchStatus] = useState<WebSearchStatus>('idle');
  const viteFlagEnabled = (import.meta.env?.VITE_ENABLE_WEB_SEARCH as string | undefined) === 'true';

  useEffect(() => {
    webSearchApiKeyRef.current = webSearchApiKey;
    webSearchBaseUrlRef.current = webSearchBaseUrl;
  }, [webSearchApiKey, webSearchBaseUrl]);

  // On mount: check server web search capability via lightweight GET /api/capabilities
  // (no LLM call — pure config check). Retries once after 3s on failure.
  useEffect(() => {
    if (!viteFlagEnabled) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchHint = () =>
      getCapabilities()
        .then((res) => {
          if (cancelled) return;
          setWebSearchServerEnabled(res.web_search?.server_enabled === true);
          const serverProvider = res.web_search?.provider;
          setWebSearchServerProvider(typeof serverProvider === 'string' ? serverProvider : null);
          if (
            (serverProvider === 'tavily' || serverProvider === 'exa' || serverProvider === 'xai' || serverProvider === 'searxng')
            && !webSearchApiKeyRef.current.trim()
            && !webSearchBaseUrlRef.current.trim()
          ) {
            setWebSearchProvider(serverProvider);
          }
        });
    fetchHint().catch(() => {
      retryTimer = setTimeout(() => {
        if (!cancelled) fetchHint().catch(() => {});
      }, 3000);
    });
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [viteFlagEnabled]);

  const webSearchMode: WebSearchMode = webSearchEnabled && !webSearchServerEnabled
    ? 'custom_override'
    : webSearchModePreference;

  const setWebSearchMode = useCallback((next: WebSearchMode) => {
    setWebSearchModePreference(next);
  }, []);

  return {
    webSearchEnabled,
    setWebSearchEnabled,
    webSearchServerEnabled,
    setWebSearchServerEnabled,
    webSearchServerProvider,
    webSearchMode,
    setWebSearchMode,
    webSearchProvider,
    setWebSearchProvider,
    webSearchApiKey,
    setWebSearchApiKey,
    webSearchBaseUrl,
    setWebSearchBaseUrl,
    webSearchStatus,
    setWebSearchStatus,
    webSearchAvailable: viteFlagEnabled,
  };
}
