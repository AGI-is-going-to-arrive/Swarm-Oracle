import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReportSection } from './ReportSection';
import type { ReportSection as ReportSectionType, ReportChart } from '../../types';

const I18N: Record<string, string> = {
  'result.report.chartEmpty': '[L10N chartEmpty]',
  'result.report.probabilityChartTitle': '[L10N probabilityChartTitle]',
  'result.report.factionChartTitle': '[L10N factionChartTitle]',
  'result.report.dominantBranch': '[L10N dominantBranch]',
  'result.report.factionMembers': '{{count}} members',
  'result.report.factionRelations': 'Relationship links: {{count}}',
  'result.report.factionOpposition': 'Avg. opposition: {{value}}',
  'result.report.factionOppositionNone': 'Avg. opposition: n/a',
  'result.report.chartUnavailable': '[L10N chartUnavailable]',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, arg2?: unknown) => {
      let val = I18N[key];
      if (!val) {
        if (typeof arg2 === 'string') return arg2;
        if (arg2 && typeof arg2 === 'object' && 'defaultValue' in arg2) {
          const opt = arg2 as { defaultValue?: string };
          if (opt.defaultValue) return opt.defaultValue;
        }
        return key;
      }
      if (arg2 && typeof arg2 === 'object') {
        const obj = arg2 as Record<string, unknown>;
        Object.entries(obj).forEach(([k, v]) => {
          val = val.replace(`{{${k}}}`, String(v));
        });
      }
      return val;
    },
    i18n: { language: 'en' },
  }),
}));

describe('ReportSection', () => {
  const mockOnOpenEvidence = vi.fn();

  const baseSection: ReportSectionType = {
    id: 'sec-1',
    title: 'Test Section',
    title_i18n: { zh: '测试章节', en: 'Test Section' },
    intent: 'testing stuff',
    body_md_i18n: { zh: '这是内容', en: 'This is content' },
    evidence_refs: [],
    charts: [],
  };

  it('renders section title and markdown body', () => {
    render(<ReportSection section={baseSection} onOpenEvidence={mockOnOpenEvidence} index={0} />);
    expect(screen.getByText('1.')).toBeInTheDocument();
    expect(screen.getByText('Test Section')).toBeInTheDocument();
    expect(screen.getByText('This is content')).toBeInTheDocument();
  });

  it('renders populated probability_bar chart correctly', () => {
    const probabilityChart: ReportChart = {
      kind: 'probability_bar',
      type: 'probability_bar',
      data: {
        status: 'available',
        reason: null,
        sort: ['branch-a', 'branch-b'],
        branches: [
          {
            branch_id: 'branch-a',
            label: 'Branch A Label',
            probability: 0.62,
            dominant: true,
            status: 'COMPLETED',
          },
          {
            branch_id: 'branch-b',
            label: 'Branch B Label',
            probability: 0.38,
            dominant: false,
            status: 'COMPLETED',
          },
        ],
      },
    };

    const section = { ...baseSection, charts: [probabilityChart] };
    render(<ReportSection section={section} onOpenEvidence={mockOnOpenEvidence} index={0} />);

    // Assert branch labels and percentages appear
    expect(screen.getByText('Branch A Label')).toBeInTheDocument();
    expect(screen.getByText('62%')).toBeInTheDocument();
    expect(screen.getByText('Branch B Label')).toBeInTheDocument();
    expect(screen.getByText('38%')).toBeInTheDocument();

    // Assert a11y label for dominant branch is rendered in screen-reader text
    expect(screen.getByText('[L10N dominantBranch]')).toBeInTheDocument();
  });

  it('renders populated faction_share chart correctly', () => {
    const factionChart: ReportChart = {
      kind: 'faction_share',
      type: 'faction_share',
      data: {
        status: 'available',
        reason: null,
        factions: [
          {
            faction_key: 'faction-1',
            label: 'Faction One Label',
            member_count: 5,
            share: 0.75,
            stance_center: 0.8,
            confidence: 0.9,
          },
        ],
        relation_edge_count: 12,
        avg_opposition: 0.45,
      },
    };

    const section = { ...baseSection, charts: [factionChart] };
    render(<ReportSection section={section} onOpenEvidence={mockOnOpenEvidence} index={0} />);

    expect(screen.getByText('Faction One Label')).toBeInTheDocument();
    expect(screen.getByText('5 members (75%)')).toBeInTheDocument();
    expect(screen.getByText('Relationship links: 12')).toBeInTheDocument();
    expect(screen.getByText('Avg. opposition: 0.45')).toBeInTheDocument();
  });

  it('renders known-type chart with missing/empty data using empty-state line', () => {
    const emptyChart: ReportChart = {
      kind: 'probability_bar',
      type: 'probability_bar',
      data: {
        status: 'missing',
        reason: 'Missing data reason text',
        sort: [],
        branches: [],
      },
    };

    const section = { ...baseSection, charts: [emptyChart] };
    render(<ReportSection section={section} onOpenEvidence={mockOnOpenEvidence} index={0} />);

    // Assert reason is rendered, and NO chartUnavailable is shown
    expect(screen.getByText('Missing data reason text')).toBeInTheDocument();
    expect(screen.queryByText('[L10N chartUnavailable]')).not.toBeInTheDocument();
  });

  it('renders generic chartEmpty copy when known-type status is missing and reason is null', () => {
    const emptyChart: ReportChart = {
      kind: 'faction_share',
      type: 'faction_share',
      data: {
        status: 'missing',
        reason: null,
        factions: [],
        relation_edge_count: 0,
        avg_opposition: null,
      },
    };

    const section = { ...baseSection, charts: [emptyChart] };
    render(<ReportSection section={section} onOpenEvidence={mockOnOpenEvidence} index={0} />);

    expect(screen.getByText('[L10N chartEmpty]')).toBeInTheDocument();
    expect(screen.queryByText('[L10N chartUnavailable]')).not.toBeInTheDocument();
  });

  it('renders chartUnavailable placeholder for unknown chart type', () => {
    const unknownChart: ReportChart = {
      kind: 'future_chart',
      type: 'future_chart',
      data: {
        raw: [],
        note: '...',
      },
    };

    const section = { ...baseSection, charts: [unknownChart] };
    render(<ReportSection section={section} onOpenEvidence={mockOnOpenEvidence} index={0} />);

    expect(screen.getByText('[L10N chartUnavailable]')).toBeInTheDocument();
    expect(screen.queryByText('[L10N chartEmpty]')).not.toBeInTheDocument();
  });
});
