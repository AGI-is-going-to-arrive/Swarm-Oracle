/* ═══════════════════════════════════════════════════════════
   F11 — SocialFeedPanel
   Displays timeline events and headline cards.
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import { getSocialFeed } from '../../api/client';
import type { SocialFeedResponse, SocialFeedEvent, SocialHeadlineCard } from '../../types';
import './SocialFeedPanel.css';

interface SocialFeedPanelProps {
  scenarioId: string;
}

export default function SocialFeedPanel({ scenarioId }: SocialFeedPanelProps) {
  const { t } = useTranslation();
  const {
    enabled,
    loading: capLoading,
    error: capError,
    reload,
  } = useCapabilityCheck('social_headlines');

  const [feed, setFeed] = useState<SocialFeedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  const fetchData = useCallback(async (activeSignal: { active: boolean }) => {
    if (!scenarioId) return;
    setLoading(true);
    setFetchError(false);
    try {
      const res = await getSocialFeed(scenarioId);
      if (!activeSignal.active) return;
      setFeed(res);
    } catch {
      if (!activeSignal.active) return;
      // RED LINE: SHORT message only, no secrets / token / URLs
      console.error('[SocialFeedPanel] Failed to fetch social feed');
      setFetchError(true);
    } finally {
      if (activeSignal.active) {
        setLoading(false);
      }
    }
  }, [scenarioId]);

  useEffect(() => {
    if (!enabled || capLoading || capError) {
      return;
    }

    const activeSignal = { active: true };
    void fetchData(activeSignal);

    return () => {
      activeSignal.active = false;
    };
  }, [enabled, capLoading, capError, fetchData]);

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
          onClick={() => {
            const activeSignal = { active: true };
            void fetchData(activeSignal);
          }}
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
                      {card.faction_label || t('social_feed.confidence_label', 'Faction')}
                    </span>
                    <span className="social-headline-card__branch">{card.branch_title}</span>
                  </div>
                  <h5 className="social-headline-card__headline">{card.headline}</h5>
                  <p className="social-headline-card__summary">{card.summary}</p>
                  <div className="social-headline-card__footer">
                    <span className="social-headline-card__type">{card.event_type}</span>
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
              {events.map((event) => (
                <li key={event.event_id} className="social-feed-event">
                  <div className="social-feed-event__dot" aria-hidden="true" />
                  <div className="social-feed-event__content">
                    <div className="social-feed-event__header">
                      <span className="social-feed-event__round">
                        {t('social_feed.event_round', { round: event.round_number })}
                      </span>
                      <span className="social-feed-event__type">{event.event_type}</span>
                      <span className="social-feed-event__faction">{event.faction_label}</span>
                      {event.confidence !== null && (
                        <span className="social-feed-event__confidence">
                          {t('social_feed.confidence_label')}: {Math.round(event.confidence * 100)}%
                        </span>
                      )}
                    </div>
                    <div className="social-feed-event__branch">{event.branch_title}</div>
                    <p className="social-feed-event__summary">{event.summary}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </section>
  );
}
