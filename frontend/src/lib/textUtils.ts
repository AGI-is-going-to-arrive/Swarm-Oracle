/**
 * Text utility helpers for safe user-visible string handling.
 *
 * Why: `String.prototype.slice` operates on UTF-16 code units, which can
 * split surrogate pairs (e.g. emoji 🌍, mathematical symbols, CJK extension B).
 * Splitting a surrogate pair produces an invalid code unit that browsers render
 * as a replacement character (U+FFFD), corrupting visible text.
 *
 * Use these helpers whenever truncating user-visible content. Do NOT use them
 * for hex strings, UUIDs, tokens, or other ASCII-only identifiers — plain
 * `slice()` is faster and safe in those cases.
 */

/**
 * Truncate a user-visible string to at most `maxCodepoints` Unicode code points,
 * preserving surrogate pairs. Appends `ellipsis` (default `…`) when truncation
 * occurs. The ellipsis itself does NOT count toward `maxCodepoints` — callers
 * receive at most `maxCodepoints` content code points plus the ellipsis suffix.
 *
 * @param input  The source string (any input is coerced to string; `null`/`undefined` → "").
 * @param maxCodepoints  Upper bound on visible code points; values < 1 are clamped to 1.
 * @param ellipsis  Suffix appended when truncation occurs. Defaults to `…` (…).
 *                  Pass `''` to suppress the ellipsis.
 * @returns A string whose visible code-point length is `≤ maxCodepoints` (+ ellipsis on truncation).
 *
 * @example
 *   truncateCodepoints('Hello 🌍🚀!', 7)         // → 'Hello 🌍…'
 *   truncateCodepoints('Hello 🌍🚀!', 100)       // → 'Hello 🌍🚀!'  (no truncation)
 *   truncateCodepoints('abc', 10)                 // → 'abc'         (no truncation)
 *   truncateCodepoints('Hello 🌍🚀!', 6, '...')   // → 'Hello ...'   (custom suffix)
 */
export function truncateCodepoints(
  input: unknown,
  maxCodepoints: number,
  ellipsis = '…',
): string {
  const text = typeof input === 'string' ? input : String(input ?? '');
  const limit = Math.max(1, Math.floor(maxCodepoints));
  // Array.from iterates by Unicode code points, never splitting surrogate pairs.
  const codepoints = Array.from(text);
  if (codepoints.length <= limit) return text;
  return codepoints.slice(0, limit).join('') + ellipsis;
}

/**
 * Count the number of Unicode code points in a string. Surrogate pairs count as 1.
 * Equivalent to `Array.from(s).length` but with explicit input coercion.
 */
export function countCodepoints(input: unknown): number {
  const text = typeof input === 'string' ? input : String(input ?? '');
  return Array.from(text).length;
}

export function getFirstGrapheme(text: string): string {
  if (!text) return '?';
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const first = seg.segment(text)[Symbol.iterator]().next();
    return first.done ? '?' : first.value.segment;
  }
  const codepoints = Array.from(text);
  const [first, second] = codepoints;
  if (!first) return '?';

  const isRegionalIndicator = (value: string | undefined) => {
    if (!value) return false;
    const point = value.codePointAt(0);
    return point != null && point >= 0x1f1e6 && point <= 0x1f1ff;
  };

  if (isRegionalIndicator(first) && isRegionalIndicator(second)) {
    return `${first}${second}`;
  }

  let cluster = first;
  let index = 1;
  while (codepoints[index] === '\u200d' && codepoints[index + 1]) {
    cluster += `${codepoints[index]}${codepoints[index + 1]}`;
    index += 2;
  }
  return cluster;
}
