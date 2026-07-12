import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  PremortemAnalysis,
  PremortemEvidenceLink,
  PremortemEvidenceRole,
  PremortemFailureMode,
  PremortemReason,
  ReportEvidence,
} from '../../types';

type ReportLanguage = 'zh' | 'en';
type Translate = (key: string, defaultValue: string) => string;

type NormalizedPremortem =
  | { kind: 'legacy' }
  | { kind: 'malformed' }
  | { kind: 'missing'; reason: PremortemReason }
  | {
    kind: 'ready';
    status: 'available' | 'partial';
    reason: PremortemReason | null;
    items: PremortemFailureMode[];
  };

interface Props {
  analysis: PremortemAnalysis | null | undefined;
  evidence: readonly ReportEvidence[];
  isZh: boolean;
  onOpenEvidence: (refs: string[]) => void;
}

const PREMORTEM_REASONS = new Set<PremortemReason>([
  'no_distinct_evidence',
  'insufficient_source_diversity',
  'generation_failed',
  'lineage_unavailable',
  'report_generation_failed',
  'byte_budget_truncated',
]);

const EVIDENCE_ROLES = new Set<PremortemEvidenceRole>([
  'failure_signal',
  'failure_mechanism',
  'counterevidence',
]);

const ANALYSIS_KEYS = ['status', 'reason', 'items'] as const;
const FAILURE_MODE_KEYS = [
  'id',
  'failure_mode_i18n',
  'mechanism_i18n',
  'early_warning_i18n',
  'uncertainty_i18n',
  'evidence_chain',
] as const;
const EVIDENCE_LINK_KEYS = ['evidence_ref', 'role', 'rationale_i18n'] as const;
const I18N_TEXT_KEYS = ['zh', 'en'] as const;

const REASON_KEYS: Record<PremortemReason, string> = {
  no_distinct_evidence: 'result.report.premortem.reason.no_distinct_evidence',
  insufficient_source_diversity: 'result.report.premortem.reason.insufficient_source_diversity',
  generation_failed: 'result.report.premortem.reason.generation_failed',
  lineage_unavailable: 'result.report.premortem.reason.lineage_unavailable',
  report_generation_failed: 'result.report.premortem.reason.report_generation_failed',
  byte_budget_truncated: 'result.report.premortem.reason.byte_budget_truncated',
};

const REASON_DEFAULTS: Record<PremortemReason, string> = {
  no_distinct_evidence: 'No distinct simulation evidence supported a failure mode.',
  insufficient_source_diversity: 'Simulation source diversity was insufficient for a complete analysis.',
  generation_failed: 'Premortem generation failed.',
  lineage_unavailable: 'Branch lineage evidence was unavailable.',
  report_generation_failed: 'Report generation failed before premortem analysis completed.',
  byte_budget_truncated: 'The premortem analysis was omitted to stay within the report size limit.',
};

const ROLE_KEYS: Record<PremortemEvidenceRole, string> = {
  failure_signal: 'result.report.premortem.role.failure_signal',
  failure_mechanism: 'result.report.premortem.role.failure_mechanism',
  counterevidence: 'result.report.premortem.role.counterevidence',
};

