/* ═══════════════════════════════════════════════════════════
   Document-driven Agent Generation — Uploader
   ─────────────────────────────────────────────────────────────
   Drag-and-drop + click-to-browse PDF dropzone. Validates type
   and size client-side, streams the file to the backend, and
   surfaces a multi-stage progress + success summary.
   ═══════════════════════════════════════════════════════════ */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  uploadDocumentForAgents,
  type DocumentAgentIdentity,
  type DocumentAgentResult,
} from '../../api/client';
import { captureApiError, getApiErrorCode, getApiErrorStatus, getApiErrorDiagnostic, type ApiErrorState } from '../../lib/apiErrorMessage';
import { EntityExtractionProgress, type ExtractionStage } from './EntityExtractionProgress';
import './DocumentUploader.css';

const ACCEPTED_MIME = 'application/pdf';
const ACCEPTED_EXTENSION = '.pdf';
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export interface DocumentUploaderProps {
  /** Notify the parent so it can refresh the agent list / show toast. */
  onAgentsCreated?: (result: DocumentAgentResult) => void;
}

type UploaderStatus =
  | { kind: 'idle' }
  | { kind: 'selected'; file: File }
  | { kind: 'uploading'; file: File; stage: ExtractionStage }
  | { kind: 'success'; file: File; result: DocumentAgentResult }
  | { kind: 'error'; file: File | null; errorKey: DocumentErrorKey; error?: ApiErrorState };

type DocumentErrorKey = `agents.doc_uploader.${
  | 'error_unsupported_type' | 'error_too_large' | 'error_empty' | 'error_empty_text'
  | 'error_no_agents_created' | 'error_timeout' | 'error_cancelled'
  | 'error_extraction_failed' | 'error_unauthorized' | 'error_generic'}`;

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function isPdfFile(file: File): boolean {
  if (file.type === ACCEPTED_MIME) return true;
  // Some browsers omit the MIME on drag-drop; fall back to extension.
  return file.name.toLowerCase().endsWith(ACCEPTED_EXTENSION);
}

function validateFile(file: File): DocumentErrorKey | null {
  if (!isPdfFile(file)) return 'agents.doc_uploader.error_unsupported_type';
  if (file.size > MAX_BYTES) return 'agents.doc_uploader.error_too_large';
  if (file.size === 0) return 'agents.doc_uploader.error_empty';
  return null;
}

function documentErrorKey(error: unknown): DocumentErrorKey {
  if (error instanceof DOMException && error.name === 'AbortError') return 'agents.doc_uploader.error_cancelled';
  switch (getApiErrorCode(error)) {
    case 'DOCUMENT_FILE_EMPTY': return 'agents.doc_uploader.error_empty';
    case 'DOCUMENT_TEXT_EMPTY': return 'agents.doc_uploader.error_empty_text';
    case 'DOCUMENT_AGENT_CREATION_FAILED': return 'agents.doc_uploader.error_no_agents_created';
    case 'DOCUMENT_PDF_TIMEOUT':
    case 'DOCUMENT_LLM_TIMEOUT': return 'agents.doc_uploader.error_timeout';
  }
  switch (getApiErrorStatus(error)) {
    case 504: return 'agents.doc_uploader.error_timeout';
    case 413: return 'agents.doc_uploader.error_too_large';
    case 415: return 'agents.doc_uploader.error_unsupported_type';
    case 422: return 'agents.doc_uploader.error_extraction_failed';
    case 401:
    case 403: return 'agents.doc_uploader.error_unauthorized';
  }
  if (error instanceof Error && error.message.toLowerCase().includes('timed out')) return 'agents.doc_uploader.error_timeout';
  return 'agents.doc_uploader.error_generic';
}

