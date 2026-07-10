/* ═══════════════════════════════════════════════════════════
   SnapshotImportDialog — S3-6 frontend
   Drag-and-drop ZIP upload to import a scenario snapshot.
   ═══════════════════════════════════════════════════════════ */

import {
  type DragEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  getOfficialSamples,
  importOfficialSample,
  importScenarioSnapshot,
  type OfficialSampleSummary,
} from '../../api/client';
import { getLocalizedApiErrorMessage } from '../../lib/apiErrorMessage';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import './SnapshotExport.css';

interface SnapshotImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImported: (scenarioId: string) => void;
}

type ImportStep = 'select' | 'ready' | 'importing' | 'done' | 'error';

const ZIP_MIME_TYPES = new Set(['application/zip', 'application/x-zip-compressed']);
const SNAPSHOT_EXTENSIONS = ['.zip', '.swarm'];
const MAX_DISPLAY_FILE_BYTES = 50 * 1024 * 1024; // Match backend upload cap.

function isZipFile(file: File): boolean {
  if (ZIP_MIME_TYPES.has(file.type)) return true;
  return SNAPSHOT_EXTENSIONS.some(ext => file.name.toLowerCase().endsWith(ext));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function SnapshotImportDialog({
  isOpen,
  onClose,
  onImported,
}: SnapshotImportDialogProps) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<ImportStep>('select');
  const [errorMessage, setErrorMessage] = useState('');
  const [newScenarioId, setNewScenarioId] = useState<string>('');
  const [dragActive, setDragActive] = useState(false);
  const [officialSamples, setOfficialSamples] = useState<OfficialSampleSummary[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const [sampleImportingId, setSampleImportingId] = useState<string | null>(null);
  const [sampleImportError, setSampleImportError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(false);
  const catalogControllerRef = useRef<AbortController | null>(null);
  const importControllerRef = useRef<AbortController | null>(null);

  useFocusTrap(dialogRef, isOpen);

  const loadOfficialCatalog = useCallback(async () => {
    catalogControllerRef.current?.abort();
    const controller = new AbortController();
    catalogControllerRef.current = controller;
    setCatalogLoading(true);
    setCatalogError(false);
    try {
      const response = await getOfficialSamples({ signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      setOfficialSamples(response.samples);
    } catch {
      if (!mountedRef.current || controller.signal.aborted) return;
      setOfficialSamples([]);
      setCatalogError(true);
    } finally {
      if (mountedRef.current && catalogControllerRef.current === controller) {
        setCatalogLoading(false);
        catalogControllerRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      mountedRef.current = false;
      catalogControllerRef.current?.abort();
      importControllerRef.current?.abort();
      return;
    }
    mountedRef.current = true;
    setFile(null);
    setStep('select');
    setErrorMessage('');
    setNewScenarioId('');
    setDragActive(false);
    setOfficialSamples([]);
    setSampleImportingId(null);
    setSampleImportError('');
    void loadOfficialCatalog();
    return () => {
      mountedRef.current = false;
      catalogControllerRef.current?.abort();
      catalogControllerRef.current = null;
      importControllerRef.current?.abort();
      importControllerRef.current = null;
    };
  }, [isOpen, loadOfficialCatalog]);

  // Parent guarantees the dialog is unmounted when closed, so state
  // resets naturally on the next open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && step !== 'importing') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    closeButtonRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, onClose, step]);

  const validateAndSet = useCallback(
    (candidate: File | null) => {
      if (!candidate) return;
      if (!isZipFile(candidate)) {
        setErrorMessage(
          t(
            'snapshot.import_invalid_format',
            'Please choose a valid SwarmOracle snapshot (.zip or .swarm).',
          ),
        );
        setStep('error');
        setFile(null);
        return;
      }
      if (candidate.size > MAX_DISPLAY_FILE_BYTES) {
        setErrorMessage(
          t(
            'snapshot.import_file_too_large',
            'Snapshot file is too large to import via the browser.',
          ),
        );
        setStep('error');
        setFile(null);
        return;
      }
      setFile(candidate);
      setErrorMessage('');
      setStep('ready');
    },
    [t],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setDragActive(false);
      const dropped = event.dataTransfer.files?.[0] ?? null;
      validateAndSet(dropped);
    },
    [validateAndSet],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
  }, []);

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const picked = event.target.files?.[0] ?? null;
      validateAndSet(picked);
    },
    [validateAndSet],
  );

  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImport = useCallback(async () => {
    if (!file || importControllerRef.current) return;
    const controller = new AbortController();
    importControllerRef.current = controller;
    setSampleImportingId(null);
    setStep('importing');
    setErrorMessage('');
    try {
      const result = await importScenarioSnapshot(file, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      setNewScenarioId(result.scenario_id);
      setStep('done');
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      const message = getLocalizedApiErrorMessage(
        err,
        t,
        t('snapshot.import_failed', 'Snapshot import failed. Please try again.'),
      );
      setErrorMessage(message);
      setStep('error');
    } finally {
      if (importControllerRef.current === controller) {
        importControllerRef.current = null;
      }
    }
  }, [file, t]);

  const handleOfficialSampleImport = useCallback(async (sampleId: string) => {
    if (importControllerRef.current) return;
    const controller = new AbortController();
    importControllerRef.current = controller;
    setSampleImportingId(sampleId);
    setSampleImportError('');
    setStep('importing');
    try {
      const result = await importOfficialSample(sampleId, { signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      onImported(result.scenario_id);
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      setSampleImportError(getLocalizedApiErrorMessage(
        err,
        t,
        t('snapshot.sample_import_failed', 'Built-in sample import failed. Please try again.'),
      ));
      setSampleImportingId(null);
      setStep('select');
    } finally {
      if (importControllerRef.current === controller) {
        importControllerRef.current = null;
      }
    }
  }, [onImported, t]);

  const handleViewScenario = useCallback(() => {
    if (newScenarioId) onImported(newScenarioId);
  }, [newScenarioId, onImported]);

  const handleBackdrop = useCallback(() => {
    if (step !== 'importing') onClose();
  }, [step, onClose]);

  if (!isOpen) return null;

  const sampleLanguage = i18n.language.startsWith('zh') ? 'zh' : 'en';
  const importingSample = sampleImportingId
    ? officialSamples.find((sample) => sample.id === sampleImportingId) ?? null
    : null;

  return (
    <div
      className="snapshot-export-overlay"
      onClick={handleBackdrop}
      data-testid="snapshot-import-overlay"
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
          <h2 id={titleId}>{t('snapshot.import_title', 'Import Scenario Snapshot')}</h2>
          <button
            type="button"
            ref={closeButtonRef}
            className="snapshot-export-dialog__close"
            onClick={onClose}
            disabled={step === 'importing'}
            aria-label={t('common.close', 'Close')}
          >
            ✕
          </button>
        </header>

        <div className="snapshot-export-dialog__body">
          {(step === 'select' || step === 'ready' || step === 'error') && (
            <>
              {step !== 'ready' ? (
                <section className="snapshot-samples" aria-labelledby={`${titleId}-samples`}>
                  <div className="snapshot-samples__header">
                    <div>
                      <h3 id={`${titleId}-samples`}>
                        {t('snapshot.samples_title', 'Try an official sample')}
                      </h3>
                      <p>{t(
                        'snapshot.samples_hint',
                        'No model or API key needed. Import a complete run and explore it immediately.',
                      )}</p>
                    </div>
                    {catalogError ? (
                      <button
                        type="button"
                        className="btn btn-ghost snapshot-samples__retry"
                        onClick={() => void loadOfficialCatalog()}
                      >
                        {t('snapshot.sample_catalog_retry', 'Retry samples')}
                      </button>
                    ) : null}
                  </div>

                  {catalogLoading ? (
                    <p className="snapshot-samples__status" role="status">
                      {t('snapshot.sample_catalog_loading', 'Loading built-in samples…')}
                    </p>
                  ) : null}
                  {catalogError ? (
                    <p className="snapshot-samples__error" role="alert">
                      {t(
                        'snapshot.sample_catalog_failed',
                        'Built-in samples are unavailable. You can still import a local file.',
                      )}
                    </p>
                  ) : null}
                  {sampleImportError ? (
                    <p className="snapshot-samples__error" role="alert">
                      {sampleImportError}
                    </p>
                  ) : null}
                  {officialSamples.length > 0 ? (
                    <div className="snapshot-samples__grid">
                      {officialSamples.map((sample) => {
                        const title = sample.title[sampleLanguage];
                        const summary = sample.summary[sampleLanguage];
                        return (
                          <article className="snapshot-sample-card" key={sample.id}>
                            <div className="snapshot-sample-card__copy">
                              <h4>{title}</h4>
                              <p>{summary}</p>
                              <span>{t('snapshot.sample_scope', {
                                agents: sample.agent_count,
                                outcomes: sample.outcome_count,
                                defaultValue: '{{agents}} agents · {{outcomes}} outcomes',
                              })}</span>
                            </div>
                            <button
                              type="button"
                              className="btn snapshot-sample-card__action"
                              onClick={() => void handleOfficialSampleImport(sample.id)}
                              aria-label={t('snapshot.sample_use_aria', {
                                title,
                                defaultValue: `Explore ${title}`,
                              })}
                            >
                              {t('snapshot.sample_use', 'Explore now')}
                            </button>
                          </article>
                        );
                      })}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {step !== 'ready' ? (
                <div className="snapshot-import-divider" role="separator">
                  <span>{t('snapshot.import_own_file', 'Or import your own file')}</span>
                </div>
              ) : null}

              <div
                className={`snapshot-import-dropzone${dragActive ? ' snapshot-import-dropzone--active' : ''}`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                role="region"
                aria-labelledby={titleId}
              >
                <p className="snapshot-import-dropzone__title">
                  {t('snapshot.import_drop_hint', 'Drag a snapshot ZIP here')}
                </p>
                <p className="snapshot-import-dropzone__or">
                  {t('snapshot.import_or', 'or')}
                </p>
                <button
                  type="button"
                  className="btn btn-ghost snapshot-import-dropzone__pick"
                  onClick={handlePickFile}
                >
                  {t('snapshot.import_pick_file', 'Choose file…')}
                </button>
                <input
                  id={inputId}
                  ref={fileInputRef}
                  type="file"
                  accept=".zip,.swarm,application/zip"
                  className="snapshot-import-dropzone__input"
                  onChange={handleFileInputChange}
                  aria-label={t('snapshot.import_pick_file', 'Choose file…')}
                  tabIndex={-1}
                />
              </div>

              {file && (
                <dl className="snapshot-export-preview">
                  <div className="snapshot-export-preview__row">
                    <dt>{t('snapshot.import_filename_label', 'File')}</dt>
                    <dd>{file.name}</dd>
                  </div>
                  <div className="snapshot-export-preview__row">
                    <dt>{t('snapshot.import_filesize_label', 'Size')}</dt>
                    <dd>{formatBytes(file.size)}</dd>
                  </div>
                </dl>
              )}

              {step === 'error' && errorMessage && (
                <p
                  className="snapshot-export-step__error-text"
                  role="alert"
                  aria-live="assertive"
                >
                  ⚠️ {errorMessage}
                </p>
              )}
            </>
          )}

          {step === 'importing' && (
            <div
              className="snapshot-export-step snapshot-export-step--loading"
              role="status"
              aria-live="polite"
            >
              <div className="snapshot-export-spinner" aria-hidden="true" />
              <p>
                {importingSample
                  ? t('snapshot.sample_import_in_progress', {
                      title: importingSample.title[sampleLanguage],
                      defaultValue: `Opening ${importingSample.title[sampleLanguage]}…`,
                    })
                  : t('snapshot.import_in_progress', 'Importing snapshot…')}
              </p>
              <p className="snapshot-export-step__subtle">
                {importingSample
                  ? t(
                      'snapshot.sample_import_in_progress_hint',
                      'Rebuilding the complete local run. No model call is made.',
                    )
                  : t('snapshot.import_in_progress_hint', 'Validating archive and rebuilding scenario.')}
              </p>
            </div>
          )}

          {step === 'done' && (
            <div className="snapshot-export-step snapshot-export-step--done">
              <p className="snapshot-export-step__success">
                {t('snapshot.import_success', 'Snapshot imported successfully.')}
              </p>
              <p className="snapshot-export-step__subtle">
                {t('snapshot.import_success_hint', 'A new scenario has been created from your snapshot.')}
              </p>
              {newScenarioId && (
                <p className="snapshot-export-step__subtle">
                  <code>{newScenarioId}</code>
                </p>
              )}
            </div>
          )}
        </div>

        <footer className="snapshot-export-dialog__footer">
          {(step === 'select' || step === 'error') && (
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {t('common.cancel', 'Cancel')}
            </button>
          )}
          {step === 'ready' && (
            <>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleImport}
                data-testid="snapshot-import-confirm"
              >
                {t('snapshot.import_confirm', 'Confirm import')}
              </button>
            </>
          )}
          {step === 'importing' && (
            <button type="button" className="btn btn-ghost" disabled>
              {t('snapshot.import_in_progress', 'Importing snapshot…')}
            </button>
          )}
          {step === 'done' && (
            <>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                {t('common.close', 'Close')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleViewScenario}
                disabled={!newScenarioId}
                data-testid="snapshot-import-view-scenario"
              >
                {t('snapshot.import_view_scenario', 'View scenario')}
              </button>
            </>
          )}
          {step === 'error' && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setStep('select');
                setErrorMessage('');
                setFile(null);
                fileInputRef.current?.click();
              }}
              data-testid="snapshot-import-retry"
            >
              {t('common.retry', 'Retry')}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
