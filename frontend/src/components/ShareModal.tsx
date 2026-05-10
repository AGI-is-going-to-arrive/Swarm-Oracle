/* ═══════════════════════════════════════════════════════════
   ShareModal — Generate social media copy for various platforms
   ═══════════════════════════════════════════════════════════ */

import { useState, useCallback, useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { generateSocialCopy } from '../api/client';
import { getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import { getDirectorIdentity } from '../lib/directorIdentity';
import { loadLlmProviderPolicy, validateByok } from '../lib/llmProviderPolicy';
import { type ShareFlavorContext } from '../lib/shareEnvelope';
import type { BranchInfo } from '../types';
import ShareArtifact, { type ShareArtifactHandle } from './ShareArtifact';
import ShareablePredictionCard, {
  type ShareablePredictionCardHandle,
} from './result/ShareablePredictionCard';
import { useFocusTrap } from '../hooks/useFocusTrap';
import './ShareModal.css';

interface Platform {
  key: string;
  labelKey: string;
  icon: string;
  color: string;
}

const PLATFORMS: Platform[] = [
  { key: 'xiaohongshu', labelKey: 'share.platform_xiaohongshu', icon: '📕', color: '#fe2c55' },
  { key: 'weibo',       labelKey: 'share.platform_weibo',       icon: '🔴', color: '#ff8200' },
  { key: 'zhihu',       labelKey: 'share.platform_zhihu',       icon: '💙', color: '#0066ff' },
  { key: 'reddit',      labelKey: 'share.platform_reddit',      icon: '🟠', color: '#ff4500' },
  { key: 'x',           labelKey: 'share.platform_x',           icon: '𝕏',  color: '#000000' },
];

interface ShareModalProps {
  scenarioId: string;
  shareContext?: ShareFlavorContext;
  /** Optional artifact-only data. Falls back to shareContext when omitted. */
  branches?: BranchInfo[];
  agentNames?: string[];
  sourceFamilies?: string[];
  /** Mode key (roundtable / debate / scenario / ending_chamber etc.) used by
      the prediction-card variant. Renders verbatim if no i18n key matches. */
  mode?: string;
  onClose: () => void;
  onAutomationStateChange?: (state: Record<string, unknown> | null) => void;
}

function pickDominantBranchForCard(branches: BranchInfo[]): BranchInfo | null {
  if (!branches || branches.length === 0) return null;
  const completed = branches.filter((b) => b.status === 'COMPLETED');
  const pool = completed.length > 0 ? completed : branches;
  return pool.reduce<BranchInfo | null>((best, current) => {
    if (!best) return current;
    const bp = typeof best.probability === 'number' ? best.probability : 0;
    const cp = typeof current.probability === 'number' ? current.probability : 0;
    return cp > bp ? current : best;
  }, null);
}

function formatPredictionCardDate(date: Date): string {
  // Locale-neutral YYYY-MM-DD; deterministic for export.
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function downloadBlobAsFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Feature-detect clipboard image write. Required for the copy button to
    appear; if missing we hide the action so users don't get a confusing
    "copy failed" toast. */
function clipboardCanWriteImages(): boolean {
  if (typeof navigator === 'undefined') return false;
  const cb: { write?: unknown } | undefined = navigator.clipboard as
    | { write?: unknown }
    | undefined;
  if (!cb || typeof cb.write !== 'function') return false;
  // ClipboardItem is the gating constructor on Safari/Firefox.
  return typeof window !== 'undefined' && typeof (window as { ClipboardItem?: unknown }).ClipboardItem === 'function';
}

export default function ShareModal({
  scenarioId,
  shareContext,
  branches,
  agentNames,
  sourceFamilies,
  mode,
  onClose,
  onAutomationStateChange,
}: ShareModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const directorIdentity = getDirectorIdentity();
  const [activePlatform, setActivePlatform] = useState<string | null>(null);
  const [copy, setCopy] = useState('');
  const [platformName, setPlatformName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copyError, setCopyError] = useState('');
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [exportingImage, setExportingImage] = useState(false);
  const [exportImageError, setExportImageError] = useState('');
  const [exportingPredictionCard, setExportingPredictionCard] = useState(false);
  const [predictionCardError, setPredictionCardError] = useState('');
  const [predictionCardCopied, setPredictionCardCopied] = useState(false);
  const artifactRef = useRef<ShareArtifactHandle | null>(null);
  const predictionCardRef = useRef<ShareablePredictionCardHandle | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const requestControllerRef = useRef<AbortController | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const predictionCardCopiedTimerRef = useRef<number | null>(null);
  const clipboardSupportsImages = clipboardCanWriteImages();

  useFocusTrap(dialogRef, true);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const clearCopiedTimers = useCallback(() => {
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
    if (predictionCardCopiedTimerRef.current !== null) {
      window.clearTimeout(predictionCardCopiedTimerRef.current);
      predictionCardCopiedTimerRef.current = null;
    }
  }, []);

  const handleClose = useCallback(() => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    clearCopiedTimers();
    onCloseRef.current();
  }, [clearCopiedTimers]);

  useEffect(() => {
    mountedRef.current = true;
    closeButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      mountedRef.current = false;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      clearCopiedTimers();
      window.removeEventListener('keydown', onKey);
    };
  }, [clearCopiedTimers, handleClose]);

  /** When branches aren't supplied, synthesize a single fallback BranchInfo
      from shareContext.dominantBranchTitle so the artifact still renders.
      We never include sensitive fields — only outcome title + insight. */
  const artifactBranches: BranchInfo[] = branches && branches.length > 0
    ? branches
    : (shareContext?.dominantBranchTitle
        ? [{
            id: 'share-artifact-fallback',
            parent_branch_id: null,
            fork_round: 0,
            fork_reason: '',
            title: shareContext.dominantBranchTitle,
            summary: '',
            story: '',
            insight: shareContext?.counterplaySummary ?? '',
            key_moments: [],
            probability: 1,
            status: 'COMPLETED',
          }]
        : []);
  const artifactQuestion = shareContext?.question ?? '';

  /** Prediction-card payload — derived from the same dominant branch we'd
      pick for the OG artifact, but exposed as primitive fields the card
      component understands. We never include LLM/API config. */
  const predictionDominant = pickDominantBranchForCard(artifactBranches);
  const predictionInsight =
    predictionDominant?.insight?.trim()
    || predictionDominant?.summary?.trim()
    || shareContext?.counterplaySummary?.trim()
    || '';
  const predictionMode = mode || 'scenario';
  const predictionDate = formatPredictionCardDate(new Date());
  const predictionAgentCount = (agentNames ?? []).filter((n) => typeof n === 'string' && n.trim().length > 0).length || undefined;

  const handleGenerate = useCallback(async (platform: string) => {
    if (loading) return;
    let controller: AbortController | null = null;
    setActivePlatform(platform);
    setCopy('');
    setError('');
    setCopyError('');
    setPlatformName('');
    try {
      const providerPolicy = loadLlmProviderPolicy();
      const validation = validateByok({
        apiKey: providerPolicy.apiKey,
        baseUrl: providerPolicy.baseUrl,
      });
      if (!validation.valid) {
        setError(getLocalizedApiErrorMessage({ code: validation.errorCode }, t, t('share.error')));
        setStatus('error');
        return;
      }
      setStatus('loading');
      setLoading(true);
      setCopied(false);
      requestControllerRef.current?.abort();
      controller = new AbortController();
      requestControllerRef.current = controller;
      const result = await generateSocialCopy(scenarioId, platform, {
        llmApiKey: providerPolicy.apiKey || undefined,
        llmBaseUrl: providerPolicy.baseUrl || undefined,
        llmModel: providerPolicy.model || undefined,
        llmRequestsPerMinute: providerPolicy.requestsPerMinute ?? undefined,
        llmTokensPerMinute: providerPolicy.tokensPerMinute ?? undefined,
        userId: directorIdentity.userId,
      }, {
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      const normalizedCopy = result.copy.trim();
      if (!normalizedCopy) {
        setError(t('share.error'));
        setStatus('error');
        return;
      }
      setCopy(normalizedCopy);
      setPlatformName(result.platform_name);
      setStatus('success');
    } catch (err) {
      if (controller?.signal.aborted || !mountedRef.current) return;
      setError(getLocalizedApiErrorMessage(err, t, t('share.error')));
      setStatus('error');
    } finally {
      if (mountedRef.current && !controller?.signal.aborted) {
        setLoading(false);
      }
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  }, [scenarioId, loading, t, directorIdentity.userId]);

  const handleCopy = useCallback(async () => {
    setCopyError('');
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        throw new Error('clipboard-unavailable');
      }
      await navigator.clipboard.writeText(copy);
      if (!mountedRef.current) return;
      setCopied(true);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) {
          setCopied(false);
        }
        copiedTimerRef.current = null;
      }, 2000);
    } catch {
      if (!mountedRef.current) return;
      setCopied(false);
      setCopyError(t('share.copy_error'));
    }
  }, [copy, t]);

  /** Capture the offscreen artifact card as PNG and trigger a download.
      We do NOT include any LLM/API config here — the artifact only renders
      question / outcome / source-family chips / agent display names. */
  const handleExportImage = useCallback(async () => {
    if (exportingImage) return;
    if (!artifactRef.current) return;
    setExportImageError('');
    setExportingImage(true);
    try {
      const ok = await artifactRef.current.exportPng();
      if (!ok) {
        setExportImageError(t('share.export_image_failed', 'Image export failed. Please try again.'));
      }
    } catch (err) {
      console.error('[ShareModal] export image failed', err);
      setExportImageError(t('share.export_image_failed', 'Image export failed. Please try again.'));
    } finally {
      setExportingImage(false);
    }
  }, [exportingImage, t]);

  /** Capture the off-screen ShareablePredictionCard and download it. */
  const handleDownloadPredictionCard = useCallback(async () => {
    if (exportingPredictionCard) return;
    if (!predictionCardRef.current) return;
    setPredictionCardError('');
    setPredictionCardCopied(false);
    setExportingPredictionCard(true);
    try {
      const result = await predictionCardRef.current.exportPng();
      if (!mountedRef.current) return;
      if (!result.success || !result.blob) {
        setPredictionCardError(
          t('prediction_card.export_failed', 'Prediction card export failed. Please try again.'),
        );
        return;
      }
      downloadBlobAsFile(result.blob, `swarmoracle_prediction_${Date.now()}.png`);
    } catch (err) {
      console.error('[ShareModal] prediction card download failed', err);
      setPredictionCardError(
        t('prediction_card.export_failed', 'Prediction card export failed. Please try again.'),
      );
    } finally {
      setExportingPredictionCard(false);
    }
  }, [exportingPredictionCard, t]);

  /** Capture the off-screen ShareablePredictionCard and copy as PNG to the
      system clipboard. Hidden when the platform doesn't support image
      writes (Safari < 16.4 / Firefox without permission etc.). */
  const handleCopyPredictionCard = useCallback(async () => {
    if (exportingPredictionCard) return;
    if (!predictionCardRef.current) return;
    setPredictionCardError('');
    setPredictionCardCopied(false);
    setExportingPredictionCard(true);
    try {
      const result = await predictionCardRef.current.exportPng();
      if (!result.success || !result.blob) {
        setPredictionCardError(
          t('prediction_card.copy_failed', 'Could not copy prediction card. Try downloading instead.'),
        );
        return;
      }
      // Cast: ClipboardItem is feature-detected before we expose this button.
      const ClipboardItemCtor = (window as unknown as {
        ClipboardItem: new (items: Record<string, Blob>) => ClipboardItem;
      }).ClipboardItem;
      const item = new ClipboardItemCtor({ 'image/png': result.blob });
      await navigator.clipboard.write([item]);
      if (!mountedRef.current) return;
      setPredictionCardCopied(true);
      if (predictionCardCopiedTimerRef.current !== null) {
        window.clearTimeout(predictionCardCopiedTimerRef.current);
      }
      predictionCardCopiedTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) {
          setPredictionCardCopied(false);
        }
        predictionCardCopiedTimerRef.current = null;
      }, 2000);
    } catch (err) {
      if (!mountedRef.current) return;
      console.error('[ShareModal] prediction card copy failed', err);
      setPredictionCardError(
        t('prediction_card.copy_failed', 'Could not copy prediction card. Try downloading instead.'),
      );
    } finally {
      setExportingPredictionCard(false);
    }
  }, [exportingPredictionCard, t]);

  const activePlatformLabel = PLATFORMS.find(p => p.key === activePlatform);

  useEffect(() => {
    onAutomationStateChange?.({
      kind: 'share_modal',
      active_platform: activePlatform,
      platform_name: platformName || null,
      status,
      loading,
      error: error || null,
      copied,
      copy_error: copyError || null,
      has_copy: Boolean(copy),
      copy_length: copy.length,
      share_context: shareContext ?? null,
      available_platforms: PLATFORMS.map((platform) => platform.key),
      exporting_image: exportingImage,
      export_image_error: exportImageError || null,
      exporting_prediction_card: exportingPredictionCard,
      prediction_card_error: predictionCardError || null,
      prediction_card_copied: predictionCardCopied,
      prediction_card_clipboard_supported: clipboardSupportsImages,
    });

    return () => {
      onAutomationStateChange?.(null);
    };
  }, [activePlatform, copied, copy, copyError, error, loading, onAutomationStateChange, platformName, shareContext, status, exportingImage, exportImageError, exportingPredictionCard, predictionCardError, predictionCardCopied, clipboardSupportsImages]);

  return (
    <div className="share-overlay" onClick={handleClose}>
      <div
        ref={dialogRef}
        className="share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="share-modal__header">
          <h2 id={titleId}>{t('share.title')}</h2>
          <button
            type="button"
            ref={closeButtonRef}
            className="share-modal__close"
            onClick={handleClose}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </header>

        <div className="share-modal__platforms">
          {PLATFORMS.map((p) => (
            <button
              type="button"
              key={p.key}
              className={`share-platform-btn ${activePlatform === p.key ? 'share-platform-btn--active' : ''}`}
              onClick={() => handleGenerate(p.key)}
              disabled={loading}
              aria-pressed={activePlatform === p.key}
            >
              <span className="share-platform-icon">{p.icon}</span>
              <span className="share-platform-label">{t(p.labelKey)}</span>
            </button>
          ))}
          <button
            type="button"
            className="share-platform-btn share-platform-btn--image"
            onClick={handleExportImage}
            disabled={exportingImage || loading}
            data-testid="share-export-image-btn"
            aria-busy={exportingImage}
          >
            <span className="share-platform-icon" aria-hidden="true">🖼️</span>
            <span className="share-platform-label">
              {exportingImage
                ? t('share.export_downloading', 'Generating image…')
                : t('share.export_image', 'Export as Image')}
            </span>
          </button>
          <button
            type="button"
            className="share-platform-btn share-platform-btn--prediction"
            onClick={handleDownloadPredictionCard}
            disabled={exportingPredictionCard || loading}
            data-testid="share-prediction-card-download-btn"
            aria-busy={exportingPredictionCard}
          >
            <span className="share-platform-icon" aria-hidden="true">🔮</span>
            <span className="share-platform-label">
              {exportingPredictionCard
                ? t('prediction_card.exporting', 'Generating card…')
                : t('prediction_card.download_button', 'Download Prediction Card')}
            </span>
          </button>
          {clipboardSupportsImages && (
            <button
              type="button"
              className="share-platform-btn share-platform-btn--prediction-copy"
              onClick={handleCopyPredictionCard}
              disabled={exportingPredictionCard || loading}
              data-testid="share-prediction-card-copy-btn"
              aria-busy={exportingPredictionCard}
            >
              <span className="share-platform-icon" aria-hidden="true">📋</span>
              <span className="share-platform-label">
                {predictionCardCopied
                  ? t('prediction_card.copied', 'Copied!')
                  : t('prediction_card.copy_button', 'Copy Prediction Card')}
              </span>
            </button>
          )}
        </div>
        {exportImageError && (
          <p
            className="share-modal__error-text"
            role="alert"
            aria-live="assertive"
            style={{ padding: '0 24px 8px' }}
          >
            ⚠️ {exportImageError}
          </p>
        )}
        {predictionCardError && (
          <p
            className="share-modal__error-text"
            role="alert"
            aria-live="assertive"
            style={{ padding: '0 24px 8px' }}
          >
            ⚠️ {predictionCardError}
          </p>
        )}

        <div className="share-modal__content">
          {!activePlatform && !loading && (
            <p className="share-modal__hint">{t('share.hint')}</p>
          )}

          {loading && (
            <div className="share-modal__loading" role="status" aria-live="polite">
              <div className="share-spinner" />
              <p>{t('share.generating', { platform: activePlatformLabel ? t(activePlatformLabel.labelKey) : '' })}</p>
              <p className="share-modal__subtle">{t('share.generating_hint')}</p>
            </div>
          )}

          {error && (
            <div className="share-modal__error" role="alert" aria-live="assertive">
              <p>⚠️ {error}</p>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => activePlatform && handleGenerate(activePlatform)}
              >
                {t('share.retry')}
              </button>
            </div>
          )}

          {copy && !loading && (
            <div className="share-modal__result">
              <div className={`share-modal__status share-modal__status--${status}`}>
                <strong>{t('share.ready', { platform: platformName || (activePlatformLabel ? t(activePlatformLabel.labelKey) : '') })}</strong>
                <span>{copied ? t('share.copied_hint') : t('share.ready_hint')}</span>
              </div>
              <div className="share-result-header">
                <span className="share-result-platform">{t('share.copy_label', { platform: platformName })}</span>
                <button
                  type="button"
                  className={`btn share-copy-btn ${copied ? 'share-copy-btn--copied' : ''}`}
                  onClick={handleCopy}
                >
                  {copied ? t('share.copied') : t('share.copy_btn')}
                </button>
              </div>
              {copyError && (
                <p className="share-modal__error-text" role="alert" aria-live="assertive">
                  ⚠️ {copyError}
                </p>
              )}
              <pre className="share-result-text">{copy}</pre>
            </div>
          )}
        </div>
        {/* Offscreen ShareArtifact: kept in the DOM so html2canvas can
            rasterize the real layout. position:fixed/left:-99999px keeps
            it out of the viewport without skipping paint. */}
        <ShareArtifact
          ref={artifactRef}
          question={artifactQuestion}
          branches={artifactBranches}
          agentNames={agentNames}
          sourceFamilies={sourceFamilies}
        />
        {/* Off-screen ShareablePredictionCard. Same offscreen pattern as
            ShareArtifact — kept in the DOM so html2canvas can rasterize the
            real layout. Receives the same dominant-branch projection used
            by the OG card, but renders the social-card variant. */}
        <ShareablePredictionCard
          ref={predictionCardRef}
          question={artifactQuestion}
          probability={typeof predictionDominant?.probability === 'number' ? predictionDominant.probability : null}
          insight={predictionInsight}
          mode={predictionMode}
          date={predictionDate}
          agentCount={predictionAgentCount}
        />
      </div>
    </div>
  );
}
