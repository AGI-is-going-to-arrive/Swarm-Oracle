import { afterEach, describe, expect, it, vi } from 'vitest';

import i18n, { LANGUAGE_STORAGE_KEY, resolveInitialLanguage } from './config';
import { dateLocale, formatUiDateTime, normalizeLanguage, readLanguagePreference } from './language';

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
  it.each([['zh', 'zh'], ['zh-CN', 'zh'], ['ZH_tw', 'zh'], [' en-AU ', 'en'], ['zhang', 'en']] as const)('normalizes %s safely', (input, expected) => {
    expect(normalizeLanguage(input)).toBe(expected);
  });

  it('prefers the saved language over the opposite browser language', () => {
    Object.defineProperty(window.navigator, 'language', { configurable: true, value: 'zh-CN' });
    Object.defineProperty(window, 'localStorage', { configurable: true, value: createStorageMock({ getItem: () => 'en-US' }) });
    expect(readLanguagePreference()).toBe('en');
    expect(resolveInitialLanguage()).toBe('en');
  });

  it('ignores malformed preferences and falls back to the browser language', () => {
    Object.defineProperty(window.navigator, 'language', { configurable: true, value: 'zh-CN' });
    Object.defineProperty(window, 'localStorage', { configurable: true, value: createStorageMock({ getItem: () => 'not-a-language' }) });
    expect(readLanguagePreference()).toBeNull();
    expect(resolveInitialLanguage()).toBe('zh');
  });

  it('formats ISO dates using UI language and preserves uncertain timestamps', () => {
    const iso = '2026-09-05T01:02:03Z';
    expect(dateLocale('zh-CN')).toBe('zh-CN');
    expect(formatUiDateTime(iso, 'zh-CN')).toBe(new Date(iso).toLocaleString('zh-CN'));
    expect(formatUiDateTime(iso, 'en-AU')).toBe(new Date(iso).toLocaleString('en-US'));
    for (const raw of ['Yesterday', '05/09/2026', '2026-02-30T01:02:03Z', '2026-13-01T00:00:00Z', '2026-05-01T99:00:00Z']) {
      expect(formatUiDateTime(raw, 'zh')).toBe(raw);
    }
    expect(formatUiDateTime('2024-02-29', 'zh')).toBe(new Date(2024, 1, 29).toLocaleDateString('zh-CN'));
  });
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
    // <html lang> follows the normalized base subtag ('zh'), not a hardcoded
    // 'zh-CN', so the attribute always reflects the actually-active language.
    expect(document.documentElement.lang).toBe('zh');
  });
});
