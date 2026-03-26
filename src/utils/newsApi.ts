/**
 * NewsAPI Integration
 * 
 * Fetches top headlines from NewsAPI.
 * Falls back to mock data if API key is not configured or on error.
 */
import { getApiConfig, isApiConfigured } from './apiConfig';

export interface NewsArticle {
  title: string;
  description: string | null;
  source: string;
  url: string;
  imageUrl: string | null;
  publishedAt: string;
}

export interface NewsResult {
  articles: NewsArticle[];
  isLive: boolean;
  error?: string;
}

/** Mock news data for fallback */
export const mockNewsArticles: NewsArticle[] = [
  {
    title: 'Schweizer Wirtschaft wächst stärker als erwartet',
    description: 'Das Bruttoinlandprodukt der Schweiz ist im letzten Quartal um 1.2% gewachsen.',
    source: 'SRF News',
    url: '#',
    imageUrl: null,
    publishedAt: 'Vor 2 Std.',
  },
  {
    title: 'Neue KI-Regulierung in der EU beschlossen',
    description: 'Das EU-Parlament hat neue Richtlinien für den Einsatz von Künstlicher Intelligenz verabschiedet.',
    source: 'NZZ',
    url: '#',
    imageUrl: null,
    publishedAt: 'Vor 4 Std.',
  },
  {
    title: 'Zürich investiert in Smart-City-Projekt',
    description: 'Die Stadt Zürich startet ein umfassendes Digitalisierungsprojekt für öffentliche Dienste.',
    source: 'Tages-Anzeiger',
    url: '#',
    imageUrl: null,
    publishedAt: 'Vor 5 Std.',
  },
  {
    title: 'FC Basel gewinnt Spitzenspiel',
    description: 'Mit einem 3:1 Sieg sichert sich der FC Basel die Tabellenführung in der Super League.',
    source: 'Blick',
    url: '#',
    imageUrl: null,
    publishedAt: 'Vor 6 Std.',
  },
  {
    title: 'Innovationspreis für Schweizer Startup',
    description: 'Ein ETH-Spin-off erhält den renommierten Swiss Innovation Award für nachhaltige Technologie.',
    source: 'Handelszeitung',
    url: '#',
    imageUrl: null,
    publishedAt: 'Gestern',
  },
];

/** Format relative time from ISO date string */
const formatRelativeTime = (isoDate: string): string => {
  try {
    const date = new Date(isoDate);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMin < 60) return `Vor ${diffMin} Min.`;
    if (diffHours < 24) return `Vor ${diffHours} Std.`;
    if (diffDays === 1) return 'Gestern';
    return `Vor ${diffDays} Tagen`;
  } catch {
    return isoDate;
  }
};

/**
 * Fetches news from NewsAPI.
 * Returns mock data if API key is missing or on error.
 */
export const fetchNewsData = async (): Promise<NewsResult> => {
  if (!isApiConfigured('newsApi')) {
    return { articles: mockNewsArticles, isLive: false, error: 'API-Key nicht konfiguriert' };
  }

  const config = getApiConfig().newsApi;

  try {
    const res = await fetch(
      `${config.baseUrl}/top-headlines?country=${encodeURIComponent(config.country)}&pageSize=10&apiKey=${config.apiKey}`
    );

    if (!res.ok) {
      throw new Error(`NewsAPI Fehler: ${res.status}`);
    }

    const data = await res.json();

    if (data.status !== 'ok') {
      throw new Error(data.message || 'NewsAPI Fehler');
    }

    const articles: NewsArticle[] = (data.articles || [])
      .filter((a: any) => a.title && a.title !== '[Removed]')
      .slice(0, 8)
      .map((a: any) => ({
        title: a.title,
        description: a.description,
        source: a.source?.name || 'Unbekannt',
        url: a.url || '#',
        imageUrl: a.urlToImage || null,
        publishedAt: a.publishedAt ? formatRelativeTime(a.publishedAt) : '',
      }));

    if (articles.length === 0) {
      return { articles: mockNewsArticles, isLive: false, error: 'Keine Artikel gefunden' };
    }

    return { articles, isLive: true };
  } catch (err) {
    console.error('[NewsWidget] API-Fehler:', err);
    return {
      articles: mockNewsArticles,
      isLive: false,
      error: err instanceof Error ? err.message : 'Unbekannter Fehler',
    };
  }
};
