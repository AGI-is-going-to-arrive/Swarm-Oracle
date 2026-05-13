/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Web sources collapsible section
   ═══════════════════════════════════════════════════════════ */

import { useResultContext } from './ResultContext';

function getSafeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

export default function WebSourcesSection() {
  const {
    t,
    scenario,
    webSourcesOpen,
    setWebSourcesOpen,
    blurCollapsedPanelFocus,
  } = useResultContext();

  if (
    !scenario?.web_search_context
    || typeof scenario.web_search_context.query !== 'string'
    || !Array.isArray(scenario.web_search_context.snippets)
  ) {
    return null;
  }

  return (
    <section className="result-web-sources">
      <button
        type="button"
        className="result-web-sources__trigger"
        aria-expanded={webSourcesOpen}
        aria-controls="result-web-sources-body"
        onClick={() => setWebSourcesOpen((prev) => !prev)}
      >
        <span>{t('result.web_sources_title')}</span>
        <span aria-hidden="true">{webSourcesOpen ? '▲' : '▼'}</span>
      </button>
      <div
        id="result-web-sources-body"
        className={`result-web-sources__body ${webSourcesOpen ? 'is-open' : ''}`}
        aria-hidden={!webSourcesOpen}
        inert={!webSourcesOpen || undefined}
        onFocusCapture={webSourcesOpen ? undefined : blurCollapsedPanelFocus}
      >
        <div className="result-web-sources__inner">
          <div className="result-web-sources__meta">
            <span>{t('result.web_sources_query')}: {scenario.web_search_context.query}</span>
            {typeof scenario.web_search_context.provider === 'string' && (
              <span>{t('result.web_sources_provider')}: {scenario.web_search_context.provider}</span>
            )}
            {scenario.web_search_context.cached && (
              <span>{t('result.web_sources_cached')}</span>
            )}
          </div>
          <div className="result-web-sources__list">
            {scenario.web_search_context.snippets
              .filter((s): s is { text: string; source_url: string } =>
                s != null && typeof s.text === 'string')
              .map((snippet, idx) => (
              <article key={idx} className="result-web-sources__item">
                <p className="result-web-sources__item-text">{snippet.text}</p>
                {snippet.source_url && /^https?:\/\//i.test(snippet.source_url) && (
                  <a
                    className="result-web-sources__item-url"
                    href={snippet.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t('result.web_sources_visit')}
                  >
                    {snippet.source_url}
                  </a>
                )}
              </article>
            ))}
            {scenario.web_search_context.snippets.length === 0 && (
              <p className="result-web-sources__item-text">
                {t('result.web_sources_empty', {
                  defaultValue: 'No live web sources matched this query.',
                })}
              </p>
            )}
          </div>

          {/* Native search citations from LLM provider */}
          {Array.isArray(scenario.web_search_context.native_citations)
            && scenario.web_search_context.native_citations.length > 0 && (
            <div className="result-web-sources__native" role="region" aria-label={t('result.native_citations_title')}>
              <h4 className="result-web-sources__native-heading">
                {t('result.native_citations_title')}
              </h4>
              <div className="result-web-sources__list">
                {scenario.web_search_context.native_citations
                  .map((c) => {
                    if (c == null || typeof c.text !== 'string') {
                      return null;
                    }
                    const safeUrl = getSafeHttpUrl(c.source_url);
                    return safeUrl ? { text: c.text, source_url: safeUrl } : null;
                  })
                  .filter((c): c is { text: string; source_url: string } => c != null)
                  .map((cit, idx) => (
                  <article key={`nc-${idx}`} className="result-web-sources__item result-web-sources__item--native">
                    <p className="result-web-sources__item-text">{cit.text}</p>
                    <a
                      className="result-web-sources__item-url"
                      href={cit.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t('result.web_sources_visit')}
                    >
                      {cit.source_url}
                    </a>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
