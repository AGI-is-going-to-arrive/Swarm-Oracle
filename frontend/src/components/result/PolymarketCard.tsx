/* ═══════════════════════════════════════════════════════════
   PolymarketCard — Prediction market source category.
   Renders PolymarketGeoGatedPlaceholder if configured_host !== "us".
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';
import { SourceCategoryCard, type SourceCategoryState } from './SourceCategoryCard';
import { PolymarketGeoGatedPlaceholder } from './PolymarketGeoGatedPlaceholder';
import type { WebSearchProviderEntry } from '../../api/client';

export interface PolymarketCardProps {
  capability?: WebSearchProviderEntry | undefined;
  state?: SourceCategoryState;
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
  items = [],
}: PolymarketCardProps) {
  const { t } = useTranslation();

  // Geo gate: render placeholder if configured_host !== "us"
  if (capability && capability.configured_host !== 'us') {
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
    >
      {resolvedState === 'ready' && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-md border border-slate-700/40 bg-slate-900/50 p-2 text-xs"
            >
              <p className="text-slate-100">{item.question}</p>
              <div className="mt-1 flex items-center justify-between text-slate-400">
                {typeof item.probability === 'number' && (
                  <span>{Math.round(item.probability * 100)}%</span>
                )}
                {item.url && /^https?:\/\//i.test(item.url) && (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-slate-200"
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
