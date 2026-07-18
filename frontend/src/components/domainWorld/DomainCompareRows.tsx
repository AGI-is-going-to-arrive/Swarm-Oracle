import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  domainVariableLabel,
  formatDomainValue,
  maxDivergenceScore,
} from '../../lib/domainWorld';
import type { DomainStateDiff, DivergenceComponents } from '../../types';
import './DomainCompareRows.css';

export interface DomainCompareRowsProps {
  domainStateDiff?: DomainStateDiff | null;
  divergenceComponents?: DivergenceComponents | null;
  speechDivergenceScore?: number | null;
}

export function DomainCompareRows({
  domainStateDiff,
  divergenceComponents = null,
  speechDivergenceScore = null,
}: DomainCompareRowsProps) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const status = domainStateDiff?.status ?? 'not_applicable';
  const rows = useMemo(
    () => (Array.isArray(domainStateDiff?.rows) ? domainStateDiff!.rows.slice(0, 8) : []),
    [domainStateDiff],
  );

  const displayScore = useMemo(() => {
    const domain = divergenceComponents?.domain ?? null;
    const text = divergenceComponents?.text ?? speechDivergenceScore ?? null;
    return maxDivergenceScore(text, domain);
  }, [divergenceComponents, speechDivergenceScore]);

  const worldOnlyCount = useMemo(
    () => rows.filter((row) => row.is_different).length,
    [rows],
  );

  const unavailable = status === 'unavailable' || status === 'schema_mismatch';
  const notApplicable = status === 'not_applicable' || (!domainStateDiff && rows.length === 0);

  if (notApplicable && !domainStateDiff) {
    return null;
  }

  return (
    <section
      className="domain-compare-rows"
      data-testid="domain-compare-rows"
      aria-label={t('domain_compare.region')}
    >
      <h3 className="domain-compare-rows__title">{t('domain_compare.title')}</h3>

      {displayScore != null && (
        <p className="domain-compare-rows__score" data-testid="domain-compare-score">
          {t('domain_compare.divergence_combined', {
            percent: Math.round(displayScore * 100),
          })}
          {worldOnlyCount > 0 && (
            <>
              {' · '}
              {t('domain_compare.world_divergence_count', { count: worldOnlyCount })}
            </>
          )}
        </p>
      )}

      {unavailable && (
        <div className="domain-compare-rows__banner" role="status" data-testid="domain-compare-unavailable">
          {status === 'schema_mismatch'
            ? t('domain_compare.schema_mismatch')
            : t('domain_compare.unavailable')}
          {(domainStateDiff?.branch_a_failure_code || domainStateDiff?.branch_b_failure_code) && (
            <span>
              {' '}
              {t('domain_compare.side_codes', {
                a: domainStateDiff?.branch_a_failure_code ?? '—',
                b: domainStateDiff?.branch_b_failure_code ?? '—',
              })}
            </span>
          )}
        </div>
      )}

      {status === 'not_applicable' && (
        <p className="domain-compare-rows__banner" role="status">
          {t('domain_compare.not_applicable')}
        </p>
      )}

      {status === 'comparable' && rows.length === 0 && (
        <p className="domain-compare-rows__banner" role="status">
          {t('domain_compare.no_differences')}
        </p>
      )}

      {rows.length > 0 && (
        <div className="domain-compare-rows__table-wrap">
          <table className="domain-compare-rows__table">
            <caption className="sr-only">{t('domain_compare.table_caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('domain_compare.col_variable')}</th>
                <th scope="col">{t('domain_compare.col_unit')}</th>
                <th scope="col">{t('domain_compare.col_branch_a')}</th>
                <th scope="col">{t('domain_compare.col_branch_b')}</th>
                <th scope="col">{t('domain_compare.col_delta')}</th>
                <th scope="col">{t('domain_compare.col_first_diff')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const label = domainVariableLabel(row, isZh);
                const aUnavailable = row.branch_a.status !== 'available';
                const bUnavailable = row.branch_b.status !== 'available';
                return (
                  <tr
                    key={row.variable_id}
                    data-testid={`domain-compare-row-${row.variable_id}`}
                    className={row.is_different ? 'domain-compare-rows__diff' : undefined}
                  >
                    <th scope="row">{label}</th>
                    <td>{row.unit}</td>
                    <td>
                      {aUnavailable
                        ? (
                            <>
                              <span>{t('domain_compare.side_unavailable')}</span>
                              <span className="domain-compare-rows__badge">
                                {t('domain_world.unavailable_side')}
                              </span>
                            </>
                          )
                        : formatDomainValue(row.branch_a.value)}
                    </td>
                    <td>
                      {bUnavailable
                        ? (
                            <>
                              <span>{t('domain_compare.side_unavailable')}</span>
                              <span className="domain-compare-rows__badge">
                                {t('domain_world.unavailable_side')}
                              </span>
                            </>
                          )
                        : formatDomainValue(row.branch_b.value)}
                    </td>
                    <td>
                      {row.delta == null
                        ? t('domain_compare.delta_na')
                        : row.delta}
                    </td>
                    <td>
                      {row.first_difference
                        ? t('domain_compare.first_diff', {
                            round: row.first_difference.round_number,
                            rules: [
                              ...(row.first_difference.branch_a_rule_ids ?? []),
                              ...(row.first_difference.branch_b_rule_ids ?? []),
                            ].join(', ') || '—',
                            actions: [
                              ...(row.first_difference.branch_a_source_action_ids ?? []),
                              ...(row.first_difference.branch_b_source_action_ids ?? []),
                            ].join(', ') || '—',
                          })
                        : t('domain_compare.no_first_diff')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default DomainCompareRows;
