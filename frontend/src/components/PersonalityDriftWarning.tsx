import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getPersonalityDrift,
  type PersonalityDriftResult,
  type PersonalityDriftSeverity,
} from '../api/client';
import './PersonalityDriftWarning.css';

interface PersonalityDriftWarningProps {
  scenarioId: string;
  enabled: boolean;
}

const EVIDENCE_TRUNCATE = 80;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = Array.from(text).slice(0, max).join('');
  return `${slice}…`;
}

function severityRank(severity: PersonalityDriftSeverity): number {
  if (severity === 'high') return 2;
  if (severity === 'medium') return 1;
  return 0;
}

function topDimension(result: PersonalityDriftResult) {
  if (!result.drift_dimensions.length) return null;
  return result.drift_dimensions.reduce((max, current) =>
    Math.abs(current.delta) > Math.abs(max.delta) ? current : max,
  );
}

export default function PersonalityDriftWarning({
  scenarioId,
  enabled,
}: PersonalityDriftWarningProps) {
  const { t } = useTranslation();
  const [results, setResults] = useState<PersonalityDriftResult[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shouldFetch = enabled && Boolean(scenarioId);

  useEffect(() => {
    if (!shouldFetch) return;
    let cancelled = false;
    void getPersonalityDrift(scenarioId)
      .then((data) => {
        if (cancelled) return;
        setResults(Array.isArray(data) ? data : []);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResults([]);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [shouldFetch, scenarioId]);

  const flagged = useMemo(
    () =>
      results
        .filter((r) => r.severity === 'medium' || r.severity === 'high')
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    [results],
  );

  if (!enabled) return null;

  const headingId = `drift-warning-heading-${scenarioId}`;
  const bodyId = `drift-warning-body-${scenarioId}`;

  if (error && flagged.length === 0) {
    return (
      <section
        className="drift-warning drift-warning--unavailable"
        role="status"
        aria-live="polite"
      >
        <p className="drift-warning__unavailable">
          <span className="drift-warning__icon" aria-hidden="true">⚠️</span>
          <span>{t('drift_warning.unavailable')}</span>
        </p>
      </section>
    );
  }

  if (flagged.length === 0) return null;

  return (
    <section
      className="drift-warning"
      role="region"
      aria-labelledby={headingId}
    >
      <button
        type="button"
        className="drift-warning__header"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={() => setCollapsed((prev) => !prev)}
      >
        <span className="drift-warning__icon" aria-hidden="true">⚠️</span>
        <span id={headingId} className="drift-warning__title">
          {t('drift_warning.title')}
        </span>
        <span className="drift-warning__count">
          {t('drift_warning.count', { count: flagged.length })}
        </span>
        <span className="drift-warning__chevron" aria-hidden="true">
          {collapsed ? '▸' : '▾'}
        </span>
      </button>

      {!collapsed && (
        <div id={bodyId}>
          <p className="drift-warning__evidence">
            {t('drift_warning.proxy_caveat')}
          </p>
          <ul className="drift-warning__list">
          {flagged.map((result) => {
            const top = topDimension(result);
            const evidence = result.evidence?.[0] ?? '';
            const dimensionLabel = top
              ? t(`drift_warning.dimension.${top.dimension}`, {
                  defaultValue: top.dimension,
                })
              : null;
            return (
              <li
                key={result.agent_id}
                className={`drift-warning__agent drift-warning__agent--${result.severity}`}
              >
                <div className="drift-warning__agent-row">
                  <span className="drift-warning__agent-name">
                    {result.agent_name}
                  </span>
                  <span
                    className={`drift-warning__badge drift-warning__badge--${result.severity}`}
                  >
                    {t(`drift_warning.severity.${result.severity}`)}
                  </span>
                </div>
                {top && (
                  <div className="drift-warning__delta">
                    <span className="drift-warning__dimension">{dimensionLabel}</span>
                    <span
                      className={`drift-warning__delta-value drift-warning__delta-value--${
                        top.delta >= 0 ? 'positive' : 'negative'
                      }`}
                    >
                      {top.delta >= 0 ? '+' : ''}
                      {top.delta.toFixed(2)}
                    </span>
                  </div>
                )}
                {evidence && (
                  <p
                    className="drift-warning__evidence"
                    title={evidence.length > EVIDENCE_TRUNCATE ? evidence : undefined}
                  >
                    {truncate(evidence, EVIDENCE_TRUNCATE)}
                  </p>
                )}
              </li>
            );
          })}
          </ul>
        </div>
      )}
    </section>
  );
}
