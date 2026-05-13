import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getCapabilities,
  type WebSearchDomainFilterMode,
  type WebSearchProviderCapability,
} from '../api/client';

export type WebSearchProviderOption = 'tavily' | 'exa' | 'xai' | 'searxng';
export type WebSearchMode = 'server_default' | 'custom_override';
export type WebSearchStatus = 'idle' | 'searching' | 'success' | 'skipped' | 'error';

/**
 * Effective provider capability resolved from either the server default
 * (when the run uses server_default mode) or inferred from the user's custom
 * override base URL (custom_override mode).
 *
 * `source` documents where the capability came from so the UI can render
 * different hints for "server default", "inferred from custom override", and
 * "unknown custom provider".
 */
export type WebSearchCapabilitySource = 'server' | 'inferred' | 'unknown';

export interface EffectiveProviderCapability extends WebSearchProviderCapability {
  source: WebSearchCapabilitySource;
  /** Provider option this capability was resolved for. Null when unknown. */
  resolvedProvider: WebSearchProviderOption | null;
}

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
  /**
   * Provider capability resolved for the current mode/provider/base URL.
   * Always returns an object (never undefined) so callers can read fields
   * directly. `source='unknown'` indicates the UI should not claim domain
   * filter support.
   */
  effectiveProviderCapability: EffectiveProviderCapability;
  /** Convenience boolean: does the effective provider support domain filtering? */
  supportsDomainFilter: boolean;
  /** Provider inferred from the custom override base URL (null when unknown). */
  inferredCustomProvider: WebSearchProviderOption | null;
}

/**
 * Built-in capability table for the four supported providers. This mirrors the
 * server-side `provider_capability` registry and lets the UI render hints when
 * the user supplies a custom override (where the server cannot tell us which
 * provider the BYOK base_url targets).
 */
const PROVIDER_CAPABILITY_TABLE: Record<WebSearchProviderOption, WebSearchProviderCapability> = {
  tavily: { supports_domain_filter: true, supports_sources: true, domain_filter_mode: 'api' },
  exa: { supports_domain_filter: true, supports_sources: true, domain_filter_mode: 'api' },
  xai: { supports_domain_filter: true, supports_sources: true, domain_filter_mode: 'api' },
  searxng: { supports_domain_filter: true, supports_sources: true, domain_filter_mode: 'query' },
};

function hasSearxHostToken(host: string): boolean {
  return host
    .split('.')
    .flatMap((label) => label.split('-'))
    .some((token) => token === 'searxng' || token === 'searx');
}

/**
 * Infer the provider option from a custom override base URL. Returns null when
 * the URL is empty, malformed, or does not match any known provider host.
 */
export function inferProviderFromBaseUrl(baseUrl: string): WebSearchProviderOption | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  let host = '';
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === 'api.tavily.com' || host.endsWith('.tavily.com')) return 'tavily';
  if (host === 'api.exa.ai' || host.endsWith('.exa.ai')) return 'exa';
  if (host === 'api.x.ai' || host.endsWith('.x.ai')) return 'xai';
  if (hasSearxHostToken(host)) return 'searxng';
  return null;
}

