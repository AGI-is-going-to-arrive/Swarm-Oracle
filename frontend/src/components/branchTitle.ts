const SHORT_CJK_TITLE_CHARS = 6;
const SHORT_EN_TITLE_WORDS = 3;
const CJK_HINT_CHARS = 18;
const EN_HINT_WORDS = 9;

function countCjkChars(value: string): number {
  return Array.from(value).filter((char) => /[\u3400-\u9fff]/u.test(char)).length;
}

function getFirstReadableClause(value?: string | null): string {
  return (value || '')
    .replace(/\s+/g, ' ')
    .split(/[。！？；，、,.!?;:：]/u)[0]
    ?.trim() ?? '';
}

function truncateCjkClause(value: string): string {
  const chars = Array.from(value);
  return chars.length > CJK_HINT_CHARS
    ? `${chars.slice(0, CJK_HINT_CHARS).join('')}...`
    : value;
}

function truncateEnglishClause(value: string): string {
  const words = value.split(/\s+/).filter(Boolean);
  return words.length > EN_HINT_WORDS
    ? `${words.slice(0, EN_HINT_WORDS).join(' ')}...`
    : value;
}

export function buildReadableBranchTitle(
  title: string | undefined,
  description: string | undefined,
  forkReason: string | undefined,
  isZh: boolean,
): string {
  const rawTitle = (title || '').trim();
  const sourceHint = getFirstReadableClause(description) || getFirstReadableClause(forkReason);
  if (!rawTitle || !sourceHint) return rawTitle;
  if (rawTitle.includes(':') || rawTitle.includes('：')) return rawTitle;

  const hasCjk = /[\u3400-\u9fff]/u.test(`${rawTitle}${sourceHint}`);
  const titleCjkChars = countCjkChars(rawTitle);
  const titleWords = rawTitle.split(/\s+/).filter(Boolean).length;
  const isShortTitle = hasCjk || isZh
    ? titleCjkChars > 0 && titleCjkChars <= SHORT_CJK_TITLE_CHARS
    : titleWords > 0 && titleWords <= SHORT_EN_TITLE_WORDS;
  if (!isShortTitle || sourceHint.includes(rawTitle)) return rawTitle;

  const compactHint = hasCjk || isZh
    ? truncateCjkClause(sourceHint)
    : truncateEnglishClause(sourceHint);
  return `${rawTitle}${hasCjk || isZh ? '：' : ': '}${compactHint}`;
}
