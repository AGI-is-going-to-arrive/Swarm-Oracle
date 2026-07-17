import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReportSection } from './ReportSection';
import type { ReportSection as ReportSectionType, ReportChart } from '../../types';

const I18N: Record<string, string> = {
  'result.report.viewCitedEvidence': '[L10N view cited evidence]',
  'result.report.sectionTier.generation': '[L10N generated source]',
  'result.report.sectionTier.rewrite': '[L10N rewritten source]',
  'result.report.sectionTier.static': '[L10N static fallback source]',
  'result.report.sectionFailureReason.timeout': '[L10N section timeout]',
  'result.report.sectionFailureReason.tool_floor_not_met': '[L10N tool floor not met]',
  'result.report.sectionFailureReason.empty_outline': '[L10N empty outline]',
  'result.report.sectionFailureReason.json_parse_error': '[L10N invalid generated section]',
  'result.report.sectionFailureReason.plan_outline_timeout': '[L10N outline planning timeout]',
  'result.report.sectionFailureReason.unsupported_action': '[L10N unsupported action]',
  'result.report.sectionFailureReason.tool_budget_exhausted': '[L10N tool budget exhausted]',
  'result.report.sectionFailureReason.empty_body': '[L10N empty generated section]',
  'result.report.sectionFailureReason.other': '[L10N other fallback reason]',
  'result.report.chartEmpty': '[L10N chartEmpty]',
  'result.report.probabilityChartTitle': '[L10N simulated branch distribution]',
  'result.report.probabilityChartNoComparison': '[L10N no branch comparison]',
  'result.report.factionChartTitle': '[L10N factionChartTitle]',
  'result.report.dominantBranch': '[L10N dominant simulated path]',
  'result.report.factionMembers': '{{count}} members',
  'result.report.factionRelations': 'Affect-proxy links: {{count}}',
  'result.report.factionOpposition': 'Avg. affect distance: {{value}}',
  'result.report.factionOppositionNone': 'Avg. affect distance: n/a',
  'result.report.chartUnavailable': '[L10N chartUnavailable]',
  'result.report.chartEmptyReason.no_branches': 'No completed branches to chart yet.',
  'result.report.chartEmptyReason.feature_disabled': "This chart's data source is turned off.",
  'result.report.chartEmptyReason.no_faction_snapshots': 'No faction snapshots were captured for this run.',
  'result.report.chartEmptyReason.empty_faction_membership': 'No faction membership data is available yet.',
  'result.report.chartEmptyReason.relation_edges_missing': 'Faction relationship data is incomplete.',
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
    // Editorial skin renders a zero-padded hanging section number.
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('Test Section')).toBeInTheDocument();
    expect(screen.getByText('This is content')).toBeInTheDocument();
  });

  it('uses an explicit report content language instead of the UI locale', () => {
    render(
      <ReportSection
        section={baseSection}
        onOpenEvidence={mockOnOpenEvidence}
        index={0}
        language="zh"
      />,
    );

    expect(screen.getByText('测试章节')).toBeInTheDocument();
    expect(screen.getByText('这是内容')).toBeInTheDocument();
    expect(screen.queryByText('Test Section')).toBeNull();
    expect(screen.queryByText('This is content')).toBeNull();
  });

  it.each([
    ['generation', '[L10N generated source]'],
    ['rewrite', '[L10N rewritten source]'],
    ['static', '[L10N static fallback source]'],
  ] as const)('renders the %s source tier as a localized chip', (tier, localizedLabel) => {
    render(
      <ReportSection
        section={{ ...baseSection, tier }}
        onOpenEvidence={mockOnOpenEvidence}
        index={0}
      />,
    );

    expect(screen.getByText(localizedLabel)).toBeInTheDocument();
    expect(screen.queryByText(tier)).not.toBeInTheDocument();
  });

  it.each([
    ['timeout', '[L10N section timeout]'],
    ['tool_floor_not_met', '[L10N tool floor not met]'],
    ['empty_outline', '[L10N empty outline]'],
    ['json_parse_error', '[L10N invalid generated section]'],
    ['plan_outline_timeout', '[L10N outline planning timeout]'],
    ['unsupported_action', '[L10N unsupported action]'],
    ['tool_budget_exhausted', '[L10N tool budget exhausted]'],
    ['empty_body', '[L10N empty generated section]'],
    ['other', '[L10N other fallback reason]'],
  ] as const)('maps the %s failure reason through localized whitelist copy', (failureReason, localizedLabel) => {
    render(
      <ReportSection
        section={{ ...baseSection, tier: 'static', failure_reason: failureReason }}
        onOpenEvidence={mockOnOpenEvidence}
        index={0}
      />,
    );

    expect(screen.getByText(localizedLabel)).toBeInTheDocument();
    expect(screen.queryByText(failureReason)).not.toBeInTheDocument();
  });

  it('maps an unknown failure reason to other without rendering provider text', () => {
    const rawProviderReason = 'provider stack: upstream secret detail';
    const untrustedSection = {
      ...baseSection,
      tier: 'static',
      failure_reason: rawProviderReason,
    } as unknown as ReportSectionType;

    render(<ReportSection section={untrustedSection} onOpenEvidence={mockOnOpenEvidence} index={0} />);

    expect(screen.getByText('[L10N other fallback reason]')).toBeInTheDocument();
    expect(screen.queryByText(rawProviderReason)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('upstream secret detail');
  });

  it('keeps analytic content and the evidence drawer trigger with fallback metadata', () => {
    const onOpenEvidence = vi.fn();
    render(
      <ReportSection
        section={{
          ...baseSection,
          tier: 'static',
          failure_reason: 'timeout',
          evidence_refs: ['evidence-1', 'evidence-2'],
        }}
        onOpenEvidence={onOpenEvidence}
        index={0}
      />,
    );

    expect(screen.getByText('This is content')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '[L10N view cited evidence]' }));
    expect(onOpenEvidence).toHaveBeenCalledWith(['evidence-1', 'evidence-2']);
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
    expect(screen.getByText('[L10N simulated branch distribution]')).toBeInTheDocument();

    // Assert a11y label for dominant branch is rendered in screen-reader text
    expect(screen.getByText('[L10N dominant simulated path]')).toBeInTheDocument();
  });

  it('renders only a localized no-comparison message for a single-path chart', () => {
    const singlePathChart: ReportChart = {
      kind: 'probability_bar',
      type: 'probability_bar',
      data: {
        status: 'available',
        reason: null,
        sort: ['branch-only'],
        branches: [
          {
            branch_id: 'branch-only',
            label: 'Only Branch',
            probability: 1,
            dominant: true,
            status: 'COMPLETED',
          },
        ],
      },
    };

    const section = { ...baseSection, charts: [singlePathChart] };
    const { container } = render(
      <ReportSection section={section} onOpenEvidence={mockOnOpenEvidence} index={0} />,
    );

    expect(screen.getByText('[L10N no branch comparison]')).toBeInTheDocument();
    expect(screen.queryByText('Only Branch')).toBeNull();
    expect(screen.queryByText('100%')).toBeNull();
    expect(container.querySelector('.report-chart__row')).toBeNull();
    expect(container.querySelector('.bar-track')).toBeNull();
  });

  it('does not infer a single path from probability=1 when multiple branches exist', () => {
    const multiPathChart: ReportChart = {
      kind: 'probability_bar',
      type: 'probability_bar',
      data: {
        status: 'available',
        reason: null,
        sort: ['branch-a', 'branch-b'],
        branches: [
          {
            branch_id: 'branch-a',
            label: 'Dominant Branch',
            probability: 1,
            dominant: true,
            status: 'COMPLETED',
          },
          {
            branch_id: 'branch-b',
            label: 'Other Branch',
            probability: 0,
            dominant: false,
            status: 'COMPLETED',
          },
        ],
      },
    };

    const section = { ...baseSection, charts: [multiPathChart] };
    render(<ReportSection section={section} onOpenEvidence={mockOnOpenEvidence} index={0} />);

    expect(screen.getByText('[L10N simulated branch distribution]')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.queryByText('[L10N no branch comparison]')).toBeNull();
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
    expect(screen.getByText('Affect-proxy links: 12')).toBeInTheDocument();
    expect(screen.getByText('Avg. affect distance: 0.45')).toBeInTheDocument();
    expect(screen.queryByText('Relationship links: 12')).not.toBeInTheDocument();
    expect(screen.queryByText('Avg. opposition: 0.45')).not.toBeInTheDocument();
  });

  it('renders known-type chart with missing/empty data using empty-state line', () => {
    const emptyChart: ReportChart = {
      kind: 'probability_bar',
      type: 'probability_bar',
      data: {
        status: 'missing',
        reason: 'no_faction_snapshots',
        sort: [],
        branches: [],
      },
    };

    const section = { ...baseSection, charts: [emptyChart] };
    render(<ReportSection section={section} onOpenEvidence={mockOnOpenEvidence} index={0} />);

    // Assert reason is rendered as localized text, the raw code is NOT in the document, and NO chartUnavailable is shown
    expect(screen.getByText('No faction snapshots were captured for this run.')).toBeInTheDocument();
    expect(screen.queryByText('no_faction_snapshots')).not.toBeInTheDocument();
    expect(screen.queryByText('[L10N chartUnavailable]')).not.toBeInTheDocument();
  });

  it('renders known-type chart with unknown/unrecognized reason using generic fallback', () => {
    const emptyChart: ReportChart = {
      kind: 'probability_bar',
      type: 'probability_bar',
      data: {
        status: 'missing',
        reason: 'some_unknown_reason_code',
        sort: [],
        branches: [],
      },
    };

    const section = { ...baseSection, charts: [emptyChart] };
    render(<ReportSection section={section} onOpenEvidence={mockOnOpenEvidence} index={0} />);

    // Assert it falls back to generic chartEmpty and the raw reason code is NOT in the document
    expect(screen.getByText('[L10N chartEmpty]')).toBeInTheDocument();
    expect(screen.queryByText('some_unknown_reason_code')).not.toBeInTheDocument();
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

    // Expect it to render chartUnavailable
    expect(screen.getByText('[L10N chartUnavailable]')).toBeInTheDocument();
    expect(screen.queryByText('[L10N chartEmpty]')).not.toBeInTheDocument();
  });

  it('renders chartUnavailable placeholder for known chart types with malformed data', () => {
    // 1. probability_bar type missing branches array
    const malformedProbChart: ReportChart = JSON.parse(
      JSON.stringify({
        kind: 'probability_bar',
        type: 'probability_bar',
        data: {
          status: 'available',
          reason: null,
          sort: [],
        },
      })
    );

    const section1 = { ...baseSection, charts: [malformedProbChart] };
    const { unmount } = render(<ReportSection section={section1} onOpenEvidence={mockOnOpenEvidence} index={0} />);
    expect(screen.getByText('[L10N chartUnavailable]')).toBeInTheDocument();
    unmount();

    // 2. faction_share type missing factions array
    const malformedFactionChart: ReportChart = JSON.parse(
      JSON.stringify({
        kind: 'faction_share',
        type: 'faction_share',
        data: {
          status: 'available',
          reason: null,
          relation_edge_count: 5,
          avg_opposition: 0.1,
        },
      })
    );

    const section2 = { ...baseSection, charts: [malformedFactionChart] };
    render(<ReportSection section={section2} onOpenEvidence={mockOnOpenEvidence} index={0} />);
    expect(screen.getByText('[L10N chartUnavailable]')).toBeInTheDocument();
  });

  it('strips a leading body heading that duplicates the section title', () => {
    const section = {
      ...baseSection,
      body_md_i18n: { zh: '## 测试章节\n\n正文内容。', en: '## Test Section\n\nActual body text.' },
    };
    render(<ReportSection section={section} onOpenEvidence={mockOnOpenEvidence} index={0} />);
    // The section title <h3> is the ONLY "Test Section" — the redundant leading
    // markdown heading in the body is stripped so it does not render a duplicate.
    expect(screen.getAllByText('Test Section')).toHaveLength(1);
    expect(screen.getByText('Actual body text.')).toBeInTheDocument();
  });

  it('keeps a leading body heading that does not match the section title', () => {
    const section = {
      ...baseSection,
      body_md_i18n: { zh: '## 别的标题\n\n正文。', en: '## Different Heading\n\nBody copy.' },
    };
    render(<ReportSection section={section} onOpenEvidence={mockOnOpenEvidence} index={0} />);
    expect(screen.getByText('Test Section')).toBeInTheDocument(); // the section title
    expect(screen.getByText('Different Heading')).toBeInTheDocument(); // a genuine heading is preserved
    expect(screen.getByText('Body copy.')).toBeInTheDocument();
  });
});
