/* ═══════════════════════════════════════════════════════════
   LanguageSwitcher — Global EN/ZH toggle (fixed bottom-right)
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';

export function LanguageSwitcher() {
  const { i18n } = useTranslation();

  return (
    <div className="lang-switch lang-switch--global">
      <button
        className={`lang-switch__opt ${i18n.language.startsWith('en') ? 'lang-switch__opt--active' : ''}`}
        onClick={() => i18n.changeLanguage('en')}
      >
        En
      </button>
      <button
        className={`lang-switch__opt ${!i18n.language.startsWith('en') ? 'lang-switch__opt--active' : ''}`}
        onClick={() => i18n.changeLanguage('zh')}
      >
        中文
      </button>
    </div>
  );
}
