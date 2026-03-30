import {
  clearCache as clearUnderlyingPretextCache,
  layout as layoutPreparedText,
  prepare as prepareUnderlyingText,
  setLocale as setUnderlyingLocale,
  type PreparedText,
} from '@chenglou/pretext';

export type TextLayoutWhiteSpace = 'normal' | 'pre-wrap';

export interface PrepareTextOptions {
  text: string;
  font: string;
  whiteSpace?: TextLayoutWhiteSpace;
  locale?: string | null;
  allowUnsafeSystemUi?: boolean;
}

export interface MeasureParagraphOptions extends PrepareTextOptions {
  maxWidthPx: number;
  lineHeightPx: number;
}

export interface ParagraphMeasurement {
  height: number;
  lineCount: number;
}

const preparedTextCache = new Map<string, PreparedText>();
let activeLocale: string | null = null;

function normalizeLocale(locale?: string | null): string | null {
  const normalized = locale?.trim();
  return normalized ? normalized : null;
}

function normalizeWhiteSpace(whiteSpace?: TextLayoutWhiteSpace): TextLayoutWhiteSpace {
  return whiteSpace === 'pre-wrap' ? 'pre-wrap' : 'normal';
}

function usesUnsafeSystemUi(font: string): boolean {
  return /\bsystem-ui\b/i.test(font);
}

function assertSafeFont(font: string, allowUnsafeSystemUi = false): void {
  if (!allowUnsafeSystemUi && usesUnsafeSystemUi(font)) {
    throw new Error('Pretext font contract rejects system-ui because it is documented as unsafe for layout accuracy on macOS.');
  }
}

function syncLocale(locale: string | null): void {
  if (locale === activeLocale) {
    return;
  }

  // Pretext keeps locale-sensitive caches globally, so locale switches must
  // invalidate the wrapper cache as well.
  setUnderlyingLocale(locale ?? undefined);
  activeLocale = locale;
  preparedTextCache.clear();
}

function buildPreparedCacheKey(
  text: string,
  font: string,
  whiteSpace: TextLayoutWhiteSpace,
  locale: string | null,
): string {
  return JSON.stringify({
    font,
    locale,
    text,
    whiteSpace,
  });
}

export function clearPretextCache(): void {
  preparedTextCache.clear();
  clearUnderlyingPretextCache();
}

export function prepareText({
  text,
  font,
  whiteSpace,
  locale,
  allowUnsafeSystemUi,
}: PrepareTextOptions): PreparedText {
  const normalizedLocale = normalizeLocale(locale);
  const normalizedWhiteSpace = normalizeWhiteSpace(whiteSpace);
  const normalizedText = text ?? '';

  assertSafeFont(font, allowUnsafeSystemUi);
  syncLocale(normalizedLocale);

  const cacheKey = buildPreparedCacheKey(
    normalizedText,
    font,
    normalizedWhiteSpace,
    normalizedLocale,
  );
  const cached = preparedTextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const prepared = prepareUnderlyingText(normalizedText, font, {
    whiteSpace: normalizedWhiteSpace,
  });
  preparedTextCache.set(cacheKey, prepared);
  return prepared;
}

export function measureParagraph({
  maxWidthPx,
  lineHeightPx,
  ...prepareOptions
}: MeasureParagraphOptions): ParagraphMeasurement {
  if (maxWidthPx <= 0) {
    throw new Error(`Pretext requires maxWidthPx > 0. Received ${maxWidthPx}.`);
  }
  if (lineHeightPx <= 0) {
    throw new Error(`Pretext requires lineHeightPx > 0. Received ${lineHeightPx}.`);
  }

  const prepared = prepareText(prepareOptions);
  const { height, lineCount } = layoutPreparedText(prepared, maxWidthPx, lineHeightPx);
  return { height, lineCount };
}
