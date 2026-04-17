import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { SemanticScholarCard } from './SemanticScholarCard';

i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

describe('SemanticScholarCard', () => {
  it('renders empty state by default', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <SemanticScholarCard />
      </I18nextProvider>,
    );
    expect(screen.getByTestId('result-sources-academic')).toBeInTheDocument();
  });

  it('renders items with citation count', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <SemanticScholarCard
          state="ready"
          items={[
            {
              id: 's1',
              title: 'Influential paper',
              authors: ['Alice'],
              citationCount: 42,
            },
          ]}
        />
      </I18nextProvider>,
    );
    expect(screen.getByText('Influential paper')).toBeInTheDocument();
    // formatting fallback via i18n defaultValue
    expect(screen.getByText(/42/)).toBeInTheDocument();
  });
});
