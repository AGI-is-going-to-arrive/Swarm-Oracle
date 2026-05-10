/* ═══════════════════════════════════════════════════════════
   SnapshotExportWizard — S3-6 frontend
   Two-step wizard for exporting a scenario as a ZIP snapshot.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { exportScenarioSnapshot } from '../../api/client';
import { getLocalizedApiErrorMessage } from '../../lib/apiErrorMessage';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import './SnapshotExport.css';

interface SnapshotExportWizardProps {
  scenarioId: string;
  isOpen: boolean;
  onClose: () => void;
  /** Optional human-readable title shown in step 1 preview. */
  scenarioTitle?: string;
}

type WizardStep = 'configure' | 'exporting' | 'done' | 'error';

function buildSnapshotFilename(scenarioId: string): string {
  return `swarmoracle_snapshot_${scenarioId}_${Date.now()}.zip`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function SnapshotExportWizard({
  scenarioId,
  isOpen,
  onClose,
  scenarioTitle,
}: SnapshotExportWizardProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const includePrivateId = useId();
  const [includePrivate, setIncludePrivate] = useState(false);
  const [step, setStep] = useState<WizardStep>('configure');
  const [errorMessage, setErrorMessage] = useState('');
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const requestControllerRef = useRef<AbortController | null>(null);

  useFocusTrap(dialogRef, isOpen);

  useEffect(() => {
    if (!isOpen) return;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
    };
  }, [isOpen]);

  // Escape key + auto-focus close button on open.
  // (Parent guarantees the dialog is unmounted when closed, so state
  // resets naturally on the next open.)
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && step !== 'exporting') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    closeButtonRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, onClose, step]);

  const handleExport = useCallback(async () => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setStep('exporting');
    setErrorMessage('');
    try {
      const blob = await exportScenarioSnapshot(scenarioId, includePrivate, {
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      downloadBlob(blob, buildSnapshotFilename(scenarioId));
      setStep('done');
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      const message = getLocalizedApiErrorMessage(
        err,
        t,
        t('snapshot.export_failed', 'Snapshot export failed. Please try again.'),
      );
      setErrorMessage(message);
      setStep('error');
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  }, [scenarioId, includePrivate, t]);

  const handleBackdrop = useCallback(() => {
    if (step !== 'exporting') onClose();
  }, [step, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="snapshot-export-overlay"
      onClick={handleBackdrop}
      data-testid="snapshot-export-overlay"
    >
      <div
        ref={dialogRef}
        className="snapshot-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="snapshot-export-dialog__header">
          <h2 id={titleId}>{t('snapshot.export_title', 'Export Scenario Snapshot')}</h2>
          <button
            type="button"
            ref={closeButtonRef}
            className="snapshot-export-dialog__close"
            onClick={onClose}
            disabled={step === 'exporting'}
            aria-label={t('common.close', 'Close')}
          >
            ✕
          </button>
        </header>

        <div className="snapshot-export-dialog__body">
          {step === 'configure' && (
            <div className="snapshot-export-step">
              <p className="snapshot-export-step__hint">
                {t(
                  'snapshot.export_hint',
                  'Bundle this scenario into a portable ZIP that can be re-imported later.',
                )}
              </p>
              <dl className="snapshot-export-preview">
                <div className="snapshot-export-preview__row">
                  <dt>{t('snapshot.scenario_id_label', 'Scenario ID')}</dt>
                  <dd>
                    <code>{scenarioId}</code>
                  </dd>
                </div>
                {scenarioTitle && (
                  <div className="snapshot-export-preview__row">
                    <dt>{t('snapshot.scenario_title_label', 'Title')}</dt>
                    <dd>{scenarioTitle}</dd>
                  </div>
                )}
              </dl>
              <label
                htmlFor={includePrivateId}
                className="snapshot-export-checkbox"
              >
                <input
                  id={includePrivateId}
                  type="checkbox"
                  checked={includePrivate}
                  onChange={(event) => setIncludePrivate(event.target.checked)}
                />
                <span>
                  <strong>
                    {t('snapshot.include_private_label', 'Include private data (user IDs)')}
                  </strong>
                  <small>
                    {t(
                      'snapshot.include_private_hint',
                      'Owner-only. Avoid sharing snapshots with private data publicly.',
                    )}
                  </small>
                </span>
              </label>
            </div>
          )}

          {step === 'exporting' && (
            <div
              className="snapshot-export-step snapshot-export-step--loading"
              role="status"
              aria-live="polite"
            >
              <div className="snapshot-export-spinner" aria-hidden="true" />
              <p>{t('snapshot.export_in_progress', 'Bundling snapshot…')}</p>
              <p className="snapshot-export-step__subtle">
                {t('snapshot.export_in_progress_hint', 'This may take a few seconds.')}
              </p>
            </div>
          )}

          {step === 'done' && (
            <div className="snapshot-export-step snapshot-export-step--done">
              <p className="snapshot-export-step__success">
                {t('snapshot.export_success', 'Snapshot downloaded.')}
              </p>
              <p className="snapshot-export-step__subtle">
                {t(
                  'snapshot.export_success_hint',
                  'Check your browser downloads folder for the ZIP file.',
                )}
              </p>
            </div>
          )}

          {step === 'error' && (
            <div
              className="snapshot-export-step snapshot-export-step--error"
              role="alert"
              aria-live="assertive"
            >
              <p>⚠️ {errorMessage}</p>
            </div>
          )}
        </div>

        <footer className="snapshot-export-dialog__footer">
          {step === 'configure' && (
            <>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleExport}
                data-testid="snapshot-export-start"
              >
                {t('snapshot.export_start', 'Start export')}
              </button>
            </>
          )}
          {step === 'exporting' && (
            <button type="button" className="btn btn-ghost" disabled>
              {t('snapshot.export_in_progress', 'Bundling snapshot…')}
            </button>
          )}
          {step === 'done' && (
            <button type="button" className="btn" onClick={onClose}>
              {t('common.close', 'Close')}
            </button>
          )}
          {step === 'error' && (
            <>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleExport}
                data-testid="snapshot-export-retry"
              >
                {t('common.retry', 'Retry')}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
