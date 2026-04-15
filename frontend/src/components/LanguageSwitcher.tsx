/* ═══════════════════════════════════════════════════════════
   LanguageSwitcher — Global EN/ZH toggle (fixed bottom-right)
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();

  return (
    <div
      className="lang-switch lang-switch--global"
      role="group"
      aria-label={t('common.language_switcher', 'Language switcher')}
    >
      <button
        type="button"
        lang="en"
        aria-pressed={i18n.language.startsWith('en')}
        aria-label={t('common.switch_to_english', 'Switch language to English')}
        title={t('common.switch_to_english', 'Switch language to English')}
        className={`lang-switch__opt ${i18n.language.startsWith('en') ? 'lang-switch__opt--active' : ''}`}
        onClick={() => i18n.changeLanguage('en')}
      >
        EN
      </button>
      <button
        type="button"
        lang="zh-CN"
        aria-pressed={!i18n.language.startsWith('en')}
        aria-label={t('common.switch_to_chinese', 'Switch language to Chinese')}
        title={t('common.switch_to_chinese', 'Switch language to Chinese')}
        className={`lang-switch__opt ${!i18n.language.startsWith('en') ? 'lang-switch__opt--active' : ''}`}
        onClick={() => i18n.changeLanguage('zh')}
      >
        中文
      </button>
    </div>
  );
}
