import { describe, expect, it } from 'vitest';

import i18n, { LANGUAGE_STORAGE_KEY } from './i18n/config';

const defaultTestLanguage = window.navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
const alternateLanguage = defaultTestLanguage === 'zh' ? 'en' : 'zh';

describe('test storage harness', () => {
  it('can mutate storage and language inside a test', async () => {
    window.localStorage.setItem('transient-key', 'value');
    window.sessionStorage.setItem('transient-session', 'value');
    await i18n.changeLanguage(alternateLanguage);

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: () => 'stale-value',
        setItem: () => {},
      },
    });

    expect(i18n.language).toBe(alternateLanguage);
  });

  it('restores full storage implementations and default language before the next test', () => {
    expect(window.localStorage.getItem('transient-key')).toBeNull();
    expect(window.sessionStorage.getItem('transient-session')).toBeNull();
    expect(window.localStorage.removeItem).toEqual(expect.any(Function));
    expect(window.localStorage.clear).toEqual(expect.any(Function));
    expect(i18n.language).toBe(defaultTestLanguage);
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });
});
