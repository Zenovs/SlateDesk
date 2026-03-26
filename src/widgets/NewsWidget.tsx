/**
 * News Widget – Shows top headlines from NewsAPI.
 * Falls back to mock data if API key is not configured.
 */
import React, { useState, useEffect, useCallback } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { fetchNewsData, type NewsResult } from '../utils/newsApi';
import { isApiConfigured } from '../utils/apiConfig';

const NewsComponent: React.FC<WidgetProps> = () => {
  const [news, setNews] = useState<NewsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const loadNews = useCallback(async () => {
    try {
      const result = await fetchNewsData();
      setNews(result);
      setLastUpdate(new Date());
    } catch {
      console.error('[NewsWidget] Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNews();
    // Refresh every 15 minutes
    const interval = setInterval(loadNews, 15 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadNews]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
        ⏳ Nachrichten werden geladen...
      </div>
    );
  }

  if (!news || news.articles.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
        ⚠️ Keine Nachrichten verfügbar
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      {/* Status indicator */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontSize: 'var(--font-size-xs)',
        color: 'var(--text-tertiary)',
        paddingBottom: 4,
      }}>
        <span>
          {news.isLive ? '🟢 Live' : '🔴 Offline'}
          {!news.isLive && !isApiConfigured('newsApi') && ' (Mock-Daten)'}
        </span>
        {lastUpdate && (
          <span>{lastUpdate.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}</span>
        )}
      </div>

      {/* Error notice */}
      {news.error && !news.isLive && isApiConfigured('newsApi') && (
        <div style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--error-color, #ef4444)',
          background: 'rgba(239, 68, 68, 0.1)',
          padding: '4px 8px',
          borderRadius: 'var(--radius-sm)',
        }}>
          ⚠️ {news.error}
        </div>
      )}

      {/* Article list */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {news.articles.map((article, idx) => (
          <a
            key={idx}
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex',
              gap: 10,
              padding: '8px 0',
              borderBottom: '1px solid var(--border-color)',
              textDecoration: 'none',
              color: 'inherit',
              cursor: article.url !== '#' ? 'pointer' : 'default',
            }}
          >
            {/* Optional image */}
            {article.imageUrl && (
              <div style={{
                width: 56,
                height: 56,
                borderRadius: 'var(--radius-sm)',
                overflow: 'hidden',
                flexShrink: 0,
                background: 'var(--bg-tertiary)',
              }}>
                <img
                  src={article.imageUrl}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 'var(--font-size-sm)',
                fontWeight: 'var(--font-weight-medium)',
                color: 'var(--text-primary)',
                lineHeight: 1.3,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}>
                {article.title}
              </div>
              {article.description && (
                <div style={{
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--text-tertiary)',
                  marginTop: 3,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {article.description}
                </div>
              )}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 'var(--font-size-xs)',
                color: 'var(--text-tertiary)',
                marginTop: 4,
              }}>
                <span style={{ fontWeight: 'var(--font-weight-medium)' }}>{article.source}</span>
                <span>{article.publishedAt}</span>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
};

export const newsWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'news',
    name: 'Nachrichten',
    description: 'Top-Schlagzeilen (NewsAPI)',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 3,
    minHeight: 3,
    defaultWidth: 4,
    defaultHeight: 4,
    permissions: ['network'],
    refreshInterval: 900,
  },
  component: NewsComponent,
};