const ROLE_DEFAULTS: Record<PremortemEvidenceRole, string> = {
  failure_signal: 'Failure signal',
  failure_mechanism: 'Failure mechanism',
  counterevidence: 'Counterevidence',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isI18nText(value: unknown): value is { zh: string; en: string } {
  return isRecord(value)
    && hasExactKeys(value, I18N_TEXT_KEYS)
    && typeof value.zh === 'string'
    && value.zh.trim().length > 0
    && typeof value.en === 'string'
    && value.en.trim().length > 0;
}

function isPremortemReason(value: unknown): value is PremortemReason {
  return typeof value === 'string' && PREMORTEM_REASONS.has(value as PremortemReason);
}

function isEvidenceLink(value: unknown): value is PremortemEvidenceLink {
  return isRecord(value)
    && hasExactKeys(value, EVIDENCE_LINK_KEYS)
    && typeof value.evidence_ref === 'string'
    && value.evidence_ref.trim().length > 0
    && typeof value.role === 'string'
    && EVIDENCE_ROLES.has(value.role as PremortemEvidenceRole)
    && isI18nText(value.rationale_i18n);
}

function isFailureMode(value: unknown): value is PremortemFailureMode {
  if (!isRecord(value)
    || !hasExactKeys(value, FAILURE_MODE_KEYS)
    || typeof value.id !== 'string'
    || !/^pm_\d{3}$/u.test(value.id)
    || !isI18nText(value.failure_mode_i18n)
    || !isI18nText(value.mechanism_i18n)
    || !isI18nText(value.early_warning_i18n)
    || !isI18nText(value.uncertainty_i18n)
    || !Array.isArray(value.evidence_chain)
    || value.evidence_chain.length === 0
    || !value.evidence_chain.every(isEvidenceLink)) {
    return false;
  }
  const refs = value.evidence_chain.map((link) => link.evidence_ref);
  return new Set(refs).size === refs.length;
}

function isReportEvidence(value: unknown): value is ReportEvidence {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id.trim().length > 0
    && typeof value.branch_id === 'string'
    && value.branch_id.trim().length > 0
    && typeof value.round_id === 'string'
    && value.round_id.trim().length > 0
    && Number.isInteger(value.round_number)
    && Number(value.round_number) >= 0
    && typeof value.agent_id === 'string'
    && value.agent_id.trim().length > 0
    && typeof value.agent_name === 'string'
    && value.agent_name.trim().length > 0
    && typeof value.message_id === 'string'
    && value.message_id.trim().length > 0
    && typeof value.quote === 'string'
    && value.quote.trim().length > 0
    && typeof value.kind === 'string'
    && ['utterance', 'causal_fact', 'faction_event', 'interview'].includes(value.kind);
}

function buildEvidenceIndex(evidence: readonly ReportEvidence[]): Map<string, ReportEvidence> {
  const counts = new Map<string, number>();
  for (const value of evidence) {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) continue;
    counts.set(value.id, (counts.get(value.id) ?? 0) + 1);
  }

  const uniqueEvidence = new Map<string, ReportEvidence>();
  for (const value of evidence) {
    if (isReportEvidence(value) && counts.get(value.id) === 1) {
      uniqueEvidence.set(value.id, value);
    }
  }
  return uniqueEvidence;
}

function hasAvailableEvidenceDiversity(
  item: PremortemFailureMode,
  evidenceById: ReadonlyMap<string, ReportEvidence>,
): boolean {
  if (item.evidence_chain.length < 2) return false;
  const referenced = item.evidence_chain
    .map((link) => evidenceById.get(link.evidence_ref))
    .filter((value): value is ReportEvidence => value !== undefined);
  if (referenced.length < 2) return false;

  const coordinates = new Set(referenced.map((item) => JSON.stringify([
    item.branch_id,
    item.round_id,
    item.round_number,
    item.agent_id,
    item.message_id,
  ])));
  const agentIds = new Set(referenced.map((item) => item.agent_id));
  const branchIds = new Set(referenced.map((item) => item.branch_id));
  return coordinates.size >= 2 && (agentIds.size >= 2 || branchIds.size >= 2);
}

function normalizePremortemAnalysis(
  value: unknown,
  evidence: readonly ReportEvidence[],
): NormalizedPremortem {
  if (value === null || value === undefined) return { kind: 'legacy' };
  if (!isRecord(value)
    || !hasExactKeys(value, ANALYSIS_KEYS)
    || !Array.isArray(value.items)) {
    return { kind: 'malformed' };
  }
  if (value.items.length > 3) return { kind: 'malformed' };

  if (value.status === 'missing') {
    if (value.items.length !== 0 || !isPremortemReason(value.reason)) {
      return { kind: 'malformed' };
    }
    return { kind: 'missing', reason: value.reason };
  }

  if (value.status !== 'available' && value.status !== 'partial') {
    return { kind: 'malformed' };
  }
  if (value.items.length === 0 || !value.items.every(isFailureMode)) {
    return { kind: 'malformed' };
  }
  const originalItems = value.items;
  const originalItemIds = originalItems.map((item) => item.id);
  if (new Set(originalItemIds).size !== originalItemIds.length) {
    return { kind: 'malformed' };
  }
  if (value.status === 'available'
    && (value.reason !== null
      || originalItems.some((item) => item.evidence_chain.length < 2))) {
    return { kind: 'malformed' };
  }
  const evidenceById = buildEvidenceIndex(evidence);
  const filteredItems = originalItems.map((item) => ({
    ...item,
    evidence_chain: item.evidence_chain.filter((link) => evidenceById.has(link.evidence_ref)),
  }));
  const evidenceWasDropped = filteredItems.some((item, index) => (
    item.evidence_chain.length !== originalItems[index].evidence_chain.length
  ));
  const items = filteredItems.filter((item) => item.evidence_chain.length > 0);
  if (items.length === 0) {
    return { kind: 'missing', reason: 'lineage_unavailable' };
  }

  if (value.status === 'partial') {
    if (!isPremortemReason(value.reason)) return { kind: 'malformed' };
    return { kind: 'ready', status: 'partial', reason: value.reason, items };
  }
  if (evidenceWasDropped || items.some((item) => item.evidence_chain.length < 2)) {
    return {
      kind: 'ready',
      status: 'partial',
      reason: 'insufficient_source_diversity',
      items,
    };
  }
  if (items.some((item) => !hasAvailableEvidenceDiversity(item, evidenceById))) {
    return {
      kind: 'ready',
      status: 'partial',
      reason: 'insufficient_source_diversity',
      items,
    };
  }
  return { kind: 'ready', status: 'available', reason: null, items };
}

