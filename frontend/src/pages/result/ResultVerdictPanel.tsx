/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Result Verdict Panel
   Displays the LLM-produced verdict that answers the original
   user question, with confidence badge and accessible region.
   When no verdict is available (older scenarios completed before
   FEATURE_RESULT_VERDICT, or verdict generation failed), renders
   a neutral fallback that still anchors the user to the original
   question and points to the endings below.
   ═══════════════════════════════════════════════════════════ */

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { FullReport } from '../../types';
import './ResultVerdictPanel.css';

export type VerdictConfidence = 'high' | 'medium' | 'low';

export interface ResultVerdictPanelProps {
  verdict: string | null | undefined;
  confidence: VerdictConfidence | null | undefined;
  confidenceKind?: 'model_self_rating' | null;
  question: string;
  report?: FullReport | null;
  reportStale?: boolean;
  onOpenEvidence?: (evidenceIds?: string[]) => void;
}

function VerdictEvidence({ report, reportStale = false, onOpenEvidence }: Pick<ResultVerdictPanelProps, 'report' | 'reportStale' | 'onOpenEvidence'>) {
  const { t, i18n } = useTranslation();
  if (!report) return null;
  const claims = report.claims ?? [];
  const counts = {
    strong: claims.filter((claim) => claim.evidence_strength === 'strong').length,
    moderate: claims.filter((claim) => claim.evidence_strength === 'moderate').length,
    unsupported: claims.filter((claim) => claim.evidence_strength === 'unsupported').length,
  };
  const weakCount = claims.filter((claim) => claim.evidence_strength === 'weak').length;
  const language = i18n?.language?.startsWith('zh') ? 'zh' : 'en';
  const basis = report.verdict.analytic_confidence.basis_i18n?.[language]
    || (report.language === language ? report.verdict.analytic_confidence.basis : '');
  return (
    <div className="verdict-evidence">
      <p className="verdict-evidence__title">{t(reportStale ? 'result.report.historicalEvidence' : 'result.report.savedEvidence')}</p>
      <p className="verdict-evidence__summary">{claims.length > 0
        ? t('result.report.claimSupportCounts', counts)
        : t('result.report.claimChecksUnavailable')}</p>
      {weakCount > 0 && <p className="verdict-evidence__summary">{t('result.report.weakClaimCount', { count: weakCount })}</p>}
      <p className="verdict-evidence__note">{t(reportStale ? 'result.report.historicalEvidenceNote' : 'result.report.claimSupportNote')}</p>
      {report.evidence.length > 0 && onOpenEvidence && (
        <button type="button" className="btn btn-secondary" onClick={() => onOpenEvidence(report.evidence.map((item) => item.id))}>
          {t('result.report.viewCitedEvidence')}
        </button>
      )}
      {(claims.length > 0 || basis) && (
        <details className="verdict-evidence__details">
          <summary>{t('result.report.inspectClaims')}</summary>
          {basis && <p>{basis}</p>}
          {claims.length > 0 && <p className="verdict-evidence__note">{t('result.report.originalClaimsNote')}</p>}
          <ul>
            {claims.map((claim) => {
              const refs = report.evidence
                .filter((item) => claim.message_ids.includes(item.message_id))
                .map((item) => item.id);
              const strengthKey = claim.evidence_strength === 'strong'
                ? 'result.report.claimStrong'
                : claim.evidence_strength === 'moderate' ? 'result.report.claimModerate'
                  : claim.evidence_strength === 'weak' ? 'result.report.claimWeak' : 'result.report.claimUnsupported';
              return (
                <li key={claim.claim_id}>
                  <span className="verdict-evidence__strength">{t(strengthKey)}</span>
                  <p lang={report.language}>{claim.claim_text}</p>
                  {refs.length > 0 && onOpenEvidence && (
                    <button type="button" className="btn btn-ghost" onClick={() => onOpenEvidence(refs)}>
                      {t('result.report.viewCitedEvidence')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

function isValidConfidence(value: unknown): value is VerdictConfidence {
  return value === 'high' || value === 'medium' || value === 'low';
}

export default function ResultVerdictPanel({
  verdict,
  confidence,
  confidenceKind,
  question,
  report,
  reportStale,
  onOpenEvidence,
}: ResultVerdictPanelProps) {
  const { t, i18n } = useTranslation();
  const labelId = useId();

  const originalVerdictText = typeof verdict === 'string' ? verdict.trim() : '';
  const displayLanguage = i18n?.language?.startsWith('zh') ? 'zh' : 'en';
  const translatedConclusion = !reportStale
    ? report?.authored_content_i18n?.[displayLanguage]?.headline_answer?.trim()
    : undefined;
  const verdictText = translatedConclusion || originalVerdictText;
  const questionText = typeof question === 'string' ? question.trim() : '';
  const hasVerdict = verdictText.length > 0;

  // Unavailable fallback: panel is mounted (capability enabled) but the
  // scenario has no verdict — either it pre-dates FEATURE_RESULT_VERDICT
  // or verdict generation failed. By the time the user reaches ResultView
  // the simulation is always completed, so the messaging is neutral
  // ("no verdict available") rather than implying ongoing analysis. The
  // CSS class keeps the legacy `--pending` suffix for style continuity.
  if (!hasVerdict) {
    return (
      <section
        className="result-verdict-panel result-verdict-panel--pending"
        role="region"
        aria-labelledby={labelId}
        aria-live="polite"
        data-testid="result-verdict-panel-pending"
      >
        <header className="result-verdict-panel__header">
          <span id={labelId} className="result-verdict-panel__label">
            {t('result.verdict_label', { defaultValue: 'Prediction Verdict' })}
          </span>
        </header>

        {questionText && (
          <>
            <span className="result-verdict-panel__question-label">
              {t('result.question_answered_label', { defaultValue: 'Question answered' })}
            </span>
            <p className="result-verdict-panel__question" data-testid="result-verdict-question">
              {questionText}
            </p>
          </>
        )}

        <p
          className="result-verdict-panel__pending"
          data-testid="result-verdict-pending"
        >
          {t('result.verdict_pending', {
            defaultValue:
              'No prediction verdict is available — explore the endings below for insights.',
          })}
        </p>
        <VerdictEvidence report={report} reportStale={reportStale} onOpenEvidence={onOpenEvidence} />
      </section>
    );
  }

  const safeConfidence = !translatedConclusion && isValidConfidence(confidence) ? confidence : null;

  const confidenceLevelLabel = safeConfidence
    ? t(`result.verdict_confidence_${safeConfidence}`, {
        defaultValue:
          safeConfidence === 'high'
            ? 'High Confidence'
            : safeConfidence === 'medium'
              ? 'Medium Confidence'
              : 'Low Confidence',
      })
    : null;
  const safeConfidenceKind = confidenceKind === 'model_self_rating'
    ? confidenceKind
    : null;
  const confidenceLabel = confidenceLevelLabel
    ? safeConfidenceKind
      ? `${t('result.verdict_confidence_kind_model_self_rating', {
          defaultValue: 'Model self-rating',
        })}: ${confidenceLevelLabel}`
      : confidenceLevelLabel
    : null;

  return (
    <section
      className="result-verdict-panel"
      role="region"
      aria-labelledby={labelId}
      aria-live="polite"
    >
      <header className="result-verdict-panel__header">
        <span id={labelId} className="result-verdict-panel__label">
          {translatedConclusion
            ? t('result.report.translatedConclusion')
            : t('result.verdict_label', { defaultValue: 'Prediction Verdict' })}
        </span>
        {confidenceLabel && safeConfidence && (
          <span
            className={`result-verdict-panel__badge result-verdict-panel__badge--${safeConfidence}`}
            data-testid="result-verdict-confidence-badge"
            data-confidence-kind={safeConfidenceKind ?? undefined}
          >
            <span className="result-verdict-panel__badge-dot" aria-hidden="true" />
            {confidenceLabel}
          </span>
        )}
      </header>

      {questionText && (
        <>
          <span className="result-verdict-panel__question-label">
            {t('result.question_answered_label', { defaultValue: 'Question answered' })}
          </span>
          <p className="result-verdict-panel__question" data-testid="result-verdict-question">
            {questionText}
          </p>
        </>
      )}

      <p className="result-verdict-panel__text" data-testid="result-verdict-text">
        {verdictText}
      </p>
      {translatedConclusion && (
        <>
          <p className="verdict-evidence__note">{t('result.report.translatedConclusionNote')}</p>
          {originalVerdictText && (
            <details className="verdict-evidence__details">
              <summary>{t('result.report.originalVerdict')}</summary>
              <p lang={report?.language}>{originalVerdictText}</p>
            </details>
          )}
        </>
      )}
      <VerdictEvidence report={report} reportStale={reportStale} onOpenEvidence={onOpenEvidence} />
    </section>
  );
}
