/**
 * S2-1 — ConversationHistoryPicker.
 *
 * Shared "Load history" UI used by EndingChatModal, RoundtableAgentChat, and
 * NodeConversationSheet to reload past Agent Conversation threads for the
 * given scenario. Calls:
 *   - GET /api/scenario/{id}/conversations  (list, cursor-paginated)
 *   - GET /api/conversation/{thread_id}     (full turn history)
 *
 * The component owns its own state (open/loading/list/error/cursor); the
 * caller only supplies `scenarioId` + `onSelect`. `onSelect` receives the
 * fully loaded thread detail so the host can hydrate its own message store.
 *
 * UX:
 *   - "Load history" toggle button reveals the inline picker.
 *   - Skeleton placeholders during the list fetch (no spinner).
 *   - Per-row skeleton placeholder while the picked thread loads.
 *   - "Load more" appended when `has_more=true`.
 *   - Empty/error states use distinct copy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type ConversationDetail,
  type ConversationListItem,
  getConversation,
  getScenarioConversations,
} from '../api/client';
import './ConversationHistoryPicker.css';
import { formatUiDateTime } from '../i18n/language';

const PAGE_LIMIT = 20;
const SKELETON_ROWS = 4;

export interface ConversationHistoryPickerProps {
  /** Scenario id to list conversation threads for. */
  scenarioId: string;
  /**
   * Optional filter: restrict the list to threads whose `origin_node_type`
   * matches one of the supplied values. Filtering is applied client-side
   * after the page is fetched so cursor pagination still works.
   */
  filterNodeTypes?: readonly string[];
  /** Optional className for the outer container. */
  className?: string;
  /**
   * Called when a thread is fully loaded (list metadata + turn history).
   * Host should hydrate its message store from `detail.turns`.
   */
  onSelect: (detail: ConversationDetail, summary: ConversationListItem) => void;
  /** Optional override for the toggle button label. */
  toggleLabel?: string;
  /**
   * When true the picker is rendered always-open (no toggle button). Used
   * inside the NodeConversationSheet where the sheet itself is the toggle.
   */
  alwaysOpen?: boolean;
}

interface ListPageState {
  items: ConversationListItem[];
  cursor: number;
  hasMore: boolean;
}

