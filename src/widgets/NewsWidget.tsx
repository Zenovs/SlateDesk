/**
 * News Widget – Shows top headlines with configurable settings.
 * Settings: Category, country, language, article count, API key.
 */
import React, { useState, useEffect, useCallback } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { fetchNewsData, type NewsResult } from '../utils/newsApi';
import { isApiConfigured } from '../utils/apiConfig';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

interface NewsSettings {
  category: string;
  country: string;
  language: string;
  maxArticles: number;
  apiKey: string;
}

const DEFAULT_SETTINGS: NewsSettings = {
  category: 'general',
  country: 'ch',
  language: 'de',
  maxArticles: 8,
  apiKey: '',
};

const CATEGORIES = [
  { value: 'general', label: 'Allgemein' },
  { value: 'business', label: 'Wirtschaft' },
  { value: 'technology', label: 'Technologie' },
  { value: 'science', label: 'Wissenschaft' },
  { value: 'sports', label: 'Sport' },
  { value: 'entertainment', label: 'Unterhaltung' },
  { value: 'health', label: 'Gesundheit' },
];

const COUNTRIES = [
  { value: 'ch', label: '🇨🇭 Schweiz' },
  { value: 'de', label: '🇩🇪 Deutschland' },
  { value: 'at', label: '🇦🇹 Österreich' },
  { value: 'us', label: '🇺🇸 USA' },
  { value: 'gb', label: '🇬🇧 Grossbritannien' },
  { value: 'fr', label: '🇫🇷 Frankreich' },
  { value: 'it', label: '🇮🇹 Italien' },
];

const LANGUAGES = [
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'it', label: 'Italiano' },
];

const NewsComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const [news, setNews] = useState<NewsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const settings = getSettings<NewsSettings>(instanceId, DEFAULT_SETTINGS);

  // Listen for settings open event
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, handler);
    return () => { eventBus.off(`widget:openSettings:${instanceId}`, handler); };
  }, [instanceId]);

  const loadNews = useCallback(async () => {
    try {
      const result = await fetchNewsData(settings.country, settings.category, settings.maxArticles, settings.apiKey);
      setNews(result);
      setLastUpdate(new Date());
    } catch {
      console.error('[NewsWidget] Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, [settings.country, settings.category, settings.maxArticles, settings.apiKey]);

  useEffect(() => {
    loadNews();
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
    <>
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
            {!news.isLive && !isApiConfigured('newsApi') && !settings.apiKey && ' (Mock-Daten)'}
          </span>
          {lastUpdate && (
            <span>{lastUpdate.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}</span>
          )}
        </div>

        {/* Error notice */}
        {news.error && !news.isLive && (isApiConfigured('newsApi') || settings.apiKey) && (
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

      <WidgetSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Einstellungen: Nachrichten"
      >
        <div className="settings-section">
          <div className="settings-section-title">Inhalt</div>
          
          <div className="settings-field">
            <label className="settings-label">Kategorie</label>
            <select
              className="settings-select"
              value={settings.category}
              onChange={(e) => updateSettings(instanceId, { category: e.target.value })}
            >
              {CATEGORIES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="settings-field">
            <label className="settings-label">Land</label>
            <select
              className="settings-select"
              value={settings.country}
              onChange={(e) => updateSettings(instanceId, { country: e.target.value })}
            >
              {COUNTRIES.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="settings-field">
            <label className="settings-label">Sprache</label>
            <select
              className="settings-select"
              value={settings.language}
              onChange={(e) => updateSettings(instanceId, { language: e.target.value })}
            >
              {LANGUAGES.map(l => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>

          <div className="settings-field">
            <label className="settings-label">Anzahl Artikel</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="range"
                className="settings-range"
                min={3}
                max={20}
                value={settings.maxArticles}
                onChange={(e) => updateSettings(instanceId, { maxArticles: parseInt(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span className="settings-range-value">{settings.maxArticles}</span>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">API-Konfiguration</div>
          <div className="settings-field">
            <label className="settings-label">NewsAPI API-Key</label>
            <input
              className="settings-input"
              type="password"
              value={settings.apiKey}
              onChange={(e) => updateSettings(instanceId, { apiKey: e.target.value })}
              placeholder="API-Key eingeben (optional)"
            />
            <p className="settings-description" style={{ marginTop: 4 }}>
              Optional – API-Key kann auch in der .env Datei konfiguriert werden.
              Kostenloser Key unter newsapi.org erhältlich.
            </p>
          </div>
          <div className="settings-info-box">
            💡 Ohne API-Key werden Mock-Daten angezeigt. Für Live-Nachrichten
            benötigst du einen kostenlosen NewsAPI Key.
          </div>
        </div>
      </WidgetSettingsDialog>
    </>
  );
};

export const newsWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'news',
    name: 'Nachrichten',
    description: 'Top-Schlagzeilen (NewsAPI)',
    version: '2.0.0',
    author: 'SlateDesk',
    minWidth: 3,
    minHeight: 3,
    defaultWidth: 4,
    defaultHeight: 4,
    permissions: ['network'],
    refreshInterval: 900,
    hasSettings: true,
  },
  component: NewsComponent,
};
