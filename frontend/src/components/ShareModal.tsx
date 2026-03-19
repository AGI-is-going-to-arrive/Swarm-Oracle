/* ═══════════════════════════════════════════════════════════
   ShareModal — Generate social media copy for various platforms
   ═══════════════════════════════════════════════════════════ */

import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { generateSocialCopy } from '../api/client';
import { getDirectorIdentity } from '../lib/directorIdentity';
import { loadLlmProviderPolicy } from '../lib/llmProviderPolicy';
import { buildShareCopyEnvelope, type ShareFlavorContext } from '../lib/shareEnvelope';
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
  onClose: () => void;
  onAutomationStateChange?: (state: Record<string, unknown> | null) => void;
}

export default function ShareModal({ scenarioId, shareContext, onClose, onAutomationStateChange }: ShareModalProps) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const directorIdentity = getDirectorIdentity();
  const [activePlatform, setActivePlatform] = useState<string | null>(null);
  const [copy, setCopy] = useState('');
  const [platformName, setPlatformName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  const handleGenerate = useCallback(async (platform: string) => {
    if (loading) return;
    setActivePlatform(platform);
    setCopy('');
    setError('');
    setStatus('loading');
    setLoading(true);
    setCopied(false);
    try {
      const providerPolicy = loadLlmProviderPolicy();
      const result = await generateSocialCopy(scenarioId, platform, {
        llmApiKey: providerPolicy.apiKey || undefined,
        llmBaseUrl: providerPolicy.baseUrl || undefined,
        llmModel: providerPolicy.model || undefined,
        userId: directorIdentity.userId,
      });
      setCopy(buildShareCopyEnvelope(result.copy, shareContext ?? {}, isZh));
      setPlatformName(result.platform_name);
      setStatus('success');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('share.error'));
      setStatus('error');
    } finally {
      setLoading(false);
    }
  }, [scenarioId, loading, shareContext, isZh, t]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(copy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = copy;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [copy]);

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
      has_copy: Boolean(copy),
      copy_length: copy.length,
      share_context: shareContext ?? null,
      available_platforms: PLATFORMS.map((platform) => platform.key),
    });

    return () => {
      onAutomationStateChange?.(null);
    };
  }, [activePlatform, copied, copy, error, loading, onAutomationStateChange, platformName, shareContext, status]);

  return (
    <div className="share-overlay" onClick={onClose}>
      <div className="share-modal" onClick={(e) => e.stopPropagation()}>
        <header className="share-modal__header">
          <h2>{t('share.title')}</h2>
          <button className="share-modal__close" onClick={onClose}>✕</button>
        </header>

        <div className="share-modal__platforms">
          {PLATFORMS.map((p) => (
            <button
              key={p.key}
              className={`share-platform-btn ${activePlatform === p.key ? 'active' : ''}`}
              onClick={() => handleGenerate(p.key)}
              disabled={loading}
            >
              <span className="share-platform-icon">{p.icon}</span>
              <span className="share-platform-label">{t(p.labelKey)}</span>
            </button>
          ))}
        </div>

        <div className="share-modal__content">
          {!activePlatform && !loading && (
            <p className="share-modal__hint">{t('share.hint')}</p>
          )}

          {loading && (
            <div className="share-modal__loading">
              <div className="share-spinner" />
              <p>{t('share.generating', { platform: activePlatformLabel ? t(activePlatformLabel.labelKey) : '' })}</p>
              <p className="share-modal__subtle">{t('share.generating_hint')}</p>
            </div>
          )}

          {error && (
            <div className="share-modal__error">
              <p>⚠️ {error}</p>
              <button className="btn btn-ghost" onClick={() => activePlatform && handleGenerate(activePlatform)}>
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
              {shareContext && (shareContext.profileLabel || shareContext.resonanceLabel || shareContext.profileHooks?.length) && (
                <div className="share-context">
                  {shareContext.profileLabel && (
                    <span className="share-context__chip share-context__chip--primary">
                      {shareContext.profileLabel}
                    </span>
                  )}
                  {shareContext.resonanceLabel && (
                    <span className="share-context__chip">{shareContext.resonanceLabel}</span>
                  )}
                  {(shareContext.profileHooks ?? []).slice(0, 3).map((hook) => (
                    <span key={hook} className="share-context__chip">{hook}</span>
                  ))}
                </div>
              )}
              <div className="share-result-header">
                <span className="share-result-platform">{t('share.copy_label', { platform: platformName })}</span>
                <button
                  className={`btn share-copy-btn ${copied ? 'copied' : ''}`}
                  onClick={handleCopy}
                >
                  {copied ? t('share.copied') : t('share.copy_btn')}
                </button>
              </div>
              <pre className="share-result-text">{copy}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
