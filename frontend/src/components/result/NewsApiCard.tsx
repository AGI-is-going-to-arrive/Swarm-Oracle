/* ═══════════════════════════════════════════════════════════
   NewsApiCard — Deep news source category (news_deep family).
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';
import { SourceCategoryCard, type SourceCategoryState } from './SourceCategoryCard';

export interface NewsApiItem {
  id: string;
  title: string;
  source?: string;
  publishedAt?: string;
  description?: string;
  url?: string;
}

export interface NewsApiCardProps {
  state?: SourceCategoryState;
  reason?: string;
  testIdOverride?: string;
  items?: NewsApiItem[];
  optimizedQuery?: string;
  searchPass?: 1 | 2;
}

export function NewsApiCard({
  state = 'empty',
  reason,
  testIdOverride,
  items = [],
  optimizedQuery,
  searchPass,
}: NewsApiCardProps) {
  const { t } = useTranslation();
  const title = t('source.news_deep.title', { defaultValue: 'News (Deep)' });
  const subtitle = t('source.news_deep.subtitle', {
    defaultValue: 'Full-text news with structured metadata.',
  });

  const resolvedState: SourceCategoryState =
    state === 'ready' && items.length === 0 ? 'empty' : state;

  return (
    <SourceCategoryCard
      family="news_deep"
      title={title}
      subtitle={subtitle}
      state={resolvedState}
      reason={reason}
      testIdOverride={testIdOverride}
      optimizedQuery={optimizedQuery}
      searchPass={searchPass}
    >
      {resolvedState === 'ready' && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="result-source-card__item"
            >
              <p className="result-source-card__item-title">{item.title}</p>
              <div className="result-source-card__item-meta">
                {item.source && <span>{item.source}</span>}
                {item.publishedAt && (
                  <span>{item.publishedAt}</span>
                )}
              </div>
              {item.description && (
                <p className="result-source-card__item-summary">{item.description}</p>
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

export default NewsApiCard;
