/* ═══════════════════════════════════════════════════════════
   S3-5 — ShareablePredictionCard
   1200×630 social card (Open Graph dimensions). Render-only
   component; intended to be rasterized via html2canvas. We do
   not use CSS variables or oklch() because html2canvas's CSS
   parser cannot resolve either reliably — every color is a hex
   or rgba literal.
   ═══════════════════════════════════════════════════════════ */

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './ShareablePredictionCard.css';

export interface ShareablePredictionCardProps {
  question: string;
  /** 0..1 (matches BranchInfo.probability). null when unknown. */
  probability: number | null;
  insight: string;
  /** Mode key (roundtable / ending_chamber / debate / scenario etc.). */
  mode: string;
  /** ISO date or human-readable; rendered verbatim. */
  date: string;
  agentCount?: number;
  /** Notified after the export attempt finishes (success or failure). */
  onExport?: (result: ShareablePredictionCardExportResult) => void;
}

export interface ShareablePredictionCardExportResult {
  success: boolean;
  /** PNG blob — only present when success === true. Caller owns lifecycle. */
  blob?: Blob;
}

export interface ShareablePredictionCardHandle {
  /** Captures the off-screen card as PNG. Returns the export result so
      callers can wire up download / clipboard / share flows themselves. */
  exportPng: () => Promise<ShareablePredictionCardExportResult>;
}

const MODE_LABEL_FALLBACK_KEY: Record<string, string> = {
  ending_chamber: 'prediction_card.mode_ending_chamber',
  worldline_roundtable: 'prediction_card.mode_roundtable',
  one_move_only: 'prediction_card.mode_one_move',
  crossline_gallery: 'prediction_card.mode_crossline',
  debate: 'prediction_card.mode_debate',
  scenario: 'prediction_card.mode_scenario',
};

function clampProbabilityPercent(value: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // BranchInfo.probability is 0..1; coerce defensively.
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return Math.round(pct);
}

const ShareablePredictionCard = forwardRef<
  ShareablePredictionCardHandle,
  ShareablePredictionCardProps
>(function ShareablePredictionCard(props, ref) {
  const { question, probability, insight, mode, date, agentCount, onExport } = props;
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement | null>(null);

  const probabilityPercent = useMemo(() => clampProbabilityPercent(probability), [probability]);
  const probabilityLabel = probabilityPercent === null ? '—' : `${probabilityPercent}%`;
  const modeLabelKey = MODE_LABEL_FALLBACK_KEY[mode] ?? null;
  // i18n contract: keys live under prediction_card.* (provided by team-lead).
  // When the mode key is unknown we fall back to the raw mode string so we
  // never leave the badge blank in production.
  const modeLabel = modeLabelKey ? t(modeLabelKey, mode) : mode || t('prediction_card.mode_default', 'Prediction');

  const exportPng = useCallback(async (): Promise<ShareablePredictionCardExportResult> => {
    const node = cardRef.current;
    if (!node) {
      const result: ShareablePredictionCardExportResult = { success: false };
      onExport?.(result);
      return result;
    }
    try {
      const { html2canvas } = await import('../../hooks/screenCaptureHtmlVendor');
      const canvas = await html2canvas(node, {
        // Card paints its own gradient; this matches the deepest tone so
        // any unpainted region blends rather than showing white.
        backgroundColor: '#0a0a14',
        // 2x scale → crisp 2400×1260 PNG at modest file size.
        scale: 2,
        logging: false,
        useCORS: true,
        // Off-screen container has unusual viewport math; pin dimensions.
        width: 1200,
        height: 630,
      });
      const blob: Blob | null = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/png', 0.95);
      });
      if (!blob) {
        const result: ShareablePredictionCardExportResult = { success: false };
        onExport?.(result);
        return result;
      }
      const result: ShareablePredictionCardExportResult = { success: true, blob };
      onExport?.(result);
      return result;
    } catch (err) {
      console.error('[ShareablePredictionCard] PNG export failed', err);
      const result: ShareablePredictionCardExportResult = { success: false };
      onExport?.(result);
      return result;
    }
  }, [onExport]);

  useImperativeHandle(ref, () => ({ exportPng }), [exportPng]);

  return (
    <div className="prediction-card-host" aria-hidden="true" data-testid="shareable-prediction-card">
      <div className="prediction-card" ref={cardRef}>
        {/* Left brand panel — fixed 40% width. */}
        <div className="prediction-card__brand">
          <div className="prediction-card__brand-mark">S</div>
          <div className="prediction-card__brand-title">SwarmOracle</div>
          <div className="prediction-card__brand-subtitle">
            {t('prediction_card.brand_subtitle', 'AI What-If Prediction')}
          </div>
          <div className="prediction-card__brand-decoration" aria-hidden="true" />
        </div>

        {/* Right content panel — 60%. */}
        <div className="prediction-card__content">
          <div className="prediction-card__question-label">
            {t('prediction_card.question_label', 'Question')}
          </div>
          <h2 className="prediction-card__question">{question}</h2>

          <div className="prediction-card__probability">
            <span className="prediction-card__probability-glow" aria-hidden="true" />
            <div className="prediction-card__probability-block">
              <div className="prediction-card__probability-label">
                {t('prediction_card.probability_label', 'Probability')}
              </div>
              <div className="prediction-card__probability-value">{probabilityLabel}</div>
            </div>
          </div>

          {insight && (
            <p className="prediction-card__insight">{insight}</p>
          )}

          <div className="prediction-card__footer">
            <div className="prediction-card__footer-meta">
              <span className="prediction-card__footer-mode">{modeLabel}</span>
              <span className="prediction-card__footer-divider" aria-hidden="true">·</span>
              <span className="prediction-card__footer-date">{date}</span>
              {typeof agentCount === 'number' && agentCount > 0 && (
                <>
                  <span className="prediction-card__footer-divider" aria-hidden="true">·</span>
                  <span className="prediction-card__footer-agents">
                    {t('prediction_card.agent_count', '{{count}} agents', { count: agentCount })}
                  </span>
                </>
              )}
            </div>
            <div className="prediction-card__watermark">swarmoracle.ai</div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default ShareablePredictionCard;
