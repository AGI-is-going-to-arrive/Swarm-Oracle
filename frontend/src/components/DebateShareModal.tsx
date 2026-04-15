import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
  const [platform, setPlatform] = useState<DebateSharePlatform>('xiaohongshu');
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const copy = buildDebateShareCopy(platform, context, t);
  const isLocalReadonlyCopy = isDebateLocalReadonlyCopyUrl(context.permalinkUrl);

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

  const handleCopy = async () => {
    try {
      await copyText(copy);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const handleCopyLink = async () => {
    if (!context.permalinkUrl) return;
    try {
      await copyText(context.permalinkUrl);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      setLinkCopied(false);
    }
  };

  return (
    <div className="debate-modal-overlay" onClick={onClose}>
      <div className="debate-modal debate-modal--share" onClick={(event) => event.stopPropagation()}>
        <header className="debate-modal__header">
          <h2>{t('debate.share_title')}</h2>
          <button type="button" className="debate-modal__close" onClick={onClose}>
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
                onClick={() => setPlatform(option)}
              >
                {DEBATE_SHARE_PLATFORM_META[option].icon} {t(DEBATE_SHARE_PLATFORM_META[option].labelKey)}
              </button>
            ))}
          </div>
          <pre className="debate-share-modal__copy">{copy}</pre>
        </div>

        <footer className="debate-modal__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.close')}
          </button>
          {context.permalinkUrl && (
            <button type="button" className="btn btn-ghost" onClick={handleCopyLink}>
              {linkCopied
                ? t(isLocalReadonlyCopy ? 'debate.local_copy_copied' : 'share.permalink_copied')
                : t(isLocalReadonlyCopy ? 'debate.copy_local_copy_btn' : 'share.copy_permalink_btn')}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={handleCopy}>
            {copied ? t('share.copied') : t('share.copy_btn')}
          </button>
        </footer>
      </div>
    </div>
  );
}
