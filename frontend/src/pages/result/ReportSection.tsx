import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SafeMarkdown } from '../../components/SafeMarkdown';
import type { ReportSection as ReportSectionType } from '../../types';
import { ReportChartRenderer } from './ReportCharts';

interface Props {
  section: ReportSectionType;
  onOpenEvidence: (refs: string[]) => void;
  index: number;
}

// The page owns <h1>, the report panel owns <h2>, section titles are <h3>; demote any
// markdown headings to <h4> so the chapter body never hijacks the page heading hierarchy.
function demoteHeadings(md: string): string {
  if (!md) return '';
  return md.replace(/^#{1,3}\s/gm, '#### ');
}

export const ReportSection = React.memo(function ReportSection({ section, onOpenEvidence, index }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const title = isZh ? section.title_i18n.zh || section.title : section.title_i18n.en || section.title;
  const content = useMemo(() => {
    const raw = isZh ? section.body_md_i18n.zh || '' : section.body_md_i18n.en || '';
    return demoteHeadings(raw);
  }, [isZh, section.body_md_i18n.zh, section.body_md_i18n.en]);

  return (
    <section
      id={`report-section-${section.id}`}
      className="report-section mb-10 pb-6 border-b border-[color:var(--border-subtle)] last:border-b-0"
    >
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-end items-start gap-3 mb-4">
        <h3 className="text-xl font-bold text-[color:var(--text-primary)] break-words [overflow-wrap:anywhere]">
          <span className="text-[color:var(--text-muted)] mr-2">{index + 1}.</span>
          {title}
        </h3>
        {section.evidence_refs && section.evidence_refs.length > 0 && (
          <button
            type="button"
            onClick={() => onOpenEvidence(section.evidence_refs)}
            className="text-sm px-3 py-1.5 rounded-md bg-[color:var(--bg-hover)] hover:bg-[color:var(--bg-deep)] text-[color:var(--color-primary)] border border-[color:var(--border-default)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-ring)] transition-colors motion-reduce:transition-none shrink-0"
            aria-label={t('result.report.viewCitedEvidence')}
          >
            {t('result.report.viewEvidence')}
            <span className="ml-1.5 inline-flex items-center justify-center bg-[color:var(--color-primary-glow)] rounded-full px-1.5 text-xs font-mono">
              {section.evidence_refs.length}
            </span>
          </button>
        )}
      </div>
      <div className="prose prose-sm md:prose-base max-w-none text-[color:var(--text-secondary)] break-words [overflow-wrap:anywhere]">
        <SafeMarkdown>{content}</SafeMarkdown>
      </div>
      {section.charts && section.charts.length > 0 && (
        <div className="space-y-4 mt-4">
          {section.charts.map((chart, idx) => (
            <ReportChartRenderer key={idx} chart={chart} />
          ))}
        </div>
      )}
    </section>
  );
});
