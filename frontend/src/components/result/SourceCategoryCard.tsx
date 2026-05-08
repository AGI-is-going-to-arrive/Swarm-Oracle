/* ═══════════════════════════════════════════════════════════
   SourceCategoryCard — Generic container base for 4 source families
   (Polymarket / Finance / Academic / News-Deep)

   FE-5 (v2): standard card shell with title, subtitle, skeleton,
   empty, rate-limited, network-error, and content states.
   ═══════════════════════════════════════════════════════════ */

import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';

export type SourceCategoryState =
  | 'loading'
  | 'empty'
  | 'rate_limited'
  | 'network_error'
  | 'ready';

export interface SourceCategoryCardProps {
  family: 'polymarket' | 'finance' | 'academic' | 'news_deep';
  title: string;
  subtitle?: string;
  state: SourceCategoryState;
  children?: ReactNode;
  /** Optional extra className for the outer element. */
  className?: string;
  /** Optional override of the data-testid base. */
  testIdOverride?: string;
}

export function SourceCategoryCard({
  family,
  title,
  subtitle,
  state,
  children,
  className,
  testIdOverride,
}: SourceCategoryCardProps) {
  const { t } = useTranslation();
  const baseTestId = testIdOverride ?? `result-sources-${family}`;

  let stateTestId: string | undefined;
  let stateBody: ReactNode = null;

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
        <p className="result-source-card__empty">
          {t(`source.${family}.empty`, { defaultValue: 'No results.' })}
        </p>
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
    case 'ready':
    default:
      stateBody = children ?? null;
  }

  return (
    <section
      data-testid={baseTestId}
      data-state={state}
      data-source-family={family}
      className={cn('result-source-card', className)}
      aria-labelledby={`${baseTestId}-title`}
    >
      <header className="result-source-card__header">
        <h3
          id={`${baseTestId}-title`}
          className="result-source-card__title"
        >
          {title}
        </h3>
        {subtitle && <p className="result-source-card__subtitle">{subtitle}</p>}
      </header>
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
