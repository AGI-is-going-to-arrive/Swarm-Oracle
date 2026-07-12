import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  exportAgentPack,
  importAgentPack,
  isApiError,
  type AgentPackImportResponse,
  type AgentPackV1,
} from '../api/client';
import { useFocusTrap } from '../hooks/useFocusTrap';
import type { AgentIdentityInfo } from '../types';
import {
  parseAgentPackBytes,
  parseAgentPackText,
  type AgentPackValidationError,
  type AgentPackValidationResult,
} from '../lib/agentPackImportUtils';
import { triggerJsonDownload } from './personaExportImportUtils';
import './PersonaExportImport.css';

type ImportError = AgentPackValidationError
  | 'conflict'
  | 'unavailable'
  | 'server_invalid'
  | 'failed'
  | 'unknown_outcome'
  | 'refresh_failed_after_import';

export interface AgentPackDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: (response: AgentPackImportResponse) => void | Promise<void>;
}

type ExportError =
  | 'member_not_found'
  | 'unavailable'
  | 'invalid_request'
  | 'invalid_response'
  | 'failed';

export interface AgentPackExportDialogProps {
  open: boolean;
  identities: readonly AgentIdentityInfo[];
  onClose: () => void;
}

const AGENT_PACK_MAX_AGENTS = 20;

function agentPackFileName(title: string): string {
  const sanitized = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-');
  const stem = Array.from(sanitized).slice(0, 80).join('');
  return `${stem || 'agents'}-agent-pack.json`;
}

function normalizedAgentPackTitle(title: string): string | null {
  const normalized = title.trim();
  const length = Array.from(normalized).length;
  return length >= 1 && length <= 100 ? normalized : null;
}

function mapExportError(error: unknown): ExportError {
  if (!isApiError(error)) return 'failed';
  const code = error.code.trim().toUpperCase();
  if (error.status === 404 && code === 'AGENT_PACK_MEMBER_NOT_FOUND') {
    return 'member_not_found';
  }
  if (
    error.status === 404
    || error.status === 503
    || code === 'FEATURE_DISABLED'
    || code === 'AGENT_PACK_EXPORT_UNAVAILABLE'
  ) {
    return 'unavailable';
  }
  if (error.status === 413 || error.status === 422) return 'invalid_request';
  return 'failed';
}

function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error('file_read_failed'));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function personaExcerpt(text: string): string {
  const characters = Array.from(text);
  if (characters.length <= 160) return text;
  return `${characters.slice(0, 160).join('')}…`;
}

function mapImportError(error: unknown): ImportError {
  if (!isApiError(error)) return 'unknown_outcome';
  const code = error.code.trim().toUpperCase();
  if (error.status === 409 || code === 'AGENT_PACK_CONFLICT') return 'conflict';
  if (error.status === 503 || code === 'AGENT_PACK_IMPORT_UNAVAILABLE') return 'unavailable';
  if (error.status === 413 || error.status === 422) return 'server_invalid';
  return 'failed';
}

