import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getScenarioActions,
  type SocialActionEntry,
  type SocialActionFilters,
  type SocialActionStatus,
  type SocialActionType,
} from '../../api/client';
import { ACTION_LEDGER_POLL_INTERVAL_MS, isActionsUnavailableError } from './actionLedgerUtils';
import './ActionLedgerPanel.css';

const ACTION_TYPES: SocialActionType[] = [
  'POST', 'COMMENT', 'REACTION', 'FOLLOW', 'MUTE', 'SEARCH', 'TREND', 'REFRESH', 'IDLE',
];
const ACTION_STATUSES: SocialActionStatus[] = ['verified', 'unavailable', 'failed'];

interface ActionLedgerSelection {
  branchId: string;
  round: number;
  agent: { id: string; name: string };
  actionId: string;
}

interface ActionLedgerPanelProps {
  scenarioId: string;
  branchId?: string;
  onSelectAction?: (selection: ActionLedgerSelection) => void;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

interface ActionPayloadDetails {
  sourceName?: string;
  publishedAt?: string;
  credibilityHint?: string;
  tags?: string[];
  reaction?: string;
}

function readPayloadText(payload: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = payload[key];
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function getActionPayloadDetails(item: SocialActionEntry): ActionPayloadDetails {
  const details: ActionPayloadDetails = {};
  if (item.action_type === 'POST' && item.payload.bootstrap === true) {
    details.sourceName = readPayloadText(item.payload, 'source_name', 80);
    details.publishedAt = readPayloadText(item.payload, 'published_at', 64);
    details.credibilityHint = readPayloadText(item.payload, 'credibility_hint', 300);
    if (Array.isArray(item.payload.tags)) {
      const tags = item.payload.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 12);
      if (tags.length > 0) details.tags = tags;
    }
  }
  if (item.action_type === 'REACTION') {
    details.reaction = readPayloadText(item.payload, 'reaction', 40);
  }
  return details;
}

function mergeActions(current: SocialActionEntry[], incoming: SocialActionEntry[]): SocialActionEntry[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => byId.set(item.id, item));
  return Array.from(byId.values()).sort((left, right) => left.sequence - right.sequence);
}

