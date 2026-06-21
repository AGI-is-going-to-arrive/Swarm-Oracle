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

// The section already renders its title as an <h3>; some persisted body_md repeat that
// title as a leading markdown heading, which would render a duplicate heading right under
// the section title (off-spec vs the mockup). Strip ONLY a leading heading whose text
// matches the section title — legitimate sub-headings or a different leading heading stay.
function normalizeHeadingText(s: string): string {
  return s.replace(/[\s#*_`：:。.,，、]/g, '').toLowerCase();
}
function stripRedundantLeadingTitle(md: string, title: string): string {
  if (!md || !title) return md || '';
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (i >= lines.length) return md;
  const headingMatch = lines[i].trim().match(/^#{1,6}\s+(.*)$/);
  if (headingMatch && normalizeHeadingText(headingMatch[1]) === normalizeHeadingText(title)) {
    lines.splice(i, 1);
    if (i < lines.length && lines[i].trim() === '') lines.splice(i, 1);
    return lines.join('\n');
  }
  return md;
}

export const ReportSection = React.memo(function ReportSection({ section, onOpenEvidence, index }: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const title = isZh ? section.title_i18n.zh || section.title : section.title_i18n.en || section.title;
  const content = useMemo(() => {
    const raw = isZh ? section.body_md_i18n.zh || '' : section.body_md_i18n.en || '';
    return demoteHeadings(stripRedundantLeadingTitle(raw, title));
  }, [isZh, section.body_md_i18n.zh, section.body_md_i18n.en, title]);

  const sectionNumber = String(index + 1).padStart(2, '0');

  return (
    <section
      id={`report-section-${section.id}`}
      className="report-section"
    >
      <div className="report-section__head">
        <span className="report-section__id" aria-hidden="true">{sectionNumber}</span>
        <h3 className="report-section__title">
          {title}
        </h3>
        {/* WIRE: Evidence · N → opens the evidence drawer (hidden when no refs). */}
        {section.evidence_refs && section.evidence_refs.length > 0 && (
          <button
            type="button"
            onClick={() => onOpenEvidence(section.evidence_refs)}
            className="report-section__evidence-btn"
            aria-label={t('result.report.viewCitedEvidence')}
          >
            {t('result.report.evidenceLabelShort', 'Evidence')}
            <span className="report-section__evidence-n">· {section.evidence_refs.length}</span>
          </button>
        )}
      </div>
      <div className="prose max-w-none break-words [overflow-wrap:anywhere]">
        <SafeMarkdown>{content}</SafeMarkdown>
      </div>
      {/* KEEP: probability_bar / faction_share charts (with their own empty states). */}
      {section.charts && section.charts.length > 0 && (
        <div className="report-section__charts">
          {section.charts.map((chart, idx) => (
            <ReportChartRenderer key={idx} chart={chart} />
          ))}
        </div>
      )}
    </section>
  );
});