export function AgentPackDialog({ open, onClose, onImported }: AgentPackDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = `${titleId}-description`;
  const pastePanelId = `${titleId}-paste-panel`;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const requestInFlightRef = useRef(false);
  const importCommittedRef = useRef(false);
  const ingestEpochRef = useRef(0);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [pack, setPack] = useState<AgentPackV1 | null>(null);
  const [error, setError] = useState<ImportError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [importCommitted, setImportCommitted] = useState(false);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    ingestEpochRef.current += 1;
    if (!open) return;
    requestInFlightRef.current = false;
    importCommittedRef.current = false;
    setPasteOpen(false);
    setPasted('');
    setPack(null);
    setError(null);
    setSubmitting(false);
    setImportCommitted(false);
  }, [open]);

  const closeIfIdle = useCallback(() => {
    if (!requestInFlightRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || requestInFlightRef.current) return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, open]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  const ingestResult = useCallback((result: AgentPackValidationResult) => {
    if (result.ok) {
      setPack(result.pack);
      setError(null);
      return;
    }
    setPack(null);
    setError(result.error);
  }, []);

  const handlePasteChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    if (importCommittedRef.current) return;
    ingestEpochRef.current += 1;
    const text = event.target.value;
    setPasted(text);
    if (!text.trim()) {
      setPack(null);
      setError(null);
      return;
    }
    ingestResult(parseAgentPackText(text));
  }, [ingestResult]);

  const handleFileInput = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || requestInFlightRef.current || importCommittedRef.current) return;
    const ingestEpoch = ++ingestEpochRef.current;
    if (!file.name.toLowerCase().endsWith('.json') && file.type && !file.type.includes('json')) {
      setPack(null);
      setError('invalid_schema');
      return;
    }
    try {
      const result = parseAgentPackBytes(await readFileBytes(file));
      if (ingestEpoch !== ingestEpochRef.current || requestInFlightRef.current) return;
      ingestResult(result);
    } catch {
      if (ingestEpoch !== ingestEpochRef.current || requestInFlightRef.current) return;
      setPack(null);
      setError('invalid_json');
    }
  }, [ingestResult]);

  const handleSubmit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!pack || requestInFlightRef.current || importCommittedRef.current) return;
    requestInFlightRef.current = true;
    ingestEpochRef.current += 1;
    setSubmitting(true);
    setError(null);
    let response: AgentPackImportResponse;
    try {
      response = await importAgentPack(pack);
    } catch (caught) {
      setError(mapImportError(caught));
      requestInFlightRef.current = false;
      setSubmitting(false);
      return;
    }

    importCommittedRef.current = true;
    setImportCommitted(true);
    try {
      await onImported(response);
      onClose();
    } catch {
      setError('refresh_failed_after_import');
    } finally {
      requestInFlightRef.current = false;
      setSubmitting(false);
    }
  }, [onClose, onImported, pack]);

  const errorMessage = useMemo(() => {
    if (!error) return null;
    const messages: Record<ImportError, string> = {
      invalid_schema: t(
        'agent_pack.invalid_schema',
        'This file is not a valid SwarmOracle Agent Pack v1.',
      ),
      invalid_json: t('agent_pack.invalid_json', 'This file does not contain valid JSON.'),
      invalid_utf8: t('agent_pack.invalid_utf8', 'This file is not valid UTF-8 text.'),
      too_large: t('agent_pack.too_large', 'Agent Pack files must be 256 KiB or smaller.'),
      conflict: t(
        'agent_pack.conflict',
        'No agents were imported because this pack conflicts with your library.',
      ),
      unavailable: t(
        'agent_pack.unavailable',
        'Import is temporarily unavailable. Try again.',
      ),
      server_invalid: t(
        'agent_pack.server_invalid',
        'The pack did not pass server validation. No agents were imported.',
      ),
      failed: t(
        'agent_pack.failed',
        'The pack could not be imported. No agents were imported. Try again.',
      ),
      unknown_outcome: t(
        'agent_pack.unknown_outcome',
        'The import result is unknown. Refresh Agent Library before trying again.',
      ),
      refresh_failed_after_import: t(
        'agent_pack.refresh_failed_after_import',
        'Agents were imported, but the library could not refresh. Reload the library or page to see them.',
      ),
    };
    return messages[error];
  }, [error, t]);

  if (!open) return null;
  const contentLocked = submitting || importCommitted;

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) closeIfIdle();
  };

  return (
    <div
      className="persona-import-backdrop"
      onClick={handleBackdropClick}
      data-testid="agent-pack-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="persona-import-dialog agent-pack-dialog"
        tabIndex={-1}
      >
        <header className="persona-import-dialog__header">
          <h2 id={titleId} className="persona-import-dialog__title">
            {t('agent_pack.dialog_title', 'Review Agent Pack')}
          </h2>
          <button
            type="button"
            className="persona-import-dialog__close"
            onClick={closeIfIdle}
            disabled={submitting}
            aria-label={t('agent_pack.close', 'Close Agent Pack dialog')}
          >
            ×
          </button>
        </header>
        <p id={descriptionId} className="persona-import-dialog__intro">
          {t(
            'agent_pack.description',
            'Choose or paste a pack to preview every agent before anything is imported.',
          )}
        </p>

        <form onSubmit={handleSubmit}>
          <div
            className="persona-drop-zone"
            role="button"
            tabIndex={contentLocked ? -1 : 0}
            aria-disabled={contentLocked}
            onClick={() => {
              if (!requestInFlightRef.current && !importCommittedRef.current) {
                fileInputRef.current?.click();
              }
            }}
            onKeyDown={(event) => {
              if (
                !requestInFlightRef.current
                && !importCommittedRef.current
                && (event.key === 'Enter' || event.key === ' ')
              ) {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
          >
            <span className="persona-drop-zone__hint">
              {t('agent_pack.choose_file', 'Choose an Agent Pack JSON file')}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="persona-drop-zone__file"
              disabled={contentLocked}
              onChange={(event) => void handleFileInput(event)}
              data-testid="agent-pack-file-input"
              tabIndex={-1}
            />
          </div>

          <div className="persona-paste-section">
            <button
              type="button"
              className="persona-paste-toggle"
              aria-expanded={pasteOpen}
              aria-controls={pastePanelId}
              disabled={contentLocked}
              onClick={() => setPasteOpen((value) => !value)}
            >
              {t('agent_pack.paste_toggle', 'Paste Agent Pack JSON')}
            </button>
            {pasteOpen && (
              <div id={pastePanelId} className="persona-paste-panel">
                <label className="persona-paste-label" htmlFor={`${titleId}-paste`}>
                  {t('agent_pack.paste_label', 'Agent Pack JSON')}
                </label>
                <textarea
                  id={`${titleId}-paste`}
                  className="persona-paste-textarea"
                  value={pasted}
                  disabled={contentLocked}
                  onChange={handlePasteChange}
                  spellCheck={false}
                />
              </div>
            )}
          </div>

          {errorMessage && (
            <div
              className={error === 'refresh_failed_after_import'
                ? 'agent-pack-committed-warning'
                : 'persona-import-error'}
              role="alert"
            >
              {errorMessage}
            </div>
          )}

          {pack && (
            <section className="agent-pack-preview" aria-labelledby={`${titleId}-preview-title`}>
              <h3 id={`${titleId}-preview-title`}>
                {t('agent_pack.preview_title', 'Preview')}: {pack.title}
              </h3>
              <ol aria-label={t('agent_pack.preview_order', 'Agents in import order')}>
                {pack.agents.map((agent, index) => (
                  <li key={`${index}-${agent.name}`}>
                    <strong>{agent.name}</strong>
                    <span>{t('agent_pack.role', 'Role')}: {agent.role}</span>
                    <span>
                      {t('agent_pack.tags', 'Tags')}: {agent.tags.length > 0
                        ? agent.tags.join(', ')
                        : t('agent_pack.no_tags', 'None')}
                    </span>
                    <span>{t('agent_pack.persona_excerpt', 'Persona')}: {personaExcerpt(agent.persona_text)}</span>
                  </li>
                ))}
              </ol>
              <p className="agent-pack-preview__warning">
                {t(
                  'agent_pack.full_persona_warning',
                  'The complete persona text for every listed agent will be imported.',
                )}
              </p>
            </section>
          )}

          <div className="persona-import-actions">
            <button
              type="button"
              className="agent-button"
              onClick={closeIfIdle}
              disabled={submitting}
            >
              {importCommitted
                ? t('agent_pack.close_action', 'Close')
                : t('agent_pack.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              className="agent-button agent-button--primary"
              disabled={contentLocked || pack === null}
              aria-busy={submitting}
            >
              {importCommitted
                ? t('agent_pack.imported', 'Imported')
                : submitting
                  ? t('agent_pack.importing', 'Importing…')
                  : t('agent_pack.confirm', {
                    count: pack?.agents.length ?? 0,
                    defaultValue: `Import ${pack?.agents.length ?? 0} Agents`,
                  })}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function AgentPackExportDialog({
  open,
  identities,
  onClose,
}: AgentPackExportDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = `${titleId}-description`;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestEpochRef = useRef(0);
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ExportError | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  useFocusTrap(dialogRef, open);

  const availableIdentities = useMemo(() => {
    const seen = new Set<string>();
    return identities.filter((identity) => {
      if (seen.has(identity.id)) return false;
      seen.add(identity.id);
      return true;
    });
  }, [identities]);
  const identitySignature = useMemo(
    () => JSON.stringify(availableIdentities.map((identity) => identity.id)),
    [availableIdentities],
  );
  const identitySignatureRef = useRef(identitySignature);
  identitySignatureRef.current = identitySignature;
  const selectedIds = useMemo(
    () => availableIdentities
      .filter((identity) => selected.has(identity.id))
      .map((identity) => identity.id),
    [availableIdentities, selected],
  );
  const normalizedTitle = normalizedAgentPackTitle(title);

  const cancelRequest = useCallback(() => {
    requestEpochRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setSubmitting(false);
  }, []);

  const closeDialog = useCallback(() => {
    cancelRequest();
    onClose();
  }, [cancelRequest, onClose]);

  useEffect(() => {
    if (!open) {
      cancelRequest();
      return;
    }
    cancelRequest();
    setTitle('');
    setSelected(new Set());
    setError(null);
    setDownloaded(false);
  }, [cancelRequest, open]);

  useEffect(() => {
    if (!open) return;
    const allowed = new Set(availableIdentities.map((identity) => identity.id));
    setSelected((current) => {
      const next = new Set(Array.from(current).filter((id) => allowed.has(id)));
      return next.size === current.size ? current : next;
    });
    if (requestRef.current) {
      cancelRequest();
      setError('member_not_found');
      setDownloaded(false);
    }
  }, [availableIdentities, cancelRequest, identitySignature, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeDialog();
    };
    window.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [closeDialog, open]);

  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  useEffect(() => () => {
    requestEpochRef.current += 1;
    requestRef.current?.abort();
  }, []);

  const toggleIdentity = useCallback((identityId: string) => {
    if (requestRef.current) return;
    setDownloaded(false);
    setError(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(identityId)) {
        next.delete(identityId);
      } else if (next.size < AGENT_PACK_MAX_AGENTS) {
        next.add(identityId);
      }
      return next;
    });
  }, []);

  const selectFirstTwenty = useCallback(() => {
    if (requestRef.current) return;
    setSelected(new Set(
      availableIdentities
        .slice(0, AGENT_PACK_MAX_AGENTS)
        .map((identity) => identity.id),
    ));
    setDownloaded(false);
    setError(null);
  }, [availableIdentities]);

  const handleSubmit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (
      requestRef.current
      || normalizedTitle === null
      || selectedIds.length < 1
      || selectedIds.length > AGENT_PACK_MAX_AGENTS
    ) return;

    const controller = new AbortController();
    const requestEpoch = requestEpochRef.current + 1;
    const requestIdentitySignature = identitySignature;
    requestEpochRef.current = requestEpoch;
    requestRef.current = controller;
    setSubmitting(true);
    setError(null);
    setDownloaded(false);

    try {
      const response = await exportAgentPack(
        { title: normalizedTitle, identity_ids: selectedIds },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || requestEpochRef.current !== requestEpoch) return;
      if (identitySignatureRef.current !== requestIdentitySignature) {
        setError('member_not_found');
        return;
      }

      const validated = parseAgentPackText(JSON.stringify(response));
      if (!validated.ok) {
        setError('invalid_response');
        return;
      }
      triggerJsonDownload(validated.pack, agentPackFileName(validated.pack.title));
      setDownloaded(true);
    } catch (caught) {
      if (controller.signal.aborted || requestEpochRef.current !== requestEpoch) return;
      setError(mapExportError(caught));
    } finally {
      if (requestEpochRef.current === requestEpoch) {
        requestRef.current = null;
        setSubmitting(false);
      }
    }
  }, [identitySignature, normalizedTitle, selectedIds]);

  const errorMessage = useMemo(() => {
    if (!error) return null;
    const messages: Record<ExportError, string> = {
      member_not_found: t(
        'agent_pack.export_member_not_found',
        'One or more selected Agents are no longer available. Refresh the library and try again.',
      ),
      unavailable: t(
        'agent_pack.export_unavailable',
        'Agent Pack export is temporarily unavailable. Try again.',
      ),
      invalid_request: t(
        'agent_pack.export_invalid_request',
        'The Agent Pack selection is invalid. Review the title and selected Agents.',
      ),
      invalid_response: t(
        'agent_pack.export_invalid_response',
        'The server returned an invalid Agent Pack. Nothing was downloaded.',
      ),
      failed: t(
        'agent_pack.export_failed',
        'Agent Pack export failed. Nothing was downloaded. Try again.',
      ),
    };
    return messages[error];
  }, [error, t]);

  if (!open) return null;
  const selectionFull = selected.size >= AGENT_PACK_MAX_AGENTS;

  return (
    <div
      className="persona-import-backdrop"
      data-testid="agent-pack-export-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="persona-import-dialog agent-pack-dialog"
        tabIndex={-1}
      >
        <header className="persona-import-dialog__header">
          <h2 id={titleId} className="persona-import-dialog__title">
            {t('agent_pack.export_dialog_title', 'Export Agent Pack')}
          </h2>
          <button
            type="button"
            className="persona-import-dialog__close"
            onClick={closeDialog}
            aria-label={t('agent_pack.export_close', 'Close Agent Pack export')}
          >
            ×
          </button>
        </header>
        <p id={descriptionId} className="persona-import-dialog__intro">
          {t(
            'agent_pack.export_description',
            'Create a local JSON file containing the selected Agents in library order.',
          )}
        </p>

        <form onSubmit={(event) => void handleSubmit(event)}>
          <label className="persona-paste-label" htmlFor={`${titleId}-pack-title`}>
            {t('agent_pack.export_title_label', 'Pack title')}
          </label>
          <input
            id={`${titleId}-pack-title`}
            className="agent-pack-export-title"
            value={title}
            disabled={submitting}
            onChange={(event) => {
              setTitle(event.target.value);
              setDownloaded(false);
              setError(null);
            }}
            autoComplete="off"
          />
          <p className="agent-pack-export-hint">
            {t('agent_pack.export_title_hint', 'Required, up to 100 characters.')}
          </p>

          <fieldset className="agent-pack-export-fieldset" disabled={submitting}>
            <legend>
              {t('agent_pack.export_members', {
                count: selectedIds.length,
                defaultValue: `Agents (${selectedIds.length}/20 selected)`,
              })}
            </legend>
            <div className="agent-pack-export-list">
              {availableIdentities.map((identity) => {
                const checked = selected.has(identity.id);
                const source = identity.kind === 'generated'
                  ? t('agent_pack.export_source_generated', 'Generated')
                  : t('agent_pack.export_source_custom', 'Custom');
                return (
                  <label key={identity.id} className="agent-pack-export-member">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && selectionFull}
                      aria-label={t('agent_pack.export_include_agent_detail', {
                        name: identity.display_name,
                        role: identity.role,
                        source,
                        defaultValue: `Include ${identity.display_name}, ${identity.role}, ${source}`,
                      })}
                      onChange={() => toggleIdentity(identity.id)}
                    />
                    <span>
                      <strong>{identity.display_name}</strong>
                      <small>
                        {identity.role}
                        {' · '}
                        <span className="agent-pack-export-source">{source}</span>
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
            <div className="agent-pack-export-selection-actions">
              <button type="button" className="agent-link" onClick={selectFirstTwenty}>
                {t('agent_pack.export_select_first', 'Select first 20')}
              </button>
              <button
                type="button"
                className="agent-link"
                onClick={() => {
                  setSelected(new Set());
                  setDownloaded(false);
                  setError(null);
                }}
              >
                {t('agent_pack.export_clear', 'Clear selection')}
              </button>
            </div>
          </fieldset>

          <p className="agent-pack-preview__warning">
            {t(
              'agent_pack.export_disclosure',
              'The file includes full persona text, decision biases, and tags. Stored credential fields are excluded and common credential patterns are redacted, but review it for any other sensitive text before sharing. IDs, owner data, memories, growth history, and conversations are excluded. Imported Agents are recreated as custom Agents.',
            )}
          </p>

          {errorMessage && <div className="persona-import-error" role="alert">{errorMessage}</div>}
          {downloaded && (
            <div className="agent-pack-export-success" role="status">
              {t('agent_pack.export_success', 'Agent Pack downloaded locally.')}
            </div>
          )}

          <div className="persona-import-actions">
            <button type="button" className="agent-button" onClick={closeDialog}>
              {downloaded
                ? t('agent_pack.close_action', 'Close')
                : t('agent_pack.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              className="agent-button agent-button--primary"
              disabled={
                submitting
                || normalizedTitle === null
                || selectedIds.length < 1
                || selectedIds.length > AGENT_PACK_MAX_AGENTS
              }
              aria-busy={submitting}
            >
              {submitting
                ? t('agent_pack.exporting', 'Exporting…')
                : t('agent_pack.export_confirm', {
                  count: selectedIds.length,
                  defaultValue: selectedIds.length === 1
                    ? 'Export 1 Agent'
                    : `Export ${selectedIds.length} Agents`,
                })}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AgentPackDialog;
