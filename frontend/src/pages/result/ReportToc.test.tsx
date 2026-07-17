import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReportToc } from './ReportToc';
import type { ReportSection } from '../../types';

const mockSections: ReportSection[] = [
  {
    id: 'sec-1',
    title: 'Section One',
    title_i18n: { zh: '章节一', en: 'Section One' },
    intent: '',
    body_md_i18n: { zh: '', en: '' },
    evidence_refs: [],
    charts: [],
  },
  {
    id: 'sec-2',
    title: 'Section Two',
    title_i18n: { zh: '章节二', en: 'Section Two' },
    intent: '',
    body_md_i18n: { zh: '', en: '' },
    evidence_refs: [],
    charts: [],
  },
];

describe('ReportToc Component', () => {
  it('renders standard relative anchors when hrefBase is not provided', () => {
    render(<ReportToc sections={mockSections} />);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);

    expect(links[0]).toHaveAttribute('href', '#report-section-sec-1');
    expect(links[1]).toHaveAttribute('href', '#report-section-sec-2');
  });

  it('renders cross-route deep links when hrefBase is provided', () => {
    render(<ReportToc sections={mockSections} hrefBase="/result/123/report" />);

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);

    expect(links[0]).toHaveAttribute('href', '/result/123/report#report-section-sec-1');
    expect(links[1]).toHaveAttribute('href', '/result/123/report#report-section-sec-2');
  });

  it('uses an explicit report content language instead of the UI locale', () => {
    render(<ReportToc sections={mockSections} language="zh" />);

    expect(screen.getByText('章节一')).toBeInTheDocument();
    expect(screen.getByText('章节二')).toBeInTheDocument();
    expect(screen.queryByText('Section One')).toBeNull();
    expect(screen.queryByText('Section Two')).toBeNull();
  });
});
