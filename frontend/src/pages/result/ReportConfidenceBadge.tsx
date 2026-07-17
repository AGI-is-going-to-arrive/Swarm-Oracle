import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ReportVerdict } from '../../types';
import { getReportDisclaimerText } from './reportDisclaimer';

interface Props {
  verdict: ReportVerdict;
  language?: 'zh' | 'en';
}

const CONFIDENCE_LEVEL_KEY: Record<ReportVerdict['analytic_confidence']['level'], string> = {
  high: 'result.report.confidence_level.high',
  medium: 'result.report.confidence_level.medium',
  low: 'result.report.confidence_level.low',
};

const CONFIDENCE_LEVEL_FALLBACK: Record<ReportVerdict['analytic_confidence']['level'], string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

// Displayable word-estimate values from `derive_likelihood_label`. The non-display
// `single_path` sentinel is handled separately below; any other value falls back to the
// neutral `missing` label so a raw backend string never leaks.
const KNOWN_WEP_KEYS = new Set([
  'almost_no_chance',
  'very_unlikely',
  'unlikely',
  'roughly_even',
  'likely',
  'very_likely',
  'almost_certain',
  'missing',
]);

const KNOWN_CONFIDENCE_LEVELS = new Set<string>(['high', 'medium', 'low']);

const CONFIDENCE_WEP_FALLBACK: Record<string, string> = {
  almost_no_chance: 'Almost No Chance',
  very_unlikely: 'Very Unlikely',
  unlikely: 'Unlikely',
  roughly_even: 'Roughly Even',
  likely: 'Likely',
  very_likely: 'Very Likely',
  almost_certain: 'Almost Certain',
  missing: 'Not Available',
};

// How many of the 3 meter segments are "reached" for each confidence level.
const CONFIDENCE_LEVEL_SEGMENTS: Record<ReportVerdict['analytic_confidence']['level'], number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * §E display guard. A probability is renderable only when finite and within [0, 1].
 * Legal extremes (0, 1) are valid — only non-finite / out-of-range values are rejected.
 */
function isRenderableProbability(probability: unknown): probability is number {
  return isFiniteNumber(probability) && probability >= 0 && probability <= 1;
}

/**
 * §E display guard. An interval is renderable only when it is a 2-tuple of finite numbers
 * with 0 <= low <= high <= 1. Anything else (non-array, wrong length, non-finite, out of
 * range, or reversed) is rejected — we NEVER silently clamp; we degrade to a qualitative
 * "no interval estimate" band instead. Legal extremes like [0.9, 1.0] pass.
 */
function isRenderableInterval(interval: unknown): interval is [number, number] {
  if (!Array.isArray(interval) || interval.length !== 2) return false;
  const [low, high] = interval;
  if (!isFiniteNumber(low) || !isFiniteNumber(high)) return false;
  if (low < 0 || high > 1) return false;
  if (low > high) return false;
  return true;
}

