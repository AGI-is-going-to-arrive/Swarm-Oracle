import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { NewsApiCard } from './NewsApiCard';

i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

describe('NewsApiCard', () => {
  it('renders empty state by default', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <NewsApiCard />
      </I18nextProvider>,
    );
    expect(screen.getByTestId('result-sources-news_deep')).toBeInTheDocument();
    expect(screen.getByTestId('result-sources-empty')).toBeInTheDocument();
  });

  it('renders news items', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <NewsApiCard
          state="ready"
          items={[
            {
              id: 'n1',
              title: 'Breaking news headline',
              source: 'Reuters',
              publishedAt: '2026-04-18',
              description: 'Some description text.',
              url: 'https://example.com/news/1',
            },
          ]}
        />
      </I18nextProvider>,
    );
    expect(screen.getByText('Breaking news headline')).toBeInTheDocument();
    expect(screen.getByText('Reuters')).toBeInTheDocument();
  });
});
