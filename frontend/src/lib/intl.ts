/**
 * FE-3 — Intl helpers (Round 9 per research §11.9):
 * Thin wrappers around `Intl.RelativeTimeFormat` + `Intl.PluralRules` so
 * conversation/source UIs don't hardcode strings like "2h ago" or
 * "attempt 2/5". Callers pass either a past timestamp or an attempt pair;
 * we return a locale-aware string without pulling in dayjs.
 */

const DEFAULT_LOCALE = 'en';

function resolveLocale(locale?: string): string {
  if (locale && typeof locale === 'string' && locale.length > 0) return locale;
  try {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const tag = nav?.language;
    if (typeof tag === 'string' && tag.length > 0) return tag;
  } catch {
    /* jsdom / SSR fallback */
  }
  return DEFAULT_LOCALE;
}

/**
 * Human-readable relative time from a past `Date | number | string` to `now`.
 * Returns e.g. "2 hours ago" / "2 小时前" based on locale.
 */
export function formatRelativeTime(
  from: Date | number | string,
  locale?: string,
  now: Date = new Date(),
): string {
  const fromDate = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(fromDate.getTime())) return '';
  const resolved = resolveLocale(locale);
  const rtf = new Intl.RelativeTimeFormat(resolved, { numeric: 'auto' });
  const deltaMs = fromDate.getTime() - now.getTime();
  const deltaSec = Math.round(deltaMs / 1000);
  const absSec = Math.abs(deltaSec);
  if (absSec < 60) return rtf.format(deltaSec, 'second');
  const deltaMin = Math.round(deltaSec / 60);
  if (Math.abs(deltaMin) < 60) return rtf.format(deltaMin, 'minute');
  const deltaHour = Math.round(deltaMin / 60);
  if (Math.abs(deltaHour) < 24) return rtf.format(deltaHour, 'hour');
  const deltaDay = Math.round(deltaHour / 24);
  return rtf.format(deltaDay, 'day');
}

/**
 * ICU-style plural selection. Callers supply the three forms (zero / one /
 * other) in an object; we return the one that matches the current locale's
 * plural rules for `count`. Works for both en and zh.
 */
export function selectPlural(
  count: number,
  forms: { zero?: string; one?: string; other: string },
  locale?: string,
): string {
  const resolved = resolveLocale(locale);
  if (count === 0 && forms.zero !== undefined) return forms.zero;
  const pr = new Intl.PluralRules(resolved);
  const rule = pr.select(count);
  if (rule === 'one' && forms.one !== undefined) return forms.one;
  return forms.other;
}

/**
 * Format an "attempt N/M" string with locale-aware digits. Callers can pass
 * a `template` such as "attempt {{n}}/{{m}}"; we substitute digits in a
 * locale-friendly way via `Intl.NumberFormat`.
 */
export function formatAttemptProgress(
  attempt: number,
  max: number,
  template: string,
  locale?: string,
): string {
  const resolved = resolveLocale(locale);
  const nf = new Intl.NumberFormat(resolved);
  return template
    .replace('{{n}}', nf.format(attempt))
    .replace('{{m}}', nf.format(max));
}
