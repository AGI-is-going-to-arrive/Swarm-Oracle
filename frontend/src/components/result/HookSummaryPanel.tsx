import { useTranslation } from 'react-i18next';
import { useHookSummary, type HookKey, type HookSummaryItem } from '../../hooks/useHookSummary';

interface HookSummaryPanelProps {
  scenarioId: string | null;
  branchId?: string;
  debateId?: string;
  identityId?: string;
}

const HOOK_ICONS: Record<HookKey, string> = {
  causal_graph: '\u{1F578}️',
  factions: '\u{1F6E1}️',
  checkpoints: '\u{1F4BE}',
  identity: '\u{1F9EC}',
  argument_map: '\u{1F5FA}️',
};

const HOOK_TITLE_KEYS: Record<HookKey, string> = {
  causal_graph: 'result.hooks.causal_graph',
  factions: 'result.hooks.factions',
  checkpoints: 'result.hooks.checkpoints',
  identity: 'result.hooks.identity',
  argument_map: 'result.hooks.argument_map',
};

function HookCard({
  item,
  onRetry,
}: {
  item: HookSummaryItem;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const titleKey = HOOK_TITLE_KEYS[item.key];
  const titleId = `hook-card-${item.key}`;

  return (
    <div
      className={`hook-summary-card${!item.enabled ? ' hook-summary-card--disabled' : ''}`}
      aria-labelledby={titleId}
    >
      <div className="hook-summary-card__header">
        <span className="hook-summary-card__icon" aria-hidden="true">
          {HOOK_ICONS[item.key]}
        </span>
        <span className="hook-summary-card__title" id={titleId}>
          {t(titleKey)}
        </span>
      </div>
      <div className="hook-summary-card__body">
        {!item.enabled && (
          <span className="hook-summary-card__disabled">
            {t('result.hooks.disabled', 'Not enabled')}
          </span>
        )}
        {item.enabled && item.loading && (
          <span className="hook-summary-card__skeleton" aria-label={t('result.hooks.loading', 'Loading...')}>
            {t('result.hooks.loading', 'Loading...')}
          </span>
        )}
        {item.enabled && !item.loading && item.error && (
          <div className="hook-summary-card__error">
            <span>{t('result.hooks.error', 'Failed to load')}</span>
            <button
              className="hook-summary-card__retry"
              onClick={onRetry}
              type="button"
              aria-label={t('result.hooks.retry_for', 'Retry {{hook}}', { hook: t(titleKey) })}
            >
              {t('result.hooks.retry', 'Retry')}
            </button>
          </div>
        )}
        {item.enabled && !item.loading && !item.error && item.data && (
          <div className="hook-summary-card__stats">
            <span className="hook-summary-card__count">
              {t('result.hooks.count', '{{total}} items', { total: item.data.count })}
            </span>
            {item.data.latestRound !== undefined && (
              <span className="hook-summary-card__detail">
                {t('result.hooks.latest_round', 'Latest: round {{round}}', { round: item.data.latestRound })}
              </span>
            )}
            {item.data.eventCount !== undefined && (
              <span className="hook-summary-card__detail">
                {t('result.hooks.events', '{{total}} events', { total: item.data.eventCount })}
              </span>
            )}
          </div>
        )}
        {item.enabled && !item.loading && !item.error && !item.data && (
          <span className="hook-summary-card__empty">
            {t('result.hooks.no_data', 'No data')}
          </span>
        )}
      </div>
    </div>
  );
}

export function HookSummaryPanel({ scenarioId, branchId, debateId, identityId }: HookSummaryPanelProps) {
  const { t } = useTranslation();
  const { items, loading, refetch } = useHookSummary(scenarioId, branchId, debateId, identityId);

  if (!scenarioId) return null;

  const hasAnyEnabled = items.some((i) => i.enabled);
  if (!loading && !hasAnyEnabled) return null;

  return (
    <section className="hook-summary-panel" role="region" aria-label={t('result.hooks.title', 'Generated artifacts')}>
      <h3 className="hook-summary-panel__heading">
        {t('result.hooks.title', 'Generated artifacts')}
      </h3>
      <div className="hook-summary-panel__grid">
        {loading && items.length === 0
          ? Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="hook-summary-card hook-summary-card--skeleton">
                <div className="hook-summary-card__header">
                  <span className="hook-summary-card__skeleton">&nbsp;</span>
                </div>
                <div className="hook-summary-card__body">
                  <span className="hook-summary-card__skeleton">&nbsp;</span>
                </div>
              </div>
            ))
          : items.map((item) => (
              <HookCard key={item.key} item={item} onRetry={refetch} />
            ))}
      </div>
    </section>
  );
}
