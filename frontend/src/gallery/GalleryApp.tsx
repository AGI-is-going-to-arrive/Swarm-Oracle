import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { parsePublicArtifact, MAX_ARTIFACT_BYTES } from './parseArtifact';
import { decodePublicArtifactHash } from './artifactLink';
import { GalleryArtifactView } from './GalleryArtifactView';
import { type PublicArtifact } from '../types';
import './gallery.css';
import './galleryI18n'; // Initialize independent i18n configurations

function advanceLoadEpoch(epochRef: { current: number }): number {
  epochRef.current += 1;
  return epochRef.current;
}

export function GalleryApp() {
  const { t, i18n } = useTranslation();
  const [artifact, setArtifact] = useState<PublicArtifact | null>(null);
  const [errorKey, setErrorKey] = useState<'gallery.error_too_large' | 'gallery.error_malformed' | 'gallery.error_unknown_version' | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const loadEpochRef = useRef(0);

  // Load artifact from Hash on mount and on hash changes
  useEffect(() => {
    const loadFromHash = () => {
      const loadEpoch = advanceLoadEpoch(loadEpochRef);
      const hash = window.location.hash;
      if (!hash.startsWith('#data=')) {
        setArtifact(null);
        setErrorKey(null);
        return;
      }

      const decoded = decodePublicArtifactHash(hash);
      if (!decoded.ok) {
        if (decoded.reason === 'too_large') {
          setErrorKey('gallery.error_too_large');
        } else {
          setErrorKey('gallery.error_malformed');
        }
        setArtifact(null);
        return;
      }

      const parsed = parsePublicArtifact(decoded.json);
      if (loadEpoch !== loadEpochRef.current) return;
      if (parsed.ok) {
        setArtifact(parsed.artifact);
        setErrorKey(null);
      } else if (parsed.reason === 'unknown_version') {
        setErrorKey('gallery.error_unknown_version');
        setArtifact(null);
      } else {
        setErrorKey('gallery.error_malformed');
        setArtifact(null);
      }
    };

    loadFromHash();
    window.addEventListener('hashchange', loadFromHash);
    return () => {
      advanceLoadEpoch(loadEpochRef);
      window.removeEventListener('hashchange', loadFromHash);
    };
  }, []);

  const handleFile = (file: File) => {
    const loadEpoch = advanceLoadEpoch(loadEpochRef);
    if (file.size > MAX_ARTIFACT_BYTES) {
      setErrorKey('gallery.error_too_large');
      setArtifact(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      if (loadEpoch !== loadEpochRef.current) return;
      const text = e.target?.result;
      if (typeof text !== 'string') {
        setErrorKey('gallery.error_malformed');
        setArtifact(null);
        return;
      }
      const parsed = parsePublicArtifact(text);
      if (loadEpoch !== loadEpochRef.current) return;
      if (parsed.ok) {
        setArtifact(parsed.artifact);
        setErrorKey(null);
      } else {
        if (parsed.reason === 'unknown_version') {
          setErrorKey('gallery.error_unknown_version');
        } else {
          setErrorKey('gallery.error_malformed');
        }
        setArtifact(null);
      }
    };
    reader.onerror = () => {
      if (loadEpoch !== loadEpochRef.current) return;
      setErrorKey('gallery.error_malformed');
      setArtifact(null);
    };
    reader.readAsText(file);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0] ?? null;
    e.currentTarget.value = '';
    if (file) handleFile(file);
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

      {errorKey && (
        <div className="error-banner" role="alert">
          {t(errorKey, { max: MAX_ARTIFACT_BYTES / (1024 * 1024) })}
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
