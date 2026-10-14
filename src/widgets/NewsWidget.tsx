/**
 * News widget – RSS/Atom feeds, fetched, merged and deduplicated by the Rust
 * backend (`feeds_fetch`): no API key, no CORS. Three views: list, rotating
 * headline with image, ticker. Items are not links (nobody can follow them
 * on the kiosk); relative times are recomputed every minute.
 */
import { type CSSProperties, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Newspaper, RotateCcw } from 'lucide-react';
import { useElementSize } from '../hooks/useElementSize';
import { usePolling } from '../hooks/usePolling';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { useAppState } from '../state/appState';
import type { WidgetProps } from '../types/widget';
import { type FeedItem, type FeedsResult, feedsFetch } from '../utils/backend';
import { NEWS_DEFAULT_SETTINGS, type NewsMode, type NewsSettings } from './manifests/news';
import { activeFeeds, describeFeedErrors, failedFeedNames, filterItems, relativeTime } from './news/newsItems';
import { useNow } from './shared/hooks';
import './styles/news.css';

/** Items requested from the backend; the filters (age, keywords) pick from these. */
const FETCH_POOL = 150;
/** Content height (px) below which a list turns into a ticker. */
const COMPACT_MAX_HEIGHT = 72;
const TICKER_SPEED_PX_PER_S = 70;
const MAX_DOTS = 12;
const NO_URLS: ReadonlySet<string> = new Set();

// ── Settings ─────────────────────────────────────────────────────────────────

/** Version 2 used NewsAPI: these keys (including the API key) are gone. */
const LEGACY_KEYS = ['category', 'country', 'language', 'maxArticles', 'apiKey'] as const;

interface LegacyMigration {
  patch: Record<string, unknown>;
  values: Partial<NewsSettings>;
}

function legacyMigration(stored: Record<string, unknown> | undefined): LegacyMigration | null {
  if (!stored) return null;
  const present = LEGACY_KEYS.filter((key) => key in stored);
  if (present.length === 0) return null;
  const patch: Record<string, unknown> = Object.fromEntries(present.map((key) => [key, undefined]));
  const values: Partial<NewsSettings> = {};
  if (stored.maxItems === undefined && typeof stored.maxArticles === 'number') {
    patch.maxItems = values.maxItems = stored.maxArticles;
  }
  return { patch, values };
}

