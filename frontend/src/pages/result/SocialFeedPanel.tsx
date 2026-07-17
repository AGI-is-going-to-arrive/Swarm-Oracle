/* ═══════════════════════════════════════════════════════════
   F11 — SocialFeedPanel
   Displays timeline events and headline cards.
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import { getSocialFeed } from '../../api/client';
import type { SocialFeedResponse, SocialFeedEvent, SocialHeadlineCard } from '../../types';
import { SafeMarkdown } from '../../components/SafeMarkdown';
import './SocialFeedPanel.css';

const INITIAL_VISIBLE_EVENT_COUNT = 12;
const EVENT_BATCH_SIZE = 12;

interface SocialFeedPanelProps {
  scenarioId: string;
}

export default function SocialFeedPanel({ scenarioId }: SocialFeedPanelProps) {
  const { t, i18n } = useTranslation();
  const {
    enabled,
    loading: capLoading,
    error: capError,
    reload,
  } = useCapabilityCheck('social_headlines');

  const [feed, setFeed] = useState<SocialFeedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [visibleEventCount, setVisibleEventCount] = useState(INITIAL_VISIBLE_EVENT_COUNT);
  const fetchRequestIdRef = useRef(0);
  const primaryEventToggleRef = useRef<HTMLButtonElement>(null);
  const restoreEventToggleFocusRef = useRef(false);

  const formatEventType = useCallback((eventType: string): string => {
    const fallback = typeof eventType === 'string' ? eventType.trim() : '';
    const normalizedType = fallback
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const key = `social_feed.event_types.${normalizedType}`;
    return fallback && i18n.exists(key) ? t(key) : fallback;
  }, [i18n, t]);

  const fetchData = useCallback(async () => {
    if (!scenarioId) return;
    const requestId = ++fetchRequestIdRef.current;
    setLoading(true);
    setFetchError(false);
    try {
      const res = await getSocialFeed(scenarioId);
      if (requestId !== fetchRequestIdRef.current) return;
      setFeed(res);
      setVisibleEventCount(INITIAL_VISIBLE_EVENT_COUNT);
    } catch {
      if (requestId !== fetchRequestIdRef.current) return;
      // RED LINE: SHORT message only, no secrets / token / URLs
      console.error('[SocialFeedPanel] Failed to fetch social feed');
      setFetchError(true);
    } finally {
      if (requestId === fetchRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [scenarioId]);

  useEffect(() => {
    if (!enabled || capLoading || capError) {
      return;
    }

    void fetchData();

    return () => {
      fetchRequestIdRef.current += 1;
    };
  }, [enabled, capLoading, capError, fetchData]);

  useEffect(() => {
    if (!restoreEventToggleFocusRef.current) return;
    restoreEventToggleFocusRef.current = false;
    primaryEventToggleRef.current?.focus();
  }, [visibleEventCount]);

  if (capLoading) {
    return (
      <div className="social-feed-skeleton" data-testid="social-feed-skeleton">
        <div className="social-feed-skeleton__header" />
        <div className="social-feed-skeleton__body" />
      </div>
    );
  }

  if (capError) {
    return (
      <section className="social-feed-panel social-feed-panel--error" aria-labelledby="social-feed-title">
        <h3 id="social-feed-title" className="social-feed-panel__title">{t('social_feed.section_title')}</h3>
        <p className="social-feed-panel__error-text">{t('social_feed.error')}</p>
        <button
          type="button"
          className="btn btn-ghost social-feed-panel__retry-btn"
          onClick={() => {
            if (reload) {
              void reload();
            }
          }}
          aria-label={t('social_feed.retry')}
        >
          {t('social_feed.retry')}
        </button>
      </section>
    );
  }

  if (!enabled) {
    return (
      <div className="social-feed-disabled-placeholder" data-testid="social-feed-disabled">
        {t('social_feed.disabled_explanation')}
      </div>
    );
  }

  if (fetchError) {
    return (
      <section className="social-feed-panel social-feed-panel--error" aria-labelledby="social-feed-title">
        <h3 id="social-feed-title" className="social-feed-panel__title">{t('social_feed.section_title')}</h3>
        <p className="social-feed-panel__error-text">{t('social_feed.error')}</p>
        <button
          type="button"
          className="btn btn-ghost social-feed-panel__retry-btn"
          onClick={() => void fetchData()}
          aria-label={t('social_feed.retry')}
        >
          {t('social_feed.retry')}
        </button>
      </section>
    );
  }

  if (loading) {
    return (
      <div className="social-feed-skeleton" data-testid="social-feed-loading">
        <div className="social-feed-skeleton__header" />
        <div className="social-feed-skeleton__body" />
      </div>
    );
  }

  // Defend against null/undefined or non-array payloads
  const events: SocialFeedEvent[] = Array.isArray(feed?.events) ? feed.events : [];
  const headlines: SocialHeadlineCard[] = Array.isArray(feed?.headline_cards) ? feed.headline_cards : [];
  const hasContent = events.length > 0 || headlines.length > 0;

  if (!hasContent) {
    return (
      <section className="social-feed-panel" aria-labelledby="social-feed-title">
        <h3 id="social-feed-title" className="social-feed-panel__title">{t('social_feed.section_title')}</h3>
        <p className="social-feed-panel__empty" data-testid="social-feed-empty">{t('social_feed.empty')}</p>
      </section>
    );
  }

  const isDeterministic = feed?.generation_mode === 'deterministic';
  const boundedVisibleEventCount = Math.min(visibleEventCount, events.length);
  const visibleEvents = events.slice(0, boundedVisibleEventCount);
  const remainingEventCount = events.length - boundedVisibleEventCount;
  const hasHiddenEvents = remainingEventCount > 0;
  const isEventListExpanded = boundedVisibleEventCount > INITIAL_VISIBLE_EVENT_COUNT;
  const rawTotalEventCount = feed?.total_event_count;
  const hasValidTotalEventCount = typeof rawTotalEventCount === 'number'
    && Number.isSafeInteger(rawTotalEventCount)
    && rawTotalEventCount >= 0;
  const totalEventCount = hasValidTotalEventCount
    ? Math.max(events.length, rawTotalEventCount)
    : events.length;
  const hasConfirmedTruncation = feed?.events_truncated === true
    && hasValidTotalEventCount
    && totalEventCount > events.length;

  return (
    <section className="social-feed-panel" aria-labelledby="social-feed-title">
      <div className="social-feed-panel__header">
        <h3 id="social-feed-title" className="social-feed-panel__title">
          {t('social_feed.section_title')}
        </h3>
        {isDeterministic && (
          <span className="social-feed-panel__mode-badge" data-testid="deterministic-badge">
            {t('social_feed.mode_deterministic')}
          </span>
        )}
      </div>

      {hasConfirmedTruncation && (
        <p
          className="social-feed-panel__truncated-notice"
          data-testid="social-feed-truncated-notice"
          role="note"
        >
          {t('social_feed.truncated_notice', {
            loaded: events.length,
            total: totalEventCount,
            defaultValue:
              'This feed contains the latest {{loaded}} of {{total}} projected events. The Agent Action Ledger preserves complete native agent actions; older faction projections may be unavailable here.',
          })}
        </p>
      )}

      <div className="social-feed-panel__layout">
        {/* Headline Cards Section */}
        {headlines.length > 0 && (
          <div className="social-feed-headlines">
            <h4 className="social-feed-headlines__title">{t('social_feed.headlines_title')}</h4>
            <div className="social-feed-headlines__grid" role="list" aria-label={t('social_feed.aria_feed_list')}>
              {headlines.map((card) => (
                <div
                  key={card.card_id}
                  className="social-headline-card"
                  role="listitem"
                  aria-label={t('social_feed.aria_headline_card', { headline: card.headline })}
                >
                  <div className="social-headline-card__badge-row">
                    <span className="social-headline-card__faction">
                      {card.faction_label || t('social_feed.faction_label', 'Faction')}
                    </span>
                    <span className="social-headline-card__branch">{card.branch_title}</span>
                  </div>
                  <h5 className="social-headline-card__headline">{card.headline}</h5>
                  <p className="social-headline-card__summary">{card.summary}</p>
                  <div className="social-headline-card__footer">
                    <span className="social-headline-card__type">{formatEventType(card.event_type)}</span>
                    {card.round_number !== null && (
                      <span className="social-headline-card__round">
                        {t('social_feed.event_round', { round: card.round_number })}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Timeline Events Section */}
        {events.length > 0 && (
          <div className="social-feed-timeline">
            <ol className="social-feed-timeline__list">
              {visibleEvents.map((event) => (
                <li key={event.event_id} className="social-feed-event">
                  <div className="social-feed-event__dot" aria-hidden="true" />
                  <div className="social-feed-event__content">
                    <div className="social-feed-event__header">
                      <span className="social-feed-event__round">
                        {t('social_feed.event_round', { round: event.round_number })}
                      </span>
                      <span className="social-feed-event__type">{formatEventType(event.event_type)}</span>
                      <span className="social-feed-event__faction">{event.faction_label}</span>
                      {event.confidence !== null && (
                        <span className="social-feed-event__confidence">
                          {t('social_feed.confidence_label')}: {Math.round(event.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    <div className="social-feed-event__branch">{event.branch_title}</div>
                    <div className="social-feed-event__summary">
                      <SafeMarkdown>{event.summary}</SafeMarkdown>
                    </div>
                  </div>
                </li>
              ))}
            </ol>

            {(events.length > INITIAL_VISIBLE_EVENT_COUNT || hasConfirmedTruncation) && (
              <div className="social-feed-timeline__controls">
                <p
                  className="social-feed-timeline__count"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {hasConfirmedTruncation
                    ? t('social_feed.event_count_truncated', {
                        visible: boundedVisibleEventCount,
                        loaded: events.length,
                        total: totalEventCount,
                      })
                    : t('social_feed.event_count', {
                        visible: boundedVisibleEventCount,
                        total: events.length,
                      })}
                </p>
                {events.length > INITIAL_VISIBLE_EVENT_COUNT && (
                  <div className="social-feed-timeline__actions">
                    <button
                      ref={primaryEventToggleRef}
                      type="button"
                      className="btn btn-ghost social-feed-timeline__toggle"
                      onClick={() => {
                        if (hasHiddenEvents) {
                          setVisibleEventCount((currentCount) => (
                            Math.min(currentCount + EVENT_BATCH_SIZE, events.length)
                          ));
                        } else {
                          setVisibleEventCount(INITIAL_VISIBLE_EVENT_COUNT);
                        }
                      }}
                      aria-expanded={isEventListExpanded}
                    >
                      {hasHiddenEvents
                        ? t('social_feed.show_more', { count: remainingEventCount })
                        : t('social_feed.show_first', { count: INITIAL_VISIBLE_EVENT_COUNT })}
                    </button>
                    {isEventListExpanded && hasHiddenEvents && (
                      <button
                        type="button"
                        className="btn btn-ghost social-feed-timeline__toggle"
                        onClick={() => {
                          restoreEventToggleFocusRef.current = true;
                          setVisibleEventCount(INITIAL_VISIBLE_EVENT_COUNT);
                        }}
                      >
                        {t('social_feed.show_first', { count: INITIAL_VISIBLE_EVENT_COUNT })}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
