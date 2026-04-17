import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { GlobalOfflineBanner } from './GlobalOfflineBanner';

i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

describe('GlobalOfflineBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hidden when online and no WS flag', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <GlobalOfflineBanner />
      </I18nextProvider>,
    );
    expect(screen.queryByTestId('global-offline-banner')).not.toBeInTheDocument();
  });

  it('visible when navigator.onLine becomes false', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <GlobalOfflineBanner />
      </I18nextProvider>,
    );
    act(() => {
      Object.defineProperty(navigator, 'onLine', {
        value: false,
        configurable: true,
      });
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByTestId('global-offline-banner')).toBeInTheDocument();
  });

  it('visible after WS disconnect grace (10s default)', () => {
    const start = Date.now();
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <GlobalOfflineBanner wsDisconnectedAt={start} />
      </I18nextProvider>,
    );
    expect(screen.queryByTestId('global-offline-banner')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    rerender(
      <I18nextProvider i18n={i18n}>
        <GlobalOfflineBanner wsDisconnectedAt={start} />
      </I18nextProvider>,
    );
    expect(screen.getByTestId('global-offline-banner')).toBeInTheDocument();
  });

  it('calls onRetry when retry button clicked', () => {
    const onRetry = vi.fn();
    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    });
    render(
      <I18nextProvider i18n={i18n}>
        <GlobalOfflineBanner onRetry={onRetry} />
      </I18nextProvider>,
    );
    const banner = screen.getByTestId('global-offline-banner');
    const btn = banner.querySelector('button');
    expect(btn).not.toBeNull();
    act(() => {
      btn!.click();
    });
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
