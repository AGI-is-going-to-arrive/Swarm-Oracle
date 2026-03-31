import { describe, expect, it } from 'vitest';

import {
  predictTextareaHeight,
  resolveInputFontSizePx,
  resolveInputLineHeightMultiplier,
} from './inputPredict';

describe('resolveInputFontSizePx', () => {
  it('returns clamped desktop size for wide viewports', () => {
    const px = resolveInputFontSizePx(1440);
    // clamp(2rem, 1.7rem + 1.5vw, 3rem) = clamp(32, 27.2+21.6, 48) = 48
    expect(px).toBe(48);
  });

  it('returns clamped minimum desktop size for narrow-desktop viewports', () => {
    const px = resolveInputFontSizePx(700);
    // 1.7*16 + 700*0.015 = 27.2 + 10.5 = 37.7 → clamp(32, 37.7, 48) = 37.7
    expect(px).toBeCloseTo(37.7, 1);
  });

  it('returns mobile size for 375px viewport', () => {
    const px = resolveInputFontSizePx(375);
    // clamp(1.45rem, 6.8vw, 2.2rem) = clamp(23.2, 25.5, 35.2) = 25.5
    expect(px).toBe(375 * 0.068);
  });

  it('clamps to minimum on very small mobile', () => {
    const px = resolveInputFontSizePx(300);
    // 300*0.068 = 20.4 → clamp(23.2, 20.4, 35.2) = 23.2
    expect(px).toBe(1.45 * 16);
  });
});

describe('resolveInputLineHeightMultiplier', () => {
  it('returns 1.12 for mobile', () => {
    expect(resolveInputLineHeightMultiplier(640)).toBe(1.12);
    expect(resolveInputLineHeightMultiplier(320)).toBe(1.12);
  });

  it('returns 1.2 for desktop', () => {
    expect(resolveInputLineHeightMultiplier(641)).toBe(1.2);
    expect(resolveInputLineHeightMultiplier(1440)).toBe(1.2);
  });
});

describe('predictTextareaHeight', () => {
  it('returns single line for empty text', () => {
    const result = predictTextareaHeight('', 700, { viewportWidth: 1024 });
    expect(result.lines).toBe(1);
    expect(result.height).toBeGreaterThan(0);
  });

  it('returns single line for short text', () => {
    const result = predictTextareaHeight('Hello', 700, { viewportWidth: 1024 });
    expect(result.lines).toBe(1);
  });

  it('returns multiple lines for long text', () => {
    const longText = 'This is a very long question that should definitely wrap across multiple lines when displayed in the textarea input field at the top of the page.';
    const result = predictTextareaHeight(longText, 300, { viewportWidth: 1024 });
    expect(result.lines).toBeGreaterThan(1);
    expect(result.height).toBeGreaterThan(result.lines * 10);
  });

  it('handles Chinese text', () => {
    const zhText = '这是一个很长的中文问题，用来测试文本预测是否能正确处理中文字符的换行和高度计算。';
    const result = predictTextareaHeight(zhText, 300, {
      viewportWidth: 1024,
      locale: 'zh',
    });
    expect(result.lines).toBeGreaterThanOrEqual(1);
    expect(result.height).toBeGreaterThan(0);
  });

  it('returns larger height for narrower containers', () => {
    const text = 'A moderately long question that exercises wrap behavior in different widths.';
    const wide = predictTextareaHeight(text, 700, { viewportWidth: 1024 });
    const narrow = predictTextareaHeight(text, 300, { viewportWidth: 1024 });
    expect(narrow.lines).toBeGreaterThanOrEqual(wide.lines);
  });

  it('respects mobile font size override', () => {
    const text = 'Mobile viewport question testing';
    const mobile = predictTextareaHeight(text, 340, { viewportWidth: 375 });
    const desktop = predictTextareaHeight(text, 340, { viewportWidth: 1024 });
    // Mobile has smaller font, so may fit more chars per line
    expect(mobile.lines).toBeLessThanOrEqual(desktop.lines + 1);
  });

  it('gracefully handles zero container width', () => {
    const result = predictTextareaHeight('test', 0, { viewportWidth: 1024 });
    expect(result.lines).toBe(1);
    expect(result.height).toBeGreaterThan(0);
  });
});
