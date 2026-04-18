import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, string | number | undefined>) =>
      String(options?.defaultValue ?? _key),
  }),
}));

function replaceGlobal(name: 'window' | 'document' | 'navigator', value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return descriptor;
}

function restoreGlobal(name: 'window' | 'document' | 'navigator', descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }
  delete (globalThis as Partial<typeof globalThis>)[name];
}

describe('GlobalOfflineBanner — SSR safety', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('server-renders without useLayoutEffect warnings when DOM globals are absent', async () => {
    const windowDescriptor = replaceGlobal('window', undefined);
    const documentDescriptor = replaceGlobal('document', undefined);
    const navigatorDescriptor = replaceGlobal('navigator', undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      vi.resetModules();
      const React = await import('react');
      const { renderToString } = await import('react-dom/server');
      const { GlobalOfflineBanner } = await import('./GlobalOfflineBanner');

      const html = renderToString(
        React.createElement(GlobalOfflineBanner, {
          wsDisconnectedAt: Date.now() - 10_000,
        }),
      );

      expect(html).toContain('global-offline-banner');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      restoreGlobal('window', windowDescriptor);
      restoreGlobal('document', documentDescriptor);
      restoreGlobal('navigator', navigatorDescriptor);
    }
  });
});
