/* ═══════════════════════════════════════════════════════════
   PersonaExportImport — export button + import dialog for
   user-portable Agent backup JSON files (schema_version 1).
   ═══════════════════════════════════════════════════════════ */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  exportPersona,
  importPersona,
  isApiError,
  type PersonaExportPayload,
} from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { triggerJsonDownload, validatePersonaPayload } from './personaExportImportUtils';
import './PersonaExportImport.css';

function sanitizeFileNameStem(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'agent';
  return trimmed.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-').slice(0, 80) || 'agent';
}

function apiErrorCode(error: unknown): string | null {
  if (!isApiError(error)) return null;
  return error.code.trim().toUpperCase() || null;
}

function logUnexpectedPersonaError(context: string, error: unknown) {
  if (error instanceof Error) {
    console.debug(`[PersonaExportImport] ${context} failed`, error);
  }
}

// ── ExportButton ────────────────────────────────────────

export interface ExportButtonProps {
  identityId: number | string;
  name: string;
}

export function ExportButton({ identityId, name }: ExportButtonProps) {
  const { t } = useTranslation();
  const { enabled, loading: capLoading } = useCapabilityCheck('persona_export');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (busy) return;
      setBusy(true);
      setStatus(null);
      try {
        const payload = await exportPersona(identityId);
        const fileName = `${sanitizeFileNameStem(name)}-agent-backup.json`;
        triggerJsonDownload(payload, fileName);
        setStatus({ kind: 'ok', message: t('persona_export.export_success', 'Agent backup exported') });
      } catch (err) {
        const code = apiErrorCode(err);
        if (!code) logUnexpectedPersonaError('Export', err);
        const message = code === 'FEATURE_DISABLED' || code === 'PERSONA_EXPORT_DISABLED'
          ? t('persona_export.feature_disabled', 'Agent backups are not enabled.')
          : code === 'AGENT_IDENTITY_NOT_FOUND' || code === 'PERSONA_EXPORT_NOT_FOUND'
            ? t('persona_export.export_not_found', 'Agent backup could not be found.')
            : t('persona_export.export_failed', 'Could not export Agent backup. Please try again.');
        setStatus({ kind: 'err', message });
      } finally {
        setBusy(false);
      }
    },
    [busy, identityId, name, t],
  );

  // Auto-clear OK status after 2.5s; errors persist until next attempt.
  useEffect(() => {
    if (status?.kind !== 'ok') return;
    const id = window.setTimeout(() => setStatus(null), 2500);
    return () => window.clearTimeout(id);
  }, [status]);

  if (capLoading) return null;
  if (!enabled) return null;

  return (
    <span className="persona-export-wrap">
      <button
        type="button"
        className="persona-export-btn"
        onClick={handleClick}
        disabled={busy}
        aria-busy={busy}
        aria-label={t('persona_export.export_agent_aria', {
          name,
          defaultValue: 'Export backup for {{name}}',
        })}
      >
        <svg
          className="persona-export-btn__icon"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M8 1v9m0 0L4.5 6.5M8 10l3.5-3.5M2 13h12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {t('persona_export.export', 'Export Backup')}
      </button>
      {status && (
        <span
          className={`persona-export-status${status.kind === 'err' ? ' persona-export-status--error' : ''}`}
          role="status"
          aria-live="polite"
        >
          {status.message}
        </span>
      )}
    </span>
  );
}

// ── ImportDialog ─────────────────────────────────────────

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (id: string) => void;
}

