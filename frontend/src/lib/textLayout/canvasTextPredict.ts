/**
 * Pretext P4 — Canvas/Theater text prediction bridge.
 *
 * Provides pretext-based text measurement as an alternative to creating and
 * destroying temporary Phaser text objects in WorldScene.showBubble().
 *
 * When pretext is available, this avoids a DOM-touching `getBounds()` call
 * per bubble render. Falls back to `null` so the caller can use the original
 * Phaser measurement path.
 */
import { measureParagraph } from './pretext';

const BUBBLE_FONT_STACK = '"Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

export interface BubbleSizePrediction {
  textWidth: number;
  textHeight: number;
}

function buildBubbleFont(sizePx: number, weight: number | string = 700): string {
  return `normal ${weight} ${sizePx}px ${BUBBLE_FONT_STACK}`;
}

/**
 * Predict the text dimensions for a Phaser speech bubble without creating a
 * temporary Phaser.GameObjects.Text.
 *
 * @returns The predicted text bounds, or `null` if pretext fails (caller
 *          should fall back to the original Phaser measurement).
 */
export function predictBubbleTextSize(
  text: string,
  wrapWidth: number,
  options?: {
    fontSizePx?: number;
    lineSpacing?: number;
    locale?: string | null;
  },
): BubbleSizePrediction | null {
  if (!text || wrapWidth <= 0) return null;

  const fontSizePx = options?.fontSizePx ?? 14;
  const lineSpacing = options?.lineSpacing ?? 4;
  // Phaser lineHeight = fontSize + lineSpacing
  const lineHeightPx = fontSizePx + lineSpacing;

  try {
    const font = buildBubbleFont(fontSizePx);
    const { lineCount, height } = measureParagraph({
      text,
      font,
      maxWidthPx: wrapWidth,
      lineHeightPx,
    });
    // Width: use wrapWidth for multi-line, estimate for single-line
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const avgCharWidth = cjkCount / text.length > 0.3
      ? fontSizePx * 0.95
      : fontSizePx * 0.52;
    const textWidth = lineCount <= 1
      ? Math.min(wrapWidth, text.length * avgCharWidth)
      : wrapWidth;
    return {
      textWidth,
      textHeight: height,
    };
  } catch {
    // Pretext unavailable — caller falls back to Phaser measurement
    return null;
  }
}