export function ActionLedgerPanel({ scenarioId, branchId, onSelectAction }: ActionLedgerPanelProps) {
  const { t } = useTranslation();
  const contentId = useId();
  const scopeKey = `${scenarioId}:${branchId ?? ''}`;
  const [expandedScope, setExpandedScope] = useState<string | null>(null);
  const expanded = expandedScope === scopeKey;
  const [filters, setFilters] = useState<SocialActionFilters>({});
  const [state, setState] = useState<LoadState>('idle');
  const [items, setItems] = useState<SocialActionEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [expandedActionIds, setExpandedActionIds] = useState<Set<string>>(new Set());
  const requestEpoch = useRef(0);
  const pageController = useRef<AbortController | null>(null);
  const pollController = useRef<AbortController | null>(null);
  const latestActionCursor = useRef<string | undefined>(undefined);

  const scopedFilters = useMemo<SocialActionFilters>(() => ({ ...filters, branchId }), [branchId, filters]);
  const requestKey = JSON.stringify([scopeKey, scopedFilters]);

  const load = useCallback((controller: AbortController, epoch: number): void => {
    setState('loading');
    setItems([]);
    setNextCursor(null);
    setLoadMoreError(false);
    void getScenarioActions(scenarioId, scopedFilters, { signal: controller.signal }).then((response) => {
      if (controller.signal.aborted || requestEpoch.current !== epoch) return;
      setItems(mergeActions([], response.items));
      setNextCursor(response.next_cursor);
      setState('ready');
    }).catch((error: unknown) => {
      if (controller.signal.aborted || requestEpoch.current !== epoch) return;
      setState(isActionsUnavailableError(error) ? 'unsupported' : 'error');
    });
  }, [scenarioId, scopedFilters]);

  useEffect(() => {
    requestEpoch.current += 1;
    pageController.current?.abort();
    pageController.current = null;
    pollController.current?.abort();
    pollController.current = null;
    setLoadingMore(false);
    setLoadMoreError(false);
    setExpandedActionIds(new Set());
    if (!expanded) {
      setState('idle');
      setItems([]);
      setNextCursor(null);
      return;
    }
    const epoch = requestEpoch.current;
    const controller = new AbortController();
    load(controller, epoch);
    return () => controller.abort();
  }, [expanded, load, requestKey]);

  useEffect(() => {
    const latest = items.at(-1);
    latestActionCursor.current = latest ? `${latest.sequence}:${latest.id}` : undefined;
  }, [items]);

  useEffect(() => {
    if (!expanded || state !== 'ready') return;
    const epoch = requestEpoch.current;
    let polling = false;
    const poll = (): void => {
      if (polling) return;
      polling = true;
      const controller = new AbortController();
      pollController.current?.abort();
      pollController.current = controller;
      void getScenarioActions(
        scenarioId,
        { ...scopedFilters, cursor: latestActionCursor.current },
        { signal: controller.signal },
      ).then((response) => {
        if (controller.signal.aborted || requestEpoch.current !== epoch) return;
        setItems((current) => mergeActions(current, response.items));
      }).catch(() => {
        // Keep already rendered durable entries during transient polling failures.
      }).finally(() => {
        if (pollController.current === controller) pollController.current = null;
        polling = false;
      });
    };
    const timer = window.setInterval(poll, ACTION_LEDGER_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      pollController.current?.abort();
      pollController.current = null;
    };
  }, [expanded, requestKey, scenarioId, scopedFilters, state]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const controller = new AbortController();
    pageController.current?.abort();
    pageController.current = controller;
    const epoch = requestEpoch.current;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const response = await getScenarioActions(
        scenarioId,
        { ...scopedFilters, cursor: nextCursor },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || requestEpoch.current !== epoch) return;
      setItems((current) => mergeActions(current, response.items));
      setNextCursor(response.next_cursor === nextCursor ? null : response.next_cursor);
    } catch {
      if (!controller.signal.aborted && requestEpoch.current === epoch) setLoadMoreError(true);
    } finally {
      if (pageController.current === controller) pageController.current = null;
      if (!controller.signal.aborted && requestEpoch.current === epoch) setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, scenarioId, scopedFilters]);

  const agents = useMemo(() => Array.from(new Map(items.map((item) => [item.agent.id, item.agent])).values()).sort((a, b) => a.name.localeCompare(b.name)), [items]);
  const setFilter = <Key extends keyof SocialActionFilters>(key: Key, value: SocialActionFilters[Key]): void => {
    setFilters((current) => ({ ...current, [key]: value, cursor: undefined }));
  };
  const toggleActionDetails = (actionId: string): void => {
    setExpandedActionIds((current) => {
      const next = new Set(current);
      if (next.has(actionId)) next.delete(actionId);
      else next.add(actionId);
      return next;
    });
  };

  return (
    <section className="action-ledger" data-testid="action-ledger-panel">
      <button
        type="button"
        className="action-ledger__toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpandedScope(expanded ? null : scopeKey)}
      >
        <span><strong>{t('action_ledger.title')}</strong><small>{t('action_ledger.summary')}</small></span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div id={contentId} className="action-ledger__content">
          <p className="action-ledger__caveat" role="note">{t('action_ledger.readonly_caveat')}</p>
          <div className="action-ledger__filters" aria-label={t('action_ledger.filters_aria')}>
            <label>{t('action_ledger.type_filter')}
              <select value={filters.actionType ?? ''} onChange={(event) => setFilter('actionType', event.target.value as SocialActionType || undefined)}>
                <option value="">{t('action_ledger.all_types')}</option>
                {ACTION_TYPES.map((type) => <option key={type} value={type}>{t(`action_ledger.type_${type.toLowerCase()}`)}</option>)}
              </select>
            </label>
            <label>{t('action_ledger.agent_filter')}
              <select value={filters.agentId ?? ''} onChange={(event) => setFilter('agentId', event.target.value || undefined)}>
                <option value="">{t('action_ledger.all_agents')}</option>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </label>
            <label>{t('action_ledger.round_filter')}
              <input type="number" min="1" inputMode="numeric" value={filters.round ?? ''} onChange={(event) => {
                const value = Number(event.target.value);
                setFilter('round', event.target.value === '' || value < 1 ? undefined : value);
              }} />
            </label>
            <label>{t('action_ledger.status_filter')}
              <select value={filters.status ?? ''} onChange={(event) => setFilter('status', event.target.value as SocialActionStatus || undefined)}>
                <option value="">{t('action_ledger.all_statuses')}</option>
                {ACTION_STATUSES.map((status) => <option key={status} value={status}>{t(`action_ledger.status_${status}`)}</option>)}
              </select>
            </label>
          </div>

          {state === 'loading' && <p role="status">{t('action_ledger.loading')}</p>}
          {state === 'unsupported' && <p className="action-ledger__empty" data-testid="action-ledger-unsupported">{t('action_ledger.unsupported')}</p>}
          {state === 'error' && <div role="alert"><p>{t('action_ledger.error')}</p><button type="button" onClick={() => setFilters((current) => ({ ...current }))}>{t('common.retry')}</button></div>}
          {state === 'ready' && items.length === 0 && <p className="action-ledger__empty" data-testid="action-ledger-empty">{t('action_ledger.empty')}</p>}
          {state === 'ready' && items.length > 0 && (
            <>
              <ol className="action-ledger__list" aria-label={t('action_ledger.list_aria')}>
                {items.map((item) => {
                  const details = getActionPayloadDetails(item);
                  const hasDetails = Boolean(
                    item.parent_action_id
                    || details.sourceName
                    || details.publishedAt
                    || details.credibilityHint
                    || details.tags?.length
                    || details.reaction,
                  );
                  const detailsExpanded = expandedActionIds.has(item.id);
                  const detailsId = `${contentId}-${item.id}-details`;
                  return (
                  <li key={item.id}>
                    <article className={`action-ledger__card action-ledger__card--${item.action_type.toLowerCase()}`}>
                      <span className="action-ledger__meta"><strong>{t(`action_ledger.type_${item.action_type.toLowerCase()}`)}</strong><span>#{item.sequence}</span><span>{item.agent.name}</span><span>{t('action_ledger.round', { round: item.round })}</span></span>
                      <span className={`action-ledger__status action-ledger__status--${item.status}`}>{t(`action_ledger.status_${item.status}`)}</span>
                      {item.content && <span className="action-ledger__body">{item.content}</span>}
                      {item.target && <span className="action-ledger__target">{t('action_ledger.target', { target: `${item.target.kind}:${item.target.id}` })}</span>}
                      {item.failure_code && <span className="action-ledger__failure">{t('action_ledger.failure_code', { code: item.failure_code })}</span>}
                      <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
                      <span className="action-ledger__actions">
                        <button
                          type="button"
                          className="action-ledger__details-toggle"
                          aria-expanded={detailsExpanded}
                          aria-controls={detailsId}
                          onClick={() => toggleActionDetails(item.id)}
                        >
                          {t('action_ledger.details')}
                        </button>
                        {onSelectAction && (
                          <button
                            type="button"
                            className="action-ledger__select"
                            onClick={() => onSelectAction({ branchId: item.branch_id, round: item.round, agent: item.agent, actionId: item.id })}
                            aria-label={t('action_ledger.entry_aria', { type: item.action_type, agent: item.agent.name, round: item.round })}
                          >
                            {t('action_ledger.open_context', 'Open context')}
                          </button>
                        )}
                      </span>
                      {detailsExpanded && (
                        <dl id={detailsId} className="action-ledger__details">
                          {item.parent_action_id && <><dt>{t('action_ledger.parent_action', 'Parent action')}</dt><dd>{item.parent_action_id}</dd></>}
                          {details.sourceName && <><dt>{t('action_ledger.source_name', 'Source')}</dt><dd>{details.sourceName}</dd></>}
                          {details.publishedAt && <><dt>{t('action_ledger.published_at', 'Published at')}</dt><dd>{details.publishedAt}</dd></>}
                          {details.credibilityHint && <><dt>{t('action_ledger.credibility_hint', 'Credibility')}</dt><dd>{details.credibilityHint}</dd></>}
                          {details.tags && <><dt>{t('action_ledger.tags', 'Tags')}</dt><dd>{details.tags.join(', ')}</dd></>}
                          {details.reaction && <><dt>{t('action_ledger.reaction', 'Reaction')}</dt><dd>{details.reaction}</dd></>}
                          {!hasDetails && <><dt>{t('action_ledger.details')}</dt><dd>{t('action_ledger.none')}</dd></>}
                        </dl>
                      )}
                    </article>
                  </li>
                  );
                })}
              </ol>
              {loadMoreError && <p role="alert">{t('action_ledger.load_more_error')}</p>}
              {nextCursor && <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>{loadingMore ? t('action_ledger.loading_more') : t('action_ledger.load_more')}</button>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default ActionLedgerPanel;
