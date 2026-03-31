import { measureParagraph } from './pretext';

const HEADING_FONT_STACK = '"Cormorant Garamond", "Noto Serif SC", serif';

export interface TextareaHeightPrediction {
  lines: number;
  height: number;
}

/**
 * Build the CSS font shorthand that matches the InputView hero textarea.
 *
 * On desktop (>640 px) the textarea uses `clamp(2rem, 1.7rem + 1.5vw, 3rem)`.
 * On mobile (<=640 px) it uses `clamp(1.45rem, 6.8vw, 2.2rem)`.
 * Callers pass the *resolved* pixel font size so the prediction is viewport-accurate.
 */
function buildInputFont(fontSizePx: number, weight = 400): string {
  return `normal ${weight} ${fontSizePx}px ${HEADING_FONT_STACK}`;
}

/**
 * Resolve the effective font size (in px) for the InputView hero textarea at
 * a given viewport width.  Mirrors the CSS `clamp()` values in InputView.css.
 */
export function resolveInputFontSizePx(viewportWidth: number): number {
  const rootFontSize = 16; // browser default
  if (viewportWidth <= 640) {
    // clamp(1.45rem, 6.8vw, 2.2rem)
    const vw = viewportWidth * 0.068;
    return Math.min(Math.max(1.45 * rootFontSize, vw), 2.2 * rootFontSize);
  }
  // clamp(2rem, 1.7rem + 1.5vw, 3rem)
  const vw = 1.7 * rootFontSize + viewportWidth * 0.015;
  return Math.min(Math.max(2 * rootFontSize, vw), 3 * rootFontSize);
}

/**
 * Resolve the line-height multiplier for the InputView hero textarea.
 * Desktop: 1.2, Mobile (<=640px): 1.12.
 */
export function resolveInputLineHeightMultiplier(viewportWidth: number): number {
  return viewportWidth <= 640 ? 1.12 : 1.2;
}

/**
 * Predict the textarea height for the InputView hero input without DOM measurement.
 *
 * Falls back to a simple char-per-line estimate when pretext throws (e.g. if
 * the font metrics aren't available in CI / SSR).
 */
export function predictTextareaHeight(
  text: string,
  containerWidth: number,
  options?: {
    viewportWidth?: number;
    fontSizePx?: number;
    lineHeightMultiplier?: number;
    locale?: string | null;
  },
): TextareaHeightPrediction {
  const viewportWidth = options?.viewportWidth ?? (typeof window !== 'undefined' ? window.innerWidth : 1024);
  const fontSizePx = options?.fontSizePx ?? resolveInputFontSizePx(viewportWidth);
  const lineHeightMultiplier = options?.lineHeightMultiplier ?? resolveInputLineHeightMultiplier(viewportWidth);
  const lineHeightPx = fontSizePx * lineHeightMultiplier;

  if (!text || containerWidth <= 0) {
    return { lines: 1, height: lineHeightPx };
  }

  try {
    const font = buildInputFont(fontSizePx);
    const { lineCount, height } = measureParagraph({
      text,
      font,
      maxWidthPx: containerWidth,
      lineHeightPx,
      locale: options?.locale,
    });
    return { lines: lineCount, height };
  } catch {
    // Fallback: rough estimate based on average character width
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const avgCharWidth = fontSizePx * (cjkCount / text.length > 0.3 ? 1.0 : 0.55);
    const charsPerLine = Math.max(1, Math.floor(containerWidth / avgCharWidth));
    const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
    return { lines, height: lines * lineHeightPx };
  }
}
