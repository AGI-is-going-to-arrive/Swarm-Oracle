/* ═══════════════════════════════════════════════════════════
   SwarmOracle — InputView web-search provider name helpers
   ═══════════════════════════════════════════════════════════ */

// Map raw provider ids (e.g. "xai", "searxng") to friendly display names so
// user-facing copy never shows internal lowercase identifiers.
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  tavily: 'Tavily',
  exa: 'Exa',
  firecrawl: 'Firecrawl',
  xai: 'xAI',
  searxng: 'SearXNG',
};

// Title-case an unknown provider id so we never echo an internal lowercase
// identifier (e.g. "somevendor" -> "Somevendor"). Keeps copy plain-spoken
// without leaking raw backend jargon.
function titleCaseProvider(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

// Resolve a user-facing provider name. `translate` is optional so the function
// stays a pure unit (deterministic for a given input) and is testable without
// the full i18n runtime. The backend can return `native` (model-native web
// search) via /api/capabilities; that is rendered through a locale key so it
// never surfaces as the raw internal id "native". Any other unrecognized value
// falls back to a title-cased label rather than the raw id.
export function friendlyProviderName(
  provider: string | null | undefined,
  translate?: (key: string) => string,
): string | null {
  if (!provider) return null;
  if (PROVIDER_DISPLAY_NAMES[provider]) return PROVIDER_DISPLAY_NAMES[provider];
  if (provider === 'native') {
    const label = translate?.('home.web_search_provider_native_label');
    // Guard against an i18n miss echoing the raw key back to the user.
    if (label && label !== 'home.web_search_provider_native_label') return label;
    return titleCaseProvider(provider);
  }
  return titleCaseProvider(provider);
}
