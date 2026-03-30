import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearPretextCache,
  measureParagraph,
  prepareText,
} from './pretext';

const BODY_FONT = 'normal 400 16px "Instrument Sans", "Noto Sans SC", sans-serif';

describe('pretext wrapper', () => {
  beforeEach(() => {
    clearPretextCache();
  });

  it('caches prepared text for repeated calls with the same contract', () => {
    const first = prepareText({
      text: 'Archive hinge stays stable.',
      font: BODY_FONT,
    });
    const second = prepareText({
      text: 'Archive hinge stays stable.',
      font: BODY_FONT,
    });

    expect(first).toBe(second);
  });

  it('supports normal multiline measurement for mixed Chinese and English text', () => {
    const measurement = measureParagraph({
      text: '世界线需要一个更慢、更稳的 archive verdict before the market breaks.',
      font: BODY_FONT,
      maxWidthPx: 180,
      lineHeightPx: 24,
      locale: 'zh',
    });

    expect(measurement.lineCount).toBeGreaterThan(1);
    expect(measurement.height).toBe(measurement.lineCount * 24);
  });

  it('preserves tabs and hard breaks in pre-wrap mode', () => {
    const measurement = measureParagraph({
      text: '第一行\t保留\nSecond line keeps spacing',
      font: BODY_FONT,
      maxWidthPx: 220,
      lineHeightPx: 24,
      whiteSpace: 'pre-wrap',
      locale: 'zh',
    });

    expect(measurement.lineCount).toBeGreaterThanOrEqual(2);
  });

  it('keeps emoji and bidi text measurable without crashing', () => {
    const measurement = measureParagraph({
      text: 'AGI 春天到了. بدأت الرحلة 🚀',
      font: BODY_FONT,
      maxWidthPx: 160,
      lineHeightPx: 22,
      locale: 'en',
    });

    expect(measurement.lineCount).toBeGreaterThan(1);
    expect(measurement.height).toBe(measurement.lineCount * 22);
  });

  it('rejects unsafe system-ui font contracts by default', () => {
    expect(() => prepareText({
      text: 'Unsafe font check',
      font: 'normal 400 16px system-ui',
    })).toThrow(/system-ui/i);
  });
});