export function ConversationHistoryPicker({
  scenarioId,
  filterNodeTypes,
  className,
  onSelect,
  toggleLabel,
  alwaysOpen = false,
}: ConversationHistoryPickerProps) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState<boolean>(alwaysOpen);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState<ListPageState | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const filterKey = useMemo(() => stableFilterKey(filterNodeTypes), [filterNodeTypes]);
  const contextKey = `${scenarioId}::${filterKey}`;
  const currentContextKeyRef = useRef(contextKey);
  const listRequestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  currentContextKeyRef.current = contextKey;

  const filteredItems = filterItems(page?.items ?? [], filterNodeTypes);

  const fetchPage = useCallback(
    async (cursor: number, append: boolean): Promise<void> => {
      const requestId = listRequestIdRef.current + 1;
      listRequestIdRef.current = requestId;
      const requestContextKey = contextKey;
      setLoading(true);
      setListError(null);
      try {
        const response = await getScenarioConversations(scenarioId, cursor, PAGE_LIMIT);
        if (
          requestId !== listRequestIdRef.current ||
          requestContextKey !== currentContextKeyRef.current
        ) {
          return;
        }
        setPage((prev) => {
          const merged = append && prev ? [...prev.items, ...response.items] : response.items;
          return {
            items: merged,
            cursor: response.cursor,
            hasMore: response.has_more,
          };
        });
      } catch (err) {
        if (
          requestId !== listRequestIdRef.current ||
          requestContextKey !== currentContextKeyRef.current
        ) {
          return;
        }
        setListError((err as Error).message || 'load_failed');
      } finally {
        if (
          requestId === listRequestIdRef.current &&
          requestContextKey === currentContextKeyRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [contextKey, scenarioId],
  );

  const handleToggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && page === null && !loading) {
      void fetchPage(0, false);
    }
  }, [fetchPage, loading, open, page]);

  useEffect(() => {
    listRequestIdRef.current += 1;
    detailRequestIdRef.current += 1;
    setLoading(false);
    setPage(null);
    setListError(null);
    setLoadingThreadId(null);
    setThreadError(null);
  }, [contextKey]);

  // Auto-fetch when open and not yet loaded.
  useEffect(() => {
    if (open && page === null && !loading && !listError) {
      void fetchPage(0, false);
    }
  }, [fetchPage, listError, loading, open, page]);

  const handleSelectThread = useCallback(
    async (item: ConversationListItem): Promise<void> => {
      const requestId = detailRequestIdRef.current + 1;
      detailRequestIdRef.current = requestId;
      const requestContextKey = contextKey;
      setLoadingThreadId(item.thread_id);
      setThreadError(null);
      try {
        const detail = await getConversation(item.thread_id);
        if (
          requestId !== detailRequestIdRef.current ||
          requestContextKey !== currentContextKeyRef.current
        ) {
          return;
        }
        onSelect(detail, item);
      } catch (err) {
        if (
          requestId !== detailRequestIdRef.current ||
          requestContextKey !== currentContextKeyRef.current
        ) {
          return;
        }
        setThreadError((err as Error).message || 'load_failed');
      } finally {
        if (
          requestId === detailRequestIdRef.current &&
          requestContextKey === currentContextKeyRef.current
        ) {
          setLoadingThreadId(null);
        }
      }
    },
    [contextKey, onSelect],
  );

  const handleLoadMore = useCallback(() => {
    if (!page?.hasMore || loading) return;
    void fetchPage(page.cursor, true);
  }, [fetchPage, loading, page]);

  const handleRetry = useCallback(() => {
    void fetchPage(0, false);
  }, [fetchPage]);

  const showSkeletons = loading && page === null;
  const showEmpty =
    !loading && page !== null && filteredItems.length === 0 && !page.hasMore && !listError;
  const showLoadMore = page !== null && page.hasMore && !listError;

  return (
    <div
      className={['conversation-history-picker', className ?? ''].filter(Boolean).join(' ')}
      data-testid="conversation-history-picker"
    >
      {!alwaysOpen && (
        <button
          type="button"
          className="conversation-history-picker__toggle"
          aria-expanded={open}
          aria-controls={`conv-history-list-${scenarioId}`}
          onClick={handleToggle}
          data-testid="conversation-history-picker-toggle"
        >
          {toggleLabel ?? t('conversation.history.load_history')}
        </button>
      )}

      {open && (
        <div
          id={`conv-history-list-${scenarioId}`}
          className="conversation-history-picker__panel"
          role="region"
          aria-label={t('conversation.history.select_thread')}
        >
          {showSkeletons && (
            <ul className="conversation-history-picker__list" aria-busy="true">
              {Array.from({ length: SKELETON_ROWS }).map((_, idx) => (
                <li key={idx} className="conversation-history-picker__skeleton" aria-hidden="true">
                  <span className="conversation-history-picker__skeleton-bar conversation-history-picker__skeleton-bar--title" />
                  <span className="conversation-history-picker__skeleton-bar conversation-history-picker__skeleton-bar--meta" />
                </li>
              ))}
              <li className="sr-only" aria-live="polite">
                {t('conversation.history.loading')}
              </li>
            </ul>
          )}

          {listError && !loading && (
            <div className="conversation-history-picker__error" role="alert">
              <p>{t('conversation.history.load_failed')}</p>
              <button
                type="button"
                className="conversation-history-picker__retry"
                onClick={handleRetry}
              >
                {t('conversation.history.retry')}
              </button>
            </div>
          )}

          {showEmpty && (
            <p className="conversation-history-picker__empty" role="status">
              {t('conversation.history.no_history')}
            </p>
          )}

          {filteredItems.length > 0 && (
            <>
              <p className="conversation-history-picker__hint">
                {t('conversation.history.select_thread')}
              </p>
              <ul className="conversation-history-picker__list" role="list">
                {filteredItems.map((item) => {
                  const isLoading = loadingThreadId === item.thread_id;
                  return (
                    <li key={item.thread_id} className="conversation-history-picker__row">
                      <button
                        type="button"
                        className="conversation-history-picker__row-button"
                        disabled={isLoading || loadingThreadId !== null}
                        onClick={() => void handleSelectThread(item)}
                        data-testid={`conversation-history-picker-row-${item.thread_id}`}
                      >
                        <span className="conversation-history-picker__row-title">
                          {labelFor(item, t)}
                        </span>
                        <span className="conversation-history-picker__row-meta">
                          <span>{formatUiDateTime(item.created_at, i18n?.language)}</span>
                          <span>
                            {t('conversation.history.thread_count', {
                              count: item.last_turn_sequence,
                            })}
                          </span>
                        </span>
                        {isLoading && (
                          <span
                            className="conversation-history-picker__row-skeleton"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {threadError && (
                <p className="conversation-history-picker__error" role="alert">
                  {t('conversation.history.load_failed')}
                </p>
              )}
            </>
          )}

          {showLoadMore && (
            <button
              type="button"
              className="conversation-history-picker__load-more"
              onClick={handleLoadMore}
              disabled={loading}
            >
              {loading
                ? t('conversation.history.loading')
                : t('conversation.history.load_more')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function stableFilterKey(filterNodeTypes?: readonly string[]): string {
  if (!filterNodeTypes || filterNodeTypes.length === 0) return '';
  return JSON.stringify(Array.from(new Set(filterNodeTypes)).sort());
}

function filterItems(
  items: ConversationListItem[],
  filterNodeTypes?: readonly string[],
): ConversationListItem[] {
  if (!filterNodeTypes || filterNodeTypes.length === 0) return items;
  const allow = new Set(filterNodeTypes);
  return items.filter((item) => {
    const t = item.origin_node_type ?? '';
    return allow.has(t);
  });
}

function labelFor(
  item: ConversationListItem,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const nodeType = item.origin_node_type?.trim();
  const nodeId = item.origin_node_id?.trim();
  if (nodeType && nodeId) return `${nodeType} · ${nodeId}`;
  if (nodeType) return nodeType;
  if (nodeId) return nodeId;
  return t('conversation.history.untitled_thread');
}

export default ConversationHistoryPicker;
