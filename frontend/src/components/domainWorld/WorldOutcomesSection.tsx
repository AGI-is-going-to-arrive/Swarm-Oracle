import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  domainVariableLabel,
  domainReasonI18nKey,
  formatDomainUnitValue,
  isTruncatedRefFamily,
  normalizeWorldOutcomesProjection,
} from '../../lib/domainWorld';
import type { WorldOutcomeItem, WorldOutcomesProjection } from '../../types';
import './WorldOutcomesSection.css';

export interface WorldOutcomesSectionProps {
  worldOutcomes?: WorldOutcomesProjection | null;
  branchTitles?: Record<string, string>;
}

function formatOutcomeSummary(outcome: WorldOutcomeItem, isZh: boolean): string {
  const label = domainVariableLabel(outcome, isZh);
  const initial = formatDomainUnitValue(
    outcome.initial_value,
    outcome.unit,
    outcome.scale,
    isZh,
  );
  const final = formatDomainUnitValue(
    outcome.final_value,
    outcome.unit,
    outcome.scale,
    isZh,
  );
  const delta = formatDomainUnitValue(
    outcome.net_delta,
    outcome.unit,
    outcome.scale,
    isZh,
  );
  const transition = `${initial || '—'} → ${final || '—'}`;
  if (!delta) return isZh ? `${label}：${transition}` : `${label}: ${transition}`;
  return isZh
    ? `${label}：${transition}（Δ ${delta}）`
    : `${label}: ${transition} (Δ ${delta})`;
}

function RefTruncationNote({
  shown,
  total,
  truncated,
  testId,
}: {
  shown: number;
  total: number;
  truncated: boolean;
  testId: string;
}) {
  const { t } = useTranslation();
  if (!truncated && total <= shown) return null;
  return (
    <span className="world-outcomes__truncation" data-testid={testId} role="status">
      {t('world_outcomes.refs_shown', { shown, total })}
    </span>
  );
}

export function WorldOutcomesSection({
  worldOutcomes,
  branchTitles = {},
}: WorldOutcomesSectionProps) {
  const { t, i18n } = useTranslation();
  const isZh = Boolean(i18n?.language?.startsWith('zh'));
  const projection = useMemo(
    () => normalizeWorldOutcomesProjection(worldOutcomes),
    [worldOutcomes],
  );

  const reasonKey = domainReasonI18nKey(projection.reason_code);
  const branches = projection.branches ?? [];
  const unavailable = projection.status === 'unavailable';
  const partial = projection.status === 'partial';

  return (
    <section
      className="world-outcomes"
      data-testid="world-outcomes-section"
      aria-label={t('world_outcomes.region')}
    >
      <h3 className="world-outcomes__title">{t('world_outcomes.title')}</h3>

      {unavailable && (
        <div className="world-outcomes__banner" role="status" data-testid="world-outcomes-unavailable">
          <strong>{t('world_outcomes.unavailable_title')}</strong>
          {' '}
          {t(reasonKey)}
        </div>
      )}

      {partial && (
        <div className="world-outcomes__banner" role="status">
          {t('world_outcomes.partial_notice')}
        </div>
      )}

      {!unavailable && branches.length === 0 && (
        <p className="world-outcomes__banner" role="status">
          {t('world_outcomes.empty')}
        </p>
      )}

      {branches.map((branch) => {
        const title = branchTitles[branch.branch_id] ?? branch.branch_id;
        const empty = branch.outcomes.length === 0;
        const branchReasonKey = domainReasonI18nKey(branch.reason_code);
        return (
          <div
            key={branch.branch_id}
            className="world-outcomes__branch"
            data-testid={`world-outcomes-branch-${branch.branch_id}`}
          >
            <h4 className="world-outcomes__branch-title">
              {t('world_outcomes.branch_heading', { title })}
            </h4>
            {branch.status === 'unavailable' && (
              <p className="world-outcomes__banner" role="status">
                {t('world_outcomes.branch_unavailable')}
                {' '}
                {t(branchReasonKey)}
              </p>
            )}
            {empty && branch.status !== 'unavailable' && (
              <p className="world-outcomes__banner" role="status">
                {branch.empty_reason_code === 'NO_VERIFIED_DOMAIN_CHANGES'
                  ? t('world_outcomes.no_verified_changes')
                  : t('world_outcomes.empty')}
              </p>
            )}
            {!empty && (
              <ul className="world-outcomes__list">
                {branch.outcomes.slice(0, 8).map((outcome) => {
                  const summary = formatOutcomeSummary(outcome, isZh);
                  const actionShown = outcome.source_action_ids.length;
                  const ruleShown = outcome.source_rule_ids.length;
                  const claimShown = outcome.related_claim_ids.length;
                  return (
                    <li
                      key={`${branch.branch_id}:${outcome.variable_id}`}
                      className="world-outcomes__item"
                      data-testid={`world-outcome-${outcome.variable_id}`}
                    >
                      <p className="world-outcomes__summary">{summary}</p>
                      <div className="world-outcomes__chips" aria-label={t('world_outcomes.sources_aria')}>
                        {outcome.source_action_ids.map((actionId) => (
                          <span key={`a:${actionId}`} className="world-outcomes__chip">
                            {actionId}
                          </span>
                        ))}
                        <RefTruncationNote
                          shown={actionShown}
                          total={outcome.source_action_count}
                          truncated={isTruncatedRefFamily(
                            actionShown,
                            outcome.source_action_count,
                            outcome.source_action_ids_truncated,
                          )}
                          testId={`world-outcome-actions-trunc-${outcome.variable_id}`}
                        />
                        {outcome.source_rule_ids.map((ruleId) => (
                          <span key={`r:${ruleId}`} className="world-outcomes__chip">
                            {t('world_outcomes.rule_chip', { id: ruleId })}
                          </span>
                        ))}
                        <RefTruncationNote
                          shown={ruleShown}
                          total={outcome.source_rule_count}
                          truncated={isTruncatedRefFamily(
                            ruleShown,
                            outcome.source_rule_count,
                            outcome.source_rule_ids_truncated,
                          )}
                          testId={`world-outcome-rules-trunc-${outcome.variable_id}`}
                        />
                        {outcome.related_claim_ids.map((claimId) => (
                          <span key={`c:${claimId}`} className="world-outcomes__claim">
                            {t('world_outcomes.claim_chip', { id: claimId })}
                          </span>
                        ))}
                        <RefTruncationNote
                          shown={claimShown}
                          total={outcome.related_claim_count}
                          truncated={isTruncatedRefFamily(
                            claimShown,
                            outcome.related_claim_count,
                            outcome.related_claim_ids_truncated,
                          )}
                          testId={`world-outcome-claims-trunc-${outcome.variable_id}`}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

export default WorldOutcomesSection;
