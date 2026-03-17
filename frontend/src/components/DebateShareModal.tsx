import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildDebateShareCopy, type DebateShareContext, type DebateSharePlatform } from '../lib/debateShare';

const PLATFORMS: DebateSharePlatform[] = ['xiaohongshu', 'weibo', 'zhihu', 'reddit', 'x'];

interface DebateShareModalProps {
  context: DebateShareContext;
  onClose: () => void;
}

export function DebateShareModal({ context, onClose }: DebateShareModalProps) {
  const { t } = useTranslation();
  const [platform, setPlatform] = useState<DebateSharePlatform>('xiaohongshu');
  const [copied, setCopied] = useState(false);

  const copy = buildDebateShareCopy(platform, context, t);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copy);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
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
                {t(`share.platform_${option}`)}
              </button>
            ))}
          </div>
          <pre className="debate-share-modal__copy">{copy}</pre>
        </div>

        <footer className="debate-modal__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.close')}
          </button>
          <button type="button" className="btn btn-primary" onClick={handleCopy}>
            {copied ? t('share.copied') : t('share.copy_btn')}
          </button>
        </footer>
      </div>
    </div>
  );
}
