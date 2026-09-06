import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zh from './locales/zh.json';
import { persistLanguage, resolveInitialLanguage, syncDocumentLanguage } from './language';
export { LANGUAGE_STORAGE_KEY, normalizeLanguage, resolveInitialLanguage } from './language';

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
  persistLanguage(language);
  syncDocumentLanguage(language);
});

export default i18n;
