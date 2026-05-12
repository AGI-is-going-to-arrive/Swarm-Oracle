import { describe, expect, it } from 'vitest';

import { countCodepoints, getFirstGrapheme, truncateCodepoints } from './textUtils';

describe('truncateCodepoints', () => {
  it('returns the input unchanged when within the limit', () => {
    expect(truncateCodepoints('abc', 10)).toBe('abc');
    expect(truncateCodepoints('abc', 3)).toBe('abc');
  });

  it('truncates ASCII strings to the requested code-point count', () => {
    expect(truncateCodepoints('Hello world', 5)).toBe('Hello…');
  });

  it('preserves emoji surrogate pairs (does not split a code point)', () => {
    // Each rocket and globe is one code point but two UTF-16 units.
    const input = 'Hi 🌍🚀!';
    expect(truncateCodepoints(input, 4)).toBe('Hi 🌍…');
    // Confirm the truncated visible result has only valid code points (no U+FFFD).
    expect(truncateCodepoints(input, 4)).not.toContain('�');
  });

  it('preserves CJK extension B characters (also surrogate pairs)', () => {
    // U+20000 is a CJK Unified Ideographs Extension B char.
    const cjkExt = String.fromCodePoint(0x20000);
    const input = `${cjkExt}${cjkExt}${cjkExt}`;
    expect(truncateCodepoints(input, 2)).toBe(`${cjkExt}${cjkExt}…`);
  });

  it('clamps non-positive maxCodepoints to 1', () => {
    expect(truncateCodepoints('abcdef', 0)).toBe('a…');
    expect(truncateCodepoints('abcdef', -5)).toBe('a…');
  });

  it('floors fractional limits', () => {
    expect(truncateCodepoints('abcdef', 3.7)).toBe('abc…');
  });

  it('honors a custom ellipsis suffix', () => {
    expect(truncateCodepoints('Hello world', 5, '...')).toBe('Hello...');
    expect(truncateCodepoints('Hello world', 5, '')).toBe('Hello');
  });

  it('coerces non-string input safely', () => {
    expect(truncateCodepoints(null, 5)).toBe('');
    expect(truncateCodepoints(undefined, 5)).toBe('');
    expect(truncateCodepoints(123, 2)).toBe('12…');
  });
});

describe('countCodepoints', () => {
  it('counts ASCII chars', () => {
    expect(countCodepoints('hello')).toBe(5);
  });

  it('counts emoji as 1 (not 2)', () => {
    expect(countCodepoints('🌍')).toBe(1);
    expect(countCodepoints('🌍🚀')).toBe(2);
  });

  it('handles null/undefined', () => {
    expect(countCodepoints(null)).toBe(0);
    expect(countCodepoints(undefined)).toBe(0);
  });
});

describe('getFirstGrapheme', () => {
  it('returns a fallback for empty strings', () => {
    expect(getFirstGrapheme('')).toBe('?');
  });

  it('keeps zero-width-joiner emoji together when Intl.Segmenter is available', () => {
    expect(getFirstGrapheme('👩‍💻 Engineer')).toBe('👩‍💻');
  });

  it('keeps flag emoji pairs together when Intl.Segmenter is available', () => {
    expect(getFirstGrapheme('🇺🇳 Delegate')).toBe('🇺🇳');
  });

  it('keeps common emoji clusters together without Intl.Segmenter', () => {
    const originalSegmenter = Intl.Segmenter;
    Object.defineProperty(Intl, 'Segmenter', {
      configurable: true,
      value: undefined,
    });
    try {
      expect(getFirstGrapheme('🇺🇳 Delegate')).toBe('🇺🇳');
      expect(getFirstGrapheme('👩‍💻 Engineer')).toBe('👩‍💻');
    } finally {
      Object.defineProperty(Intl, 'Segmenter', {
        configurable: true,
        value: originalSegmenter,
      });
    }
  });
});
