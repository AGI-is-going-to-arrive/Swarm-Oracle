import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zh from './locales/zh.json';

export const LANGUAGE_STORAGE_KEY = 'swarmoracle:language:v1';

function normalizeLanguage(value: string | null | undefined): 'en' | 'zh' {
  return value?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function resolveInitialLanguage(): 'en' | 'zh' {
  if (typeof window === 'undefined') return 'zh';

  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (stored) return normalizeLanguage(stored);

  return normalizeLanguage(window.navigator.language);
}

function syncDocumentLanguage(language: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = normalizeLanguage(language) === 'zh' ? 'zh-CN' : 'en';
}

const initialLanguage = resolveInitialLanguage();

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en,
      zh,
    },
    lng: initialLanguage,
    supportedLngs: ['en', 'zh'],
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });

syncDocumentLanguage(initialLanguage);
i18n.on('languageChanged', (language) => {
  const normalized = normalizeLanguage(language);
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  }
  syncDocumentLanguage(normalized);
});

export default i18n;
