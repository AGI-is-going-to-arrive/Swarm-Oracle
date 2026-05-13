import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { SourceCategoryCard } from './SourceCategoryCard';

i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

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
});
