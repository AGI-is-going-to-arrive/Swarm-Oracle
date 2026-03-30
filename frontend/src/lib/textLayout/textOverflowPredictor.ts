import {
  measureParagraph,
  type MeasureParagraphOptions,
  type TextLayoutWhiteSpace,
} from './pretext';

export interface TextLayoutContract {
  font: string;
  lineHeightPx: number;
  maxWidthPx: number;
  whiteSpace?: TextLayoutWhiteSpace;
  maxLines?: number;
  chromeHeightPx?: number;
  locale?: string | null;
}

export interface TextOverflowPrediction {
  height: number;
  lineCount: number;
  totalHeight: number;
  overflow: boolean;
  maxLines: number | null;
  overflowLines: number;
}

const HEADING_FONT_STACK = '"Cormorant Garamond", "Noto Serif SC", serif';
const BODY_FONT_STACK = '"Instrument Sans", "Noto Sans SC", sans-serif';

function buildFontShorthand(
  sizePx: number,
  family: string,
  weight = 400,
  style: 'normal' | 'italic' = 'normal',
): string {
  return `${style} ${weight} ${sizePx}px ${family}`;
}

export const ORACLE_TEXT_LAYOUT_CONTRACTS = {
  resultEndingTitle: {
    font: buildFontShorthand(28, HEADING_FONT_STACK, 500),
    lineHeightPx: 36.4,
    maxWidthPx: 344,
    maxLines: 3,
  },
  resultInsightQuote: {
    font: buildFontShorthand(18, HEADING_FONT_STACK, 400, 'italic'),
    lineHeightPx: 28.8,
    maxWidthPx: 312,
    maxLines: 5,
  },
  resultShareCopy: {
    font: buildFontShorthand(16, BODY_FONT_STACK, 400),
    lineHeightPx: 27.2,
    maxWidthPx: 520,
    maxLines: 8,
    whiteSpace: 'pre-wrap' as const,
  },
  endingRoomBubble: {
    font: buildFontShorthand(14, BODY_FONT_STACK, 400),
    lineHeightPx: 23.52,
    maxWidthPx: 420,
    maxLines: 9,
    chromeHeightPx: 42,
  },
  endingRoomDraftBubble: {
    font: buildFontShorthand(14, BODY_FONT_STACK, 400),
    lineHeightPx: 23.52,
    maxWidthPx: 420,
    maxLines: 10,
    chromeHeightPx: 42,
    whiteSpace: 'pre-wrap' as const,
  },
  roundtablePickerHint: {
    font: buildFontShorthand(15, BODY_FONT_STACK, 400),
    lineHeightPx: 24,
    maxWidthPx: 720,
    maxLines: 5,
  },
  roundtableTranscriptBubble: {
    font: buildFontShorthand(14, BODY_FONT_STACK, 400),
    lineHeightPx: 23.52,
    maxWidthPx: 452,
    maxLines: 9,
    chromeHeightPx: 42,
  },
} as const satisfies Record<string, TextLayoutContract>;

function toMeasureOptions(
  text: string,
  contract: TextLayoutContract,
): MeasureParagraphOptions {
  return {
    text,
    font: contract.font,
    lineHeightPx: contract.lineHeightPx,
    maxWidthPx: contract.maxWidthPx,
    whiteSpace: contract.whiteSpace,
    locale: contract.locale,
  };
}

export function estimateLineCount(text: string, contract: TextLayoutContract): number {
  return measureParagraph(toMeasureOptions(text, contract)).lineCount;
}

export function estimateBubbleHeight(
  text: string,
  contract: TextLayoutContract,
): number {
  const { height } = measureParagraph(toMeasureOptions(text, contract));
  return height + (contract.chromeHeightPx ?? 0);
}

export function predictTextOverflow(
  text: string,
  contract: TextLayoutContract,
): TextOverflowPrediction {
  const { height, lineCount } = measureParagraph(toMeasureOptions(text, contract));
  const maxLines = contract.maxLines ?? null;
  const overflowLines = maxLines == null ? 0 : Math.max(0, lineCount - maxLines);

  return {
    height,
    lineCount,
    totalHeight: height + (contract.chromeHeightPx ?? 0),
    overflow: overflowLines > 0,
    maxLines,
    overflowLines,
  };
}
