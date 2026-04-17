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
          className="space-y-2"
          aria-busy="true"
          data-testid={`${baseTestId}-skeleton`}
        >
          <div className="h-3 w-4/5 animate-pulse rounded bg-slate-700/40" />
          <div className="h-3 w-3/5 animate-pulse rounded bg-slate-700/40" />
          <div className="h-3 w-2/5 animate-pulse rounded bg-slate-700/40" />
        </div>
      );
      break;
    case 'empty':
      stateTestId = 'result-sources-empty';
      stateBody = (
        <p className="text-sm text-slate-400">
          {t(`source.${family}.empty`, { defaultValue: 'No results.' })}
        </p>
      );
      break;
    case 'rate_limited':
      stateTestId = 'result-source-rate-limited';
      stateBody = (
        <p className="text-sm text-amber-400">
          {t(`source.${family}.rate_limited`, {
            defaultValue: 'Rate limit reached. Please retry later.',
          })}
        </p>
      );
      break;
    case 'network_error':
      stateTestId = 'result-source-network-error';
      stateBody = (
        <p className="text-sm text-rose-400">
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
      className={cn(
        'rounded-xl border border-slate-700/60 bg-slate-900/40 p-4 shadow-sm',
        className,
      )}
      aria-labelledby={`${baseTestId}-title`}
    >
      <header className="mb-3 flex flex-col gap-0.5">
        <h3
          id={`${baseTestId}-title`}
          className="text-sm font-semibold text-slate-100"
        >
          {title}
        </h3>
        {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
      </header>
      <div
        className="source-category-card__body"
        data-testid={stateTestId}
      >
        {stateBody}
      </div>
    </section>
  );
}

export default SourceCategoryCard;
