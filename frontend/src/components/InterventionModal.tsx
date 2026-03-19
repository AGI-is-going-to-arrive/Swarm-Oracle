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
  const { t } = useTranslation();
  const [mode, setMode] = useState<InterventionMode>('standard');
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [templates, setTemplates] = useState<InterventionTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedBatchBranchIds, setSelectedBatchBranchIds] = useState<string[]>([branchId]);
  const [retrospectiveRound, setRetrospectiveRound] = useState(
    Math.max(1, branchRoundLimits[branchId] ?? 1),
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const branchOptions = useMemo(
    () => buildBranchOptions(branchId, branchTitle, activeBranches),
    [activeBranches, branchId, branchTitle],
  );
  const currentBranchMaxRound = branchRoundLimits[branchId] ?? 0;
  const retrospectiveDisabled = currentBranchMaxRound < 1;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedBatchBranchIds((current) => {
      const validIds = new Set(branchOptions.map((branch) => branch.id));
      const preserved = current.filter((id) => validIds.has(id));
      const next = preserved.length > 0 ? preserved : [branchId];
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        return current;
      }
      return next;
    });
  }, [branchId, branchOptions]);

  useEffect(() => {
    setRetrospectiveRound(Math.max(1, branchRoundLimits[branchId] ?? 1));
  }, [branchId, branchRoundLimits]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadingTemplates(true);
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

  const handleTemplateClick = (template: InterventionTemplate) => {
    setText(template.template);
    inputRef.current?.focus();
  };

  const toggleBatchBranch = (targetId: string) => {
    setSelectedBatchBranchIds((current) =>
      current.includes(targetId)
        ? current.filter((id) => id !== targetId)
        : [...current, targetId],
    );
  };

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setErrorMsg(t('intervention.empty_text'));
      return;
    }
    if (status === 'submitting' || status === 'success') return;
    if (mode === 'retrospective' && retrospectiveDisabled) {
      setErrorMsg(t('intervention.retrospective_unavailable'));
      return;
    }
    if (mode === 'batch' && selectedBatchBranchIds.length === 0) {
      setErrorMsg(t('intervention.batch_empty'));
      return;
    }

    setStatus('submitting');
    setErrorMsg('');

    try {
      if (mode === 'standard') {
        await intervene(scenarioId, { branch_id: branchId, text: trimmed });
      } else if (mode === 'retrospective') {
        await interveneRetrospective(scenarioId, {
          branch_id: branchId,
          round_number: retrospectiveRound,
          text: trimmed,
        });
      } else {
        await interveneBatch(scenarioId, {
          interventions: selectedBatchBranchIds.map((id) => ({
            branch_id: id,
            text: trimmed,
          })),
        });
      }
      setStatus('success');
      closeTimerRef.current = setTimeout(() => onClose(), 1200);
    } catch (error) {
      setStatus('error');
      setErrorMsg(error instanceof Error ? error.message : t('intervention.error'));
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

          <div className="intervention-mode-grid" role="tablist" aria-label={t('intervention.mode_label')}>
            <button
              type="button"
              className={`intervention-mode ${mode === 'standard' ? 'intervention-mode--active' : ''}`}
              onClick={() => setMode('standard')}
              disabled={isDisabled}
            >
              <span>{t('intervention.mode_standard')}</span>
              <small>{t('intervention.mode_standard_hint')}</small>
            </button>
            <button
              type="button"
              className={`intervention-mode ${mode === 'retrospective' ? 'intervention-mode--active' : ''}`}
              onClick={() => setMode('retrospective')}
              disabled={isDisabled || retrospectiveDisabled}
            >
              <span>{t('intervention.mode_retrospective')}</span>
              <small>
                {retrospectiveDisabled
                  ? t('intervention.retrospective_disabled_hint')
                  : t('intervention.mode_retrospective_hint')}
              </small>
            </button>
            <button
              type="button"
              className={`intervention-mode ${mode === 'batch' ? 'intervention-mode--active' : ''}`}
              onClick={() => setMode('batch')}
              disabled={isDisabled}
            >
              <span>{t('intervention.mode_batch')}</span>
              <small>{t('intervention.mode_batch_hint')}</small>
            </button>
          </div>

          {!loadingTemplates && templates.length > 0 && (
            <div className="template-section">
              <label className="template-label">{t('intervention.templates_label')}</label>
              <div className="template-tags">
                {templates.map((template) => (
                  <button
                    key={template.id}
                    className="template-tag"
                    onClick={() => handleTemplateClick(template)}
                    disabled={isDisabled}
                    title={template.template}
                    type="button"
                  >
                    {template.name}
                  </button>
                ))}
              </div>
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
                onChange={(event) => setRetrospectiveRound(Number(event.target.value))}
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
                  ? t('intervention.retrospective_unavailable')
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
                      checked={selectedBatchBranchIds.includes(branch.id)}
                      onChange={() => toggleBatchBranch(branch.id)}
                      disabled={isDisabled}
                    />
                    <span>{branch.title}</span>
                    <code>{branch.id.slice(0, 8)}</code>
                  </label>
                ))}
              </div>
              <p className="intervention-help">
                {t('intervention.batch_hint', { count: selectedBatchBranchIds.length })}
              </p>
            </div>
          )}

          <textarea
            ref={inputRef}
            className="intervention-input"
            placeholder={t('intervention.placeholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={isDisabled}
            rows={4}
          />

          {errorMsg && <p className="modal-error">{errorMsg}</p>}
          {status === 'success' && <p className="modal-success">{t(`intervention.success_${mode}`)}</p>}
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
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={isDisabled || !text.trim()}
            type="button"
          >
            {status === 'submitting' ? '...' : t('intervention.submit')}
          </button>
        </footer>
      </div>
    </div>
  );
}
