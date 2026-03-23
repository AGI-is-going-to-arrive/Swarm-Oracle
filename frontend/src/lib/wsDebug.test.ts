import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isWsDebugEnabled } from './wsDebug';

describe('wsDebug', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    const sessionStore = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key: string) => sessionStore.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        sessionStore.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        sessionStore.delete(key);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('enables debug mode from the wsDebug query param', () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL('https://example.com/sim?wsDebug=1'),
    });

    expect(isWsDebugEnabled()).toBe(true);
  });

  it('falls back to sessionStorage when the query param is absent', () => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL('https://example.com/sim'),
    });
    window.sessionStorage.setItem('swarmoracle.ws-debug', '1');

    expect(isWsDebugEnabled()).toBe(true);
  });
});
