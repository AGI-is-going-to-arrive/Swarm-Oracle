import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { SourceCategoryCard } from './SourceCategoryCard';
import type { WebSearchFamilyDomainFilterMode } from '../../types';

i18n.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        'source.searched_with': 'Searched: "{{query}}"',
        'source.searched_with_raw_fallback': 'Searched with the original question',
        'source.broadened_search': 'Broadened search',
        'source.broadened_search_sr': 'These results came from the second broadened-domain search pass',
      }
    }
  }
});

function renderCard(props: Parameters<typeof SourceCategoryCard>[0]) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SourceCategoryCard {...props} />
    </I18nextProvider>,
  );
}

describe('SourceCategoryCard', () => {
  it('renders ready state with children', () => {
    renderCard({
      family: 'polymarket',
      title: 'Polymarket',
      state: 'ready',
      children: <p>content-marker</p>,
    });
    expect(screen.getByTestId('result-sources-polymarket')).toBeInTheDocument();
    expect(screen.getByText('content-marker')).toBeInTheDocument();
  });

  it('renders skeleton in loading state', () => {
    renderCard({ family: 'finance', title: 'Finance', state: 'loading' });
    expect(screen.getByTestId('result-source-skeleton')).toBeInTheDocument();
  });

  it('renders empty state', () => {
    renderCard({ family: 'academic', title: 'Academic', state: 'empty' });
    expect(screen.getByTestId('result-sources-empty')).toBeInTheDocument();
  });

  it('renders rate-limited state', () => {
    renderCard({ family: 'news_deep', title: 'News', state: 'rate_limited' });
    expect(screen.getByTestId('result-source-rate-limited')).toBeInTheDocument();
  });

  it('renders network-error state', () => {
    renderCard({ family: 'polymarket', title: 'Polymarket', state: 'network_error' });
    expect(screen.getByTestId('result-source-network-error')).toBeInTheDocument();
  });

  it('exposes data-source-family and data-state attributes', () => {
    renderCard({ family: 'finance', title: 'Finance', state: 'ready' });
    const el = screen.getByTestId('result-sources-finance');
    expect(el.getAttribute('data-source-family')).toBe('finance');
    expect(el.getAttribute('data-state')).toBe('ready');
  });

  describe('P4-1 provider-aware states', () => {
    it('renders failed state with error card + sr reason', () => {
      renderCard({
        family: 'finance',
        title: 'Finance',
        state: 'failed',
        reason: 'Provider request timed out.',
      });
      const card = screen.getByTestId('result-sources-finance');
      expect(card.getAttribute('data-state')).toBe('failed');
      expect(card.className).toContain('result-source-card__failed');
      expect(screen.getByTestId('result-source-failed')).toBeInTheDocument();
      const reasonEl = screen.getByTestId('result-sources-finance-reason');
      expect(reasonEl.textContent).toBe('Provider request timed out.');
      expect(card.getAttribute('aria-describedby')).toBe(
        'result-sources-finance-reason',
      );
    });

    it('renders unsupported_provider state with info card + sr reason', () => {
      renderCard({
        family: 'polymarket',
        title: 'Polymarket',
        state: 'unsupported_provider',
        reason: 'Tavily does not cover prediction markets.',
      });
      const card = screen.getByTestId('result-sources-polymarket');
      expect(card.getAttribute('data-state')).toBe('unsupported_provider');
      expect(card.className).toContain('result-source-card__unsupported');
      expect(screen.getByTestId('result-source-unsupported')).toBeInTheDocument();
      const reasonEl = screen.getByTestId('result-sources-polymarket-reason');
      expect(reasonEl).toBeInTheDocument();
      expect(reasonEl.id).toBe('result-sources-polymarket-reason');
      expect(reasonEl.textContent).toBe('Tavily does not cover prediction markets.');
      expect(card.getAttribute('aria-describedby')).toBe(
        'result-sources-polymarket-reason',
      );
    });

    it('renders fallback_unconstrained state with warning card and still shows children', () => {
      renderCard({
        family: 'finance',
        title: 'Finance',
        state: 'fallback_unconstrained',
        reason: 'SearXNG does not support domain scope.',
        children: <p>fallback-result-marker</p>,
      });
      const card = screen.getByTestId('result-sources-finance');
      expect(card.getAttribute('data-state')).toBe('fallback_unconstrained');
      expect(card.className).toContain('result-source-card__fallback');
      expect(screen.getByTestId('result-source-fallback')).toBeInTheDocument();
      expect(screen.getByText('fallback-result-marker')).toBeInTheDocument();
      const reasonEl = screen.getByTestId('result-sources-finance-reason');
      expect(reasonEl.textContent).toBe('SearXNG does not support domain scope.');
      expect(card.getAttribute('aria-describedby')).toBe(
        'result-sources-finance-reason',
      );
    });

    it('renders search_skipped state with muted card and sr reason fallback', () => {
      renderCard({
        family: 'academic',
        title: 'Academic',
        state: 'search_skipped',
      });
      const card = screen.getByTestId('result-sources-academic');
      expect(card.getAttribute('data-state')).toBe('search_skipped');
      expect(card.className).toContain('result-source-card__skipped');
      expect(screen.getByTestId('result-source-skipped')).toBeInTheDocument();
      const reasonEl = screen.getByTestId('result-sources-academic-reason');
      expect(reasonEl).toBeInTheDocument();
      expect(reasonEl.textContent).toBeTruthy();
      expect(card.getAttribute('aria-describedby')).toBe(
        'result-sources-academic-reason',
      );
    });

    it('does not emit aria-describedby for legacy states', () => {
      renderCard({ family: 'polymarket', title: 'Polymarket', state: 'ready' });
      expect(
        screen.getByTestId('result-sources-polymarket').getAttribute('aria-describedby'),
      ).toBeNull();
      expect(
        screen.queryByTestId('result-sources-polymarket-reason'),
      ).not.toBeInTheDocument();
    });

    it('news_deep family renders each new state with family-scoped testid', () => {
      const { rerender } = renderCard({
        family: 'news_deep',
        title: 'Deep News',
        state: 'unsupported_provider',
      });
      expect(screen.getByTestId('result-sources-news_deep-reason')).toBeInTheDocument();

      rerender(
        <I18nextProvider i18n={i18n}>
          <SourceCategoryCard
            family="news_deep"
            title="Deep News"
            state="failed"
          />
        </I18nextProvider>,
      );
      expect(screen.getByTestId('result-sources-news_deep-reason')).toBeInTheDocument();

      rerender(
        <I18nextProvider i18n={i18n}>
          <SourceCategoryCard
            family="news_deep"
            title="Deep News"
            state="fallback_unconstrained"
          />
        </I18nextProvider>,
      );
      expect(screen.getByTestId('result-sources-news_deep-reason')).toBeInTheDocument();

      rerender(
        <I18nextProvider i18n={i18n}>
          <SourceCategoryCard
            family="news_deep"
            title="Deep News"
            state="search_skipped"
          />
        </I18nextProvider>,
      );
      expect(screen.getByTestId('result-sources-news_deep-reason')).toBeInTheDocument();
    });
  });

  describe('Query Optimization and Broadened Search Features', () => {
    it('renders optimized query in empty state', () => {
      renderCard({
        family: 'academic',
        title: 'Academic',
        state: 'empty',
        optimizedQuery: 'AI海水核污染未来的世界',
      });
      expect(screen.getByText('Searched: "AI海水核污染未来的世界"')).toBeInTheDocument();
    });

    it('hides optimized query when absent or unsafe/empty', () => {
      // absent:
      const { rerender } = renderCard({
        family: 'academic',
        title: 'Academic',
        state: 'empty',
      });
      expect(screen.queryByText(/Searched:/)).not.toBeInTheDocument();
      expect(screen.getByText('Searched with the original question')).toBeInTheDocument();

      // empty string:
      rerender(
        <I18nextProvider i18n={i18n}>
          <SourceCategoryCard
            family="academic"
            title="Academic"
            state="empty"
            optimizedQuery=""
          />
        </I18nextProvider>,
      );
      expect(screen.queryByText(/Searched:/)).not.toBeInTheDocument();
      expect(screen.getByText('Searched with the original question')).toBeInTheDocument();

      // unsafe provider-query operators / internal hosts:
      rerender(
        <I18nextProvider i18n={i18n}>
          <SourceCategoryCard
            family="academic"
            title="Academic"
            state="empty"
            optimizedQuery="site:localhost secrets"
          />
        </I18nextProvider>,
      );
      expect(screen.queryByText('Searched: "site:localhost secrets"')).not.toBeInTheDocument();
      expect(screen.getByText('Searched with the original question')).toBeInTheDocument();
    });

    it('renders raw-question fallback copy when no optimized query exists', () => {
      renderCard({
        family: 'academic',
        title: 'Academic',
        state: 'empty',
      });
      expect(screen.getByText('Searched with the original question')).toBeInTheDocument();
    });

    it('renders broadened search badge for searchPass: 2 + ready state', () => {
      renderCard({
        family: 'news_deep',
        title: 'Deep News',
        state: 'ready',
        searchPass: 2,
        children: <p>news-content</p>,
      });
      expect(screen.getByText('Broadened search')).toBeInTheDocument();
      expect(screen.getByText('These results came from the second broadened-domain search pass')).toBeInTheDocument();
      expect(screen.getByText('news-content')).toBeInTheDocument();
    });

    it('hides broadened badge for searchPass: 1', () => {
      renderCard({
        family: 'news_deep',
        title: 'Deep News',
        state: 'ready',
        searchPass: 1,
        children: <p>news-content</p>,
      });
      expect(screen.queryByText('Broadened search')).not.toBeInTheDocument();
      expect(screen.queryByText('These results came from the second broadened-domain search pass')).not.toBeInTheDocument();
    });

    it('handles script-looking or special characters in optimized query safely as text', () => {
      renderCard({
        family: 'polymarket',
        title: 'Polymarket',
        state: 'empty',
        optimizedQuery: '<script>alert("hack")</script>',
      });
      expect(screen.getByText('Searched: "<script>alert("hack")</script>"')).toBeInTheDocument();
    });

    it('handles RTL/mixed-direction/script-looking query as text', () => {
      // RTL and mixed text
      const { rerender } = renderCard({
        family: 'academic',
        title: 'Academic',
        state: 'empty',
        optimizedQuery: 'AI & שלום world',
      });
      expect(screen.getByText('Searched: "AI & שלום world"')).toBeInTheDocument();

      // script-looking
      rerender(
        <I18nextProvider i18n={i18n}>
          <SourceCategoryCard
            family="academic"
            title="Academic"
            state="empty"
            optimizedQuery='<script>alert("hack")</script>'
          />
        </I18nextProvider>,
      );
      expect(screen.getByText('Searched: "<script>alert("hack")</script>"')).toBeInTheDocument();
    });

    it('includes accessible description for broadened badge', () => {
      renderCard({
        family: 'news_deep',
        title: 'Deep News',
        state: 'ready',
        searchPass: 2,
        children: <p>news-content</p>,
      });
      const badgeText = screen.getByText('Broadened search');
      expect(badgeText).toBeInTheDocument();
      const srDesc = screen.getByText('These results came from the second broadened-domain search pass');
      expect(srDesc).toBeInTheDocument();
      expect(srDesc.className).toContain('sr-only');
    });

    it("'prompt' domain filter mode type is accepted", () => {
      const mode: WebSearchFamilyDomainFilterMode = 'prompt';
      expect(mode).toBe('prompt');
    });
  });
});