export function ImportDialog({ open, onClose, onImported }: ImportDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = `${titleId}-description`;
  const pastePanelId = `${titleId}-paste-panel`;
  const [pasted, setPasted] = useState('');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, open);

  // Reset transient state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setPasted('');
      setErrorKey(null);
      setSubmitting(false);
      setDragActive(false);
      setPasteOpen(false);
    }
  }, [open]);

  // Escape closes; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  // Auto-focus the dialog when opened so screen readers announce the title.
  useEffect(() => {
    if (open && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [open]);

  const errorMessage = useMemo(() => {
    if (!errorKey) return null;
    if (errorKey === 'persona_export.invalid_schema') {
      return t(
        'persona_export.invalid_schema',
        'This backup file is not supported. Use a SwarmOracle Agent backup with schema_version 1.',
      );
    }
    if (errorKey === 'persona_export.missing_fields') {
      return t(
        'persona_export.missing_fields',
        'This backup is missing the Agent name, role, or persona text.',
      );
    }
    if (errorKey === 'persona_export.invalid_json') {
      return t('persona_export.invalid_json', 'Invalid JSON');
    }
    if (errorKey === 'persona_export.import_conflict') {
      return t('persona_export.import_conflict', 'This Agent backup already exists for your account.');
    }
    if (errorKey === 'persona_export.import_invalid') {
      return t('persona_export.import_invalid', 'Agent backup failed server validation.');
    }
    if (errorKey === 'persona_export.import_not_allowed') {
      return t('persona_export.import_not_allowed', 'Creating Agents from backup is not enabled.');
    }
    if (errorKey === 'persona_export.import_failed') {
      return t('persona_export.import_failed', 'Could not create Agent from backup. Please try again.');
    }
    return errorKey;
  }, [errorKey, t]);

  const ingestText = useCallback((text: string): { ok: true; payload: PersonaExportPayload } | { ok: false } => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setErrorKey('persona_export.invalid_json');
      return { ok: false };
    }
    const result = validatePersonaPayload(parsed);
    if (!result.ok) {
      setErrorKey(result.errorKey);
      return { ok: false };
    }
    setErrorKey(null);
    return { ok: true, payload: result.payload };
  }, []);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.json') && file.type && !file.type.includes('json')) {
      setErrorKey('persona_export.invalid_schema');
      return;
    }
    try {
      const text = await file.text();
      setPasted(text);
      ingestText(text);
    } catch {
      setErrorKey('persona_export.invalid_json');
    }
  }, [ingestText]);

  const handleFileInput = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleFile(file);
    }
    // Reset to allow re-selecting the same file.
    e.target.value = '';
  }, [handleFile]);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void handleFile(file);
    }
  }, [handleFile]);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);

  const handleDropZoneKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  }, []);

  const handleSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!pasted.trim()) {
      setErrorKey('persona_export.missing_fields');
      return;
    }
    const result = ingestText(pasted);
    if (!result.ok) return;
    setSubmitting(true);
    try {
      const response = await importPersona(result.payload);
      if (response.success) {
        onImported(response.identity_id);
        onClose();
      }
    } catch (err) {
      const code = apiErrorCode(err);
      if (!code) logUnexpectedPersonaError('Import', err);
      if (code === 'PERSONA_IMPORT_CONFLICT') {
        setErrorKey('persona_export.import_conflict');
      } else if (code === 'PERSONA_IMPORT_INVALID') {
        setErrorKey('persona_export.import_invalid');
      } else if (code === 'FEATURE_DISABLED' || code === 'PERSONA_EXPORT_DISABLED') {
        setErrorKey('persona_export.import_not_allowed');
      } else {
        setErrorKey('persona_export.import_failed');
      }
    } finally {
      setSubmitting(false);
    }
  }, [ingestText, onClose, onImported, pasted, submitting]);

  if (!open) return null;

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="persona-import-backdrop"
      onClick={handleBackdropClick}
      data-testid="persona-import-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="persona-import-dialog"
        tabIndex={-1}
      >
        <header className="persona-import-dialog__header">
          <h2 id={titleId} className="persona-import-dialog__title">
            {t('persona_export.import_title', 'Create Agent from Backup')}
          </h2>
          <button
            type="button"
            className="persona-import-dialog__close"
            onClick={onClose}
            aria-label={t('persona_export.cancel', 'Cancel')}
          >
            ×
          </button>
        </header>
        <p id={descriptionId} className="persona-import-dialog__intro">
          {t(
            'persona_export.import_description',
            'Upload a JSON backup exported from Agent Library. This creates a new Agent and does not overwrite your existing Agents.',
          )}
        </p>

        <form onSubmit={handleSubmit}>
          <div
            className={`persona-drop-zone${dragActive ? ' persona-drop-zone--active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={handleDropZoneKey}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            data-testid="persona-drop-zone"
            data-drag-active={dragActive ? 'true' : 'false'}
          >
            <svg
              className="persona-drop-zone__icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M12 16V4m0 0L7 9m5-5l5 5M4 20h16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="persona-drop-zone__hint">
              {t(
                'persona_export.drop_zone',
                'Drop a .json backup exported from Agent Library, or click to choose a file',
              )}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleFileInput}
              className="persona-drop-zone__file"
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>

          <div className="persona-paste-section">
            <button
              type="button"
              className="persona-paste-toggle"
              aria-expanded={pasteOpen}
              aria-controls={pastePanelId}
              onClick={() => setPasteOpen((value) => !value)}
            >
              {t('persona_export.paste_json_toggle', 'Advanced: paste JSON content')}
            </button>
            {pasteOpen && (
              <div id={pastePanelId} className="persona-paste-panel">
                <label className="persona-paste-label" htmlFor={`${titleId}-paste`}>
                  {t('persona_export.paste_json', 'JSON backup content')}
                </label>
                <textarea
                  id={`${titleId}-paste`}
                  className="persona-paste-textarea"
                  value={pasted}
                  onChange={(e) => {
                    setPasted(e.target.value);
                    if (errorKey) setErrorKey(null);
                  }}
                  spellCheck={false}
                  data-testid="persona-paste-textarea"
                />
              </div>
            )}
          </div>

          {errorMessage && (
            <div className="persona-import-error" role="alert">
              {errorMessage}
            </div>
          )}

          <div className="persona-import-actions">
            <button
              type="button"
              className="agent-button"
              onClick={onClose}
              disabled={submitting}
            >
              {t('persona_export.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              className="agent-button agent-button--primary"
              disabled={submitting || !pasted.trim()}
              aria-busy={submitting}
            >
              {t('persona_export.submit', 'Create as New Agent')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default { ExportButton, ImportDialog };
