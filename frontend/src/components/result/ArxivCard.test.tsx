import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { ArxivCard } from './ArxivCard';

i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

describe('ArxivCard', () => {
  it('renders empty state by default', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ArxivCard />
      </I18nextProvider>,
    );
    expect(screen.getByTestId('result-sources-academic')).toBeInTheDocument();
    expect(screen.getByTestId('result-sources-empty')).toBeInTheDocument();
  });

  it('renders items in ready state', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ArxivCard
          state="ready"
          items={[
            {
              id: 'p1',
              title: 'Foo paper',
              authors: ['Alice', 'Bob'],
              abstract: 'Abstract text.',
              url: 'https://arxiv.org/abs/2401.00001',
            },
          ]}
        />
      </I18nextProvider>,
    );
    expect(screen.getByText('Foo paper')).toBeInTheDocument();
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
  });
});
