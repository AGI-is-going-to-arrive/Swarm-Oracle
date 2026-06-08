import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ReportConfidenceBadge } from './ReportConfidenceBadge';
import type { ReportVerdict } from '../../types';

// Map every i18n key to a recognizable localized string so the test can prove the
// component reads keys (never the raw enum / backend string).
const I18N: Record<string, string> = {
  'result.report.likelihood_label': '[L10N likelihood]',
  'result.report.analytic_confidence_label': '[L10N analytic confidence]',
  'result.report.confidence_level.high': '[L10N high]',
  'result.report.confidence_level.medium': '[L10N medium]',
  'result.report.confidence_level.low': '[L10N low]',
  'result.report.disclaimer': '[L10N disclaimer]',
  'result.report.wep.likely': '[L10N wep likely]',
  'result.report.wep.almost_certain': '[L10N wep almost_certain]',
  'result.report.wep.roughly_even': '[L10N wep roughly_even]',
  'result.report.wep.missing': '[L10N wep missing]',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => I18N[key] ?? fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

function makeVerdict(overrides: Partial<ReportVerdict> = {}): ReportVerdict {
  return {
    headline_answer: 'Yes, with caveats.',
    // Backend emits the snake_case word-estimate enum (e.g. `likely`).
    likelihood: { probability: 0.64, interval: [0.5, 0.78], wep: 'likely' },
    analytic_confidence: { level: 'medium', basis: 'Based on 12 evidence items.' },
    disclaimer: '',
    ...overrides,
  };
}

describe('ReportConfidenceBadge', () => {
  it('localizes labels and the confidence level word (never the raw enum)', () => {
    render(<ReportConfidenceBadge verdict={makeVerdict({ analytic_confidence: { level: 'high', basis: 'b' } })} />);

    expect(screen.getByText(/\[L10N likelihood\]/)).toBeInTheDocument();
    expect(screen.getByText(/\[L10N analytic confidence\]/)).toBeInTheDocument();
    // Localized level word is shown; the raw enum value "high" must NOT leak verbatim.
    expect(screen.getByText('[L10N high]')).toBeInTheDocument();
    expect(screen.queryByText('high')).toBeNull();
  });

  it('localizes the word-estimate (WEP) through result.report.wep.* (never the raw value)', () => {
    render(<ReportConfidenceBadge verdict={makeVerdict({ likelihood: { probability: 0.9, interval: [0.8, 1], wep: 'almost_certain' } })} />);
    expect(screen.getByText('[L10N wep almost_certain]')).toBeInTheDocument();
    // The raw backend enum string must NOT appear verbatim.
    expect(screen.queryByText('almost_certain')).toBeNull();
  });

  it('normalizes a display-cased WEP value to its locale key', () => {
    // Defensive: even if the backend ever sent "Roughly Even", it must resolve to the key.
    render(<ReportConfidenceBadge verdict={makeVerdict({ likelihood: { probability: 0.5, interval: [0.4, 0.6], wep: 'Roughly Even' } })} />);
    expect(screen.getByText('[L10N wep roughly_even]')).toBeInTheDocument();
    expect(screen.queryByText('Roughly Even')).toBeNull();
  });

  it('shows the neutral localized fallback for an unknown WEP value (no raw string)', () => {
    render(<ReportConfidenceBadge verdict={makeVerdict({ likelihood: { probability: 0.5, interval: [0.4, 0.6], wep: 'bogus_tier_xyz' } })} />);
    expect(screen.getByText('[L10N wep missing]')).toBeInTheDocument();
    expect(screen.queryByText('bogus_tier_xyz')).toBeNull();
  });

  it('omits the WEP chip entirely when the backend sends an empty value', () => {
    const { container } = render(
      <ReportConfidenceBadge verdict={makeVerdict({ likelihood: { probability: 0.5, interval: [0.4, 0.6], wep: '' } })} />,
    );
    expect(screen.queryByText('[L10N wep missing]')).toBeNull();
    // The likelihood row still renders, just without a WEP chip.
    expect(container.querySelector('.report-confidence-badge')).not.toBeNull();
  });

  it('shows a localized safe fallback for an unknown confidence level (never the raw value)', () => {
    render(
      <ReportConfidenceBadge
        verdict={makeVerdict({
          // Cast: simulate a backend value outside the typed enum.
          analytic_confidence: { level: 'unknown_level' as ReportVerdict['analytic_confidence']['level'], basis: 'b' },
        })}
      />,
    );
    expect(screen.getByText('[L10N wep missing]')).toBeInTheDocument();
    expect(screen.queryByText('unknown_level')).toBeNull();
  });

  it('falls back to the localized disclaimer when the verdict carries none', () => {
    render(<ReportConfidenceBadge verdict={makeVerdict({ disclaimer: '   ' })} />);
    expect(screen.getByText(/\[L10N disclaimer\]/)).toBeInTheDocument();
  });

  it('prefers a backend-authored disclaimer when present', () => {
    render(<ReportConfidenceBadge verdict={makeVerdict({ disclaimer: 'Scenario-specific caveat.' })} />);
    expect(screen.getByText(/Scenario-specific caveat\./)).toBeInTheDocument();
    expect(screen.queryByText(/\[L10N disclaimer\]/)).toBeNull();
  });

  it('localizes the low confidence level', () => {
    render(<ReportConfidenceBadge verdict={makeVerdict({ analytic_confidence: { level: 'low', basis: 'b' } })} />);
    expect(screen.getByText('[L10N low]')).toBeInTheDocument();
    expect(screen.queryByText('low')).toBeNull();
  });
});
