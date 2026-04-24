import { useTranslation } from 'react-i18next';
import type { WebSearchContext } from '../../types';
import { SourceCategoryCard, type SourceCategoryState } from './SourceCategoryCard';

type FinanceSourceItem = NonNullable<
  NonNullable<WebSearchContext['family_context']>['finance']
>['items'][number];

interface FinanceSourceCardProps {
  state: SourceCategoryState;
  items: FinanceSourceItem[];
}

export function FinanceSourceCard({ state, items }: FinanceSourceCardProps) {
  const { t } = useTranslation();

  return (
    <SourceCategoryCard
      family="finance"
      title={t('source.finance.title', { defaultValue: 'Finance' })}
      subtitle={t('source.finance.subtitle', { defaultValue: 'Market & macro indicators' })}
      state={state}
      testIdOverride="result-sources-finance"
    >
      {state === 'ready' && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-md border border-slate-700/40 bg-slate-900/50 p-2 text-xs"
            >
              <p className="font-medium text-slate-100">{item.title}</p>
              <div className="mt-0.5 flex items-center gap-2 text-slate-400">
                {item.source && <span>{item.source}</span>}
              </div>
              {item.summary && (
                <p className="mt-1 line-clamp-3 text-slate-300">{item.summary}</p>
              )}
              {item.url && /^https?:\/\//i.test(item.url) && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 block underline hover:text-slate-200"
                >
                  {item.url}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </SourceCategoryCard>
  );
}

export default FinanceSourceCard;