function localized(value: { zh: string; en: string }, language: ReportLanguage): string {
  return value[language];
}

function translatedReason(reason: PremortemReason, translate: Translate): string {
  return translate(REASON_KEYS[reason], REASON_DEFAULTS[reason]);
}

function translatedRole(role: PremortemEvidenceRole, translate: Translate): string {
  return translate(ROLE_KEYS[role], ROLE_DEFAULTS[role]);
}

// The frozen write set keeps the shared runtime normalizer and export formatter
// beside the component instead of adding a second helper module.
// eslint-disable-next-line react-refresh/only-export-components
export function formatPremortemMarkdown(
  analysis: PremortemAnalysis | null | undefined,
  language: ReportLanguage,
  translate: Translate,
  evidence: readonly ReportEvidence[],
): string {
  const normalized = normalizePremortemAnalysis(analysis, evidence);
  const lines = [
    `## ${translate('result.report.premortem.title', 'Premortem analysis')}`,
    '',
  ];

  if (normalized.kind === 'legacy') {
    lines.push(
      `**${translate('result.report.premortem.statusLabel', 'Status')}**: ${translate('result.report.premortem.status.missing', 'Analysis unavailable')}`,
      '',
      translate(
        'result.report.premortem.legacyUnavailable',
        'Structured premortem is not available for this legacy or unimplemented report.',
      ),
    );
    return lines.join('\n');
  }

  if (normalized.kind === 'malformed') {
    lines.push(
      `**${translate('result.report.premortem.statusLabel', 'Status')}**: ${translate('result.report.premortem.status.missing', 'Analysis unavailable')}`,
      '',
      translate(
        'result.report.premortem.malformed',
        'The structured premortem could not be displayed because its saved data was invalid.',
      ),
    );
    return lines.join('\n');
  }

  const statusKey = normalized.kind === 'missing'
    ? 'result.report.premortem.status.missing'
    : `result.report.premortem.status.${normalized.status}`;
  const statusDefault = normalized.kind === 'missing'
    ? 'Analysis unavailable'
    : normalized.status === 'partial' ? 'Partial analysis' : 'Available';
  lines.push(
    `**${translate('result.report.premortem.statusLabel', 'Status')}**: ${translate(statusKey, statusDefault)}`,
  );

  if (normalized.kind === 'missing') {
    lines.push(
      `**${translate('result.report.premortem.reasonLabel', 'Reason')}**: ${translatedReason(normalized.reason, translate)}`,
    );
    return lines.join('\n');
  }

  if (normalized.reason) {
    lines.push(
      `**${translate('result.report.premortem.reasonLabel', 'Reason')}**: ${translatedReason(normalized.reason, translate)}`,
    );
  }
  lines.push(
    '',
    translate(
      'result.report.premortem.disclosure',
      'Simulation evidence does not establish statistical independence or real-world proof.',
    ),
  );

  for (const item of normalized.items) {
    lines.push(
      '',
      `### ${item.id} — ${localized(item.failure_mode_i18n, language)}`,
      '',
      `- **${translate('result.report.premortem.failureModeLabel', 'Failure mode')}**: ${localized(item.failure_mode_i18n, language)}`,
      `- **${translate('result.report.premortem.mechanismLabel', 'Mechanism')}**: ${localized(item.mechanism_i18n, language)}`,
      `- **${translate('result.report.premortem.earlyWarningLabel', 'Early warning')}**: ${localized(item.early_warning_i18n, language)}`,
      `- **${translate('result.report.premortem.uncertaintyLabel', 'Uncertainty')}**: ${localized(item.uncertainty_i18n, language)}`,
      `- **${translate('result.report.premortem.evidenceChainLabel', 'Evidence chain')}**:`,
    );
    for (const link of item.evidence_chain) {
      lines.push(
        `  - [${link.evidence_ref}] ${translatedRole(link.role, translate)} — ${localized(link.rationale_i18n, language)}`,
      );
    }
  }
  return lines.join('\n');
}

