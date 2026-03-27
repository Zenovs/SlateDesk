/**
 * Weather Widget – Shows weather forecast with configurable settings.
 * Settings: Location, temperature unit, API key, update interval.
 */
import React, { useState, useEffect, useCallback } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { fetchWeatherData, type WeatherResult } from '../utils/weatherApi';
import { isApiConfigured } from '../utils/apiConfig';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

interface WeatherSettings {
  city: string;
  tempUnit: 'celsius' | 'fahrenheit';
  apiKey: string;
  updateInterval: number; // minutes
}

const DEFAULT_SETTINGS: WeatherSettings = {
  city: 'Zurich,CH',
  tempUnit: 'celsius',
  apiKey: '',
  updateInterval: 30,
};

const UPDATE_INTERVALS = [
  { value: 15, label: '15 Minuten' },
  { value: 30, label: '30 Minuten' },
  { value: 60, label: '1 Stunde' },
  { value: 120, label: '2 Stunden' },
];

const toF = (c: number) => Math.round(c * 9 / 5 + 32);

const WeatherComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const [weather, setWeather] = useState<WeatherResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const settings = getSettings<WeatherSettings>(instanceId, DEFAULT_SETTINGS);

  // Listen for settings open event
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, handler);
    return () => { eventBus.off(`widget:openSettings:${instanceId}`, handler); };
  }, [instanceId]);

  const loadWeather = useCallback(async () => {
    try {
      const result = await fetchWeatherData(settings.city, settings.apiKey);
      setWeather(result);
      setLastUpdate(new Date());
    } catch {
      console.error('[WeatherWidget] Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, [settings.city, settings.apiKey]);

  useEffect(() => {
    loadWeather();
    const interval = setInterval(loadWeather, settings.updateInterval * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadWeather, settings.updateInterval]);

  const displayTemp = (temp: number) => {
    if (settings.tempUnit === 'fahrenheit') return `${toF(temp)}°F`;
    return `${temp}°C`;
  };

  const displayTempShort = (temp: number) => {
    if (settings.tempUnit === 'fahrenheit') return `${toF(temp)}°`;
    return `${temp}°`;
  };

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
            {weather.isLive ? '🟢 Live' : '🔴 Offline'}
            {weather.city && ` – ${weather.city}`}
            {!weather.isLive && !isApiConfigured('openWeatherMap') && !settings.apiKey && ' (Mock-Daten)'}
          </span>
          {lastUpdate && (
            <span>{lastUpdate.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}</span>
          )}
        </div>

        {/* Error notice */}
        {weather.error && !weather.isLive && (isApiConfigured('openWeatherMap') || settings.apiKey) && (
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
              {displayTemp(today.tempHigh)}
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
                {displayTempShort(f.tempLow)} <span style={{ color: 'var(--text-tertiary)' }}>/</span> {displayTempShort(f.tempHigh)}
              </div>
            </div>
          ))}
        </div>
      </div>

      <WidgetSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Einstellungen: Wetter"
      >
        <div className="settings-section">
          <div className="settings-section-title">Standort</div>
          <div className="settings-field">
            <label className="settings-label">Stadt</label>
            <input
              className="settings-input"
              type="text"
              value={settings.city}
              onChange={(e) => updateSettings(instanceId, { city: e.target.value })}
              placeholder="z.B. Zurich,CH oder Berlin,DE"
            />
            <p className="settings-description" style={{ marginTop: 4 }}>
              Format: Stadt,Ländercode (z.B. Zurich,CH)
            </p>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Anzeige</div>
          <div className="settings-field">
            <label className="settings-label">Temperatur-Einheit</label>
            <div className="settings-radio-group">
              {([
                { value: 'celsius', label: '°C (Celsius)' },
                { value: 'fahrenheit', label: '°F (Fahrenheit)' },
              ] as const).map(opt => (
                <label
                  key={opt.value}
                  className={`settings-radio-option ${settings.tempUnit === opt.value ? 'active' : ''}`}
                >
                  <input
                    type="radio"
                    name="tempUnit"
                    value={opt.value}
                    checked={settings.tempUnit === opt.value}
                    onChange={() => updateSettings(instanceId, { tempUnit: opt.value })}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          <div className="settings-field">
            <label className="settings-label">Update-Intervall</label>
            <select
              className="settings-select"
              value={settings.updateInterval}
              onChange={(e) => updateSettings(instanceId, { updateInterval: parseInt(e.target.value) })}
            >
              {UPDATE_INTERVALS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">API-Konfiguration</div>
          <div className="settings-field">
            <label className="settings-label">OpenWeatherMap API-Key</label>
            <input
              className="settings-input"
              type="password"
              value={settings.apiKey}
              onChange={(e) => updateSettings(instanceId, { apiKey: e.target.value })}
              placeholder="API-Key eingeben (optional)"
            />
            <p className="settings-description" style={{ marginTop: 4 }}>
              Optional – API-Key kann auch in der .env Datei konfiguriert werden.
              Kostenloser Key unter openweathermap.org erhältlich.
            </p>
          </div>
          <div className="settings-info-box">
            💡 Ohne API-Key werden Mock-Daten angezeigt. Für Live-Wetterdaten
            benötigst du einen kostenlosen OpenWeatherMap API-Key.
          </div>
        </div>
      </WidgetSettingsDialog>
    </>
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
    hasSettings: true,
  },
  component: WeatherComponent,
};
