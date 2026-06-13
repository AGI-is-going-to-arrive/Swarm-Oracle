import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { uploadDocumentSeed } from '../api/client';
import type {
  WorldContext,
  DocumentSeedAgentPreview,
} from '../types';
import './DocumentSeedPanel.css';

const ACCEPTED_EXTENSIONS = ['.pdf', '.txt', '.md', '.markdown'];
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export interface DocumentSeedPanelProps {
  worldContext: WorldContext | null;
  setWorldContext: (context: WorldContext | null) => void;
  agentsPreview: DocumentSeedAgentPreview[] | null;
  setAgentsPreview: (preview: DocumentSeedAgentPreview[] | null) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getFileExtension(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? `.${parts.pop()?.toLowerCase()}` : '';
}

export function DocumentSeedPanel({
  worldContext,
  setWorldContext,
  agentsPreview,
  setAgentsPreview,
}: DocumentSeedPanelProps) {
  const { t } = useTranslation();
  const { enabled, loading } = useCapabilityCheck('document_seed');

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [topWarnings, setTopWarnings] = useState<string[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  const acceptedHint = useMemo(
    () => t('document_seed.accept_hint', 'PDF, TXT, MD, up to {{max}} MB', { max: 25 }),
    [t]
  );

  const validateFile = useCallback(
    (file: File): string | null => {
      const ext = getFileExtension(file.name);
      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        return t('document_seed.error_invalid_extension', 'Unsupported file type. Upload a PDF, TXT, or Markdown file.');
      }
      if (file.size > MAX_BYTES) {
        return t('document_seed.error_too_large', 'File is larger than {{max}} MB. Please upload a smaller document.', { max: 25 });
      }
      if (file.size === 0) {
        return t('document_seed.error_empty', 'File is empty.');
      }
      return null;
    },
    [t]
  );

  const processFile = useCallback(
    async (file: File) => {
      setValidationError(null);
      const err = validateFile(file);
      if (err) {
        setValidationError(err);
        setWorldContext(null);
        setAgentsPreview(null);
        setTopWarnings([]);
        return;
      }

      setIsParsing(true);
      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const res = await uploadDocumentSeed(file, controller.signal);
        setWorldContext(res.world_context);
        setAgentsPreview(res.agents_preview || null);
        setTopWarnings(res.warnings || []);
      } catch {
        if (controller.signal.aborted) return;
        setWorldContext(null);
        setAgentsPreview(null);
        setTopWarnings([]);
        // Map all HTTP / network failures to the generic localized error message as per security rules
        setValidationError(t('document_seed.error_generic', 'Document parsing failed, please try a different file.'));
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setIsParsing(false);
      }
    },
    [validateFile, setWorldContext, setAgentsPreview, t]
  );
  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        void processFile(file);
      }
      event.target.value = '';
    },
    [processFile]
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragOver(false);
      const file = event.dataTransfer.files?.[0];
      if (file) {
        void processFile(file);
      }
    },
    [processFile]
  );

  const triggerFileInput = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        triggerFileInput();
      }
    },
    [triggerFileInput]
  );

  const handleRemove = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setWorldContext(null);
    setAgentsPreview(null);
    setTopWarnings([]);
    setValidationError(null);
  }, [setWorldContext, setAgentsPreview]);

  if (loading) {
    return null;
  }

  if (!enabled) {
    return (
      <div className="document-seed-panel document-seed-panel--disabled">
        <p className="document-seed-panel__disabled-message">
          {t('document_seed.capability_disabled', 'Document seeding is disabled. Check capability settings.')}
        </p>
      </div>
    );
  }

  // Render parsing / progress state
  if (isParsing) {
    return (
      <div className="document-seed-panel document-seed-panel--busy" role="status" aria-live="polite">
        <div className="document-seed-panel__spinner" aria-hidden="true" />
        <p className="document-seed-panel__parsing-text">
          {t('document_seed.parsing', 'Parsing document...')}
        </p>
      </div>
    );
  }

  // Render parsed summary display
  if (worldContext) {
    const meta = worldContext.source_metadata || {};
    const allWarnings = [
      ...(topWarnings || []),
      ...(worldContext.warnings || []),
    ];

    return (
      <div className="document-seed-panel document-seed-panel--success">
        <div className="document-seed-panel__header">
          <h3 className="document-seed-panel__title">
            {t('document_seed.panel_title', 'Document Seed Context')}
          </h3>
          <div className="document-seed-panel__controls">
            <button
              type="button"
              className="document-seed-panel__btn document-seed-panel__btn--secondary"
              onClick={triggerFileInput}
              aria-label={t('document_seed.replace', 'Replace Document')}
            >
              {t('document_seed.replace', 'Replace Document')}
            </button>
            <button
              type="button"
              className="document-seed-panel__btn document-seed-panel__btn--danger"
              onClick={handleRemove}
              aria-label={t('document_seed.remove', 'Remove')}
            >
              {t('document_seed.remove', 'Remove')}
            </button>
          </div>
        </div>

        {/* Source metadata banner */}
        <div className="document-seed-metadata">
          <div className="document-seed-metadata__item">
            <span className="document-seed-metadata__label">{t('document_seed.filename', 'Filename')}:</span>
            <span className="document-seed-metadata__value">{meta.filename}</span>
          </div>
          <div className="document-seed-metadata__row">
            <div className="document-seed-metadata__item">
              <span className="document-seed-metadata__label">{t('document_seed.size', 'Size')}:</span>
              <span className="document-seed-metadata__value">{formatFileSize(meta.byte_count || 0)}</span>
            </div>
            <div className="document-seed-metadata__item">
              <span className="document-seed-metadata__label">{t('document_seed.char_count', 'Character Count')}:</span>
              <span className="document-seed-metadata__value">{meta.char_count || 0}</span>
            </div>
            <div className="document-seed-metadata__item">
              <span className="document-seed-metadata__label">{t('document_seed.extraction_method', 'Extraction Method')}:</span>
              <span className="document-seed-metadata__value">{meta.extraction_method}</span>
            </div>
          </div>
        </div>

        {/* Warnings / Budget Surface */}
        {allWarnings.length > 0 && (
          <div className="document-seed-warnings" role="alert">
            <h4 className="document-seed-warnings__title">{t('document_seed.warnings', 'Warnings')}</h4>
            <ul className="document-seed-warnings__list">
              {allWarnings.map((warning, index) => (
                <li key={index} className="document-seed-warnings__item">{warning}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="document-seed-summary">
          <div className="document-seed-summary__field">
            <span className="document-seed-summary__label">{t('document_seed.title', 'Title')}:</span>
            <span className="document-seed-summary__value document-seed-summary__value--title">{worldContext.title}</span>
          </div>
          <div className="document-seed-summary__field">
            <span className="document-seed-summary__label">{t('document_seed.summary', 'Summary')}:</span>
            <p className="document-seed-summary__value">{worldContext.summary}</p>
          </div>

          {/* Constraints */}
          {worldContext.constraints && worldContext.constraints.length > 0 && (
            <div className="document-seed-section">
              <h4 className="document-seed-section__title">{t('document_seed.constraints', 'World Constraints')}</h4>
              <ul className="document-seed-section__list">
                {worldContext.constraints.map((constraint, idx) => (
                  <li key={idx} className="document-seed-section__item">{constraint}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Key Entities */}
          {worldContext.key_entities && worldContext.key_entities.length > 0 && (
            <div className="document-seed-section">
              <h4 className="document-seed-section__title">{t('document_seed.key_entities', 'Extracted Entities')}</h4>
              <div className="document-seed-entities">
                {worldContext.key_entities.map((entity, idx) => (
                  <div key={idx} className="document-seed-entity-card">
                    <div className="document-seed-entity-card__header">
                      <span className="document-seed-entity-card__name">{entity.name}</span>
                      <span className="document-seed-entity-card__role">{entity.role}</span>
                    </div>
                    {entity.traits && entity.traits.length > 0 && (
                      <div className="document-seed-entity-card__traits">
                        {entity.traits.map((trait, tIdx) => (
                          <span key={tIdx} className="document-seed-entity-card__trait">{trait}</span>
                        ))}
                      </div>
                    )}
                    <p className="document-seed-entity-card__perspective">
                      <span className="document-seed-entity-card__perspective-label">{t('document_seed.perspective', 'Perspective')}: </span>
                      {entity.perspective}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Evidence Snippets */}
          {worldContext.evidence_snippets && worldContext.evidence_snippets.length > 0 && (
            <div className="document-seed-section">
              <h4 className="document-seed-section__title">{t('document_seed.evidence_snippets', 'Evidence Snippets')}</h4>
              <ul className="document-seed-section__list">
                {worldContext.evidence_snippets.map((snippet, idx) => (
                  <li key={idx} className="document-seed-section__item document-seed-section__item--snippet">{snippet}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Agents Preview */}
          {agentsPreview && agentsPreview.length > 0 && (
            <div className="document-seed-section">
              <h4 className="document-seed-section__title">{t('document_seed.agents_preview', 'Agent Swarm Preview')}</h4>
              <div className="document-seed-agents">
                {agentsPreview.map((agent, idx) => (
                  <div key={idx} className="document-seed-agent-card">
                    <div className="document-seed-agent-card__header">
                      <span className="document-seed-agent-card__name">{agent.name}</span>
                      <span className="document-seed-agent-card__role">{agent.role}</span>
                    </div>
                    <p className="document-seed-agent-card__persona">{agent.persona}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.txt,.md,.markdown"
          className="document-seed-panel__hidden-input"
          onChange={handleInputChange}
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
    );
  }

  // Render idle upload dropzone
  return (
    <div className="document-seed-panel document-seed-panel--idle">
      <div
        className={`document-seed-dropzone ${isDragOver ? 'document-seed-dropzone--active' : ''} ${validationError ? 'document-seed-dropzone--error' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={t('document_seed.dropzone_aria', 'Choose a document to seed world context')}
        aria-describedby="document-seed-hint"
        onClick={triggerFileInput}
        onKeyDown={handleKeyDown}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="document-seed-dropzone__icon" aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
            <path d="M12 12v6" />
            <path d="M9 15l3-3 3 3" />
          </svg>
        </div>
        <p className="document-seed-dropzone__title">
          {t('document_seed.dropzone_title', 'Drop a PDF, TXT, or MD here, or click to browse')}
        </p>
        <p id="document-seed-hint" className="document-seed-dropzone__hint">
          {acceptedHint}
        </p>
      </div>

      {validationError && (
        <div className="document-seed-panel__error" role="alert">
          {validationError}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.txt,.md,.markdown"
        className="document-seed-panel__hidden-input"
        onChange={handleInputChange}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}

export default DocumentSeedPanel;
