import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

// ── Mock ResultContext ──
vi.mock('../../pages/result/ResultContext', () => ({
  useResultContext: vi.fn(),
}));

import { useResultContext } from '../../pages/result/ResultContext';
import { UnifiedSourceFeed } from './UnifiedSourceFeed';

i18n.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        'source.feed.title': 'Real-World Sources',
        'source.feed.filter_all': 'All',
        'source.feed.load_more': 'Load more',
        'source.feed.show_less': 'Show less',
        'source.feed.untitled': 'Untitled source',
        'source.feed.type.polymarket': 'Prediction Markets',
        'source.feed.type.finance': 'Finance',
        'source.feed.type.academic': 'Academic',
        'source.feed.type.news_deep': 'News',
        'source.feed.type.snippet': 'Web Snippets',
        'source.feed.type.citation': 'Citations',
        'source.searched_with': 'Searched: "{{query}}"',
        'source.searched_with_raw_fallback': 'Searched with the original question',
        'source.broadened_search': 'Broadened search',
        'source.broadened_search_sr': 'These results came from the second broadened-domain search pass',
        'source.polymarket.open': 'Open market',
        'source.polymarket.geo_gated_title': 'Polymarket is geo-gated (US host required)',
        'source.academic.citations': '{{count}} citations',
        'source.polymarket.title': 'Polymarket',
        'source.finance.title': 'Finance',
        'source.academic.title': 'Academic',
        'source.news_deep.title': 'News',
        'result.source_historical': 'Recorded',
        'result.source_historical_tooltip': 'This data was recorded when the scenario was created',
      },
    },
  },
});

const mockedCtx = vi.mocked(useResultContext);

