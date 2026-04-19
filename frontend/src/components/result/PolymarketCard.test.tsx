import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { PolymarketCard } from './PolymarketCard';

i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

function renderCard(props: Parameters<typeof PolymarketCard>[0]) {
  return render(
    <I18nextProvider i18n={i18n}>
      <PolymarketCard {...props} />
    </I18nextProvider>,
  );
}

describe('PolymarketCard', () => {
  it('renders geo-gated placeholder when configured_host === "non-us"', () => {
    renderCard({
      capability: {
        enabled: true,
        configured_host: 'non-us',
        rate_limit_rps: 1,
        ttl_seconds: 60,
        byok_allowed: false,
      },
    });
    const el = screen.getByTestId('result-source-polymarket-geo-gated');
    expect(el).toBeInTheDocument();
    expect(el.getAttribute('aria-disabled')).toBe('true');
    expect(el.getAttribute('aria-label')).toBeTruthy();
  });

  it('renders normal card when configured_host === "us"', () => {
    renderCard({
      capability: {
        enabled: true,
        configured_host: 'us',
        rate_limit_rps: 1,
        ttl_seconds: 60,
        byok_allowed: false,
      },
      items: [
        { id: 'm1', question: 'Will X happen?', probability: 0.62, url: 'https://polymarket.com/m1' },
      ],
      state: 'ready',
    });
    expect(screen.getByTestId('result-sources-polymarket')).toBeInTheDocument();
    expect(screen.getByText('Will X happen?')).toBeInTheDocument();
    expect(screen.getByText('62%')).toBeInTheDocument();
  });

  it('does not treat unexpected configured_host values as geo-gated', () => {
    renderCard({
      capability: {
        enabled: true,
        configured_host: 'unexpected',
        rate_limit_rps: 1,
        ttl_seconds: 60,
        byok_allowed: false,
      },
      state: 'empty',
      items: [],
    });
    expect(screen.getByTestId('result-sources-polymarket')).toBeInTheDocument();
  });

  it('renders empty when capability us but no items', () => {
    renderCard({
      capability: {
        enabled: true,
        configured_host: 'us',
        rate_limit_rps: 1,
        ttl_seconds: 60,
        byok_allowed: false,
      },
      state: 'ready',
      items: [],
    });
    expect(screen.getByTestId('result-sources-empty')).toBeInTheDocument();
  });

  it('renders without capability (fallback to normal card)', () => {
    renderCard({ items: [], state: 'empty' });
    expect(screen.getByTestId('result-sources-polymarket')).toBeInTheDocument();
  });
});
