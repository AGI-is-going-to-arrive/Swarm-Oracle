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
import type { InterventionLifecycleState } from '../stores/simulationStore';
import { getGameplayCardLabel, isGameplayCardId } from './gameplayCards';

import './InterventionReceiptCard.css';

export interface InterventionReceiptCardProps {
  scenarioId: string;
  /** Whether persisted receipts may be loaded for this scenario. */
  enabled: boolean;
  /** Terminal runs may briefly return queued receipts while settlement finishes. */
  terminal?: boolean;
  /** Refresh token: bump/change to trigger a re-fetch. */
  refreshKey?: number | string;
  /** Live intervention state map to display pending interventions. */
  interventionLifecycle?: Map<string, InterventionLifecycleState>;
  onRefundConfirmed?: () => void;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
const SETTLEMENT_RETRY_DELAYS = [500, 1500, 3000] as const;

const RECEIPT_REASON_KEYS: Record<string, string | null> = {
  'Waiting for the next available simulation round.': null,
  'Applied to the simulation round.': null,
  'No remaining simulation round can apply this intervention.': null,
  'Intervention processing failed before completion.': null,
  'Intervention processing failed.': null,
  'Applied to persisted agent responses before processing stopped.': 'intervention_receipt.reason_applied_partial',
  'Applied to persisted responses before this snapshot.': 'intervention_receipt.reason_snapshot_applied',
  'Imported snapshots do not resume queued interventions.': 'intervention_receipt.reason_snapshot_no_resume',
  'Scenario is cancelled; no remaining round can apply this intervention.': 'intervention_receipt.reason_scenario_cancelled',
  'Scenario is error; no remaining round can apply this intervention.': 'intervention_receipt.reason_scenario_error',
  'Branch is completed; this intervention cannot run.': 'intervention_receipt.reason_branch_completed',
  'Branch is pruned; this intervention cannot run.': 'intervention_receipt.reason_branch_pruned',
};

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
  terminal = false,
  refreshKey = 0,
  interventionLifecycle,
  onRefundConfirmed,
}: InterventionReceiptCardProps): ReactElement | null {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const [effects, setEffects] = useState<InterventionEffect[]>([]);
  const [effectsScenarioId, setEffectsScenarioId] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('idle');
  const [stateScenarioId, setStateScenarioId] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const lifecycleKey = JSON.stringify(Array.from(interventionLifecycle ?? []).sort(([left], [right]) => left.localeCompare(right)));

  const pendingInterventions = useMemo(() => {
    const pending: { id: string; state: string }[] = [];
    const persistedIds = new Set(effectsScenarioId === scenarioId ? effects.map((effect) => effect.intervention_log_id) : []);
    if (interventionLifecycle) {
      Array.from(interventionLifecycle.entries()).forEach(([id, state]) => {
        if ((state === 'queued' || state === 'injected') && !persistedIds.has(id)) {
          pending.push({ id, state });
        }
      });
    }
    return pending;
  }, [interventionLifecycle, effects, effectsScenarioId, scenarioId]);

  useEffect(() => {
    if (!enabled || !scenarioId) {
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const lifecycleEntries = JSON.parse(lifecycleKey) as Array<[string, InterventionLifecycleState]>;
    // Mark as loading via microtask so this stays out of the synchronous
    // useEffect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setStateScenarioId(scenarioId);
      setState('loading');
    });
    const loadReceipts = async (attempt = 0): Promise<void> => {
      try {
        const payload = await getInterventionEffects(scenarioId);
        if (cancelled) return;
        const list = Array.isArray(payload?.effects) ? payload.effects : [];
        setEffects(list);
        setEffectsScenarioId(scenarioId);
        setStateScenarioId(scenarioId);
        setState('ready');
        if (list.some((effect) => (effect.refunded_points ?? 0) > 0 || effect.gameplay_usage_refunded)) {
          onRefundConfirmed?.();
        }
        const persistedIds = new Set(list.map((effect) => effect.intervention_log_id));
        const missingLiveReceipt = lifecycleEntries.some(([id, lifecycle]) => (
          (lifecycle === 'queued' || lifecycle === 'injected') && !persistedIds.has(id)
        ));
        if (terminal && (missingLiveReceipt || list.some((effect) => effect.status === 'queued')) && attempt < SETTLEMENT_RETRY_DELAYS.length) {
          retryTimer = setTimeout(() => void loadReceipts(attempt + 1), SETTLEMENT_RETRY_DELAYS[attempt]);
        }
      } catch {
        if (cancelled) return;
        setStateScenarioId(scenarioId);
        setState('error');
      }
    };
    void loadReceipts();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [enabled, scenarioId, refreshKey, terminal, retryNonce, lifecycleKey, onRefundConfirmed]);

  const sortedEffects = useMemo(() => {
    // Server already returns newest-first; defensively re-sort by created_at just in case.
    return (effectsScenarioId === scenarioId ? [...effects] : []).sort((a, b) => {
      if (!a.created_at && !b.created_at) return 0;
      if (!a.created_at) return 1;
      if (!b.created_at) return -1;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [effects, effectsScenarioId, scenarioId]);

  const pendingCount = pendingInterventions.length + sortedEffects.filter((effect) => effect.status === 'queued').length;
  const hasPending = pendingCount > 0;
  const subtitle = hasPending
    ? t('intervention_receipt.subtitle_pending', { count: pendingCount })
    : t('intervention_receipt.subtitle', { count: sortedEffects.length });

  if ((!enabled && !hasPending) || !scenarioId) {
    return null;
  }
  const hasCurrentScenarioState = stateScenarioId === scenarioId || hasPending;
  if (state === 'loading' && hasCurrentScenarioState && !hasPending && sortedEffects.length === 0) {
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
  if (state === 'error' && hasCurrentScenarioState && !hasPending && sortedEffects.length === 0) {
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
        <button type="button" className="btn btn-ghost" onClick={() => setRetryNonce((current) => current + 1)}>
          {t('common.retry')}
        </button>
      </section>
    );
  }
  if (
    (state !== 'ready' && !hasPending && sortedEffects.length === 0) ||
    !hasCurrentScenarioState ||
    (sortedEffects.length === 0 && !hasPending)
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
          {subtitle}
        </p>
      </header>
      {state === 'error' && (
        <p role="alert" className="intervention-receipt-card__hint">{t('intervention_receipt.error')}</p>
      )}
      {terminal && hasPending && (
        <p role="status" className="intervention-receipt-card__hint">{t('intervention_receipt.final_pending')}</p>
      )}
      {(state === 'error' || (terminal && hasPending)) && (
        <button type="button" className="btn btn-ghost" disabled={state === 'loading'} onClick={() => setRetryNonce((current) => current + 1)}>
          {t('common.retry')}
        </button>
      )}
      <ol className="intervention-receipt-card__list">
        {pendingInterventions.map((pi) => (
          <li key={pi.id} className="intervention-receipt-card__entry receipt-pending">
            <h4 className="intervention-receipt-card__entry-heading">
              {!terminal && <span className="spinner-inline" aria-hidden="true" />}
              {t(terminal ? 'intervention_receipt.awaiting_final'
                : pi.state === 'queued' ? 'intervention_receipt.status_queued' : 'intervention_receipt.loading')}
            </h4>
          </li>
        ))}
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
          const receiptStatus = effect.status ?? 'applied';
          const applied = receiptStatus === 'applied';
          const reasonKey = effect.reason ? RECEIPT_REASON_KEYS[effect.reason] : null;
          return (
            <li
              className="intervention-receipt-card__entry"
              data-status={receiptStatus}
              key={effect.intervention_log_id || `${effect.round_number}-${index}`}
            >
              <div className="intervention-receipt-card__entry-header">
                <h4 className="intervention-receipt-card__entry-heading">{heading}</h4>
                <span className="intervention-receipt-card__hint">{t(`intervention_receipt.status_${receiptStatus}`)}</span>
                {applied && <span
                  className={
                    'intervention-receipt-card__confidence ' +
                    (effect.no_response_detected
                      ? 'intervention-receipt-card__confidence--silent'
                      : '')
                  }
                  data-testid="intervention-receipt-card-confidence"
                >
                  {confidenceLabel}
                </span>}
              </div>
              {!applied && (
                <p className="intervention-receipt-card__hint">
                  {t(`intervention_receipt.${receiptStatus}_hint`)}
                </p>
              )}
              {reasonKey && <p className="intervention-receipt-card__hint">{t(reasonKey)}</p>}
              {reasonKey === undefined && effect.reason && (
                <details>
                  <summary>{t('intervention_receipt.server_reason')}</summary>
                  <p>{effect.reason}</p>
                </details>
              )}
              {(effect.refunded_points ?? 0) > 0 && (
                <p className="intervention-receipt-card__hint">{t('intervention_receipt.refunded_points', { count: effect.refunded_points })}</p>
              )}
              {effect.gameplay_usage_refunded && (
                <p className="intervention-receipt-card__hint">{t('intervention_receipt.usage_refunded')}</p>
              )}
              {applied && (effect.no_response_detected ? (
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
              ))}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default InterventionReceiptCard;
