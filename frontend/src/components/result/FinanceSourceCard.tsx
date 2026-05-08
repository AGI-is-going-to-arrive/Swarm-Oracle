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
              className="result-source-card__item"
            >
              <p className="result-source-card__item-title">{item.title}</p>
              <div className="result-source-card__item-meta">
                {item.source && <span>{item.source}</span>}
              </div>
              {item.summary && (
                <p className="result-source-card__item-summary">{item.summary}</p>
              )}
              {item.url && /^https?:\/\//i.test(item.url) && (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="result-source-card__item-url"
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
