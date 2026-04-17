/* ═══════════════════════════════════════════════════════════
   PolymarketGeoGatedPlaceholder — ui-prompts §6
   Rendered when capability.web_search.providers.polymarket.configured_host !== "us"
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';

export function PolymarketGeoGatedPlaceholder() {
  const { t } = useTranslation();

  const title = t('source.polymarket.geo_gated_title', {
    defaultValue: 'Polymarket is not available in your region',
  });
  const subtitle = t('source.polymarket.geo_gated_subtitle', {
    defaultValue: 'This provider is currently gated to US hosts only.',
  });

  return (
    <section
      data-testid="result-source-polymarket-geo-gated"
      aria-disabled={true}
      aria-label={title}
      className="rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5 p-4 text-amber-200"
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 text-xs opacity-90">{subtitle}</p>
    </section>
  );
}

export default PolymarketGeoGatedPlaceholder;
