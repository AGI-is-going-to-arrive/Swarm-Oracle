/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Intervention Modal (Butterfly Effect + Templates)
   ═══════════════════════════════════════════════════════════ */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { intervene, getInterventionTemplates } from '../api/client';
import type { InterventionTemplate } from '../api/client';
import './InterventionModal.css';

interface Props {
  scenarioId: string;
  branchId: string;
  branchTitle: string;
  onClose: () => void;
}

export default function InterventionModal({ scenarioId, branchId, branchTitle, onClose }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [templates, setTemplates] = useState<InterventionTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cleanup auto-close timer on unmount
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  // Load templates
  useEffect(() => {
    let cancelled = false;
    setLoadingTemplates(true);
    getInterventionTemplates()
      .then((data) => {
        if (!cancelled) setTemplates(data ?? []);
      })
      .catch(() => {}) // silently fail — templates are optional
      .finally(() => {
        if (!cancelled) setLoadingTemplates(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Stable close handler that guards against closing during submission
  const handleClose = useCallback(() => {
    if (status === 'submitting') return;
    onClose();
  }, [status, onClose]);

  // Close on Escape key (guarded)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  const handleTemplateClick = (tpl: InterventionTemplate) => {
    setText(tpl.template);
    inputRef.current?.focus();
  };

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setErrorMsg(t('intervention.empty_text'));
      return;
    }
    if (status === 'submitting' || status === 'success') return;

    setStatus('submitting');
    setErrorMsg('');

    try {
      await intervene(scenarioId, { branch_id: branchId, text: trimmed });
      setStatus('success');
      closeTimerRef.current = setTimeout(() => onClose(), 1200);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : t('intervention.error'));
    }
  };

  const isDisabled = status === 'submitting' || status === 'success';

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && handleClose()}>
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

          {/* Template Tags (P5-D) */}
          {!loadingTemplates && templates.length > 0 && (
            <div className="template-section">
              <label className="template-label">{t('intervention.templates_label')}</label>
              <div className="template-tags">
                {templates.map((tpl) => (
                  <button
                    key={tpl.id}
                    className="template-tag"
                    onClick={() => handleTemplateClick(tpl)}
                    disabled={isDisabled}
                    title={tpl.template}
                  >
                    {tpl.name}
                  </button>
                ))}
              </div>
              <p className="template-hint">{t('intervention.templates_hint')}</p>
            </div>
          )}

          <textarea
            ref={inputRef}
            className="intervention-input"
            placeholder={t('intervention.placeholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isDisabled}
            rows={4}
          />

          {errorMsg && <p className="modal-error">{errorMsg}</p>}
          {status === 'success' && <p className="modal-success">{t('intervention.success')}</p>}
        </div>

        <footer className="modal-footer">
          <button
            className="btn btn-ghost"
            onClick={handleClose}
            disabled={status === 'submitting'}
          >
            {t('intervention.cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={isDisabled || !text.trim()}
          >
            {status === 'submitting' ? '...' : t('intervention.submit')}
          </button>
        </footer>
      </div>
    </div>
  );
}