function useNewsSettings(instanceId: string): NewsSettings {
  const stored = useAppState((s) => s.state.widgetSettings[instanceId]);
  const [raw, update] = useWidgetSettings(instanceId, NEWS_DEFAULT_SETTINGS);
  const migration = useMemo(() => legacyMigration(stored), [stored]);

  useEffect(() => {
    if (migration) update(migration.patch as Partial<NewsSettings>);
  }, [migration, update]);

  return useMemo(() => (migration ? { ...raw, ...migration.values } : raw), [raw, migration]);
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

function ageLabel(hours: number): string {
  if (hours % 24 === 0) return hours === 24 ? '24 Stunden' : `${hours / 24} Tage`;
  return `${hours} Stunden`;
}

const formatClock = (epochMs: number): string =>
  new Date(epochMs).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

// ── Parts ────────────────────────────────────────────────────────────────────

interface MessageProps {
  title: string;
  detail?: string | null;
  error?: boolean;
  onRetry?: () => void;
}

function NewsMessage({ title, detail, error = false, onRetry }: MessageProps) {
  return (
    <div className={`news-message${error ? ' news-message--error' : ''}`} role={error ? 'alert' : 'status'}>
      {error ? (
        <AlertTriangle className="news-message-icon" aria-hidden="true" />
      ) : (
        <Newspaper className="news-message-icon" aria-hidden="true" />
      )}
      <div className="news-message-title">{title}</div>
      {detail && <div className="news-message-detail">{detail}</div>}
      {onRetry && (
        <button type="button" className="news-retry" onClick={onRetry}>
          <RotateCcw size={16} aria-hidden="true" />
          Erneut versuchen
        </button>
      )}
    </div>
  );
}

interface ItemDisplay {
  now: number;
  showSource: boolean;
  showSummary: boolean;
  /** Image URL to show for an item, or null (disabled, missing or broken). */
  imageOf: (item: FeedItem) => string | null;
  onImageError: (url: string) => void;
}

function NewsMeta({ item, now, showSource }: { item: FeedItem; now: number; showSource: boolean }) {
  const time = relativeTime(item.published, now);
  if (!showSource && !time) return null;
  return (
    <div className="news-meta">
      {showSource && <span className="news-source">{item.source}</span>}
      {time && <span className="news-time">{time}</span>}
    </div>
  );
}

function NewsList({ items, display }: { items: FeedItem[]; display: ItemDisplay }) {
  return (
    <div className="news-list">
      {items.map((item) => {
        const image = display.imageOf(item);
        return (
          <article key={item.id} className="news-item">
            {image && (
              <div className="news-thumb">
                <img
                  src={image}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerPolicy="no-referrer"
                  onError={() => display.onImageError(image)}
                />
              </div>
            )}
            <div className="news-item-body">
              <h3 className="news-item-title">{item.title}</h3>
              {display.showSummary && item.summary && <p className="news-item-summary">{item.summary}</p>}
              <NewsMeta item={item} now={display.now} showSource={display.showSource} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function NewsRotation({ items, display, rotateMs }: { items: FeedItem[]; display: ItemDisplay; rotateMs: number }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (items.length < 2) return;
    const timer = setInterval(() => setTick((value) => value + 1), rotateMs);
    return () => clearInterval(timer);
  }, [items.length, rotateMs]);

  const index = tick % items.length;
  const item = items[index];
  const image = display.imageOf(item);

  return (
    <div className="news-rotation">
      {/* Keyed by item: every change mounts anew and fades in. */}
      <article key={item.id} className={`news-hero${image ? ' news-hero--image' : ''}`}>
        {image && (
          <div className="news-hero-media">
            <img
              src={image}
              alt=""
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => display.onImageError(image)}
            />
          </div>
        )}
        <div className="news-hero-body">
          <NewsMeta item={item} now={display.now} showSource={display.showSource} />
          <h3 className="news-hero-title">{item.title}</h3>
          {display.showSummary && item.summary && <p className="news-hero-summary">{item.summary}</p>}
        </div>
      </article>
      {items.length > 1 &&
        (items.length <= MAX_DOTS ? (
          <div className="news-dots" aria-hidden="true">
            {items.map((entry, i) => (
              <span key={entry.id} className={`news-dot${i === index ? ' news-dot--active' : ''}`} />
            ))}
          </div>
        ) : (
          <div className="news-counter">
            {index + 1} / {items.length}
          </div>
        ))}
    </div>
  );
}

function NewsTicker({ items, now, showSource, warning }: { items: FeedItem[]; now: number; showSource: boolean; warning: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const viewport = useElementSize(viewportRef);
  const group = useElementSize(groupRef);
  // Rounded to 5 s, so a changing «vor N Min.» does not make the band jump.
  const duration = group.width > 0 ? Math.max(10, Math.round(group.width / TICKER_SPEED_PX_PER_S / 5) * 5) : 0;
  const style = {
    '--news-ticker-duration': `${duration}s`,
    '--news-ticker-min': `${viewport.width}px`,
  } as CSSProperties;

  const entries = items.map((item) => {
    const time = relativeTime(item.published, now);
    return (
      <span key={item.id} className="news-ticker-item">
        {showSource && <span className="news-ticker-source">{item.source}</span>}
        <span className="news-ticker-title">{item.title}</span>
        {time && <span className="news-ticker-time">{time}</span>}
      </span>
    );
  });

  return (
    <div className="news-ticker">
      {warning && <AlertTriangle className="news-ticker-warning" aria-label="Nicht alle Quellen erreichbar" />}
      <div ref={viewportRef} className="news-ticker-viewport">
        {/* Two identical groups: scrolling by half the track loops seamlessly. */}
        <div className={`news-ticker-track${duration > 0 ? ' news-ticker-track--running' : ''}`} style={style}>
          <div ref={groupRef} className="news-ticker-group">
            {entries}
          </div>
          <div className="news-ticker-group" aria-hidden="true">
            {entries}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Widget ───────────────────────────────────────────────────────────────────

export function NewsWidget({ instanceId }: WidgetProps) {
  const settings = useNewsSettings(instanceId);
  const feeds = useMemo(() => activeFeeds(settings.feeds), [settings.feeds]);
  const feedsKey = useMemo(() => JSON.stringify(feeds), [feeds]);
  const refreshMs = clamp(settings.refreshMinutes, 1, 240, NEWS_DEFAULT_SETTINGS.refreshMinutes) * 60_000;
  const maxItems = clamp(settings.maxItems, 1, 50, NEWS_DEFAULT_SETTINGS.maxItems);
  const maxAgeHours = clamp(settings.maxAgeHours, 0, 24 * 365, NEWS_DEFAULT_SETTINGS.maxAgeHours);
  const rotateMs = clamp(settings.rotateSeconds, 3, 600, NEWS_DEFAULT_SETTINGS.rotateSeconds) * 1000;
  const excludeKeywords = useMemo(
    () => (Array.isArray(settings.excludeKeywords) ? settings.excludeKeywords.filter((k) => typeof k === 'string') : []),
    [settings.excludeKeywords],
  );
  const mode: NewsMode = settings.mode === 'rotation' || settings.mode === 'ticker' ? settings.mode : 'liste';

  const news = usePolling(
    async (signal): Promise<FeedsResult> => {
      const result = await feedsFetch(feeds, FETCH_POOL);
      signal.throwIfAborted();
      // Nothing at all came through: an error, so the last good items stay.
      if (result.items.length === 0 && result.errors.length > 0) throw new Error(describeFeedErrors(result.errors, feeds));
      return result;
    },
    refreshMs,
    [feedsKey],
    { enabled: feeds.length > 0 },
  );

  const retryFailed = useEffectEvent(() => {
    if (news.error) news.refresh();
  });
  useEffect(() => {
    const onOnline = () => retryFailed();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  const now = useNow(60_000);
  const data = news.data;
  const items = useMemo(
    () => filterItems(data?.items ?? [], { now, maxAgeHours, excludeKeywords, maxItems }),
    [data, now, maxAgeHours, excludeKeywords, maxItems],
  );

  // Broken images are forgotten with the next fetch (new URLs, maybe fixed).
  const [brokenImages, setBrokenImages] = useState<{ data: FeedsResult | null; urls: ReadonlySet<string> }>({
    data: null,
    urls: NO_URLS,
  });
  const broken = brokenImages.data === data ? brokenImages.urls : NO_URLS;
  const display: ItemDisplay = {
    now,
    showSource: settings.showSource !== false,
    showSummary: settings.showSummary !== false,
    imageOf: (item) =>
      settings.showImages !== false && item.imageUrl && !broken.has(item.imageUrl) ? item.imageUrl : null,
    onImageError: (url) =>
      setBrokenImages((prev) => ({ data, urls: new Set(prev.data === data ? prev.urls : NO_URLS).add(url) })),
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(rootRef);
  const compact = height > 0 && height < COMPACT_MAX_HEIGHT;
  const view: NewsMode = compact && mode === 'liste' ? 'ticker' : mode;

  const failedNames = data ? failedFeedNames(data.errors, feeds) : [];
  let notice: string | null = null;
  if (news.error && data) {
    notice = `Stand ${news.lastUpdated !== null ? formatClock(news.lastUpdated) : '–'} · ${news.error}`;
  } else if (failedNames.length > 0) {
    notice = `Nicht erreichbar: ${failedNames.join(', ')}`;
  }

  let content;
  if (feeds.length === 0) {
    content = (
      <NewsMessage
        title="Keine Quelle aktiv"
        detail="In den Einstellungen einen RSS-Feed eintragen oder aktivieren."
      />
    );
  } else if (!data) {
    content = news.error ? (
      <NewsMessage error title="Nachrichten nicht verfügbar" detail={news.error} onRetry={news.refresh} />
    ) : (
      <NewsMessage title="Nachrichten werden geladen …" />
    );
  } else if (items.length === 0) {
    content = (
      <NewsMessage
        title={maxAgeHours > 0 ? `Keine Meldungen der letzten ${ageLabel(maxAgeHours)}` : 'Keine Meldungen'}
        detail={data.items.length > 0 ? 'Höchstalter und Stichwort-Filter in den Einstellungen prüfen.' : null}
      />
    );
  } else if (view === 'ticker') {
    content = <NewsTicker items={items} now={now} showSource={display.showSource} warning={notice !== null} />;
  } else {
    content = (
      <>
        {view === 'rotation' ? (
          <NewsRotation items={items} display={display} rotateMs={rotateMs} />
        ) : (
          <NewsList items={items} display={display} />
        )}
        {notice && (
          <div className="news-notice">
            <AlertTriangle aria-hidden="true" />
            <span>{notice}</span>
          </div>
        )}
      </>
    );
  }

  return (
    <div ref={rootRef} className="news">
      {content}
    </div>
  );
}
