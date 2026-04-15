import { afterEach, describe, expect, it, vi } from 'vitest';

import i18n, { LANGUAGE_STORAGE_KEY, resolveInitialLanguage } from './config';

const realLocalStorage = window.localStorage;
const realNavigatorLanguage = window.navigator.language;
const realDocumentLang = document.documentElement.lang;

function createStorageMock(overrides: Partial<Storage> = {}): Storage {
  return {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(() => null),
    length: 0,
    ...overrides,
  } as Storage;
}

afterEach(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: realLocalStorage,
  });
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: realNavigatorLanguage,
  });
  document.documentElement.lang = realDocumentLang;
  vi.resetModules();
});

describe('i18n config storage guards', () => {
  it('falls back to navigator language when localStorage read throws during bootstrap', () => {
    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      value: 'zh-CN',
    });
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: createStorageMock({
        getItem: vi.fn(() => {
          throw new Error('storage blocked');
        }),
      }),
    });

    expect(resolveInitialLanguage()).toBe('zh');
  });

  it('keeps language changes working when localStorage write throws', async () => {
    const setItem = vi.fn(() => {
      throw new Error('storage blocked');
    });
    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      value: 'en-AU',
    });
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: createStorageMock({ setItem }),
    });

    await i18n.changeLanguage('zh');

    expect(setItem).toHaveBeenCalledWith(LANGUAGE_STORAGE_KEY, 'zh');
    expect(i18n.language).toBe('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
  });
});
