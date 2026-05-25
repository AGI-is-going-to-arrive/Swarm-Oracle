/* ═══════════════════════════════════════════════════════════
   SourceCategoryCard — Generic container base for 4 source families
   (Polymarket / Finance / Academic / News-Deep)

   FE-5 (v2): standard card shell with title, subtitle, skeleton,
   empty, rate-limited, network-error, and content states.

   P4-1: extended with provider-aware states:
   - failed: provider search failed without blocking result rendering
   - unsupported_provider: current provider can't fulfill the family
   - fallback_unconstrained: returned results but without domain scope
   - search_skipped: search intentionally skipped
   ═══════════════════════════════════════════════════════════ */

import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';

export type SourceCategoryState =
  | 'loading'
  | 'empty'
  | 'rate_limited'
  | 'network_error'
  | 'ready'
  | 'failed'
  | 'unsupported_provider'
  | 'fallback_unconstrained'
  | 'search_skipped';

export interface SourceCategoryCardProps {
  family: 'polymarket' | 'finance' | 'academic' | 'news_deep';
  title: string;
  subtitle?: string;
  state: SourceCategoryState;
  /**
   * Optional disabled / fallback reason copy. When provided, an sr-only
   * span is rendered and linked via aria-describedby for the
   * `unsupported_provider`, `fallback_unconstrained`, and `search_skipped`
   * states.
   */
  reason?: string;
  children?: ReactNode;
  /** Optional extra className for the outer element. */
  className?: string;
  /** Optional override of the data-testid base. */
  testIdOverride?: string;
  optimizedQuery?: string;
  searchPass?: 1 | 2;
}

const REASON_STATES: ReadonlySet<SourceCategoryState> = new Set<SourceCategoryState>([
  'unsupported_provider',
  'fallback_unconstrained',
  'search_skipped',
  'failed',
]);

const RAW_URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;
const SITE_OPERATOR_PATTERN = /(?:^|\s)site\s*:/i;
const LOCAL_HOST_PATTERN = /\b(?:localhost|host\.docker\.internal|metadata\.google\.internal)\b/i;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function isPrivateOrMetadataIp(value: string): boolean {
  for (const match of value.matchAll(IPV4_PATTERN)) {
    const parts = match[0].split('.').map((part) => Number(part));
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      continue;
    }
    const [a, b] = parts;
    if (
      a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
    ) {
      return true;
    }
  }
  return false;
}

function getDisplayableOptimizedQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    RAW_URL_PATTERN.test(trimmed)
    || SITE_OPERATOR_PATTERN.test(trimmed)
    || LOCAL_HOST_PATTERN.test(trimmed)
    || isPrivateOrMetadataIp(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

export function SourceCategoryCard({
  family,
  title,
  subtitle,
  state,
  reason,
  children,
  className,
  testIdOverride,
  optimizedQuery,
  searchPass,
}: SourceCategoryCardProps) {
  const { t } = useTranslation();
  const baseTestId = testIdOverride ?? `result-sources-${family}`;
  const reasonId = `${baseTestId}-reason`;
  const hasReason = REASON_STATES.has(state);
  const displayOptimizedQuery = getDisplayableOptimizedQuery(optimizedQuery);

  let stateTestId: string | undefined;
  let stateBody: ReactNode = null;
  let stateClass: string | undefined;

  switch (state) {
    case 'loading':
      stateTestId = 'result-source-skeleton';
      stateBody = (
        <div
          className="result-source-card__skeleton-group"
          aria-busy="true"
          data-testid={`${baseTestId}-skeleton`}
        >
          <div className="result-source-card__skeleton result-source-card__skeleton--wide" />
          <div className="result-source-card__skeleton result-source-card__skeleton--medium" />
          <div className="result-source-card__skeleton result-source-card__skeleton--narrow" />
        </div>
      );
      break;
    case 'empty':
      stateTestId = 'result-sources-empty';
      stateBody = (
        <div className="result-source-card__empty-container">
          <p className="result-source-card__empty result-source-card__empty-text">
            {t(`source.${family}.empty`, { defaultValue: 'No results.' })}
          </p>
          {displayOptimizedQuery ? (
            <p className="result-source-card__search-query" dir="auto">
              {t('source.searched_with', { query: displayOptimizedQuery })}
            </p>
          ) : (
            <p className="result-source-card__search-query">
              {t('source.searched_with_raw_fallback')}
            </p>
          )}
        </div>
      );
      break;
    case 'rate_limited':
      stateTestId = 'result-source-rate-limited';
      stateBody = (
        <p className="result-source-card__rate-limited">
          {t(`source.${family}.rate_limited`, {
            defaultValue: 'Rate limit reached. Please retry later.',
          })}
        </p>
      );
      break;
    case 'network_error':
      stateTestId = 'result-source-network-error';
      stateBody = (
        <p className="result-source-card__error">
          {t(`source.${family}.network_error`, {
            defaultValue: 'Network error while fetching sources.',
          })}
        </p>
      );
      break;
    case 'failed':
      stateTestId = 'result-source-failed';
      stateClass = 'result-source-card__failed';
      stateBody = (
        <p className="result-source-card__notice">
          <span className="result-source-card__notice-icon" aria-hidden="true">
            ⚠️
          </span>
          <span>
            {t(`source.${family}.failed`, {
              defaultValue: 'Source search failed for this category.',
            })}
          </span>
        </p>
      );
      break;
    case 'unsupported_provider':
      stateTestId = 'result-source-unsupported';
      stateClass = 'result-source-card__unsupported';
      stateBody = (
        <p className="result-source-card__notice">
          <span className="result-source-card__notice-icon" aria-hidden="true">
            ℹ️
          </span>
          <span>
            {t(`source.${family}.unsupported_provider`, {
              defaultValue:
                'Current search provider does not support this category.',
            })}
          </span>
        </p>
      );
      break;
    case 'fallback_unconstrained':
      stateTestId = 'result-source-fallback';
      stateClass = 'result-source-card__fallback';
      stateBody = (
        <>
          <p className="result-source-card__notice">
            <span className="result-source-card__notice-icon" aria-hidden="true">
              ⚠️
            </span>
            <span>
              {t(`source.${family}.fallback_unconstrained`, {
                defaultValue:
                  'Search scope expanded — domain filtering unavailable.',
              })}
            </span>
          </p>
          {children}
        </>
      );
      break;
    case 'search_skipped':
      stateTestId = 'result-source-skipped';
      stateClass = 'result-source-card__skipped';
      stateBody = (
        <p className="result-source-card__notice">
          <span className="result-source-card__notice-icon" aria-hidden="true">
            ⏭
          </span>
          <span>
            {t(`source.${family}.search_skipped`, {
              defaultValue: 'Search skipped.',
            })}
          </span>
        </p>
      );
      break;
    case 'ready':
    default:
      stateBody = children ?? null;
  }

  return (
    <section
      data-testid={baseTestId}
      data-state={state}
      data-source-family={family}
      className={cn('result-source-card', stateClass, className)}
      aria-labelledby={`${baseTestId}-title`}
      aria-describedby={hasReason ? reasonId : undefined}
    >
      <header className="result-source-card__header">
        <h3
          id={`${baseTestId}-title`}
          className="result-source-card__title"
        >
          {title}
        </h3>
        {searchPass === 2 && state === 'ready' && (
          <span className="result-source-card__broadened-badge">
            <span aria-hidden="true">{t('source.broadened_search')}</span>
            <span className="sr-only">
              {t('source.broadened_search_sr')}
            </span>
          </span>
        )}
        {subtitle && <p className="result-source-card__subtitle">{subtitle}</p>}
      </header>
      {hasReason && (
        <>
          <span
            id={reasonId}
            data-testid={`${baseTestId}-reason`}
            className="result-source-card__sr-reason"
          >
            {reason
              ?? t(`source.${family}.${state}`, {
                defaultValue:
                  state === 'failed'
                    ? 'Source search failed for this category.'
                    : state === 'unsupported_provider'
                    ? 'Current search provider does not support this category.'
                    : state === 'fallback_unconstrained'
                    ? 'Search scope expanded — domain filtering unavailable.'
                    : 'Search skipped.',
              })}
          </span>
          {reason && (
            <p
              className="result-source-card__reason-detail"
              aria-hidden="true"
              data-testid={`${baseTestId}-reason-detail`}
            >
              {reason}
            </p>
          )}
        </>
      )}
      <div
        className="source-category-card__body result-source-card__body"
        data-testid={stateTestId}
      >
        {stateBody}
      </div>
    </section>
  );
}

export default SourceCategoryCard;