export const ReportConfidenceBadge = React.memo(function ReportConfidenceBadge({ verdict, language }: Props) {
  const { t, i18n } = useTranslation();
  const { likelihood, analytic_confidence, disclaimer } = verdict;

  // Localize the level word (never surface the raw enum). An unexpected/unknown level falls
  // back to the neutral localized "Not Available" label rather than leaking the machine value.
  const level = analytic_confidence.level;
  const isKnownLevel = KNOWN_CONFIDENCE_LEVELS.has(level);
  const levelLabel = isKnownLevel
    ? t(CONFIDENCE_LEVEL_KEY[level], CONFIDENCE_LEVEL_FALLBACK[level])
    : t('result.report.wep.missing', 'Not Available');
  const reachedSegments = isKnownLevel ? CONFIDENCE_LEVEL_SEGMENTS[level] : 0;

  // Localize displayable WEP values through `result.report.wep.*`. Normalize defensively
  // (the field is a free string in the type) and fall back to the neutral localized label
  // for any value outside the known set — never render the raw backend string.
  const normalizedWep = (likelihood.wep ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  let branchCountNum: number | null = null;
  if (analytic_confidence.basis) {
    const branchMatch = analytic_confidence.basis.match(/branch_count=(\d+)/);
    if (branchMatch) {
      const parsedBranches = Number.parseInt(branchMatch[1], 10);
      if (Number.isFinite(parsedBranches)) {
        branchCountNum = parsedBranches;
      }
    }
  }
  const statisticsSuppressed = normalizedWep === 'missing';
  const singlePath = !statisticsSuppressed
    && (normalizedWep === 'single_path' || branchCountNum === 1);
  const wepLabel = KNOWN_WEP_KEYS.has(normalizedWep)
    ? t(`result.report.wep.${normalizedWep}`, CONFIDENCE_WEP_FALLBACK[normalizedWep] ?? 'Not Available')
    : likelihood.wep
      ? t('result.report.wep.missing', 'Not Available')
      : '';

  // §E: probability / interval honest display guards. Stale/garbage data degrades to a
  // qualitative band or em-dash — it is never silently clamped into a fake range.
  // wep="missing" is the backend suppressed-statistics sentinel (no answer branch was
  // resolvable): its probability/interval are placeholders, not estimates — hide both.
  const probabilityRenderable =
    !singlePath && !statisticsSuppressed && isRenderableProbability(likelihood.probability);
  const probabilityText = probabilityRenderable
    ? (likelihood.probability * 100).toFixed(1)
    : '—';
  const intervalRenderable =
    !singlePath && !statisticsSuppressed && isRenderableInterval(likelihood.interval);

  // Prefer scenario-specific disclaimers, but localize legacy persisted boilerplate.
  // Kept as a tail footnote so the existing scenario-custom disclaimer path is preserved.
  const disclaimerText = getReportDisclaimerText(disclaimer, t);

  // §F: recompose the consensus / basis line WITH a denominator (N branches, N evidence,
  // agents-aligned). Parsed out of the machine basis string; falls back to localized
  // basis_i18n / raw basis when the structured form is absent.
  const currentLang = language ?? (i18n.language?.startsWith('zh') ? 'zh' : 'en');
  let displayBasis = '';
  let consensusPct: number | null = null;
  // Raw 0..1 consensus fraction for threshold checks (decoupled from the rounded display %).
  let consensusFraction: number | null = null;
  const basisI18n = analytic_confidence.basis_i18n;
  if (basisI18n) {
    if (language) {
      // An explicit language has already been checked against report availability.
      // Never bypass that decision by falling through to the unavailable locale;
      // the raw basis below is the bounded primary-language fallback.
      displayBasis = basisI18n[language] || '';
    } else if (currentLang === 'zh') {
      displayBasis = basisI18n.zh || basisI18n.en || '';
    } else {
      displayBasis = basisI18n.en || basisI18n.zh || '';
    }
  }
  if (analytic_confidence.basis) {
    const basisStr = analytic_confidence.basis;
    const match = basisStr.match(/branch_count=(\d+);\s*evidence_count=(\d+);\s*agent_consensus=([\d.]+)/);
    if (match) {
      const branchCount = match[1];
      const evidenceCount = match[2];
      const agentConsensus = match[3];
      const parsedConsensus = Number.parseFloat(agentConsensus);
      if (Number.isFinite(parsedConsensus)) {
        consensusPct = Math.round(parsedConsensus * 100);
        consensusFraction = parsedConsensus;
      }
      if (!displayBasis) {
        displayBasis = t('result.report.confidence_basis_recomposed', {
          branchCount,
          evidenceCount,
          agentConsensus,
          defaultValue: `Based on ${branchCount} branches, ${evidenceCount} pieces of evidence, and ${agentConsensus} consensus.`,
        });
      }
    } else if (!displayBasis) {
      displayBasis = basisStr;
    }
  }

  // §F honest hedge: derive the simulation framing from REAL basis data instead of
  // hard-coding "single-branch / agents aligned" (which would contradict a multi-branch
  // or low/missing-consensus report). branch_count was parsed independently above so the
  // descriptor still works when the full debug pattern (with consensus) is absent.
  const hedgeParts: string[] = [];
  if (branchCountNum === 1) {
    hedgeParts.push(t('result.report.hedge_branch_single', 'Single-branch simulation'));
  } else if (branchCountNum !== null && branchCountNum > 1) {
    hedgeParts.push(
      t('result.report.hedge_branch_multi', {
        count: branchCountNum,
        defaultValue: `${branchCountNum}-branch simulation`,
      }),
    );
  }
  // Only claim "agents aligned" when the RAW consensus is genuinely >= 60% — compare the
  // unrounded fraction so a 59.5% value can't round up to 60 and be falsely upgraded.
  if (consensusFraction !== null && consensusFraction >= 0.6) {
    hedgeParts.push(t('result.report.hedge_agents_aligned', 'Agents aligned'));
  }
  const hedgeText = hedgeParts.join(' · ');

  const intervalAriaText = intervalRenderable
    ? `${(likelihood.interval[0] * 100).toFixed(1)}% – ${(likelihood.interval[1] * 100).toFixed(1)}%`
    : t('result.report.interval_unavailable', 'Interval unavailable');
  const weightLabel = branchCountNum !== null && branchCountNum > 1
    ? t('result.report.dominant_branch_share_label', 'Dominant simulated branch share')
    : t('result.report.simulation_weight_label', 'Simulation result weight');
  const intervalLabel = branchCountNum !== null && branchCountNum > 1
    ? t('result.report.simulated_distribution_range_label', 'Simulated distribution range')
    : t('result.report.intervalLabel', 'Interval');

  return (
    <section className="report-hero report-reveal report-d1" aria-label={t('result.report.summary_label', 'Verdict')}>
      <div className="report-hero__grid">
        {/* Probability stat */}
        <div className="report-hero__stat">
          {singlePath ? (
            <p className="report-hero__single-path">
              {t(
                'result.report.single_path_no_distribution',
                'Only one simulated path is available, so there is no branch distribution to compare.',
              )}
            </p>
          ) : (
            <>
              <div className="report-hero__eyebrow">{weightLabel}</div>
              <p className="report-hero__pct">
                {probabilityText}
                {probabilityRenderable && <span className="report-hero__unit">%</span>}
              </p>
              {intervalRenderable ? (
                <div className="report-hero__interval" aria-label={intervalAriaText}>
                  <span className="report-hero__interval-lbl">{intervalLabel}</span>
                  ({(likelihood.interval[0] * 100).toFixed(1)}%, {(likelihood.interval[1] * 100).toFixed(1)}%)
                </div>
              ) : (
                // §E: invalid/reversed/out-of-range interval — qualitative band, no fake numbers.
                <div className="report-hero__interval">
                  <span className="report-hero__interval-lbl">{intervalLabel}</span>
                  {t('result.report.interval_unavailable', 'Interval unavailable')}
                </div>
              )}
              <div className="report-hero__wep-row">
                {wepLabel && (
                  <span className="report-hero__wep">
                    <span className="report-hero__wep-dot" aria-hidden="true" />
                    {wepLabel}
                  </span>
                )}
                {/* §F: honest hedge — derived from real branch count / consensus, omitted when unverifiable. */}
                {hedgeText && <span className="report-hero__hedge">{hedgeText}</span>}
              </div>
            </>
          )}
        </div>

        {/* Confidence + consensus meta */}
        <div className="report-hero__meta">
          <div>
            <div className="report-meter__head">
              <span className="report-meter__label">{t('result.report.analytic_confidence_label', 'Analytic Confidence')}</span>
              <span className="report-meter__value">{levelLabel}</span>
            </div>
            <div
              className="report-meter__track"
              role="img"
              aria-label={`${t('result.report.analytic_confidence_label', 'Analytic Confidence')}: ${levelLabel}`}
            >
              {[0, 1, 2].map((seg) => {
                const on = seg < reachedSegments;
                const strong = on && reachedSegments >= 2;
                return (
                  <span
                    key={seg}
                    className={`report-meter__seg${on ? ' is-on' : ''}${strong ? ' is-strong' : ''}`}
                  />
                );
              })}
            </div>
            <div className="report-meter__ticks" aria-hidden="true">
              <span className={level === 'low' ? 'is-active' : ''}>{t('result.report.confidence_level.low', 'Low')}</span>
              <span className={level === 'medium' ? 'is-active' : ''}>{t('result.report.confidence_level.medium', 'Medium')}</span>
              <span className={level === 'high' ? 'is-active' : ''}>{t('result.report.confidence_level.high', 'High')}</span>
            </div>
          </div>

          {(displayBasis || consensusPct !== null) && (
            <div className="report-hero__basis">
              {displayBasis}
            </div>
          )}
        </div>

        {/* §F: persistent plain-language disclaimer band under the hero numbers. */}
        <div className="report-hero__disclaimer">
          <p>{t('result.report.disclaimer_band_1')}</p>
          <p>{t('result.report.disclaimer_band_2')}</p>
          {disclaimerText && <p>{disclaimerText}</p>}
        </div>
      </div>
    </section>
  );
});
