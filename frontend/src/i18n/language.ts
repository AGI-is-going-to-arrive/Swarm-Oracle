/** Lightweight language and date rules shared by the app and standalone Gallery. */
export type AppLanguage = 'en' | 'zh';
export const LANGUAGE_STORAGE_KEY = 'swarmoracle:language:v1';

export function normalizeLanguage(value: string | null | undefined): AppLanguage {
  return /^zh(?:[-_]|$)/i.test(value?.trim() ?? '') ? 'zh' : 'en';
}

export function readLanguagePreference(): AppLanguage | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)?.trim();
    return value && /^(?:en|zh)(?:[-_]|$)/i.test(value) ? normalizeLanguage(value) : null;
  } catch {
    return null;
  }
}

export function resolveInitialLanguage(): AppLanguage {
  if (typeof window === 'undefined') return 'zh';
  return readLanguagePreference() ?? normalizeLanguage(window.navigator.language);
}

export function persistLanguage(language: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalizeLanguage(language));
  } catch {
    // Language changes remain usable when browser storage is unavailable.
  }
}

export function syncDocumentLanguage(language: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = normalizeLanguage(language);
}

export function dateLocale(language: string | null | undefined): 'zh-CN' | 'en-US' {
  return normalizeLanguage(language) === 'zh' ? 'zh-CN' : 'en-US';
}

/** Preserve human timestamps and malformed dates instead of guessing their meaning. */
export function formatUiDateTime(value: string, language: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) return value;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return value;
  const dateOnly = value.length === 10;
  const date = dateOnly ? new Date(0) : new Date(value);
  if (dateOnly) {
    date.setFullYear(year, month - 1, day);
    date.setHours(0, 0, 0, 0);
  }
  if (Number.isNaN(date.getTime())) return value;
  try {
    return dateOnly ? date.toLocaleDateString(dateLocale(language)) : date.toLocaleString(dateLocale(language));
  } catch {
    return value;
  }
}
