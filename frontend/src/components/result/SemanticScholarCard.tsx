/* ═══════════════════════════════════════════════════════════
   SemanticScholarCard — Academic source (Semantic Scholar half of `academic` family).
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';
import { SourceCategoryCard, type SourceCategoryState } from './SourceCategoryCard';

export interface SemanticScholarItem {
  id: string;
  title: string;
  authors?: string[];
  citationCount?: number;
  abstract?: string;
  url?: string;
}

export interface SemanticScholarCardProps {
  state?: SourceCategoryState;
  items?: SemanticScholarItem[];
  testIdOverride?: string;
  title?: string;
  subtitle?: string;
}

export function SemanticScholarCard({
  state = 'empty',
  items = [],
  testIdOverride,
  title,
  subtitle,
}: SemanticScholarCardProps) {
  const { t } = useTranslation();
  const resolvedTitle =
    title ?? t('source.academic.title', { defaultValue: 'Academic (Semantic Scholar)' });
  const resolvedSubtitle =
    subtitle
    ?? t('source.academic.subtitle', {
      defaultValue: 'Citation-ranked literature.',
    });

  const resolvedState: SourceCategoryState =
    state === 'ready' && items.length === 0 ? 'empty' : state;

  return (
    <SourceCategoryCard
      family="academic"
      title={resolvedTitle}
      subtitle={resolvedSubtitle}
      state={resolvedState}
      testIdOverride={testIdOverride}
    >
      {resolvedState === 'ready' && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-md border border-slate-700/40 bg-slate-900/50 p-2 text-xs"
            >
              <p className="font-medium text-slate-100">{item.title}</p>
              {item.authors && item.authors.length > 0 && (
                <p className="mt-0.5 text-slate-400">
                  {item.authors.slice(0, 3).join(', ')}
                  {item.authors.length > 3 ? ' ...' : ''}
                </p>
              )}
              {typeof item.citationCount === 'number' && (
                <p className="mt-0.5 text-slate-500">
                  {t('source.academic.citations', {
                    count: item.citationCount,
                    defaultValue: '{{count}} citations',
                  })}
                </p>
              )}
              {item.abstract && (
                <p className="mt-1 line-clamp-3 text-slate-300">{item.abstract}</p>
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

export default SemanticScholarCard;
