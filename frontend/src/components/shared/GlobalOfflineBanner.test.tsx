import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { useRef, type ComponentProps } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';

import { GlobalOfflineBanner } from './GlobalOfflineBanner';
import useFocusTrap from '../../hooks/useFocusTrap';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '../ui/sheet';

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

  it('keeps retry controls above modal and sheet overlays', () => {
    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    });
    renderBanner();

    const banner = screen.getByTestId('global-offline-banner');
    expect(banner).toHaveClass('z-[10000]', 'pointer-events-auto');
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveClass('pointer-events-auto');
  });

  it('stays exposed when a modal focus trap isolates root siblings', async () => {
    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    });
    renderBanner();

    const banner = screen.getByTestId('global-offline-banner');
    await act(async () => {
      banner.setAttribute('inert', '');
      banner.setAttribute('aria-hidden', 'true');
      await Promise.resolve();
    });

    expect(banner).not.toHaveAttribute('inert');
    expect(banner).not.toHaveAttribute('aria-hidden');
  });

  it('keeps Retry in the keyboard cycle while an isolated modal focus trap is active', () => {
    function OfflineDialogHarness() {
      const dialogRef = useRef<HTMLDivElement>(null);
      useFocusTrap(dialogRef, true, true);
      return (
        <>
          <GlobalOfflineBanner />
          <div ref={dialogRef} role="dialog" aria-modal="true">
            <button type="button">First dialog action</button>
            <button type="button">Last dialog action</button>
          </div>
        </>
      );
    }

    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    });
    render(
      <I18nextProvider i18n={i18n}>
        <OfflineDialogHarness />
      </I18nextProvider>,
    );

    const lastDialogAction = screen.getByRole('button', { name: 'Last dialog action' });
    const retry = screen.getByRole('button', { name: 'Retry' });
    lastDialogAction.focus();
    fireEvent.keyDown(lastDialogAction, { key: 'Tab' });

    expect(retry).toHaveFocus();
    expect(retry.closest('[data-testid="global-offline-banner"]')).not.toHaveAttribute('inert');
  });

  it.each([
    {
      name: 'Radix dialog',
      renderSurface: () => (
        <Dialog open>
          <DialogContent>
            <DialogTitle>Offline dialog</DialogTitle>
            <button type="button">Dialog action</button>
          </DialogContent>
        </Dialog>
      ),
    },
    {
      name: 'Radix sheet',
      renderSurface: () => (
        <Sheet open>
          <SheetContent>
            <SheetTitle>Offline sheet</SheetTitle>
            <button type="button">Sheet action</button>
          </SheetContent>
        </Sheet>
      ),
    },
  ])('keeps recovery keyboard-reachable inside an open $name focus scope', ({ renderSurface }) => {
    const onRetry = vi.fn();
    Object.defineProperty(navigator, 'onLine', {
      value: false,
      configurable: true,
    });

    render(
      <I18nextProvider i18n={i18n}>
        <GlobalOfflineBanner onRetry={onRetry} />
        {renderSurface()}
      </I18nextProvider>,
    );

    const modal = screen.getByRole('dialog');
    const recovery = within(modal).getByTestId('global-offline-recovery-action');
    const retry = within(recovery).getByRole('button', { name: 'Retry' });
    expect(recovery).not.toHaveAttribute('aria-hidden', 'true');
    expect(recovery).not.toHaveAttribute('inert');

    retry.focus();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
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