export const PremortemAnalysisBlock = React.memo(function PremortemAnalysisBlock({
  analysis,
  evidence,
  isZh,
  onOpenEvidence,
}: Props) {
  const { t } = useTranslation();
  const language: ReportLanguage = isZh ? 'zh' : 'en';
  const normalized = useMemo(
    () => normalizePremortemAnalysis(analysis, evidence),
    [analysis, evidence],
  );
  const translate: Translate = (key, defaultValue) => t(key, defaultValue);

  const status = normalized.kind === 'ready'
    ? normalized.status
    : 'missing';

  return (
    <section className="report-premortem" aria-labelledby="report-premortem-title">
      <div className="report-block-head">
        <span className="report-block-head__bid" aria-hidden="true">P</span>
        <h3 id="report-premortem-title" className="report-block-head__title">
          {t('result.report.premortem.title', 'Premortem analysis')}
        </h3>
        <span className={`report-premortem__status report-premortem__status--${status}`}>
          {normalized.kind === 'ready'
            ? t(
              `result.report.premortem.status.${normalized.status}`,
              normalized.status === 'partial' ? 'Partial analysis' : 'Available',
            )
            : t('result.report.premortem.status.missing', 'Analysis unavailable')}
        </span>
      </div>

      {normalized.kind === 'legacy' && (
        <p className="report-premortem__notice" role="status">
          {t(
            'result.report.premortem.legacyUnavailable',
            'Structured premortem is not available for this legacy or unimplemented report.',
          )}
        </p>
      )}

      {normalized.kind === 'malformed' && (
        <p className="report-premortem__notice" role="status">
          {t(
            'result.report.premortem.malformed',
            'The structured premortem could not be displayed because its saved data was invalid.',
          )}
        </p>
      )}

      {normalized.kind === 'missing' && (
        <p className="report-premortem__notice" role="status">
          {translatedReason(normalized.reason, translate)}
        </p>
      )}

      {normalized.kind === 'ready' && (
        <>
          {normalized.reason && (
            <p className="report-premortem__notice" role="status">
              {translatedReason(normalized.reason, translate)}
            </p>
          )}
          <p className="report-premortem__disclosure">
            {t(
              'result.report.premortem.disclosure',
              'Simulation evidence does not establish statistical independence or real-world proof.',
            )}
          </p>
          <ol className="report-premortem__items">
            {normalized.items.map((item) => (
              <li key={item.id} className="report-premortem__item">
                <article aria-labelledby={`premortem-title-${item.id}`}>
                  <div className="report-premortem__item-head">
                    <span className="report-premortem__item-id">{item.id}</span>
                    <h4 id={`premortem-title-${item.id}`} className="report-premortem__item-title">
                      {localized(item.failure_mode_i18n, language)}
                    </h4>
                  </div>
                  <dl className="report-premortem__details">
                    <div>
                      <dt>{t('result.report.premortem.mechanismLabel', 'Mechanism')}</dt>
                      <dd>{localized(item.mechanism_i18n, language)}</dd>
                    </div>
                    <div>
                      <dt>{t('result.report.premortem.earlyWarningLabel', 'Early warning')}</dt>
                      <dd>{localized(item.early_warning_i18n, language)}</dd>
                    </div>
                    <div>
                      <dt>{t('result.report.premortem.uncertaintyLabel', 'Uncertainty')}</dt>
                      <dd>{localized(item.uncertainty_i18n, language)}</dd>
                    </div>
                  </dl>
                  <div className="report-premortem__chain">
                    <h5>{t('result.report.premortem.evidenceChainLabel', 'Evidence chain')}</h5>
                    <ol>
                      {item.evidence_chain.map((link) => {
                        return (
                          <li key={link.evidence_ref}>
                            <div className="report-premortem__chain-copy">
                              <span className="report-premortem__role">
                                {translatedRole(link.role, translate)}
                              </span>
                              <span>{localized(link.rationale_i18n, language)}</span>
                            </div>
                            <button
                              type="button"
                              className="report-premortem__evidence-btn"
                              onClick={() => onOpenEvidence([link.evidence_ref])}
                              aria-label={t('result.report.premortem.openEvidence', {
                                id: link.evidence_ref,
                                defaultValue: 'Open evidence {{id}}',
                              })}
                            >
                              [{link.evidence_ref}]
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                </article>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
});
