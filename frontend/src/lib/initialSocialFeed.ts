import type { InitialSocialFeedItem } from '../api/client';

export const INITIAL_SOCIAL_FEED_MAX_ITEMS = 20;
export const INITIAL_SOCIAL_FEED_MAX_TAGS = 8;

const RFC3339_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isInitialSocialFeedValid(items: InitialSocialFeedItem[]): boolean {
  return items.length <= INITIAL_SOCIAL_FEED_MAX_ITEMS
    && items.every((item) => (
      item.sourceName.trim().length > 0
      && item.sourceName.length <= 80
      && item.content.trim().length > 0
      && item.content.length <= 1200
      && (!item.publishedAt || (
        RFC3339_WITH_TIMEZONE.test(item.publishedAt)
        && !Number.isNaN(Date.parse(item.publishedAt))
      ))
      && (!item.credibilityHint || item.credibilityHint.length <= 300)
      && (!item.tags || (
        item.tags.length <= INITIAL_SOCIAL_FEED_MAX_TAGS
        && item.tags.every((tag) => tag.trim().length > 0 && tag.length <= 40)
      ))
    ));
}
