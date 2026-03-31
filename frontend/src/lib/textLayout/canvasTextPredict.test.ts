import { describe, expect, it } from 'vitest';

import { predictBubbleTextSize } from './canvasTextPredict';

describe('predictBubbleTextSize', () => {
  it('returns null for empty text', () => {
    expect(predictBubbleTextSize('', 300)).toBeNull();
  });

  it('returns null for zero wrap width', () => {
    expect(predictBubbleTextSize('Hello', 0)).toBeNull();
  });

  it('returns valid dimensions for short text', () => {
    const result = predictBubbleTextSize('Hello world', 300);
    expect(result).not.toBeNull();
    expect(result!.textWidth).toBeGreaterThan(0);
    expect(result!.textHeight).toBeGreaterThan(0);
  });

  it('returns wrap-width for long text that wraps', () => {
    const longText = 'This is a very long bubble text that should definitely wrap across multiple lines within the speech bubble container.';
    const result = predictBubbleTextSize(longText, 200);
    expect(result).not.toBeNull();
    expect(result!.textWidth).toBe(200);
    expect(result!.textHeight).toBeGreaterThan(18); // more than 1 line
  });

  it('handles Chinese text', () => {
    const result = predictBubbleTextSize('这是一段中文对话气泡文本', 250, {
      fontSizePx: 14,
      locale: 'zh',
    });
    expect(result).not.toBeNull();
    expect(result!.textHeight).toBeGreaterThan(0);
  });

  it('respects different font sizes', () => {
    const text = 'Same text in different sizes';
    const small = predictBubbleTextSize(text, 200, { fontSizePx: 13 });
    const large = predictBubbleTextSize(text, 200, { fontSizePx: 15 });
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(large!.textHeight).toBeGreaterThanOrEqual(small!.textHeight);
  });

  it('returns narrower width for single-line text', () => {
    const result = predictBubbleTextSize('Hi', 300, { fontSizePx: 14 });
    expect(result).not.toBeNull();
    expect(result!.textWidth).toBeLessThan(300);
  });
});
