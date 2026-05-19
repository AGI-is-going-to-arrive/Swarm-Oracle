import { describe, expect, it } from 'vitest';

import { diffChars, type DiffSegment } from './textDiff';

function reconstructOld(segments: DiffSegment[]): string {
  return segments
    .filter((segment) => segment.type === 'equal' || segment.type === 'delete')
    .map((segment) => segment.text)
    .join('');
}

function reconstructNew(segments: DiffSegment[]): string {
  return segments
    .filter((segment) => segment.type === 'equal' || segment.type === 'insert')
    .map((segment) => segment.text)
    .join('');
}

function hasConsecutiveSameType(segments: DiffSegment[]): boolean {
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].type === segments[i - 1].type) {
      return true;
    }
  }
  return false;
}

describe('diffChars', () => {
  it('returns an empty array when both inputs are empty', () => {
    expect(diffChars('', '')).toEqual([]);
  });

  it('returns a single equal segment for identical strings', () => {
    expect(diffChars('hello', 'hello')).toEqual([{ type: 'equal', text: 'hello' }]);
  });

  it('returns a single equal segment for identical CJK strings', () => {
    expect(diffChars('我今天很开心', '我今天很开心')).toEqual([
      { type: 'equal', text: '我今天很开心' },
    ]);
  });

  it('returns a full insert when the old text is empty', () => {
    expect(diffChars('', '新内容')).toEqual([{ type: 'insert', text: '新内容' }]);
  });

  it('returns a full delete when the new text is empty', () => {
    expect(diffChars('旧内容', '')).toEqual([{ type: 'delete', text: '旧内容' }]);
  });

  it('returns delete + insert when the strings share no common characters', () => {
    const segments = diffChars('abc', 'xyz');
    expect(segments).toEqual([
      { type: 'delete', text: 'abc' },
      { type: 'insert', text: 'xyz' },
    ]);
  });

  it('produces clean segments for a single CJK character substitution', () => {
    const segments = diffChars('我今天很开心', '我今天不开心');
    expect(segments).toEqual([
      { type: 'equal', text: '我今天' },
      { type: 'delete', text: '很' },
      { type: 'insert', text: '不' },
      { type: 'equal', text: '开心' },
    ]);
  });

  it('handles mixed CJK and Latin text', () => {
    const segments = diffChars('Hello世界', 'Hello世界杯');
    expect(segments).toEqual([
      { type: 'equal', text: 'Hello世界' },
      { type: 'insert', text: '杯' },
    ]);
  });

  it('treats surrogate-pair emoji as single tokens', () => {
    const segments = diffChars('👋🌍', '👋🌎');
    expect(segments).toEqual([
      { type: 'equal', text: '👋' },
      { type: 'delete', text: '🌍' },
      { type: 'insert', text: '🌎' },
    ]);
    // Sanity check: neither side of the diff should contain a lone surrogate.
    for (const segment of segments) {
      expect(Array.from(segment.text).length).toBeGreaterThan(0);
    }
  });

  it('handles a single character change inside a long Chinese sentence', () => {
    const oldText = '在一个遥远的国度里住着一位善良的国王他每天都会去森林散步并与动物交谈';
    const newText = '在一个遥远的国度里住着一位邪恶的国王他每天都会去森林散步并与动物交谈';
    const segments = diffChars(oldText, newText);
    expect(segments).toEqual([
      { type: 'equal', text: '在一个遥远的国度里住着一位' },
      { type: 'delete', text: '善良' },
      { type: 'insert', text: '邪恶' },
      { type: 'equal', text: '的国王他每天都会去森林散步并与动物交谈' },
    ]);
    expect(reconstructOld(segments)).toBe(oldText);
    expect(reconstructNew(segments)).toBe(newText);
  });

  it('falls back to a simplified diff when either side exceeds 2000 code points', () => {
    const oldText = '甲'.repeat(2001);
    const newText = '乙'.repeat(2001);
    const segments = diffChars(oldText, newText);
    expect(segments).toEqual([
      { type: 'delete', text: oldText },
      { type: 'insert', text: newText },
    ]);
  });

  it('still runs the full diff at the 2000 code point boundary', () => {
    const shared = '共'.repeat(1999);
    const oldText = `${shared}A`;
    const newText = `${shared}B`;
    const segments = diffChars(oldText, newText);
    // Both inputs are exactly 2000 code points; the simplified path should
    // NOT trigger, so we expect a fine-grained diff at the trailing char.
    expect(segments).toEqual([
      { type: 'equal', text: shared },
      { type: 'delete', text: 'A' },
      { type: 'insert', text: 'B' },
    ]);
  });

  it('merges consecutive same-type segments into single chunks', () => {
    const segments = diffChars('abcdef', 'axcyef');
    expect(hasConsecutiveSameType(segments)).toBe(false);
    expect(reconstructOld(segments)).toBe('abcdef');
    expect(reconstructNew(segments)).toBe('axcyef');
  });

  it('preserves round-trip invariant for arbitrary CJK edits', () => {
    const samples: Array<[string, string]> = [
      ['今天天气很好', '今天天气不好'],
      ['人工智能改变世界', '人工智能改造世界'],
      ['Hello, 世界!', 'Hello, 新世界!'],
      ['👋🌍 hi', 'hi 👋🌎'],
      ['', '全是新内容'],
      ['全是旧内容', ''],
    ];
    for (const [oldText, newText] of samples) {
      const segments = diffChars(oldText, newText);
      expect(reconstructOld(segments)).toBe(oldText);
      expect(reconstructNew(segments)).toBe(newText);
      expect(hasConsecutiveSameType(segments)).toBe(false);
    }
  });
});
