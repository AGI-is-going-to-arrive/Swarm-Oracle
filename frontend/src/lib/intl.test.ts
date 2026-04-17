/**
 * FE-3 — intl helpers tests.
 */
import { describe, expect, it } from 'vitest';

import { formatAttemptProgress, formatRelativeTime, selectPlural } from './intl';

describe('formatRelativeTime', () => {
  it('returns past-tense string for a timestamp 2 hours ago', () => {
    const now = new Date('2026-04-18T12:00:00Z');
    const two_hours_ago = new Date(now.getTime() - 2 * 3600_000);
    const out = formatRelativeTime(two_hours_ago, 'en', now);
    expect(out).toMatch(/2\s*hours?\s*ago/i);
  });

  it('returns future-tense string for a timestamp 5 minutes in the future', () => {
    const now = new Date('2026-04-18T12:00:00Z');
    const soon = new Date(now.getTime() + 5 * 60_000);
    const out = formatRelativeTime(soon, 'en', now);
    expect(out).toMatch(/5\s*minute/i);
  });

  it('returns empty string on invalid input', () => {
    const out = formatRelativeTime('not-a-date');
    expect(out).toBe('');
  });
});

describe('selectPlural', () => {
  it('returns `one` for count === 1 in English', () => {
    expect(selectPlural(1, { one: '1 attempt', other: '{{n}} attempts' }, 'en')).toBe('1 attempt');
  });

  it('returns `other` for count > 1 in English', () => {
    expect(selectPlural(3, { one: '1 attempt', other: '3 attempts' }, 'en')).toBe('3 attempts');
  });

  it('returns `zero` when provided and count is 0', () => {
    expect(selectPlural(0, { zero: 'none', one: 'one', other: 'many' }, 'en')).toBe('none');
  });

  it('falls back to `other` for zh (no plural distinction)', () => {
    expect(selectPlural(3, { one: 'X', other: 'Y' }, 'zh')).toBe('Y');
  });
});

describe('formatAttemptProgress', () => {
  it('substitutes {{n}} and {{m}} placeholders', () => {
    expect(formatAttemptProgress(2, 5, 'attempt {{n}}/{{m}}', 'en')).toBe('attempt 2/5');
  });

  it('respects zh digit formatting (still arabic in most locales)', () => {
    const out = formatAttemptProgress(2, 5, '第 {{n}}/{{m}} 次', 'zh');
    expect(out).toContain('2');
    expect(out).toContain('5');
  });
});
