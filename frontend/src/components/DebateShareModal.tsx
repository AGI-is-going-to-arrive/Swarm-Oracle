import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useFocusTrap } from '../hooks/useFocusTrap';
import { copyText } from '../lib/copyText';
import {
  buildDebateShareCopy,
  DEBATE_SHARE_PLATFORM_META,
  isDebateLocalReadonlyCopyUrl,
  type DebateShareContext,
  type DebateSharePlatform,
} from '../lib/debateShare';

const PLATFORMS: DebateSharePlatform[] = ['xiaohongshu', 'weibo', 'zhihu', 'reddit', 'x'];

interface DebateShareModalProps {
  context: DebateShareContext;
  onClose: () => void;
  onAutomationStateChange?: (state: Record<string, unknown> | null) => void;
}

export function DebateShareModal({ context, onClose, onAutomationStateChange }: DebateShareModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  const copyInFlightRef = useRef(false);
  const feedbackTimersRef = useRef<{ copy: number | null; link: number | null }>({ copy: null, link: null });
  const titleId = useId();
  const [platform, setPlatform] = useState<DebateSharePlatform>('xiaohongshu');
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const copy = buildDebateShareCopy(platform, context, t);
  const isLocalReadonlyCopy = isDebateLocalReadonlyCopyUrl(context.permalinkUrl);

  useFocusTrap(dialogRef, true, true);

  useEffect(() => {
    const timers = feedbackTimersRef.current;
    mountedRef.current = true;
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      mountedRef.current = false;
      if (timers.copy !== null) window.clearTimeout(timers.copy);
      if (timers.link !== null) window.clearTimeout(timers.link);
    };
  }, []);

  const handleClose = useCallback(() => {
    if (!copyInFlightRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  useEffect(() => {
    onAutomationStateChange?.({
      kind: 'debate_share_modal',
      active_platform: platform,
      copied,
      link_copied: linkCopied,
      has_copy: Boolean(copy),
      copy_length: copy.length,
      permalink_url: context.permalinkUrl ?? null,
      available_platforms: PLATFORMS,
    });

    return () => {
      onAutomationStateChange?.(null);
    };
  }, [context.permalinkUrl, copied, copy, linkCopied, onAutomationStateChange, platform]);

  const handleCopy = async (link = false) => {
    const text = link ? context.permalinkUrl : copy;
    if (!text || copyInFlightRef.current) return;
    copyInFlightRef.current = true;
    setCopying(true);
    setCopyError(false);
    try {
      await copyText(text);
      if (!mountedRef.current) return;
      const timerKey = link ? 'link' : 'copy';
      const timers = feedbackTimersRef.current;
      const setCopyFeedback = link ? setLinkCopied : setCopied;
      if (timers[timerKey] !== null) window.clearTimeout(timers[timerKey]);
      setCopyFeedback(true);
      timers[timerKey] = window.setTimeout(() => setCopyFeedback(false), 1500);
    } catch {
      if (!mountedRef.current) return;
      if (link) setLinkCopied(false);
      else setCopied(false);
      setCopyError(true);
    } finally {
      copyInFlightRef.current = false;
      if (mountedRef.current) setCopying(false);
    }
  };

  return (
    <div className="debate-modal-overlay" onClick={handleClose}>
      <div
        ref={dialogRef}
        className="debate-modal debate-modal--share"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={copying}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="debate-modal__header">
          <h2 id={titleId}>{t('debate.share_title')}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="debate-modal__close"
            onClick={handleClose}
            disabled={copying}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </header>

        <div className="debate-modal__body">
          <div className="debate-modal__options">
            {PLATFORMS.map((option) => (
              <button
                key={option}
                type="button"
                className={`mode-btn ${platform === option ? 'mode-btn--active' : ''}`}
                aria-pressed={platform === option}
                disabled={copying}
                onClick={() => {
                  setPlatform(option);
                  setCopied(false);
                  setCopyError(false);
                }}
              >
                {DEBATE_SHARE_PLATFORM_META[option].icon} {t(DEBATE_SHARE_PLATFORM_META[option].labelKey)}
              </button>
            ))}
          </div>
          <pre className="debate-share-modal__copy">{copy}</pre>
          {copyError && <p className="debate-modal__error" role="alert">{t('share.copy_error')}</p>}
        </div>

        <footer className="debate-modal__footer">
          <button type="button" className="btn btn-ghost" onClick={handleClose} disabled={copying}>
            {t('common.close')}
          </button>
          {context.permalinkUrl && (
            <button type="button" className="btn btn-ghost" onClick={() => void handleCopy(true)} disabled={copying} aria-live="polite">
              {linkCopied
                ? t(isLocalReadonlyCopy ? 'debate.local_copy_copied' : 'share.permalink_copied')
                : t(isLocalReadonlyCopy ? 'debate.copy_local_copy_btn' : 'share.copy_permalink_btn')}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void handleCopy()} disabled={copying} aria-live="polite">
            {copied ? t('share.copied') : t('share.copy_btn')}
          </button>
        </footer>
      </div>
    </div>
  );
}
