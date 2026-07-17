import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ReportSection } from '../../types';

interface Props {
  sections: ReportSection[];
  hrefBase?: string;
  language?: 'zh' | 'en';
}

export const ReportToc = React.memo(function ReportToc({ sections, hrefBase, language }: Props) {
  const { t, i18n } = useTranslation();
  const contentLanguage = language ?? (i18n.language.startsWith('zh') ? 'zh' : 'en');

  if (sections.length === 0) return null;

  return (
    <nav
      className="report-toc report-reveal report-d2"
      aria-label={t('result.report.toc')}
    >
      <div className="report-toc__head">
        <span>{t('result.report.tocTitle')}</span>
        <span className="report-toc__count">
          {t('result.report.tocCount', { count: sections.length })}
        </span>
      </div>
      <div className="report-toc__grid">
        {sections.map((section, index) => (
          <a
            key={section.id}
            href={hrefBase ? `${hrefBase}#report-section-${section.id}` : `#report-section-${section.id}`}
            className="report-toc__item"
          >
            <span className="report-toc__num" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
            <span className="report-toc__title">
              {section.title_i18n[contentLanguage] || section.title}
            </span>
          </a>
        ))}
      </div>
    </nav>
  );
});