export function DocumentUploader({ onAgentsCreated }: DocumentUploaderProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dropzoneRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stageTimersRef = useRef<number[]>([]);

  const [status, setStatus] = useState<UploaderStatus>({ kind: 'idle' });
  const [isDragOver, setIsDragOver] = useState(false);

  // Always release any in-flight upload + stage timers on unmount.
  useEffect(() => () => {
    abortRef.current?.abort();
    stageTimersRef.current.forEach((id) => window.clearTimeout(id));
    stageTimersRef.current = [];
  }, []);

  const acceptedHint = useMemo(
    () =>
      t('agents.doc_uploader.accept_hint', 'PDF only, up to {{max}} MB', {
        max: 25,
      }),
    [t],
  );

  const advanceStage = useCallback((file: File) => {
    // Drive the visual stages even though the server returns one response;
    // each stage tick gives the user a sense of forward motion.
    stageTimersRef.current.forEach((id) => window.clearTimeout(id));
    stageTimersRef.current = [];

    setStatus({ kind: 'uploading', file, stage: 'reading' });
    const t1 = window.setTimeout(() => {
      setStatus((current) =>
        current.kind === 'uploading'
          ? { ...current, stage: 'extracting' }
          : current,
      );
    }, 800);
    const t2 = window.setTimeout(() => {
      setStatus((current) =>
        current.kind === 'uploading'
          ? { ...current, stage: 'generating' }
          : current,
      );
    }, 2000);
    stageTimersRef.current = [t1, t2];
  }, []);

  const startUpload = useCallback(
    async (file: File) => {
      const validationError = validateFile(file);
      if (validationError) {
        setStatus({ kind: 'error', file, errorKey: validationError });
        return;
      }

      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;

      advanceStage(file);

      try {
        const result = await uploadDocumentForAgents(file, controller.signal);
        if (abortRef.current !== controller || controller.signal.aborted) return;
        // Clear stage timers and snap to "done".
        stageTimersRef.current.forEach((id) => window.clearTimeout(id));
        stageTimersRef.current = [];
        if ((result.agents_created ?? 0) <= 0 || result.identities.length === 0) {
          setStatus({
            kind: 'error',
            file,
            errorKey: 'agents.doc_uploader.error_no_agents_created',
          });
          return;
        }
        setStatus({ kind: 'success', file, result });
        onAgentsCreated?.(result);
      } catch (err) {
        if (abortRef.current !== controller || controller.signal.aborted) return;
        stageTimersRef.current.forEach((id) => window.clearTimeout(id));
        stageTimersRef.current = [];
        setStatus({ kind: 'error', file, errorKey: documentErrorKey(err), error: captureApiError(err) });
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [advanceStage, onAgentsCreated],
  );

  const handleFileChosen = useCallback(
    (file: File) => {
      const validationError = validateFile(file);
      if (validationError) {
        setStatus({ kind: 'error', file, errorKey: validationError });
        return;
      }
      setStatus({ kind: 'selected', file });
    },
    [],
  );

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) handleFileChosen(file);
      // Allow re-selecting the same file later by resetting the input.
      event.target.value = '';
    },
    [handleFileChosen],
  );

  const openFileBrowser = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    // `dragleave` fires for child nodes too; only clear if the cursor truly left.
    if (
      dropzoneRef.current &&
      event.relatedTarget instanceof Node &&
      dropzoneRef.current.contains(event.relatedTarget)
    ) {
      return;
    }
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragOver(false);
      const file = event.dataTransfer.files?.[0];
      if (file) handleFileChosen(file);
    },
    [handleFileChosen],
  );

  const handleDropzoneKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openFileBrowser();
      }
    },
    [openFileBrowser],
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    stageTimersRef.current.forEach((id) => window.clearTimeout(id));
    stageTimersRef.current = [];
    setStatus({ kind: 'idle' });
  }, []);

  const handleConfirm = useCallback(
    (_identities: DocumentAgentIdentity[]) => {
      void _identities;
      // Caller already received `onAgentsCreated`; reset for next run.
      setStatus({ kind: 'idle' });
    },
    [],
  );

  const handleReset = useCallback(() => {
    setStatus({ kind: 'idle' });
  }, []);

  const handleStartUpload = useCallback(() => {
    if (status.kind === 'selected') {
      void startUpload(status.file);
    }
  }, [status, startUpload]);

  // ── Render branches ──────────────────────────────────────
  if (status.kind === 'uploading') {
    return (
      <section className="doc-uploader doc-uploader--busy" aria-label={t('agents.doc_uploader.label', 'Document uploader')}>
        <EntityExtractionProgress
          stage={status.stage}
          onCancel={handleCancel}
        />
      </section>
    );
  }

  if (status.kind === 'success') {
    return (
      <section className="doc-uploader doc-uploader--done" aria-label={t('agents.doc_uploader.label', 'Document uploader')}>
        <EntityExtractionProgress
          stage="done"
          result={status.result}
          onCancel={handleCancel}
          onConfirm={handleConfirm}
          onReset={handleReset}
        />
      </section>
    );
  }

  const selectedFile = status.kind === 'selected' ? status.file : null;
  const errorMessage = status.kind === 'error' ? t(status.errorKey, { max: 25 }) : null;
  const errorDiagnostic = status.kind === 'error' ? getApiErrorDiagnostic(status.error) : null;
  const errorFile = status.kind === 'error' ? status.file : null;

  return (
    <section className="doc-uploader" aria-label={t('agents.doc_uploader.label', 'Document uploader')}>
      <div
        ref={dropzoneRef}
        className={[
          'doc-uploader-dropzone',
          isDragOver ? 'doc-uploader-dropzone--active' : '',
          errorMessage ? 'doc-uploader-dropzone--error' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="button"
        tabIndex={0}
        aria-label={t(
          'agents.doc_uploader.dropzone_aria',
          'Click or press Enter to choose a PDF, or drag and drop here',
        )}
        aria-describedby="doc-uploader-hint"
        onClick={openFileBrowser}
        onKeyDown={handleDropzoneKey}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="doc-uploader-dropzone__icon" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
            <path d="M12 12v6" />
            <path d="M9 15l3-3 3 3" />
          </svg>
        </div>
        <p className="doc-uploader-dropzone__title">
          {t('agents.doc_uploader.dropzone_title', 'Drop a PDF here, or click to browse')}
        </p>
        <p id="doc-uploader-hint" className="doc-uploader-dropzone__hint">
          {acceptedHint}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={`${ACCEPTED_MIME},${ACCEPTED_EXTENSION}`}
          className="doc-uploader-dropzone__input"
          onChange={handleInputChange}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      {(selectedFile || errorFile) && (
        <div className="doc-uploader-fileinfo" role="status">
          <span className="doc-uploader-fileinfo__name">
            {(selectedFile ?? errorFile)!.name}
          </span>
          <span className="doc-uploader-fileinfo__size">
            {formatFileSize((selectedFile ?? errorFile)!.size)}
          </span>
        </div>
      )}

      {errorMessage && (
        <div className="doc-uploader-error" role="alert">
          {errorMessage}
          {errorDiagnostic && <details><summary>{t('common.error_details')}</summary><code>{errorDiagnostic}</code></details>}
        </div>
      )}

      {selectedFile && (
        <div className="doc-uploader-actions">
          <button
            type="button"
            className="doc-uploader-button doc-uploader-button--ghost"
            onClick={handleReset}
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className="doc-uploader-button doc-uploader-button--primary"
            onClick={handleStartUpload}
          >
            {t('agents.doc_uploader.action_upload', 'Upload and Extract')}
          </button>
        </div>
      )}
    </section>
  );
}

export default DocumentUploader;