const UNKNOWN_CAPABILITY: WebSearchProviderCapability = {
  supports_domain_filter: false,
  supports_sources: false,
  domain_filter_mode: 'none' as WebSearchDomainFilterMode,
};

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
  const [serverProviderCapability, setServerProviderCapability] =
    useState<WebSearchProviderCapability | null>(null);
  const [webSearchModePreference, setWebSearchModePreference] = useState<WebSearchMode>('server_default');
  const [webSearchProvider, setWebSearchProvider] = useState<WebSearchProviderOption>('tavily');
  const [webSearchApiKey, setWebSearchApiKey] = useState('');
  const [webSearchBaseUrl, setWebSearchBaseUrl] = useState('');
  const webSearchApiKeyRef = useRef(webSearchApiKey);
  const webSearchBaseUrlRef = useRef(webSearchBaseUrl);
  const [webSearchStatus, setWebSearchStatus] = useState<WebSearchStatus>('idle');
  // Search toggle is now always available; the legacy `VITE_ENABLE_WEB_SEARCH`
  // flag no longer gates fetching the server capability hint. The flag is
  // still surfaced as `webSearchAvailable` for any callers that want to
  // suppress entry points entirely in a stripped build.
  const viteFlagEnabled = (import.meta.env?.VITE_ENABLE_WEB_SEARCH as string | undefined) === 'true';

  useEffect(() => {
    webSearchApiKeyRef.current = webSearchApiKey;
    webSearchBaseUrlRef.current = webSearchBaseUrl;
  }, [webSearchApiKey, webSearchBaseUrl]);

  // On mount: check server web search capability via lightweight GET /api/capabilities
  // (no LLM call — pure config check). Retries once after 3s on failure.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchHint = () =>
      getCapabilities()
        .then((res) => {
          if (cancelled) return;
          setWebSearchServerEnabled(res.web_search?.server_enabled === true);
          const serverProvider = res.web_search?.provider;
          setWebSearchServerProvider(typeof serverProvider === 'string' ? serverProvider : null);
          setServerProviderCapability(res.web_search?.provider_capability ?? null);
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
  }, []);

  const webSearchMode: WebSearchMode = webSearchEnabled && !webSearchServerEnabled
    ? 'custom_override'
    : webSearchModePreference;

  const setWebSearchMode = useCallback((next: WebSearchMode) => {
    setWebSearchModePreference(next);
  }, []);

  const inferredCustomProvider = useMemo(
    () => inferProviderFromBaseUrl(webSearchBaseUrl),
    [webSearchBaseUrl],
  );

  // Resolve the effective capability for the current configuration:
  //  - custom_override + a usable base_url: infer from base_url host.
  //  - custom_override without inference signal: treat as 'unknown' so the UI
  //    does not claim domain filter support for an arbitrary endpoint.
  //  - server_default: use the server-provided capability (or 'unknown' when
  //    the server is silent / no provider is configured).
  const effectiveProviderCapability = useMemo<EffectiveProviderCapability>(() => {
    if (webSearchMode === 'custom_override') {
      const inferred = inferredCustomProvider;
      if (inferred) {
        return {
          ...PROVIDER_CAPABILITY_TABLE[inferred],
          source: 'inferred',
          resolvedProvider: inferred,
        };
      }
      return {
        ...UNKNOWN_CAPABILITY,
        source: 'unknown',
        resolvedProvider: null,
      };
    }
    // server_default
    const serverProviderOption =
      webSearchServerProvider === 'tavily'
        || webSearchServerProvider === 'exa'
        || webSearchServerProvider === 'xai'
        || webSearchServerProvider === 'searxng'
        ? (webSearchServerProvider as WebSearchProviderOption)
        : null;
    if (serverProviderCapability) {
      return {
        ...serverProviderCapability,
        source: 'server',
        resolvedProvider: serverProviderOption,
      };
    }
    // Legacy server: capability field is absent. If a recognized provider
    // name is published we fall back to the built-in capability table so the
    // UI keeps working against older backends. If the server publishes a
    // provider name we don't recognize, leave it 'unknown' so the user is
    // notified rather than silently optimistic.
    if (serverProviderOption) {
      return {
        ...PROVIDER_CAPABILITY_TABLE[serverProviderOption],
        source: 'server',
        resolvedProvider: serverProviderOption,
      };
    }
    return {
      ...UNKNOWN_CAPABILITY,
      source: 'unknown',
      resolvedProvider: null,
    };
  }, [
    webSearchMode,
    inferredCustomProvider,
    serverProviderCapability,
    webSearchServerProvider,
  ]);

  const supportsDomainFilter = effectiveProviderCapability.supports_domain_filter === true;

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
    effectiveProviderCapability,
    supportsDomainFilter,
    inferredCustomProvider,
  };
}
