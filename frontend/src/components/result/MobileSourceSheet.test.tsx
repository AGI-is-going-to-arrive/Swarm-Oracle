import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { MobileSourceSheet } from './MobileSourceSheet';

i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

describe('MobileSourceSheet', () => {
  it('renders children when open', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MobileSourceSheet open onOpenChange={() => {}}>
          <p data-testid="child-marker">child-marker</p>
        </MobileSourceSheet>
      </I18nextProvider>,
    );
    expect(screen.getByTestId('mobile-source-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('child-marker')).toBeInTheDocument();
  });

  it('does not render sheet content when closed', () => {
    const onOpenChange = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <MobileSourceSheet open={false} onOpenChange={onOpenChange}>
          <p data-testid="child-marker">child-marker</p>
        </MobileSourceSheet>
      </I18nextProvider>,
    );
    expect(screen.queryByTestId('mobile-source-sheet')).not.toBeInTheDocument();
  });
});
