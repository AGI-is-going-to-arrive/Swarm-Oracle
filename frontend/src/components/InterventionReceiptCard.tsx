/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Intervention Receipt Card (Phase 4)
   ═══════════════════════════════════════════════════════════
   Renders persisted intervention effect receipts (newest first).
   Internal ids never reach the visible UI; replay/read-only paths
   only render already-persisted receipts and never imply a new
   intervention is running.
   ═══════════════════════════════════════════════════════════ */

import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getInterventionEffects } from '../api/client';
import type { InterventionEffect } from '../api/client';
import { getGameplayCardLabel, isGameplayCardId } from './gameplayCards';

import './InterventionReceiptCard.css';

export interface InterventionReceiptCardProps {
  scenarioId: string;
  /** Hide the card while the simulation is mid-flight; only show after completion. */
  enabled: boolean;
  /** Refresh nonce: bump to trigger a re-fetch (e.g. on new WS intervention_applied). */
  refreshKey?: number;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

function formatConfidenceLabel(t: ReturnType<typeof useTranslation>['t'], value: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  if (clamped >= 0.66) {
    return t('intervention_receipt.confidence_high');
  }
  if (clamped >= 0.33) {
    return t('intervention_receipt.confidence_medium');
  }
  if (clamped > 0) {
    return t('intervention_receipt.confidence_low');
  }
  return t('intervention_receipt.confidence_none');
}

export function InterventionReceiptCard({
  scenarioId,
  enabled,
  refreshKey = 0,
}: InterventionReceiptCardProps): ReactElement | null {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const [effects, setEffects] = useState<InterventionEffect[]>([]);
  const [state, setState] = useState<LoadState>('idle');
  const [stateScenarioId, setStateScenarioId] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !scenarioId) {
      return;
    }
    let cancelled = false;
    // Mark as loading via microtask so this stays out of the synchronous
    // useEffect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setStateScenarioId(scenarioId);
      setState('loading');
    });
    getInterventionEffects(scenarioId)
      .then((payload) => {
        if (cancelled) return;
        const list = Array.isArray(payload?.effects) ? payload.effects : [];
        setEffects(list);
        setStateScenarioId(scenarioId);
        setState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setEffects([]);
        setStateScenarioId(scenarioId);
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, scenarioId, refreshKey]);

  // Reset visible receipts when the card is disabled (e.g. scenario swap).
  useEffect(() => {
    if (enabled && scenarioId) return;
    void Promise.resolve().then(() => {
      setEffects([]);
      setStateScenarioId(null);
      setState('idle');
    });
  }, [enabled, scenarioId]);

  const sortedEffects = useMemo(() => {
    // Server already returns newest-first; defensively re-sort by created_at just in case.
    return [...effects].sort((a, b) => {
      if (!a.created_at && !b.created_at) return 0;
      if (!a.created_at) return 1;
      if (!b.created_at) return -1;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [effects]);

  if (!enabled || !scenarioId) {
    return null;
  }
  const hasCurrentScenarioState = stateScenarioId === scenarioId;
  if (state === 'loading' && hasCurrentScenarioState) {
    return (
      <section
        className="intervention-receipt-card intervention-receipt-card--loading"
        aria-busy="true"
        aria-live="polite"
        data-testid="intervention-receipt-card-loading"
      >
        <header className="intervention-receipt-card__header">
          <h3 className="intervention-receipt-card__title">
            {t('intervention_receipt.title')}
          </h3>
        </header>
        <p className="intervention-receipt-card__hint">
          {t('intervention_receipt.loading')}
        </p>
      </section>
    );
  }
  if (state === 'error' && hasCurrentScenarioState) {
    return (
      <section
        className="intervention-receipt-card intervention-receipt-card--error"
        role="status"
        aria-live="polite"
        data-testid="intervention-receipt-card-error"
      >
        <header className="intervention-receipt-card__header">
          <h3 className="intervention-receipt-card__title">
            {t('intervention_receipt.title')}
          </h3>
        </header>
        <p className="intervention-receipt-card__hint">
          {t('intervention_receipt.error')}
        </p>
      </section>
    );
  }
  if (
    state !== 'ready' ||
    !hasCurrentScenarioState ||
    sortedEffects.length === 0
  ) {
    return null;
  }

  return (
    <section
      className="intervention-receipt-card"
      aria-label={t('intervention_receipt.title')}
      data-testid="intervention-receipt-card"
    >
      <header className="intervention-receipt-card__header">
        <h3 className="intervention-receipt-card__title">
          {t('intervention_receipt.title')}
        </h3>
        <p className="intervention-receipt-card__subtitle">
          {t('intervention_receipt.subtitle', { count: sortedEffects.length })}
        </p>
      </header>
      <ol className="intervention-receipt-card__list">
        {sortedEffects.map((effect, index) => {
          const cardLabel = isGameplayCardId(effect.card_id)
            ? getGameplayCardLabel(effect.card_id, isZh)
            : effect.card_label;
          const heading =
            cardLabel
              ? t('intervention_receipt.entry_heading_card', {
                  card: cardLabel,
                  round: effect.round_number,
                })
              : t('intervention_receipt.entry_heading_plain', {
                  round: effect.round_number,
                });

          const confidenceLabel = formatConfidenceLabel(t, effect.confidence);
          return (
            <li
              className="intervention-receipt-card__entry"
              key={effect.intervention_log_id || `${effect.round_number}-${index}`}
            >
              <div className="intervention-receipt-card__entry-header">
                <h4 className="intervention-receipt-card__entry-heading">{heading}</h4>
                <span
                  className={
                    'intervention-receipt-card__confidence ' +
                    (effect.no_response_detected
                      ? 'intervention-receipt-card__confidence--silent'
                      : '')
                  }
                  data-testid="intervention-receipt-card-confidence"
                >
                  {confidenceLabel}
                </span>
              </div>
              {effect.no_response_detected ? (
                <p className="intervention-receipt-card__no-response">
                  {t('intervention_receipt.no_response')}
                </p>
              ) : (
                <>
                  <p className="intervention-receipt-card__affected-line">
                    {t('intervention_receipt.affected_agents', {
                      count: effect.affected_agents.length,
                      names: effect.affected_agents
                        .map((entry) => entry.display_name)
                        .filter(Boolean)
                        .join(', '),
                    })}
                  </p>
                  <ul className="intervention-receipt-card__excerpts">
                    {effect.response_excerpts.map((excerpt) => {
                      const speaker =
                        effect.affected_agents.find(
                          (entry) => entry.agent_id === excerpt.agent_id,
                        )?.display_name || '';
                      return (
                        <li
                          className="intervention-receipt-card__excerpt"
                          key={`${effect.intervention_log_id}-${excerpt.agent_id}`}
                        >
                          {speaker ? (
                            <span className="intervention-receipt-card__speaker">
                              {speaker}
                            </span>
                          ) : null}
                          <span className="intervention-receipt-card__quote">
                            {excerpt.excerpt}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default InterventionReceiptCard;
