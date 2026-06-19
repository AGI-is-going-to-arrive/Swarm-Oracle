/* ═══════════════════════════════════════════════════════════
   LanguageSwitcher — Global EN/ZH toggle (fixed bottom-right)
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';
import { normalizeLanguage } from '../i18n/config';

// Data-driven language list. Keeping the switcher two-state (zh/en) on purpose;
// to add a language later, append an entry here rather than hand-writing buttons.
const LANGUAGES: ReadonlyArray<{
  code: 'en' | 'zh';
  lang: string;
  short: string;
  labelKey: string;
  labelFallback: string;
}> = [
  { code: 'en', lang: 'en', short: 'EN', labelKey: 'common.switch_to_english', labelFallback: 'Switch language to English' },
  { code: 'zh', lang: 'zh', short: '中文', labelKey: 'common.switch_to_chinese', labelFallback: 'Switch language to Chinese' },
];

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  // Positive detection: derive the current language from the active i18n value
  // and compare each option directly (no fragile "not English" inversion).
  const current = normalizeLanguage(i18n.language);

  return (
    <div
      className="lang-switch lang-switch--global"
      role="group"
      aria-label={t('common.language_switcher', 'Language switcher')}
    >
      {LANGUAGES.map((language) => {
        const active = current === language.code;
        const label = `${language.short} ${t(language.labelKey, language.labelFallback)}`;
        return (
          <button
            key={language.code}
            type="button"
            lang={language.lang}
            aria-pressed={active}
            aria-label={label}
            title={label}
            className={`lang-switch__opt ${active ? 'lang-switch__opt--active' : ''}`}
            onClick={() => i18n.changeLanguage(language.code)}
          >
            {language.short}
          </button>
        );
      })}
    </div>
  );
}
