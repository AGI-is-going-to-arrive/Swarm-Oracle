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
  items?: NewsApiItem[];
}

export function NewsApiCard({ state = 'empty', items = [] }: NewsApiCardProps) {
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
    >
      {resolvedState === 'ready' && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-md border border-slate-700/40 bg-slate-900/50 p-2 text-xs"
            >
              <p className="font-medium text-slate-100">{item.title}</p>
              <div className="mt-0.5 flex items-center gap-2 text-slate-400">
                {item.source && <span>{item.source}</span>}
                {item.publishedAt && (
                  <span className="text-slate-500">{item.publishedAt}</span>
                )}
              </div>
              {item.description && (
                <p className="mt-1 line-clamp-3 text-slate-300">{item.description}</p>
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

export default NewsApiCard;
