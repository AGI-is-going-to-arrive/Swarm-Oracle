export interface DiffSegment {
  type: 'equal' | 'insert' | 'delete';
  text: string;
}

const MAX_DIFF_LENGTH = 2000;

/**
 * Append a segment to the output list, merging with the previous segment if
 * they share the same type. Empty additions are dropped to keep output clean.
 */
function pushSegment(segments: DiffSegment[], type: DiffSegment['type'], text: string): void {
  if (!text) {
    return;
  }
  const last = segments[segments.length - 1];
  if (last && last.type === type) {
    last.text += text;
    return;
  }
  segments.push({ type, text });
}

/**
 * Compute a Longest Common Subsequence DP table for two code-point arrays.
 * Returns a 2D array `lcs` where `lcs[i][j]` is the LCS length of
 * `oldTokens.slice(0, i)` and `newTokens.slice(0, j)`.
 */
function buildLcsTable(oldTokens: string[], newTokens: string[]): number[][] {
  const m = oldTokens.length;
  const n = newTokens.length;
  const lcs: number[][] = new Array(m + 1);
  for (let i = 0; i <= m; i += 1) {
    lcs[i] = new Array(n + 1).fill(0);
  }
  for (let i = 1; i <= m; i += 1) {
    const oldToken = oldTokens[i - 1];
    const row = lcs[i];
    const prevRow = lcs[i - 1];
    for (let j = 1; j <= n; j += 1) {
      if (oldToken === newTokens[j - 1]) {
        row[j] = prevRow[j - 1] + 1;
      } else {
        row[j] = prevRow[j] >= row[j - 1] ? prevRow[j] : row[j - 1];
      }
    }
  }
  return lcs;
}

/**
 * Walk the DP table from the bottom-right corner to produce diff segments.
 * Emits one token at a time into a reversed list (each entry holds a single
 * token), then walks that list backwards while merging adjacent same-type
 * tokens so the final segments retain natural left-to-right text order.
 */
function buildSegmentsFromTable(
  oldTokens: string[],
  newTokens: string[],
  lcs: number[][],
): DiffSegment[] {
  const reversedTokens: DiffSegment[] = [];
  let i = oldTokens.length;
  let j = newTokens.length;

  while (i > 0 && j > 0) {
    if (oldTokens[i - 1] === newTokens[j - 1]) {
      reversedTokens.push({ type: 'equal', text: oldTokens[i - 1] });
      i -= 1;
      j -= 1;
    } else if (lcs[i - 1][j] > lcs[i][j - 1]) {
      // Going "up" in the table keeps a longer LCS, so consume an old token
      // (delete). Pushing delete here puts it later in the reversed list, so
      // after the final reversal it appears earlier — i.e. natural diff
      // convention "delete before insert".
      reversedTokens.push({ type: 'delete', text: oldTokens[i - 1] });
      i -= 1;
    } else {
      // Either going "left" is strictly better, or there is a tie. In the
      // tie case we deliberately pick insert first so that after reversal
      // deletes still surface before inserts in natural order.
      reversedTokens.push({ type: 'insert', text: newTokens[j - 1] });
      j -= 1;
    }
  }
  // Once one side is exhausted, the remaining tokens all sit at the start of
  // the strings (indices 0..i / 0..j). Convention is to surface deletes
  // before inserts in the final natural order, so push inserts first into
  // the reversed list (they end up later after the final reversal).
  while (j > 0) {
    reversedTokens.push({ type: 'insert', text: newTokens[j - 1] });
    j -= 1;
  }
  while (i > 0) {
    reversedTokens.push({ type: 'delete', text: oldTokens[i - 1] });
    i -= 1;
  }

  const merged: DiffSegment[] = [];
  for (let k = reversedTokens.length - 1; k >= 0; k -= 1) {
    pushSegment(merged, reversedTokens[k].type, reversedTokens[k].text);
  }
  return merged;
}

/**
 * Character-level diff between two strings.
 * Optimized for CJK text (no word boundaries needed).
 *
 * Uses `Array.from()` for code-point-safe tokenization, so surrogate pairs
 * (most emoji, rare CJK extensions) are treated as single units.
 *
 * For inputs longer than 2000 code points per side, falls back to a
 * simplified diff (full delete + full insert) to keep the O(m*n) DP bounded.
 */
export function diffChars(oldText: string, newText: string): DiffSegment[] {
  if (oldText === newText) {
    return oldText ? [{ type: 'equal', text: oldText }] : [];
  }
  if (!oldText) {
    return [{ type: 'insert', text: newText }];
  }
  if (!newText) {
    return [{ type: 'delete', text: oldText }];
  }

  const oldTokens = Array.from(oldText);
  const newTokens = Array.from(newText);

  if (oldTokens.length > MAX_DIFF_LENGTH || newTokens.length > MAX_DIFF_LENGTH) {
    return [
      { type: 'delete', text: oldText },
      { type: 'insert', text: newText },
    ];
  }

  const lcs = buildLcsTable(oldTokens, newTokens);
  return buildSegmentsFromTable(oldTokens, newTokens, lcs);
}
