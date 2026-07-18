import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  deltaDirection,
  domainReasonI18nKey,
  domainVariableLabel,
  formatDomainUnitValue,
  formatPredicateActualExpected,
  hasRenderableIdleReasons,
  isTruncatedRefFamily,
  localizeDomainUnit,
  normalizeDomainWorldProjection,
  pickBranchState,
  selectStripVariables,
  thresholdsForVariable,
} from '../../lib/domainWorld';
import type {
  DomainOpportunityThresholdRule,
  DomainWorldProjection,
} from '../../types';
import './DomainWorldStrip.css';

const MAX_PROVENANCE_SOURCES = 3;

export interface DomainWorldStripProps {
  domainWorld?: DomainWorldProjection | null;
  branchId?: string | null;
  /** Reserved for result deep-link mode; strip remains presentation-only in v1. */
  readOnly?: boolean;
}

type OpenPanel =
  | { kind: 'provenance'; variableId: string }
  | { kind: 'threshold'; variableId: string }
  | null;

export function DomainWorldStrip({
  domainWorld,
  branchId = null,
}: DomainWorldStripProps) {
  const { t, i18n } = useTranslation();
  const isZh = Boolean(i18n?.language?.startsWith('zh'));
  const regionId = useId();
  const projection = useMemo(
    () => normalizeDomainWorldProjection(domainWorld),
    [domainWorld],
  );
  const branchState = useMemo(
    () => pickBranchState(projection, branchId),
    [projection, branchId],
  );
  const cards = useMemo(
    () => selectStripVariables(projection, branchId),
    [projection, branchId],
  );
  const thresholds = branchState?.opportunity_thresholds ?? null;
  const idleReasons = branchState?.latest_domain_idle_reasons ?? [];
  const idleCount = branchState?.latest_domain_idle_reason_count ?? 0;
  const idleTruncated = Boolean(branchState?.latest_domain_idle_reasons_truncated)
    || idleCount > idleReasons.length;
  const showIdlePanel = hasRenderableIdleReasons(branchState);

  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const topUnavailable = projection.status === 'unavailable';
  const branchUnavailable = !topUnavailable && branchState?.status === 'unavailable';
  const topReasonKey = domainReasonI18nKey(projection.reason_code);
  const branchReasonKey = domainReasonI18nKey(branchState?.reason_code);
  const thresholdUnavailable = thresholds?.status === 'unavailable';
  const thresholdReasonKey = domainReasonI18nKey(thresholds?.reason_code);

  const closePanel = useCallback(() => {
    const open = openPanel;
    setOpenPanel(null);
    if (open) {
      const triggerKey = `${open.kind}:${open.variableId}`;
      queueMicrotask(() => triggerRefs.current.get(triggerKey)?.focus());
    }
  }, [openPanel]);

  useEffect(() => {
    if (!openPanel) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePanel();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    queueMicrotask(() => dialogRef.current?.focus());
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [closePanel, openPanel]);

  const togglePanel = (panel: Exclude<OpenPanel, null>) => {
    setOpenPanel((current) => (
      current
      && current.kind === panel.kind
      && current.variableId === panel.variableId
        ? null
        : panel
    ));
  };

  const onCardKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    panel: Exclude<OpenPanel, null>,
  ) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      togglePanel(panel);
    }
  };

  const openCard = openPanel
    ? cards.find((card) => card.variable.variable_id === openPanel.variableId) ?? null
    : null;
  const openSources = openPanel?.kind === 'provenance' ? (openCard?.delta?.sources ?? []) : [];
  const openShownSources = openSources.slice(0, MAX_PROVENANCE_SOURCES);
  const openSourceIds = openCard?.delta?.source_action_ids ?? openSources.map((s) => s.action_id);
  const openSourceCount = typeof openCard?.delta?.source_action_count === 'number'
    ? openCard.delta.source_action_count
    : Math.max(openSourceIds.length, openSources.length);
  const openTruncated = openPanel?.kind === 'provenance' && isTruncatedRefFamily(
    openShownSources.length,
    openSourceCount,
    Boolean(openCard?.delta?.source_action_ids_truncated)
      || openSources.length > MAX_PROVENANCE_SOURCES,
  );
  const openThresholdRules: DomainOpportunityThresholdRule[] = openPanel?.kind === 'threshold'
    ? thresholdsForVariable(thresholds, openPanel.variableId)
    : [];

  const scaleByVariable = useMemo(() => {
    const map = new Map<string, number>();
    for (const variable of projection.variables) {
      map.set(variable.variable_id, typeof variable.scale === 'number' ? variable.scale : 0);
    }
    return map;
  }, [projection.variables]);

  const labelByVariable = useMemo(() => {
    const map = new Map<string, string>();
    for (const variable of projection.variables) {
      map.set(variable.variable_id, domainVariableLabel(variable, isZh));
    }
    return map;
  }, [isZh, projection.variables]);

  return (
    <section
      ref={rootRef}
      className="domain-world-strip"
      data-testid="domain-world-strip"
      aria-labelledby={regionId}
      aria-label={t('domain_world.region')}
    >
      <div className="domain-world-strip__header">
        <h3 id={regionId} className="domain-world-strip__title">
          {t('domain_world.title')}
        </h3>
        {projection.as_of_round != null && (
          <span className="domain-world-strip__meta">
            {t('domain_world.as_of_round', { round: projection.as_of_round })}
          </span>
        )}
      </div>

      {topUnavailable && (
        <div className="domain-world-strip__banner" role="status" data-testid="domain-world-unavailable">
          <strong>{t('domain_world.unavailable_title')}</strong>
          <span>{t(topReasonKey)}</span>
        </div>
      )}

      {branchUnavailable && (
        <div
          className="domain-world-strip__banner"
          role="status"
          data-testid="domain-world-branch-unavailable"
        >
          <strong>{t('domain_world.branch_unavailable_title')}</strong>
          <span>{t(branchReasonKey)}</span>
        </div>
      )}

      {!topUnavailable && !branchUnavailable && thresholds && thresholdUnavailable && (
        <div
          className="domain-world-strip__banner"
          role="status"
          data-testid="domain-world-threshold-unavailable"
        >
          <strong>{t('domain_world.threshold.unavailable_title')}</strong>
          <span>{t(thresholdReasonKey)}</span>
        </div>
      )}

      {!topUnavailable && !branchUnavailable && cards.length === 0 && (
        <p className="domain-world-strip__empty" role="status">
          {t('domain_world.no_active_variables')}
        </p>
      )}

      {!topUnavailable && !branchUnavailable && cards.length > 0 && (
        <ul className="domain-world-strip__cards">
          {cards.map((card) => {
            const label = domainVariableLabel(card.variable, isZh);
            const valueText = formatDomainUnitValue(
              card.value,
              card.unit,
              card.variable.scale ?? 0,
              isZh,
            );
            const unitLabel = localizeDomainUnit(card.unit, isZh);
            const delta = card.delta?.applied_delta ?? null;
            const direction = deltaDirection(delta);
            const variableRules = thresholdsForVariable(thresholds, card.variable.variable_id);
            const hasThresholds = thresholds?.status === 'active' && variableRules.length > 0;
            const allMet = hasThresholds && variableRules.every((rule) => rule.preconditions_met);
            const provenanceOpen = openPanel?.kind === 'provenance'
              && openPanel.variableId === card.variable.variable_id;
            const thresholdOpen = openPanel?.kind === 'threshold'
              && openPanel.variableId === card.variable.variable_id;
            const provenanceId = `${regionId}-${card.variable.variable_id}-provenance`;
            const thresholdId = `${regionId}-${card.variable.variable_id}-threshold`;
            const name = [
              label,
              valueText || t('domain_world.value_unknown'),
              delta ? t('domain_world.delta_value', { delta }) : t('domain_world.delta_none'),
            ].join(', ');
            return (
              <li key={card.variable.variable_id} className="domain-world-strip__card-item">
                <button
                  type="button"
                  ref={(node) => {
                    const key = `provenance:${card.variable.variable_id}`;
                    if (node) triggerRefs.current.set(key, node);
                    else triggerRefs.current.delete(key);
                  }}
                  className="domain-world-strip__card"
                  aria-expanded={provenanceOpen}
                  aria-controls={provenanceId}
                  aria-haspopup="dialog"
                  aria-label={name}
                  data-testid={`domain-world-card-${card.variable.variable_id}`}
                  onClick={() => togglePanel({ kind: 'provenance', variableId: card.variable.variable_id })}
                  onKeyDown={(event) => onCardKeyDown(
                    event,
                    { kind: 'provenance', variableId: card.variable.variable_id },
                  )}
                >
                  <span className="domain-world-strip__label">{label}</span>
                  <span className="domain-world-strip__value">
                    {valueText || t('domain_world.value_unknown')}
                  </span>
                  {unitLabel && !valueText.includes(unitLabel) && (
                    <span className="domain-world-strip__unit">{unitLabel}</span>
                  )}
                  <span className={`domain-world-strip__delta domain-world-strip__delta--${direction}`}>
                    {delta
                      ? t('domain_world.delta_value', { delta })
                      : t('domain_world.delta_none')}
                  </span>
                </button>
                {hasThresholds && (
                  <button
                    type="button"
                    ref={(node) => {
                      const key = `threshold:${card.variable.variable_id}`;
                      if (node) triggerRefs.current.set(key, node);
                      else triggerRefs.current.delete(key);
                    }}
                    className={[
                      'domain-world-strip__threshold-chip',
                      allMet
                        ? 'domain-world-strip__threshold-chip--met'
                        : 'domain-world-strip__threshold-chip--blocked',
                    ].join(' ')}
                    aria-expanded={thresholdOpen}
                    aria-controls={thresholdId}
                    aria-haspopup="dialog"
                    data-testid={`domain-world-threshold-chip-${card.variable.variable_id}`}
                    onClick={() => togglePanel({
                      kind: 'threshold',
                      variableId: card.variable.variable_id,
                    })}
                    onKeyDown={(event) => onCardKeyDown(
                      event,
                      { kind: 'threshold', variableId: card.variable.variable_id },
                    )}
                  >
                    {allMet
                      ? t('domain_world.threshold.chip_met', { count: variableRules.length })
                      : t('domain_world.threshold.chip_blocked', { count: variableRules.length })}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {openPanel?.kind === 'provenance' && openCard && !topUnavailable && !branchUnavailable && (
        <div
          ref={dialogRef}
          id={`${regionId}-${openCard.variable.variable_id}-provenance`}
          className="domain-world-strip__popover"
          role="dialog"
          tabIndex={-1}
          aria-modal="false"
          aria-label={t('domain_world.provenance_title')}
          data-testid="domain-world-provenance"
        >
          <h4>{t('domain_world.provenance_title')}</h4>
          {openShownSources.length > 0 ? (
            <>
              <dl>
                {openShownSources.map((source, index) => (
                  <div key={`${source.action_id}:${index}`} className="domain-world-strip__source-block">
                    <dt>{t('domain_world.provenance.agent')}</dt>
                    <dd>{source.agent_name || source.agent_id}</dd>
                    <dt>{t('domain_world.provenance.action_type')}</dt>
                    <dd>{source.action_type || t('domain_world.value_unknown')}</dd>
                    <dt>{t('domain_world.provenance.rule')}</dt>
                    <dd>{source.rule_id}</dd>
                    <dt>{t('domain_world.provenance.round')}</dt>
                    <dd>{openCard.delta?.round_number ?? t('domain_world.value_unknown')}</dd>
                    <dt>{t('domain_world.provenance.action_id')}</dt>
                    <dd>{source.action_id}</dd>
                  </div>
                ))}
              </dl>
              {openTruncated && (
                <p
                  className="domain-world-strip__truncation"
                  data-testid="domain-world-provenance-truncated"
                  role="status"
                >
                  {t('domain_world.refs_shown', {
                    shown: openShownSources.length,
                    total: openSourceCount,
                  })}
                </p>
              )}
            </>
          ) : (
            <p>{t('domain_world.provenance_empty')}</p>
          )}
          <button
            type="button"
            className="domain-world-strip__popover-close"
            onClick={closePanel}
          >
            {t('domain_world.provenance_close')}
          </button>
        </div>
      )}

      {openPanel?.kind === 'threshold' && !topUnavailable && !branchUnavailable && (
        <div
          ref={dialogRef}
          id={`${regionId}-${openPanel.variableId}-threshold`}
          className="domain-world-strip__popover"
          role="dialog"
          tabIndex={-1}
          aria-modal="false"
          aria-label={t('domain_world.threshold.dialog_title')}
          data-testid="domain-world-threshold-dialog"
        >
          <h4>{t('domain_world.threshold.dialog_title')}</h4>
          {openThresholdRules.length === 0 ? (
            <p className="domain-world-strip__empty" role="status">
              {t('domain_world.threshold.empty')}
            </p>
          ) : (
            <ul className="domain-world-strip__rule-list">
              {openThresholdRules.map((rule) => {
                const scale = scaleByVariable.get(rule.variable_id) ?? 0;
                return (
                  <li
                    key={rule.rule_id}
                    data-testid={`domain-world-threshold-rule-${rule.rule_id}`}
                  >
                    <strong>{rule.rule_id}</strong>
                    <span className="domain-world-strip__rule-meta">
                      {t('domain_world.threshold.rule_meta', {
                        action: rule.action_type,
                        status: rule.preconditions_met
                          ? t('domain_world.threshold.met')
                          : t('domain_world.threshold.not_met'),
                      })}
                    </span>
                    {rule.preconditions.length > 0 && (
                      <ul className="domain-world-strip__predicate-list">
                        {rule.preconditions.map((predicate, index) => {
                          const formatted = formatPredicateActualExpected(predicate, {
                            scale,
                            isZh,
                            variableLabel: labelByVariable.get(predicate.variable_id)
                              ?? predicate.variable_id,
                          });
                          return (
                            <li
                              key={`${rule.rule_id}:${predicate.variable_id}:${index}`}
                              data-testid={`domain-world-threshold-pred-${rule.rule_id}-${index}`}
                            >
                              {t('domain_world.threshold.predicate_line', {
                                variable: formatted.variableLabel,
                                actual: formatted.actual || t('domain_world.value_unknown'),
                                expected: formatted.expected || t('domain_world.value_unknown'),
                                comparator: formatted.comparator,
                                met: predicate.met
                                  ? t('domain_world.threshold.met')
                                  : t('domain_world.threshold.not_met'),
                              })}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {thresholds?.status === 'active' && thresholds.rules_truncated && (
            <p className="domain-world-strip__truncation" role="status" data-testid="domain-world-threshold-truncated">
              {t('domain_world.refs_shown', {
                shown: thresholds.rules.length,
                total: thresholds.rule_count,
              })}
            </p>
          )}
          <button
            type="button"
            className="domain-world-strip__popover-close"
            onClick={closePanel}
          >
            {t('domain_world.provenance_close')}
          </button>
        </div>
      )}

      {showIdlePanel && !topUnavailable && !branchUnavailable && (
        <div
          className="domain-world-strip__banner"
          data-testid="domain-world-idle-reasons"
          role="region"
          aria-label={t('domain_world.idle.region')}
        >
          <strong>{t('domain_world.idle.title')}</strong>
          <ul className="domain-world-strip__idle-list">
            {idleReasons.map((item) => (
              <li
                key={`${item.action_id}:${item.agent_id}:${item.round_number}`}
                data-testid={`domain-world-idle-item-${item.action_id}`}
              >
                {t('domain_world.idle.item_line', {
                  round: item.round_number,
                  agent: item.agent_id,
                  rules: item.blocked_rule_ids.length > 0
                    ? item.blocked_rule_ids.join(', ')
                    : t('domain_world.value_unknown'),
                })}
              </li>
            ))}
          </ul>
          {idleTruncated && (
            <p className="domain-world-strip__truncation" role="status" data-testid="domain-world-idle-truncated">
              {t('domain_world.refs_shown', {
                shown: idleReasons.length,
                total: idleCount,
              })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default DomainWorldStrip;
