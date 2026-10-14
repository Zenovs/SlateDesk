/**
 * Pure helpers of the news widget: feed list from the settings, filtering
 * of the merged items and relative times. No React, no Tauri.
 */
import type { FeedItem, FeedSource, SourceError } from '../../utils/backend';

/** Enabled feeds with an address, each address once (settings may come from an import). */
export function activeFeeds(feeds: unknown): FeedSource[] {
  if (!Array.isArray(feeds)) return [];
  const seen = new Set<string>();
  const out: FeedSource[] = [];
  for (const feed of feeds) {
    if (typeof feed !== 'object' || feed === null) continue;
    const { url, name, enabled } = feed as Record<string, unknown>;
    if (enabled === false || typeof url !== 'string') continue;
    const address = url.trim();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const label = typeof name === 'string' ? name.trim() : '';
    out.push(label ? { url: address, name: label } : { url: address });
  }
  return out;
}

export interface ItemFilter {
  /** epoch ms */
  now: number;
  /** 0 = no limit */
  maxAgeHours: number;
  excludeKeywords: readonly string[];
  maxItems: number;
}

const fold = (value: string): string => value.toLocaleLowerCase('de-CH');

/**
 * Items newer than `maxAgeHours` without an excluded keyword in title or
 * summary, at most `maxItems`. Items without a date are kept – the backend
 * already sorts them last.
 */
export function filterItems(items: readonly FeedItem[], filter: ItemFilter): FeedItem[] {
  const keywords = filter.excludeKeywords.map((keyword) => fold(keyword.trim())).filter(Boolean);
  const oldest = filter.maxAgeHours > 0 ? filter.now - filter.maxAgeHours * 3_600_000 : -Infinity;
  const out: FeedItem[] = [];
  for (const item of items) {
    if (out.length >= filter.maxItems) break;
    if (item.published !== null && item.published < oldest) continue;
    if (keywords.length > 0) {
      const haystack = fold(`${item.title} ${item.summary ?? ''}`);
      if (keywords.some((keyword) => haystack.includes(keyword))) continue;
    }
    out.push(item);
  }
  return out;
}

/** «gerade eben», «vor 12 Min.», «vor 3 Std.», «vor 2 Tagen», older: date. */
export function relativeTime(published: number | null, now: number): string | null {
  if (published === null) return null;
  const minutes = Math.floor((now - published) / 60_000);
  if (minutes < 1) return 'gerade eben';
  if (minutes < 60) return `vor ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? 'vor 1 Tag' : `vor ${days} Tagen`;
  return new Date(published).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Display name of the feed behind each error (its name, else the host). */
export function failedFeedNames(errors: readonly SourceError[], feeds: readonly FeedSource[]): string[] {
  return errors.map((error) => feeds.find((feed) => feed.url === error.url)?.name ?? hostOf(error.url));
}

/** One German line for errors of the given feeds. */
export function describeFeedErrors(errors: readonly SourceError[], feeds: readonly FeedSource[]): string {
  const names = failedFeedNames(errors, feeds);
  return errors.map((error, index) => `${names[index]}: ${error.error}`).join('; ');
}
