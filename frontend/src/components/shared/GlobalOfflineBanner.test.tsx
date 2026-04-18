import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { GlobalOfflineBanner } from './GlobalOfflineBanner';

i18n.init({ lng: 'en', resources: { en: { translation: {} } } });

function renderBanner(props: ComponentProps<typeof GlobalOfflineBanner> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <GlobalOfflineBanner {...props} />
    </I18nextProvider>,
  );
}

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
    renderBanner();
    expect(screen.queryByTestId('global-offline-banner')).not.toBeInTheDocument();
  });

  it('visible when navigator.onLine becomes false', () => {
    renderBanner();
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
    const { rerender } = renderBanner({ wsDisconnectedAt: start });
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

  it('shows immediately when ws disconnect already exceeded the grace threshold', () => {
    const start = Date.now() - 10_000;

    renderBanner({ wsDisconnectedAt: start });

    expect(screen.getByTestId('global-offline-banner')).toBeInTheDocument();
  });

  it('hides immediately after ws disconnect state resets', () => {
    const start = Date.now() - 10_000;
    const { rerender } = renderBanner({ wsDisconnectedAt: start });

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(screen.getByTestId('global-offline-banner')).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={i18n}>
        <GlobalOfflineBanner wsDisconnectedAt={null} />
      </I18nextProvider>,
    );

    expect(screen.queryByTestId('global-offline-banner')).not.toBeInTheDocument();
  });

  it('hides immediately when ws disconnect switches back under the grace threshold', () => {
    const elapsedStart = Date.now() - 10_000;
    const freshStart = Date.now();
    const { rerender } = renderBanner({ wsDisconnectedAt: elapsedStart });

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(screen.getByTestId('global-offline-banner')).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={i18n}>
        <GlobalOfflineBanner wsDisconnectedAt={freshStart} />
      </I18nextProvider>,
    );

    expect(screen.queryByTestId('global-offline-banner')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(screen.getByTestId('global-offline-banner')).toBeInTheDocument();
  });

  it('calls onRetry when retry button clicked', () => {
    const onRetry = vi.fn();
    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    });
    renderBanner({ onRetry });
    const banner = screen.getByTestId('global-offline-banner');
    const btn = banner.querySelector('button');
    expect(btn).not.toBeNull();
    act(() => {
      btn!.click();
    });
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does not call useLayoutEffect directly in the component source', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const sourcePath = resolve(process.cwd(), 'src/components/shared/GlobalOfflineBanner.tsx');
    const source = await readFile(sourcePath, 'utf8');

    expect(source).not.toContain('useLayoutEffect(');
  });
});
