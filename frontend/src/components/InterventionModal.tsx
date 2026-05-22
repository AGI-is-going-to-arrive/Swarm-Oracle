/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Intervention Modal (Butterfly Effect + Templates)
   ═══════════════════════════════════════════════════════════ */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getInterventionTemplates,
  intervene,
  interveneBatch,
  interveneRetrospective,
} from '../api/client';
import { getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import type { InterventionTemplate } from '../api/client';
import type { BranchInfo } from '../types';
import './InterventionModal.css';

type InterventionMode = 'standard' | 'retrospective' | 'batch';

type ActiveBranch = Pick<BranchInfo, 'id' | 'title' | 'status'>;

interface Props {
  scenarioId: string;
  branchId: string;
  branchTitle: string;
  activeBranches: ActiveBranch[];
  branchRoundLimits: Record<string, number>;
  currentRound: number;
  onClose: () => void;
}

function buildBranchOptions(
  branchId: string,
  branchTitle: string,
  activeBranches: ActiveBranch[],
): Array<{ id: string; title: string }> {
  const options = activeBranches
    .filter((branch) => branch.status === 'ACTIVE')
    .map((branch) => ({
      id: branch.id,
      title: branch.title || branch.id.slice(0, 8),
    }));

  if (options.some((branch) => branch.id === branchId)) {
    return options;
  }

  return [
    {
      id: branchId,
      title: branchTitle || branchId.slice(0, 8),
    },
    ...options,
  ];
}

export default function InterventionModal({
  scenarioId,
  branchId,
  branchTitle,
  activeBranches,
  branchRoundLimits,
  currentRound,
  onClose,
}: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language?.startsWith('zh');
  const [selectedTemplate, setSelectedTemplate] = useState<InterventionTemplate | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const {
    enabled: counterfactualReplayEnabled,
    loading: counterfactualReplayLoading,
    error: counterfactualReplayError,
  } = useCapabilityCheck('counterfactual_replay');
  const [mode, setMode] = useState<InterventionMode>('standard');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [queueNotice, setQueueNotice] = useState('');
  const [templates, setTemplates] = useState<InterventionTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [selectedBatchBranchIds, setSelectedBatchBranchIds] = useState<string[] | null>(null);
  const [retrospectiveRoundState, setRetrospectiveRoundState] = useState(() => ({
    branchId,
    value: Math.max(1, branchRoundLimits[branchId] ?? 1),
  }));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const branchOptions = useMemo(
    () => buildBranchOptions(branchId, branchTitle, activeBranches),
    [activeBranches, branchId, branchTitle],
  );
  const currentBranchMaxRound = branchRoundLimits[branchId] ?? 0;
  const hasRetrospectiveHistory = currentBranchMaxRound >= 1;
  const retrospectiveCapabilityUnavailable = !counterfactualReplayLoading && !counterfactualReplayEnabled;
  const retrospectiveDisabled = !hasRetrospectiveHistory
    || counterfactualReplayLoading
    || retrospectiveCapabilityUnavailable
    || Boolean(counterfactualReplayError);
  const retrospectiveDisabledMessage = counterfactualReplayError
    ? t('common.capability_error')
    : retrospectiveCapabilityUnavailable
      ? t('intervention.retrospective_feature_disabled')
      : counterfactualReplayLoading
        ? t('common.loading')
        : t('intervention.retrospective_unavailable');
  const retrospectiveModeHint = retrospectiveDisabled
    ? (
      counterfactualReplayError
        ? t('common.capability_error')
        : retrospectiveCapabilityUnavailable
          ? t('intervention.retrospective_feature_disabled')
          : counterfactualReplayLoading
            ? t('common.loading')
            : t('intervention.retrospective_disabled_hint')
    )
    : t('intervention.mode_retrospective_hint');
  const effectiveSelectedBatchBranchIds = useMemo(() => {
    const validIds = new Set(branchOptions.map((branch) => branch.id));
    const current = selectedBatchBranchIds ?? [branchId];
    const preserved = current.filter((id) => validIds.has(id));
    return preserved.length > 0 ? preserved : [branchId];
  }, [branchId, branchOptions, selectedBatchBranchIds]);
  const retrospectiveRound = retrospectiveRoundState.branchId === branchId
    ? retrospectiveRoundState.value
    : Math.max(1, branchRoundLimits[branchId] ?? 1);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getInterventionTemplates()
      .then((data) => {
        if (!cancelled) setTemplates(data ?? []);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingTemplates(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleClose = useCallback(() => {
    if (status === 'submitting') return;
    onClose();
  }, [status, onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  const handleVariableChange = (key: string, value: string) => {
    const newValues = { ...variableValues, [key]: value };
    setVariableValues(newValues);
    if (selectedTemplate) {
      const textTemplate = (isZh ? selectedTemplate.template_zh : selectedTemplate.template_en) || selectedTemplate.template;
      let composed = textTemplate;
      selectedTemplate.variables?.forEach((v) => {
        const val = newValues[v.key] ? newValues[v.key] : `{${v.key}}`;
        composed = composed.replace(new RegExp(`\\{${v.key}\\}`, 'g'), val);
      });
      setText(composed);
    }
  };

  const handleTemplateClick = (template: InterventionTemplate) => {
    if (template.variables && template.variables.length > 0) {
      setSelectedTemplate(template);
      const initialValues: Record<string, string> = {};
      template.variables.forEach((v) => {
        initialValues[v.key] = '';
      });
      setVariableValues(initialValues);

      const textTemplate = (isZh ? template.template_zh : template.template_en) || template.template;
      let composed = textTemplate;
      template.variables.forEach((v) => {
        composed = composed.replace(new RegExp(`\\{${v.key}\\}`, 'g'), `{${v.key}}`);
      });
      setText(composed);
      inputRef.current?.focus();
    } else {
      setSelectedTemplate(null);
      setVariableValues({});
      const textTemplate = (isZh ? template.template_zh : template.template_en) || template.template;
      setText(textTemplate);
      inputRef.current?.focus();
    }
  };

  const toggleBatchBranch = (targetId: string) => {
    setSelectedBatchBranchIds((current) => {
      const currentIds = current ?? [branchId];
      return currentIds.includes(targetId)
        ? currentIds.filter((id) => id !== targetId)
        : [...currentIds, targetId];
    });
  };

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setErrorMsg(t('intervention.empty_text'));
      return;
    }
    if (status === 'submitting' || status === 'success') return;
    if (mode === 'retrospective' && retrospectiveDisabled) {
      setErrorMsg(retrospectiveDisabledMessage);
      return;
    }
    if (mode === 'batch' && effectiveSelectedBatchBranchIds.length === 0) {
      setErrorMsg(t('intervention.batch_empty'));
      return;
    }

    setStatus('submitting');
    setErrorMsg('');
    setQueueNotice('');

    try {
      if (mode === 'standard') {
        const response = await intervene(scenarioId, { branch_id: branchId, text: trimmed });
        setQueueNotice(
          (response.queued_ahead ?? 0) > 0
            ? t('intervention.queue_note_delayed', { count: response.queued_ahead })
            : t('intervention.queue_note_next'),
        );
      } else if (mode === 'retrospective') {
        await interveneRetrospective(scenarioId, {
          branch_id: branchId,
          round_number: retrospectiveRound,
          text: trimmed,
        });
      } else {
        await interveneBatch(scenarioId, {
          interventions: effectiveSelectedBatchBranchIds.map((id) => ({
            branch_id: id,
            text: trimmed,
          })),
        });
      }
      setStatus('success');
      closeTimerRef.current = setTimeout(() => onClose(), 1800);
    } catch (error) {
      setStatus('error');
      setErrorMsg(getLocalizedApiErrorMessage(error, t, t('intervention.error')));
    }
  };

  const isDisabled = status === 'submitting' || status === 'success';

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && handleClose()}>
      <div className="modal-content intervention-modal">
        <header className="modal-header">
          <h2>{t('intervention.title')}</h2>
          <p className="modal-subtitle">{t('intervention.subtitle')}</p>
        </header>

        <div className="modal-body">
          <div className="modal-field">
            <label>{t('intervention.branch_label')}</label>
            <span className="field-value">{branchTitle || branchId.slice(0, 8)}</span>
          </div>

          <div className="modal-field">
            <label>{t('intervention.round_label')}</label>
            <span className="field-value">{currentRound}</span>
          </div>

          <div className="intervention-mode-grid" role="group" aria-label={t('intervention.mode_label')}>
            <button
              type="button"
              id="intervention-tab-standard"
              aria-pressed={mode === 'standard'}
              className={`intervention-mode ${mode === 'standard' ? 'intervention-mode--active' : ''}`}
              onClick={() => setMode('standard')}
              disabled={isDisabled}
            >
              <span>{t('intervention.mode_standard')}</span>
              <small>{t('intervention.mode_standard_hint')}</small>
            </button>
            <button
              type="button"
              id="intervention-tab-retrospective"
              aria-pressed={mode === 'retrospective'}
              className={`intervention-mode ${mode === 'retrospective' ? 'intervention-mode--active' : ''}`}
              onClick={() => setMode('retrospective')}
              disabled={isDisabled || retrospectiveDisabled}
            >
              <span>{t('intervention.mode_retrospective')}</span>
              <small>{retrospectiveModeHint}</small>
            </button>
            <button
              type="button"
              id="intervention-tab-batch"
              aria-pressed={mode === 'batch'}
              className={`intervention-mode ${mode === 'batch' ? 'intervention-mode--active' : ''}`}
              onClick={() => setMode('batch')}
              disabled={isDisabled}
            >
              <span>{t('intervention.mode_batch')}</span>
              <small>{t('intervention.mode_batch_hint')}</small>
            </button>
          </div>

          <div
            id="intervention-tabpanel"
            className="intervention-tabpanel"
          >
          {!loadingTemplates && templates.length > 0 && (
            <div className="template-section">
              <label className="template-label">{t('intervention.templates_label')}</label>
              <div className="template-tags">
                {templates.map((template) => {
                  const name = (isZh ? template.name_zh : template.name_en) || template.name;
                  const textTemplate = (isZh ? template.template_zh : template.template_en) || template.template;
                  const isActive = selectedTemplate?.id === template.id;
                  return (
                    <button
                      key={template.id}
                      className={`template-tag ${isActive ? 'template-tag--active' : ''}`}
                      onClick={() => handleTemplateClick(template)}
                      disabled={isDisabled}
                      title={textTemplate}
                      type="button"
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
              {selectedTemplate && selectedTemplate.variables && selectedTemplate.variables.length > 0 && (
                <div className="template-variables">
                  {selectedTemplate.variables.map((v) => {
                    const label = (isZh ? v.label_zh : v.label_en) || v.key;
                    const placeholder = v.examples && v.examples.length > 0 ? v.examples[0] : '';
                    return (
                      <div key={v.key} className="template-variable-field">
                        <label htmlFor={`intervention-var-${v.key}`} className="template-variable-label">{label}</label>
                        <input
                          id={`intervention-var-${v.key}`}
                          className="template-variable-input"
                          type="text"
                          value={variableValues[v.key] || ''}
                          onChange={(e) => handleVariableChange(v.key, e.target.value)}
                          placeholder={placeholder}
                          disabled={isDisabled}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="template-hint">{t('intervention.templates_hint')}</p>
            </div>
          )}

          {mode === 'retrospective' && (
            <div className="intervention-panel">
              <label className="template-label" htmlFor="intervention-retrospective-round">
                {t('intervention.retrospective_round_label')}
              </label>
              <select
                id="intervention-retrospective-round"
                className="intervention-select"
                value={retrospectiveRound}
                onChange={(event) => setRetrospectiveRoundState({
                  branchId,
                  value: Number(event.target.value),
                })}
                disabled={isDisabled || retrospectiveDisabled}
              >
                {Array.from({ length: currentBranchMaxRound }, (_, index) => currentBranchMaxRound - index).map((round) => (
                  <option key={round} value={round}>
                    {t('intervention.retrospective_round_option', { round })}
                  </option>
                ))}
              </select>
              <p className="intervention-help">
                {retrospectiveDisabled
                  ? retrospectiveDisabledMessage
                  : t('intervention.retrospective_round_hint', { round: currentBranchMaxRound })}
              </p>
            </div>
          )}

          {mode === 'batch' && (
            <div className="intervention-panel">
              <label className="template-label">{t('intervention.batch_branches_label')}</label>
              <div className="intervention-branch-list">
                {branchOptions.map((branch) => (
                  <label key={branch.id} className="intervention-branch-item">
                    <input
                      type="checkbox"
                      checked={effectiveSelectedBatchBranchIds.includes(branch.id)}
                      onChange={() => toggleBatchBranch(branch.id)}
                      disabled={isDisabled}
                    />
                    <span>{branch.title}</span>
                    <code>{branch.id.slice(0, 8)}</code>
                  </label>
                ))}
              </div>
              <p className="intervention-help">
                {t('intervention.batch_hint', { count: effectiveSelectedBatchBranchIds.length })}
              </p>
            </div>
          )}

          <textarea
            ref={inputRef}
            className="intervention-input"
            placeholder={t('intervention.placeholder')}
            aria-label={t('intervention.input_label')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={isDisabled}
            rows={4}
          />

          <div aria-live="polite">
            {errorMsg && <p className="modal-error">{errorMsg}</p>}
            {status === 'success' && (
              <>
                <p className="modal-success">{t(`intervention.success_${mode}`)}</p>
                {queueNotice && <p className="intervention-help">{queueNotice}</p>}
              </>
            )}
          </div>
          </div>
        </div>

        <footer className="modal-footer">
          <button
            className="btn btn-ghost"
            onClick={handleClose}
            disabled={status === 'submitting'}
            type="button"
          >
            {t('intervention.cancel')}
          </button>
          <button
            className="btn btn-primary intervention-submit"
            onClick={handleSubmit}
            disabled={isDisabled || !text.trim()}
            type="button"
            aria-busy={status === 'submitting'}
          >
            {status === 'submitting' ? t('intervention.submitting') : t('intervention.submit')}
          </button>
        </footer>
      </div>
    </div>
  );
}
