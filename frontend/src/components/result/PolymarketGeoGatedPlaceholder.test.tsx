import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { PolymarketGeoGatedPlaceholder } from './PolymarketGeoGatedPlaceholder';

i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

describe('PolymarketGeoGatedPlaceholder', () => {
  it('renders with aria-disabled + aria-label', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <PolymarketGeoGatedPlaceholder />
      </I18nextProvider>,
    );
    const el = screen.getByTestId('result-source-polymarket-geo-gated');
    expect(el.getAttribute('aria-disabled')).toBe('true');
    expect(el.getAttribute('aria-label')).toBeTruthy();
  });

  it('snapshot is stable', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <PolymarketGeoGatedPlaceholder />
      </I18nextProvider>,
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});
