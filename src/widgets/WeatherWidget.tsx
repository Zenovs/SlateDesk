/**
 * Weather Widget – Shows weather forecast from OpenWeatherMap API.
 * Falls back to mock data if API key is not configured.
 */
import React, { useState, useEffect, useCallback } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { fetchWeatherData, type WeatherResult } from '../utils/weatherApi';
import { isApiConfigured } from '../utils/apiConfig';

const WeatherComponent: React.FC<WidgetProps> = () => {
  const [weather, setWeather] = useState<WeatherResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const loadWeather = useCallback(async () => {
    try {
      const result = await fetchWeatherData();
      setWeather(result);
      setLastUpdate(new Date());
    } catch {
      console.error('[WeatherWidget] Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWeather();
    // Refresh every 30 minutes
    const interval = setInterval(loadWeather, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadWeather]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
        ⏳ Wetter wird geladen...
      </div>
    );
  }

  if (!weather || weather.data.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
        ⚠️ Keine Wetterdaten verfügbar
      </div>
    );
  }

  const today = weather.data[0];
  const forecast = weather.data.slice(1);

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
          {weather.isLive ? '🟢 Live' : '🔴 Offline'}
          {weather.city && ` – ${weather.city}`}
          {!weather.isLive && !isApiConfigured('openWeatherMap') && ' (Mock-Daten)'}
        </span>
        {lastUpdate && (
          <span>{lastUpdate.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}</span>
        )}
      </div>

      {/* Error notice */}
      {weather.error && !weather.isLive && isApiConfigured('openWeatherMap') && (
        <div style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--error-color, #ef4444)',
          background: 'rgba(239, 68, 68, 0.1)',
          padding: '4px 8px',
          borderRadius: 'var(--radius-sm)',
        }}>
          ⚠️ {weather.error}
        </div>
      )}

      {/* Current weather */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        flex: 1,
      }}>
        <span style={{ fontSize: 48 }}>{today.icon}</span>
        <div>
          <div style={{
            fontSize: 'var(--font-size-xl)',
            fontWeight: 'var(--font-weight-bold)',
            color: 'var(--text-primary)',
          }}>
            {today.tempHigh}°C
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
            {today.condition}
          </div>
        </div>
      </div>

      {/* Forecast row */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-around',
        borderTop: '1px solid var(--border-color)',
        paddingTop: 10,
      }}>
        {forecast.map((f) => (
          <div key={f.day} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>{f.day}</div>
            <div style={{ fontSize: 22, margin: '4px 0' }}>{f.icon}</div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>
              {f.tempLow}° <span style={{ color: 'var(--text-tertiary)' }}>/</span> {f.tempHigh}°
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export const weatherWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'weather',
    name: 'Wetter',
    description: 'Wettervorhersage (OpenWeatherMap)',
    version: '2.0.0',
    author: 'SlateDesk',
    minWidth: 3,
    minHeight: 2,
    defaultWidth: 4,
    defaultHeight: 3,
    permissions: ['network'],
    refreshInterval: 1800,
  },
  component: WeatherComponent,
};
