import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../i18n/locales/en.json';
import zh from '../i18n/locales/zh.json';
import { persistLanguage, resolveInitialLanguage, syncDocumentLanguage } from '../i18n/language';

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
