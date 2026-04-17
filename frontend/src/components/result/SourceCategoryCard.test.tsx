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
});
