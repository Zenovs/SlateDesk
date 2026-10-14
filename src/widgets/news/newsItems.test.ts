import { describe, expect, it } from 'vitest';
import type { FeedItem } from '../../utils/backend';
import { activeFeeds, describeFeedErrors, failedFeedNames, filterItems, relativeTime } from './newsItems';

const NOW = Date.UTC(2026, 9, 13, 12, 0);
const HOUR = 3_600_000;

const item = (id: string, hoursAgo: number | null, title = `Meldung ${id}`, summary: string | null = null): FeedItem => ({
  id,
  title,
  link: `https://news.example.ch/${id}`,
  summary,
  published: hoursAgo === null ? null : NOW - hoursAgo * HOUR,
  source: 'SRF News',
  imageUrl: null,
});

describe('activeFeeds', () => {
  it('keeps enabled feeds with an address, once each', () => {
    expect(
      activeFeeds([
        { name: ' SRF News ', url: ' https://www.srf.ch/news/bnf/rss/1646 ', enabled: true },
        { name: 'Aus', url: 'https://aus.example.ch/rss', enabled: false },
        { name: 'Leer', url: '', enabled: true },
        { name: 'Doppelt', url: 'https://www.srf.ch/news/bnf/rss/1646', enabled: true },
        { url: 'https://www.nzz.ch/recent.rss' },
        null,
        'kaputt',
      ]),
    ).toEqual([{ url: 'https://www.srf.ch/news/bnf/rss/1646', name: 'SRF News' }, { url: 'https://www.nzz.ch/recent.rss' }]);
  });

  it('copes with missing or corrupt settings', () => {
    expect(activeFeeds(undefined)).toEqual([]);
    expect(activeFeeds({ url: 'x' })).toEqual([]);
  });
});

describe('filterItems', () => {
  const items = [
    item('a', 1, 'Bundesrat entscheidet'),
    item('b', 3, 'FC Sion gewinnt', 'Fussball am Abend'),
    item('c', 30, 'Alte Meldung'),
    item('d', null, 'Ohne Datum'),
  ];

  it('drops items older than the limit and keeps undated ones', () => {
    expect(filterItems(items, { now: NOW, maxAgeHours: 24, excludeKeywords: [], maxItems: 10 }).map((i) => i.id)).toEqual([
      'a',
      'b',
      'd',
    ]);
    expect(filterItems(items, { now: NOW, maxAgeHours: 0, excludeKeywords: [], maxItems: 10 })).toHaveLength(4);
  });

  it('excludes keywords in title or summary, ignoring case', () => {
    const filtered = filterItems(items, { now: NOW, maxAgeHours: 0, excludeKeywords: ['  FUSSBALL ', ''], maxItems: 10 });
    expect(filtered.map((i) => i.id)).toEqual(['a', 'c', 'd']);
  });

  it('limits the count after filtering', () => {
    const filtered = filterItems(items, { now: NOW, maxAgeHours: 24, excludeKeywords: ['bundesrat'], maxItems: 1 });
    expect(filtered.map((i) => i.id)).toEqual(['b']);
  });
});

describe('relativeTime', () => {
  it('formats German relative times', () => {
    expect(relativeTime(null, NOW)).toBeNull();
    expect(relativeTime(NOW - 20_000, NOW)).toBe('gerade eben');
    expect(relativeTime(NOW + 60_000, NOW)).toBe('gerade eben');
    expect(relativeTime(NOW - 12 * 60_000, NOW)).toBe('vor 12 Min.');
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe('vor 3 Std.');
    expect(relativeTime(NOW - 25 * HOUR, NOW)).toBe('vor 1 Tag');
    expect(relativeTime(NOW - 50 * HOUR, NOW)).toBe('vor 2 Tagen');
    expect(relativeTime(Date.UTC(2026, 8, 1, 10), NOW)).toBe('01.09.2026');
  });
});

describe('feed errors', () => {
  const feeds = [{ url: 'https://www.nzz.ch/recent.rss', name: 'NZZ Neueste' }, { url: 'https://feed.example.ch/rss' }];
  const errors = [
    { url: 'https://www.nzz.ch/recent.rss', error: 'HTTP 503' },
    { url: 'https://feed.example.ch/rss', error: 'Zeitüberschreitung' },
  ];

  it('names failed feeds by name or host', () => {
    expect(failedFeedNames(errors, feeds)).toEqual(['NZZ Neueste', 'feed.example.ch']);
    expect(describeFeedErrors(errors, feeds)).toBe('NZZ Neueste: HTTP 503; feed.example.ch: Zeitüberschreitung');
  });
});
