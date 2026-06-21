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
  'result.report.confidence_basis_recomposed': 'Recomposed: {{branchCount}} branches, {{evidenceCount}} evidence, {{agentConsensus}} consensus',
  'result.report.intervalLabel': '[L10N intervalLabel]',
  'result.report.interval_unavailable': '[L10N interval unavailable]',
  'result.report.hedge_branch_single': '[L10N single-branch]',
  'result.report.hedge_branch_multi': '[L10N {{count}}-branch]',
  'result.report.hedge_agents_aligned': '[L10N agents-aligned]',
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
    // Localized level word is shown (meter value + tick scale); the raw enum "high" must NOT leak.
    expect(screen.getAllByText('[L10N high]').length).toBeGreaterThan(0);
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
    // The likelihood row still renders (hero stat band), just without a WEP chip.
    expect(container.querySelector('.report-hero')).not.toBeNull();
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
    // Appears in the meter value and the tick scale; raw enum "low" must NOT leak.
    expect(screen.getAllByText('[L10N low]').length).toBeGreaterThan(0);
    expect(screen.queryByText('low')).toBeNull();
  });

  it('prefers basis_i18n translation when present', () => {
    render(
      <ReportConfidenceBadge
        verdict={makeVerdict({
          analytic_confidence: {
            level: 'medium',
            basis: 'legacy basis fallback',
            basis_i18n: { zh: '中文基础', en: 'English basis' },
          },
        })}
      />,
    );
    expect(screen.getByText('English basis')).toBeInTheDocument();
    expect(screen.queryByText('legacy basis fallback')).toBeNull();
  });

  it('recomposes legacy debug-pattern basis string client-side', () => {
    render(
      <ReportConfidenceBadge
        verdict={makeVerdict({
          analytic_confidence: {
            level: 'medium',
            basis: 'branch_count=12; evidence_count=5; agent_consensus=1.0000 (available)',
          },
        })}
      />,
    );
    expect(screen.getByText(/Recomposed: 12 branches, 5 evidence, 1\.0000 consensus/)).toBeInTheDocument();
  });

  it('renders arbitrary custom basis verbatim', () => {
    render(
      <ReportConfidenceBadge
        verdict={makeVerdict({
          analytic_confidence: {
            level: 'medium',
            basis: 'Arbitrary custom explanation',
          },
        })}
      />,
    );
    expect(screen.getByText('Arbitrary custom explanation')).toBeInTheDocument();
  });

  // ── §E display guard: honest degradation, never silent clamp ──────────────
  it('renders a legal interval as a numeric range (extremes like [0.9, 1.0] are valid)', () => {
    render(
      <ReportConfidenceBadge
        verdict={makeVerdict({ likelihood: { probability: 1.0, interval: [0.9, 1.0], wep: 'almost_certain' } })}
      />,
    );
    // The legal range renders verbatim; the qualitative fallback must NOT appear.
    expect(screen.getByText(/\(90\.0%, 100\.0%\)/)).toBeInTheDocument();
    expect(screen.queryByText('[L10N interval unavailable]')).toBeNull();
  });

  it('renders probability=1.0 (a legal extreme) as a number, never an em-dash', () => {
    const { container } = render(
      <ReportConfidenceBadge
        verdict={makeVerdict({ likelihood: { probability: 1.0, interval: [0.9, 1.0], wep: 'almost_certain' } })}
      />,
    );
    const pct = container.querySelector('.report-hero__pct');
    expect(pct?.textContent).toContain('100.0');
    expect(pct?.textContent).not.toContain('—');
  });

  it('degrades a reversed/out-of-range interval (the 195% bug) to a qualitative band, never clamps', () => {
    render(
      <ReportConfidenceBadge
        // The stale-data shape behind the "(195%, 100%)" screenshot: reversed + out of range.
        verdict={makeVerdict({ likelihood: { probability: 1.0, interval: [1.95, 1.0], wep: 'almost_certain' } })}
      />,
    );
    // No fabricated numeric range; the honest qualitative band is shown instead.
    expect(screen.getByText('[L10N interval unavailable]')).toBeInTheDocument();
    expect(screen.queryByText(/195/)).toBeNull();
    expect(screen.queryByText(/\(195\.0%, 100\.0%\)/)).toBeNull();
  });

  it('degrades a non-finite interval bound to the qualitative band', () => {
    render(
      <ReportConfidenceBadge
        verdict={makeVerdict({ likelihood: { probability: 0.5, interval: [Number.NaN, 0.6], wep: 'roughly_even' } })}
      />,
    );
    expect(screen.getByText('[L10N interval unavailable]')).toBeInTheDocument();
  });

  it('renders an em-dash for a non-finite / out-of-range probability', () => {
    const { container } = render(
      <ReportConfidenceBadge
        verdict={makeVerdict({ likelihood: { probability: 1.95, interval: [0.9, 1.0], wep: 'almost_certain' } })}
      />,
    );
    const pct = container.querySelector('.report-hero__pct');
    expect(pct?.textContent).toContain('—');
    expect(pct?.textContent).not.toContain('195');
  });

  // ── §F honest hedge: derived from real basis, never a fabricated "single-branch" claim ──
  it('derives a multi-branch hedge from basis (never falsely claims single-branch)', () => {
    render(
      <ReportConfidenceBadge
        verdict={makeVerdict({
          analytic_confidence: {
            level: 'high',
            basis: 'branch_count=12; evidence_count=5; agent_consensus=1.0000 (available)',
          },
        })}
      />,
    );
    expect(screen.getByText(/\[L10N 12-branch\]/)).toBeInTheDocument();
    expect(screen.getByText(/\[L10N agents-aligned\]/)).toBeInTheDocument();
    expect(screen.queryByText(/\[L10N single-branch\]/)).toBeNull();
  });

  it('shows the single-branch hedge only when basis reports exactly one branch', () => {
    render(
      <ReportConfidenceBadge
        verdict={makeVerdict({
          analytic_confidence: {
            level: 'high',
            basis: 'branch_count=1; evidence_count=2; agent_consensus=1.0000',
          },
        })}
      />,
    );
    expect(screen.getByText(/\[L10N single-branch\]/)).toBeInTheDocument();
  });

  it('omits the "agents aligned" claim when consensus is low', () => {
    render(
      <ReportConfidenceBadge
        verdict={makeVerdict({
          analytic_confidence: {
            level: 'low',
            basis: 'branch_count=3; evidence_count=2; agent_consensus=0.2000',
          },
        })}
      />,
    );
    expect(screen.getByText(/\[L10N 3-branch\]/)).toBeInTheDocument();
    expect(screen.queryByText(/\[L10N agents-aligned\]/)).toBeNull();
  });

  it('does not round a sub-60% consensus up to "agents aligned" (59.5% stays unaligned)', () => {
    render(
      <ReportConfidenceBadge
        verdict={makeVerdict({
          analytic_confidence: {
            level: 'medium',
            basis: 'branch_count=3; evidence_count=2; agent_consensus=0.5950 (available)',
          },
        })}
      />,
    );
    expect(screen.getByText(/\[L10N 3-branch\]/)).toBeInTheDocument();
    expect(screen.queryByText(/\[L10N agents-aligned\]/)).toBeNull();
  });

  it('claims "agents aligned" at exactly 60% raw consensus', () => {
    render(
      <ReportConfidenceBadge
        verdict={makeVerdict({
          analytic_confidence: {
            level: 'high',
            basis: 'branch_count=3; evidence_count=2; agent_consensus=0.6000 (available)',
          },
        })}
      />,
    );
    expect(screen.getByText(/\[L10N agents-aligned\]/)).toBeInTheDocument();
  });

  it('renders no hedge when the basis has no parseable branch count', () => {
    const { container } = render(
      <ReportConfidenceBadge verdict={makeVerdict({ analytic_confidence: { level: 'medium', basis: 'Freeform note.' } })} />,
    );
    expect(container.querySelector('.report-hero__hedge')).toBeNull();
  });
});