describe('UnifiedSourceFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const setupMockContext = (overrides: Record<string, unknown> = {}) => {
    mockedCtx.mockReturnValue({
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [],
          native_citations: [],
          family_context: {},
        },
      },
      capabilities: {
        web_search: {
          providers: {
            polymarket: { enabled: true },
            finance: { enabled: true },
            academic: { enabled: true },
            news_deep: { enabled: true },
          },
        },
      },
      webSourcesOpen: true,
      setWebSourcesOpen: vi.fn(),
      blurCollapsedPanelFocus: vi.fn(),
      ...overrides,
    } as unknown as ReturnType<typeof useResultContext>);
  };

  it('renders null when there are no elements', () => {
    setupMockContext({
      scenario: null,
    });
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders filter chips with counts', () => {
    setupMockContext({
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [{ text: 'snippet 1', source_url: 'https://site.com' }],
          native_citations: [],
          family_context: {
            polymarket: {
              state: 'ready',
              items: [
                { id: 'pm1', question: 'Will it rain?', probability: 0.8, url: 'https://pm.com' },
              ],
            },
          },
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    expect(screen.getByText('Real-World Sources')).toBeInTheDocument();
    // All count should be 2
    expect(screen.getByRole('button', { name: /All 2/ })).toBeInTheDocument();
    // Polymarket count should be 1
    expect(screen.getByRole('button', { name: /Prediction Markets 1/ })).toBeInTheDocument();
    // Web Snippets count should be 1
    expect(screen.getByRole('button', { name: /Web Snippets 1/ })).toBeInTheDocument();

    // Finance count is 0 but still has an empty status row, so the filter remains reachable.
    const financeChip = screen.getByRole('button', { name: /Finance 0/ });
    expect(financeChip).not.toBeDisabled();
  });

  it('filters rows when a chip is clicked', () => {
    setupMockContext({
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [{ text: 'snippet 1', source_url: 'https://site.com' }],
          native_citations: [],
          family_context: {
            polymarket: {
              state: 'ready',
              items: [
                { id: 'pm1', question: 'Will it rain?', probability: 0.8, url: 'https://pm.com' },
              ],
            },
          },
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    // Initial render should show both Polymarket item and Snippet
    expect(screen.getByText('Will it rain?')).toBeInTheDocument();
    expect(screen.getByText('snippet 1')).toBeInTheDocument();

    // Click on Polymarket chip
    fireEvent.click(screen.getByRole('button', { name: /Prediction Markets 1/ }));

    // Should only show Polymarket item, not Snippet
    expect(screen.getByText('Will it rain?')).toBeInTheDocument();
    expect(screen.queryByText('snippet 1')).not.toBeInTheDocument();
  });

  it('caps display at 6 items by default and toggles expand', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `item-${i}`,
      title: `Finance item ${i}`,
      summary: `summary ${i}`,
      source: 'Finance Source',
      url: 'https://finance.com',
    }));

    setupMockContext({
      capabilities: {
        web_search: { providers: { finance: { enabled: true } } },
      },
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [],
          native_citations: [],
          family_context: {
            finance: {
              state: 'ready',
              items,
            },
          },
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    // Should show 6 items
    expect(screen.getByText('Finance item 0')).toBeInTheDocument();
    expect(screen.getByText('Finance item 5')).toBeInTheDocument();
    expect(screen.queryByText('Finance item 6')).not.toBeInTheDocument();

    // Click "Load more"
    const loadMoreBtn = screen.getByRole('button', { name: /Load more/ });
    fireEvent.click(loadMoreBtn);

    // Should show all 10 items
    expect(screen.getByText('Finance item 9')).toBeInTheDocument();

    // Click "Show less"
    const showLessBtn = screen.getByRole('button', { name: /Show less/ });
    fireEvent.click(showLessBtn);

    // Should cap at 6 again
    expect(screen.queryByText('Finance item 6')).not.toBeInTheDocument();
  });

  it('renders status row for failed or empty state', () => {
    setupMockContext({
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [],
          native_citations: [],
          family_context: {
            academic: {
              state: 'failed',
              items: [],
              status_reason: 'Academic service unavailable',
            },
          },
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    const group = screen.getByTestId('result-sources-academic');
    expect(group).toHaveAttribute('data-state', 'failed');
    expect(within(group).getAllByText('Academic service unavailable').length).toBeGreaterThan(0);
  });

  it('renders geo-gated Polymarket status row', () => {
    setupMockContext({
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [],
          native_citations: [],
          family_context: {
            polymarket: {
              state: 'ready',
              items: [],
              configured_host: 'non-us',
            },
          },
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    const group = screen.getByTestId('result-sources-polymarket');
    expect(group).toHaveAttribute('data-state', 'geo_gated');
    expect(within(group).getByText('Polymarket is geo-gated (US host required)')).toBeInTheDocument();
  });

  it('renders historical badge when isHistorical is true', () => {
    setupMockContext({
      capabilities: {
        web_search: {
          providers: {
            polymarket: { enabled: false }, // live disabled -> historical
          },
        },
      },
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [],
          native_citations: [],
          family_context: {
            polymarket: {
              state: 'ready',
              items: [
                { id: 'pm1', question: 'Will X happen?', probability: 0.5, url: 'https://pm.com' },
              ],
            },
          },
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    expect(screen.getAllByText('Recorded')[0]).toBeInTheDocument();
  });

  it('sanitizes URLs to allow only http(s) protocols', () => {
    setupMockContext({
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [
            { text: 'safe snippet', source_url: 'https://safe.com' },
            { text: 'unsafe snippet', source_url: 'javascript:alert(1)' },
          ],
          native_citations: [],
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    // 行模板用固定「打开 →」文案，链接 href 仍指向来源 URL；按 href 校验 sanitization
    const links = screen.getAllByRole('link');
    const safeLink = links.find((l) => l.getAttribute('href') === 'https://safe.com');
    expect(safeLink).toBeDefined();

    const unsafeLink = links.find((l) => l.getAttribute('href') === 'javascript:alert(1)');
    expect(unsafeLink).toBeUndefined();
  });

  it('localizes the filter group aria-label on both desktop and mobile (guards against hardcoded label)', () => {
    // 注入独特译值，区分「i18n 解析」与「硬编码英文」——desktop/mobile 任一漏改都会令断言失败
    i18n.addResource('en', 'translation', 'source.feed.filters_label', 'I18N_FILTERS_LABEL');
    setupMockContext({
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [{ text: 'snippet 1', source_url: 'https://site.com' }],
          native_citations: [],
          family_context: {},
        },
      },
    });

    const desktop = render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );
    expect(desktop.getByRole('group', { name: 'I18N_FILTERS_LABEL' })).toBeInTheDocument();
    desktop.unmount();

    const mobile = render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="mobile" />
      </I18nextProvider>,
    );
    expect(mobile.getByRole('group', { name: 'I18N_FILTERS_LABEL' })).toBeInTheDocument();
  });

  it('renders broadened-search and optimized-query provenance on the new feed contract', () => {
    setupMockContext({
      capabilities: {
        web_search: {
          providers: {
            finance: { enabled: true },
            academic: { enabled: true },
          },
        },
      },
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [],
          native_citations: [],
          family_context: {
            finance: {
              state: 'ready',
              search_pass: 2,
              optimized_query: 'AI chip suppliers earnings',
              items: [
                {
                  id: 'finance-1',
                  title: 'Supplier earnings',
                  summary: 'Guidance moved higher',
                  source: 'Market Desk',
                  url: 'https://finance.example/article',
                },
              ],
            },
            academic: {
              state: 'empty',
              optimized_query: 'retrieval augmented generation evaluation',
              items: [],
            },
          },
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    const financeGroup = screen.getByTestId('result-sources-finance');
    expect(within(financeGroup).getByTestId('result-sources-finance-broadened-badge')).toHaveTextContent('Broadened search');
    expect(screen.getByText(/Guidance moved higher/)).toBeInTheDocument();

    const academicGroup = screen.getByTestId('result-sources-academic');
    expect(within(academicGroup).getByTestId('result-sources-academic-search-query')).toHaveTextContent(
      'retrieval augmented generation evaluation',
    );
  });

  it('keeps status-only filters enabled and outside the six-item cap', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `finance-${i}`,
      title: `Finance item ${i}`,
      url: `https://finance.example/${i}`,
    }));
    setupMockContext({
      capabilities: {
        web_search: {
          providers: {
            finance: { enabled: true },
            academic: { enabled: true },
          },
        },
      },
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [],
          native_citations: [],
          family_context: {
            finance: {
              state: 'ready',
              items,
            },
            academic: {
              state: 'empty',
              optimized_query: 'academic query',
              items: [],
            },
          },
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    const academicChip = screen.getByRole('button', { name: /Academic 0/ });
    expect(academicChip).not.toBeDisabled();
    expect(screen.getByTestId('unified-feed-status-academic')).toBeInTheDocument();
    expect(screen.getByText('Finance item 5')).toBeInTheDocument();
    expect(screen.queryByText('Finance item 6')).not.toBeInTheDocument();
  });

  it('uses target-scoped status reason ids when desktop and mobile feeds coexist', () => {
    setupMockContext({
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [],
          native_citations: [],
          family_context: {
            academic: {
              state: 'failed',
              items: [],
              status_reason: 'Academic service unavailable',
            },
          },
        },
      },
    });

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <>
          <UnifiedSourceFeed target="desktop" />
          <UnifiedSourceFeed target="mobile" />
        </>
      </I18nextProvider>,
    );

    const ids = Array.from(container.querySelectorAll('[id]')).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not render invalid probability or citation meta values', () => {
    setupMockContext({
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [],
          native_citations: [],
          family_context: {
            polymarket: {
              state: 'ready',
              items: [
                { id: 'pm-bad', question: 'Bad probability?', probability: -0.2, url: 'https://pm.example' },
              ],
            },
            academic: {
              state: 'ready',
              items: [
                { id: 'acad-bad', title: 'Bad citations', citationCount: -3, url: 'https://paper.example' },
              ],
            },
          },
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    expect(screen.getByText('Bad probability?')).toBeInTheDocument();
    expect(screen.queryByText('-20%')).not.toBeInTheDocument();
    expect(screen.getByText('Bad citations')).toBeInTheDocument();
    expect(screen.queryByText('-3 citations')).not.toBeInTheDocument();
  });

  it.each([
    ['finance', 'failed', 'Provider request timed out.'],
    ['polymarket', 'unsupported_provider', 'Tavily does not cover prediction markets.'],
    ['academic', 'search_skipped', 'Search intentionally skipped.'],
  ] as const)(
    'keeps %s %s reason text tied to the family group',
    (family, state, reason) => {
      setupMockContext({
        capabilities: {
          web_search: {
            providers: {
              [family]: { enabled: true },
            },
          },
        },
        scenario: {
          web_search_context: {
            query: 'test query',
            snippets: [],
            native_citations: [],
            family_context: {
              [family]: {
                state,
                status_reason: reason,
                items: [],
              },
            },
          },
        },
      });

      render(
        <I18nextProvider i18n={i18n}>
          <UnifiedSourceFeed target="desktop" />
        </I18nextProvider>,
      );

      const group = screen.getByTestId(`result-sources-${family}`);
      const reasonId = `result-sources-${family}-reason`;
      expect(group).toHaveAttribute('data-state', state);
      expect(group).toHaveAttribute('aria-describedby', reasonId);
      expect(screen.getByTestId(reasonId)).toHaveTextContent(reason);
      expect(within(group).getByTestId(`unified-feed-status-${family}`)).toHaveAttribute(
        'aria-describedby',
        `status-desktop-status-${family}-reason`,
      );
    },
  );

  it('renders fallback-unconstrained status and rows together', () => {
    setupMockContext({
      capabilities: {
        web_search: {
          providers: {
            finance: { enabled: true },
          },
        },
      },
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [],
          native_citations: [],
          family_context: {
            finance: {
              state: 'fallback_unconstrained',
              status_reason: 'SearXNG does not support domain scope.',
              search_pass: 2,
              items: [
                {
                  id: 'fin-fallback',
                  title: 'Fallback result',
                  summary: 'Returned without a domain filter',
                  url: 'https://finance.example/fallback',
                },
              ],
            },
          },
        },
      },
    });

    render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    const group = screen.getByTestId('result-sources-finance');
    expect(group).toHaveAttribute('data-state', 'fallback_unconstrained');
    expect(within(group).getByTestId('unified-feed-status-finance')).toHaveTextContent(
      'SearXNG does not support domain scope.',
    );
    expect(within(group).getByTestId('result-sources-finance-broadened-badge')).toHaveTextContent(
      'Broadened search',
    );
    expect(screen.getByTestId('unified-row-finance-fin-fallback')).toHaveTextContent('Fallback result');
  });

  it('filters unsafe optimized queries but keeps script-looking text as inert text', () => {
    setupMockContext({
      capabilities: {
        web_search: {
          providers: {
            academic: { enabled: true },
            news_deep: { enabled: true },
          },
        },
      },
      scenario: {
        web_search_context: {
          query: 'test query',
          snippets: [],
          native_citations: [],
          family_context: {
            academic: {
              state: 'empty',
              optimized_query: 'site:localhost secrets',
              items: [],
            },
            news_deep: {
              state: 'empty',
              optimized_query: '<script>alert("hack")</script>',
              items: [],
            },
          },
        },
      },
    });

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <UnifiedSourceFeed target="desktop" />
      </I18nextProvider>,
    );

    const academicGroup = screen.getByTestId('result-sources-academic');
    expect(within(academicGroup).getByTestId('result-sources-academic-search-query')).toHaveTextContent(
      'Searched with the original question',
    );
    expect(academicGroup).not.toHaveTextContent('site:localhost secrets');

    const newsGroup = screen.getByTestId('result-sources-news_deep');
    expect(within(newsGroup).getByTestId('result-sources-news_deep-search-query')).toHaveTextContent(
      'Searched: "<script>alert("hack")</script>"',
    );
    expect(container.querySelector('script')).toBeNull();
  });
});
