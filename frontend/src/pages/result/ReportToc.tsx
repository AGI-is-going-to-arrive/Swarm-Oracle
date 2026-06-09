import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ReportSection } from '../../types';

interface Props {
  sections: ReportSection[];
}

export const ReportToc = React.memo(function ReportToc({ sections }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  if (sections.length === 0) return null;

  return (
    <nav
      className="report-toc mb-8 p-4 bg-[color:var(--bg-hover)] rounded-lg border border-[color:var(--border-subtle)] forced-colors:border"
      aria-label={t('result.report.toc')}
    >
      <h3 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--text-secondary)] mb-3">
        {t('result.report.tocTitle')}
      </h3>
      <ul className="space-y-2">
        {sections.map((section, index) => (
          <li key={section.id}>
            <a
              href={`#report-section-${section.id}`}
              className="text-[color:var(--color-primary)] hover:text-[color:var(--color-primary-dim)] hover:underline flex items-center focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)] rounded"
            >
              <span className="w-6 text-[color:var(--text-muted)] font-mono text-sm">{index + 1}.</span>
              <span>{isZh ? section.title_i18n.zh || section.title : section.title_i18n.en || section.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
});
