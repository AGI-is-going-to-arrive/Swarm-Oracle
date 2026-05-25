/* ═══════════════════════════════════════════════════════════
   PolymarketCard — Prediction market source category.
   Renders PolymarketGeoGatedPlaceholder when configured_host === "non-us".
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';
import { SourceCategoryCard, type SourceCategoryState } from './SourceCategoryCard';
import { PolymarketGeoGatedPlaceholder } from './PolymarketGeoGatedPlaceholder';
import type { WebSearchProviderEntry } from '../../api/client';

export interface PolymarketCardProps {
  capability?: WebSearchProviderEntry | undefined;
  state?: SourceCategoryState;
  reason?: string;
  testIdOverride?: string;
  optimizedQuery?: string;
  searchPass?: 1 | 2;
  items?: Array<{
    id: string;
    question: string;
    probability?: number;
    url?: string;
  }>;
}

export function PolymarketCard({
  capability,
  state = 'empty',
  reason,
  testIdOverride,
  optimizedQuery,
  searchPass,
  items = [],
}: PolymarketCardProps) {
  const { t } = useTranslation();

  // Geo gate: render placeholder only for the explicit non-us key.
  if (capability?.configured_host === 'non-us') {
    return <PolymarketGeoGatedPlaceholder />;
  }

  const title = t('source.polymarket.title', { defaultValue: 'Polymarket' });
  const subtitle = t('source.polymarket.subtitle', {
    defaultValue: 'Prediction market odds (real-time).',
  });

  const resolvedState: SourceCategoryState =
    state === 'ready' && items.length === 0 ? 'empty' : state;

  return (
    <SourceCategoryCard
      family="polymarket"
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
              <p className="result-source-card__item-title">{item.question}</p>
              <div className="result-source-card__item-meta">
                {typeof item.probability === 'number' && (
                  <span>{Math.round(item.probability * 100)}%</span>
                )}
                {item.url && /^https?:\/\//i.test(item.url) && (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="result-source-card__item-url"
                  >
                    {t('source.polymarket.open', { defaultValue: 'Open' })}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SourceCategoryCard>
  );
}

export default PolymarketCard;
