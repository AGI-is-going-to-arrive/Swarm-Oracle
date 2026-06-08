import { useTranslation } from 'react-i18next';
import type { ReportVerdict } from '../../types';

interface Props {
  verdict: ReportVerdict;
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

// The backend `wep` is a snake_case word-estimate enum (e.g. `likely`, `roughly_even`,
// `missing`) from `derive_likelihood_label`. These are the only values it emits; anything
// else falls back to the neutral `missing` label so a raw backend string never leaks.
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

export function ReportConfidenceBadge({ verdict }: Props) {
  const { t } = useTranslation();
  const { likelihood, analytic_confidence, disclaimer } = verdict;

  // Localize the level word (never surface the raw enum). An unexpected/unknown level falls
  // back to the neutral localized "Not Available" label rather than leaking the machine value.
  const level = analytic_confidence.level;
  const levelLabel = KNOWN_CONFIDENCE_LEVELS.has(level)
    ? t(CONFIDENCE_LEVEL_KEY[level], CONFIDENCE_LEVEL_FALLBACK[level])
    : t('result.report.wep.missing', 'Not Available');

  // Localize the word-estimate (WEP) through `result.report.wep.*`. Normalize defensively
  // (the field is a free string in the type) and fall back to the neutral localized label
  // for any value outside the known seven-tier set — never render the raw backend string.
  const normalizedWep = (likelihood.wep ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const wepLabel = KNOWN_WEP_KEYS.has(normalizedWep)
    ? t(`result.report.wep.${normalizedWep}`, normalizedWep)
    : likelihood.wep
      ? t('result.report.wep.missing', 'Not Available')
      : '';

  // Prefer the backend-authored disclaimer (it can be scenario-specific), otherwise fall
  // back to the localized boilerplate so the panel is never shown without a disclaimer.
  const disclaimerText = disclaimer?.trim()
    ? disclaimer
    : t('result.report.disclaimer', 'This probability is a narrative simulation result, not a real-world prediction.');

  return (
    <div className="report-confidence-badge mb-6 p-4 rounded-lg bg-[color:var(--bg-hover)] border border-[color:var(--border-subtle)] forced-colors:border">
      <div className="flex flex-col space-y-2">
        {/* Dual-axis confidence — likelihood on its own line. */}
        <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
          <span className="font-semibold text-[color:var(--text-primary)]">
            {t('result.report.likelihood_label', 'Estimated Likelihood')}:
          </span>
          <span className="text-[color:var(--text-secondary)]">
            {(likelihood.probability * 100).toFixed(1)}%
            <span className="text-xs ml-1 text-[color:var(--text-muted)]">
              ([{(likelihood.interval[0] * 100).toFixed(1)}%, {(likelihood.interval[1] * 100).toFixed(1)}%])
            </span>
          </span>
          {wepLabel && (
            <span className="px-2 py-0.5 rounded text-xs bg-[color:var(--color-primary-glow)] text-[color:var(--color-primary)]">
              {wepLabel}
            </span>
          )}
        </div>
        {/* Analytic confidence on a separate line. */}
        <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
          <span className="font-semibold text-[color:var(--text-primary)]">
            {t('result.report.analytic_confidence_label', 'Analytic Confidence')}:
          </span>
          <span className="px-2 py-0.5 rounded text-xs bg-[color:var(--bg-elevated)] border border-[color:var(--border-default)] text-[color:var(--text-secondary)] uppercase tracking-wider">
            {levelLabel}
          </span>
          {analytic_confidence.basis && (
            <span className="text-sm text-[color:var(--text-secondary)] truncate flex-1" title={analytic_confidence.basis}>
              {analytic_confidence.basis}
            </span>
          )}
        </div>
      </div>
      {disclaimerText && (
        <div className="mt-3 pt-3 border-t border-[color:var(--border-subtle)] text-xs text-[color:var(--text-muted)] italic">
          * {disclaimerText}
        </div>
      )}
    </div>
  );
}
