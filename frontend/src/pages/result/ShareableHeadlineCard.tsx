/* ═══════════════════════════════════════════════════════════
   F11 — ShareableHeadlineCard
   1200×630 social card (Open Graph dimensions). Render-only
   component; intended to be rasterized via html2canvas. We do
   not use CSS variables or oklch() because html2canvas's CSS
   parser cannot resolve either reliably — every color is a hex
   or rgba literal.
   ═══════════════════════════════════════════════════════════ */

import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './ShareableHeadlineCard.css';

export interface ShareableHeadlineCardProps {
  headline: string;
  summary: string;
  branchTitle: string;
  roundNumber: number | null;
  eventType: string;
  factionLabel: string;
  /** ISO date or human-readable; rendered verbatim. */
  date: string;
  onExport?: (result: ShareableHeadlineCardExportResult) => void;
}

export interface ShareableHeadlineCardExportResult {
  success: boolean;
  blob?: Blob;
}

export interface ShareableHeadlineCardHandle {
  exportPng: () => Promise<ShareableHeadlineCardExportResult>;
}

const ShareableHeadlineCard = forwardRef<
  ShareableHeadlineCardHandle,
  ShareableHeadlineCardProps
>(function ShareableHeadlineCard(props, ref) {
  const {
    headline,
    summary,
    branchTitle,
    roundNumber,
    eventType,
    factionLabel,
    date,
    onExport,
  } = props;
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement | null>(null);

  const exportPng = useCallback(async (): Promise<ShareableHeadlineCardExportResult> => {
    const node = cardRef.current;
    if (!node) {
      const result: ShareableHeadlineCardExportResult = { success: false };
      onExport?.(result);
      return result;
    }
    try {
      const { html2canvas } = await import('../../hooks/screenCaptureHtmlVendor');
      const canvas = await html2canvas(node, {
        backgroundColor: '#0a0a14',
        scale: 2,
        logging: false,
        useCORS: true,
        width: 1200,
        height: 630,
      });
      const blob: Blob | null = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/png', 0.95);
      });
      if (!blob) {
        const result: ShareableHeadlineCardExportResult = { success: false };
        onExport?.(result);
        return result;
      }
      const result: ShareableHeadlineCardExportResult = { success: true, blob };
      onExport?.(result);
      return result;
    } catch (err) {
      console.error('[ShareableHeadlineCard] PNG export failed', err);
      const result: ShareableHeadlineCardExportResult = { success: false };
      onExport?.(result);
      return result;
    }
  }, [onExport]);

  useImperativeHandle(ref, () => ({ exportPng }), [exportPng]);

  return (
    <div className="headline-card-host" aria-hidden="true" data-testid="shareable-headline-card">
      <div className="headline-card" ref={cardRef}>
        {/* Left brand panel — fixed 40% width. */}
        <div className="headline-card__brand">
          <div className="headline-card__brand-mark">H</div>
          <div className="headline-card__brand-title">SwarmOracle</div>
          <div className="headline-card__brand-subtitle">
            {t('social_feed.share_headline', 'Social Feed Headline')}
          </div>
          <div className="headline-card__brand-decoration" aria-hidden="true" />
        </div>

        {/* Right content panel — 60%. */}
        <div className="headline-card__content">
          <div className="headline-card__meta-badge">
            {factionLabel || t('social_feed.confidence_label', 'Faction')}
          </div>
          <h2 className="headline-card__title">{headline}</h2>
          <p className="headline-card__summary">{summary}</p>

          <div className="headline-card__footer">
            <div className="headline-card__footer-meta">
              <span className="headline-card__footer-branch">{branchTitle}</span>
              <span className="headline-card__footer-divider" aria-hidden="true">·</span>
              <span className="headline-card__footer-type">{eventType}</span>
              {roundNumber !== null && (
                <>
                  <span className="headline-card__footer-divider" aria-hidden="true">·</span>
                  <span className="headline-card__footer-round">
                    {t('social_feed.event_round', 'Round {{round}}', { round: roundNumber })}
                  </span>
                </>
              )}
              <span className="headline-card__footer-divider" aria-hidden="true">·</span>
              <span className="headline-card__footer-date">{date}</span>
            </div>
            <div className="headline-card__watermark">swarmoracle.ai</div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ShareableHeadlineCard;
