/* ═══════════════════════════════════════════════════════════
   Document-driven Agent Generation — Extraction Progress
   ═══════════════════════════════════════════════════════════ */

import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DocumentAgentIdentity, DocumentAgentResult } from '../../api/client';

/** Stage of the multipart upload + parsing lifecycle. */
export type ExtractionStage = 'reading' | 'extracting' | 'generating' | 'done';

interface StageDescriptor {
  key: ExtractionStage;
  i18nKey: string;
  fallback: string;
}

const STAGES: StageDescriptor[] = [
  { key: 'reading', i18nKey: 'agents.doc_uploader.stage_reading', fallback: 'Reading PDF...' },
  { key: 'extracting', i18nKey: 'agents.doc_uploader.stage_extracting', fallback: 'Extracting entities...' },
  { key: 'generating', i18nKey: 'agents.doc_uploader.stage_generating', fallback: 'Generating personas...' },
];

export interface EntityExtractionProgressProps {
  /** Reflects upload lifecycle. `done` swaps the view to the success summary. */
  stage: ExtractionStage;
  /** Populated when `stage === 'done'`. */
  result?: DocumentAgentResult | null;
  /** Cancel the in-flight upload (no-op when `stage === 'done'`). */
  onCancel: () => void;
  /** Confirm and dismiss (called from the success state). */
  onConfirm?: (identities: DocumentAgentIdentity[]) => void;
  /** Optional reset/back-to-upload action shown alongside confirm. */
  onReset?: () => void;
}

const STAGE_PROGRESSION: Record<ExtractionStage, number> = {
  reading: 0,
  extracting: 1,
  generating: 2,
  done: 3,
};

export function EntityExtractionProgress({
  stage,
  result,
  onCancel,
  onConfirm,
  onReset,
}: EntityExtractionProgressProps) {
  const { t } = useTranslation();
  const liveRef = useRef<HTMLDivElement | null>(null);

  const activeIndex = STAGE_PROGRESSION[stage];
  const isComplete = stage === 'done';

  // Derive the screen-reader announcement directly from the current stage so
  // we don't introduce an effect-driven cascade.
  const announcement = useMemo(() => {
    if (isComplete) {
      return t(
        'agents.doc_uploader.aria_done',
        'Extraction complete. {{count}} agents ready to create.',
        { count: result?.agents_created ?? 0 },
      );
    }
    const stageDescriptor = STAGES[activeIndex];
    return stageDescriptor
      ? t(stageDescriptor.i18nKey, stageDescriptor.fallback)
      : '';
  }, [activeIndex, isComplete, result?.agents_created, t]);

  const identities = useMemo(() => result?.identities ?? [], [result]);
  const agentsFailed = Math.max(0, result?.agents_failed ?? 0);
  const hasCreatedAgents = identities.length > 0;

  if (isComplete) {
    return (
      <div className="doc-uploader-progress doc-uploader-progress--done" role="region">
        <div
          ref={liveRef}
          className="doc-uploader-sr-only"
          aria-live="polite"
          aria-atomic="true"
        >
          {announcement}
        </div>

        <div className="doc-uploader-progress__summary">
          <h3 className="doc-uploader-progress__heading">
            {hasCreatedAgents
              ? t('agents.doc_uploader.success_title', 'Extraction complete')
              : t('agents.doc_uploader.no_agents_title', 'No agents created')}
          </h3>
          <p className="doc-uploader-progress__count">
            {hasCreatedAgents
              ? t(
                'agents.doc_uploader.success_count',
                '{{agents}} agents ready · {{entities}} entities found',
                {
                  agents: result?.agents_created ?? 0,
                  entities: result?.entities_extracted ?? 0,
                },
              )
              : t(
                'agents.doc_uploader.no_agents_count',
                '{{entities}} entities found · 0 agents ready',
                { entities: result?.entities_extracted ?? 0 },
              )}
          </p>
          {agentsFailed > 0 && (
            <p className="doc-uploader-progress__count">
              {hasCreatedAgents
                ? t(
                  'agents.doc_uploader.partial_success',
                  '{{count}} extracted agents could not be created. The rest are ready.',
                  { count: agentsFailed },
                )
                : t(
                  'agents.doc_uploader.all_failed',
                  '{{count}} extracted agents could not be created.',
                  { count: agentsFailed },
                )}
            </p>
          )}
        </div>

        {identities.length > 0 && (
          <ul className="doc-uploader-identity-list">
            {identities.map((identity) => (
              <li key={identity.id} className="doc-uploader-identity-list__item">
                <span className="doc-uploader-identity-list__name">{identity.name}</span>
                <span className="doc-uploader-identity-list__role">{identity.role}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="doc-uploader-progress__actions">
          {onReset && (
            <button
              type="button"
              className="doc-uploader-button doc-uploader-button--ghost"
              onClick={onReset}
            >
              {t('agents.doc_uploader.action_upload_another', 'Upload another')}
            </button>
          )}
          {hasCreatedAgents && (
            <button
              type="button"
              className="doc-uploader-button doc-uploader-button--primary"
              onClick={() => onConfirm?.(identities)}
            >
              {t('agents.doc_uploader.action_create_agents', 'Create Agents')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="doc-uploader-progress" role="region" aria-busy="true">
      <div
        ref={liveRef}
        className="doc-uploader-sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </div>

      <ol className="doc-uploader-stages" aria-label={t('agents.doc_uploader.stages_label', 'Processing stages')}>
        {STAGES.map((s, index) => {
          const stateClass =
            index < activeIndex
              ? 'doc-uploader-stage--complete'
              : index === activeIndex
                ? 'doc-uploader-stage--active'
                : 'doc-uploader-stage--pending';
          return (
            <li
              key={s.key}
              className={`doc-uploader-stage ${stateClass}`}
              aria-current={index === activeIndex ? 'step' : undefined}
            >
              <span className="doc-uploader-stage__index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="doc-uploader-stage__label">
                {t(s.i18nKey, s.fallback)}
              </span>
            </li>
          );
        })}
      </ol>

      <div
        className="doc-uploader-progress-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={STAGES.length}
        aria-valuenow={activeIndex + 1}
        aria-label={t('agents.doc_uploader.progress_label', 'Extraction progress')}
      >
        <div
          className="doc-uploader-progress-bar__fill"
          style={{ width: `${((activeIndex + 1) / STAGES.length) * 100}%` }}
        />
      </div>

      <div className="doc-uploader-progress__actions">
        <button
          type="button"
          className="doc-uploader-button doc-uploader-button--ghost"
          onClick={onCancel}
        >
          {t('common.cancel', 'Cancel')}
        </button>
      </div>
    </div>
  );
}

export default EntityExtractionProgress;
