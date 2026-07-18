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
  formatDomainValue,
  isTruncatedRefFamily,
  normalizeDomainWorldProjection,
  pickBranchState,
  selectStripVariables,
} from '../../lib/domainWorld';
import type { DomainWorldProjection } from '../../types';
import './DomainWorldStrip.css';

const MAX_PROVENANCE_SOURCES = 3;

export interface DomainWorldStripProps {
  domainWorld?: DomainWorldProjection | null;
  branchId?: string | null;
  /** Reserved for result deep-link mode; strip remains presentation-only in v1. */
  readOnly?: boolean;
}

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
  const [openVariableId, setOpenVariableId] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const topUnavailable = projection.status === 'unavailable';
  const branchUnavailable = !topUnavailable && branchState?.status === 'unavailable';
  const topReasonKey = domainReasonI18nKey(projection.reason_code);
  const branchReasonKey = domainReasonI18nKey(branchState?.reason_code);

  const closePopover = useCallback(() => {
    const openId = openVariableId;
    setOpenVariableId(null);
    if (openId) {
      queueMicrotask(() => triggerRefs.current.get(openId)?.focus());
    }
  }, [openVariableId]);

  useEffect(() => {
    if (!openVariableId) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePopover();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePopover();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    queueMicrotask(() => dialogRef.current?.focus());
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [closePopover, openVariableId]);

  const onCardKeyDown = (event: KeyboardEvent<HTMLButtonElement>, variableId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpenVariableId((current) => (current === variableId ? null : variableId));
    }
  };

  const openCard = cards.find((card) => card.variable.variable_id === openVariableId) ?? null;
  const openSources = openCard?.delta?.sources ?? [];
  const openShownSources = openSources.slice(0, MAX_PROVENANCE_SOURCES);
  const openSourceIds = openCard?.delta?.source_action_ids ?? openSources.map((s) => s.action_id);
  const openSourceCount = typeof openCard?.delta?.source_action_count === 'number'
    ? openCard.delta.source_action_count
    : Math.max(openSourceIds.length, openSources.length);
  const openTruncated = isTruncatedRefFamily(
    openShownSources.length,
    openSourceCount,
    Boolean(openCard?.delta?.source_action_ids_truncated)
      || openSources.length > MAX_PROVENANCE_SOURCES,
  );

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

      {!topUnavailable && !branchUnavailable && cards.length === 0 && (
        <p className="domain-world-strip__empty" role="status">
          {t('domain_world.no_active_variables')}
        </p>
      )}

      {!topUnavailable && !branchUnavailable && cards.length > 0 && (
        <ul className="domain-world-strip__cards">
          {cards.map((card) => {
            const label = domainVariableLabel(card.variable, isZh);
            const valueText = formatDomainValue(card.value);
            const delta = card.delta?.applied_delta ?? null;
            const direction = deltaDirection(delta);
            const open = openVariableId === card.variable.variable_id;
            const dialogId = `${regionId}-${card.variable.variable_id}-provenance`;
            const name = [
              label,
              valueText || t('domain_world.value_unknown'),
              card.unit,
              delta ? t('domain_world.delta_value', { delta }) : t('domain_world.delta_none'),
            ].join(', ');
            return (
              <li key={card.variable.variable_id} className="domain-world-strip__card-item">
                <button
                  type="button"
                  ref={(node) => {
                    if (node) triggerRefs.current.set(card.variable.variable_id, node);
                    else triggerRefs.current.delete(card.variable.variable_id);
                  }}
                  className="domain-world-strip__card"
                  aria-expanded={open}
                  aria-controls={dialogId}
                  aria-haspopup="dialog"
                  aria-label={name}
                  data-testid={`domain-world-card-${card.variable.variable_id}`}
                  onClick={() => setOpenVariableId((current) => (
                    current === card.variable.variable_id ? null : card.variable.variable_id
                  ))}
                  onKeyDown={(event) => onCardKeyDown(event, card.variable.variable_id)}
                >
                  <span className="domain-world-strip__label">{label}</span>
                  <span className="domain-world-strip__value">
                    {valueText || t('domain_world.value_unknown')}
                  </span>
                  <span className="domain-world-strip__unit">{card.unit}</span>
                  <span className={`domain-world-strip__delta domain-world-strip__delta--${direction}`}>
                    {delta
                      ? t('domain_world.delta_value', { delta })
                      : t('domain_world.delta_none')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {openCard && !topUnavailable && !branchUnavailable && (
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
            onClick={closePopover}
          >
            {t('domain_world.provenance_close')}
          </button>
        </div>
      )}
    </section>
  );
}

export default DomainWorldStrip;
