import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { parsePublicArtifact, MAX_ARTIFACT_BYTES } from './parseArtifact';
import { GalleryArtifactView } from './GalleryArtifactView';
import { type PublicArtifact } from '../types';
import './gallery.css';
import './galleryI18n'; // Initialize independent i18n configurations

export function GalleryApp() {
  const { t, i18n } = useTranslation();
  const [artifact, setArtifact] = useState<PublicArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load artifact from Hash on mount and on hash changes
  useEffect(() => {
    const loadFromHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith('#data=')) {
        const dataStr = hash.substring(6);
        if (dataStr.length > MAX_ARTIFACT_BYTES) {
          setError(t('gallery.error_too_large', 'Artifact size exceeds the maximum limit of {{max}} MB.', { max: 2 }));
          setArtifact(null);
          return;
        }
        try {
          // Try decodeURIComponent first
          let decoded = decodeURIComponent(dataStr);
          let parsed = parsePublicArtifact(decoded);
          if (parsed.ok) {
            setArtifact(parsed.artifact);
            setError(null);
            if (parsed.artifact.language) {
              i18n.changeLanguage(parsed.artifact.language);
            }
            return;
          }
          // Try base64 decoding (atob) as fallback
          try {
            decoded = atob(dataStr);
            parsed = parsePublicArtifact(decoded);
            if (parsed.ok) {
              setArtifact(parsed.artifact);
              setError(null);
              if (parsed.artifact.language) {
                i18n.changeLanguage(parsed.artifact.language);
              }
              return;
            }
          } catch {
            // ignore
          }
          setError(t('gallery.error_malformed'));
        } catch {
          setError(t('gallery.error_malformed'));
        }
      }
    };

    loadFromHash();
    window.addEventListener('hashchange', loadFromHash);
    return () => window.removeEventListener('hashchange', loadFromHash);
  }, [t, i18n]);

  const handleFile = (file: File) => {
    if (file.size > MAX_ARTIFACT_BYTES) {
      setError(t('gallery.error_too_large', 'Artifact size exceeds the maximum limit of {{max}} MB.', { max: 2 }));
      setArtifact(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text !== 'string') return;
      const parsed = parsePublicArtifact(text);
      if (parsed.ok) {
        setArtifact(parsed.artifact);
        setError(null);
        if (parsed.artifact.language) {
          i18n.changeLanguage(parsed.artifact.language);
        }
      } else {
        if (parsed.reason === 'unknown_version') {
          setError(t('gallery.error_unknown_version'));
        } else {
          setError(t('gallery.error_malformed'));
        }
        setArtifact(null);
      }
    };
    reader.readAsText(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  };

  const triggerSelectFile = () => {
    fileInputRef.current?.click();
  };

  const currentLang = i18n.language.startsWith('zh') ? 'zh' : 'en';

  return (
    <div className="gallery-container">
      <header className="gallery-header">
        <h1>{t('gallery.title', 'Public Artifact Gallery')}</h1>
        <p>{t('gallery.load_prompt', 'Select or drag a public artifact JSON file to load')}</p>
        <div style={{ marginTop: '12px' }}>
          <button
            type="button"
            className="load-btn"
            style={{
              padding: '4px 12px',
              fontSize: '0.85rem',
              backgroundColor: currentLang === 'en' ? 'var(--color-primary)' : 'transparent',
              border: '1px solid var(--color-border-default)',
              color: currentLang === 'en' ? '#fff' : 'var(--color-text-secondary)',
              marginRight: '8px',
            }}
            onClick={() => i18n.changeLanguage('en')}
            aria-pressed={currentLang === 'en'}
          >
            EN
          </button>
          <button
            type="button"
            className="load-btn"
            style={{
              padding: '4px 12px',
              fontSize: '0.85rem',
              backgroundColor: currentLang === 'zh' ? 'var(--color-primary)' : 'transparent',
              border: '1px solid var(--color-border-default)',
              color: currentLang === 'zh' ? '#fff' : 'var(--color-text-secondary)',
            }}
            onClick={() => i18n.changeLanguage('zh')}
            aria-pressed={currentLang === 'zh'}
          >
            中文
          </button>
        </div>
      </header>

      {/* Drag & Drop Zone */}
      <div
        className={`load-zone ${isDragOver ? 'dragover' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={triggerSelectFile}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            triggerSelectFile();
          }
        }}
        aria-label={t('gallery.load_prompt')}
      >
        <p>{t('gallery.load_prompt', 'Select or drag a public artifact JSON file to load')}</p>
        <button type="button" className="load-btn">
          {t('gallery.load_file', 'Choose File')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
      </div>

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      {artifact ? (
        <GalleryArtifactView artifact={artifact} />
      ) : (
        <div
          style={{
            textAlign: 'center',
            padding: '40px',
            color: 'var(--color-text-secondary)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: '12px',
            backgroundColor: 'var(--color-surface)',
          }}
        >
          <p>{t('gallery.empty', 'No artifact loaded. Please load a valid artifact JSON.')}</p>
        </div>
      )}
    </div>
  );
}
