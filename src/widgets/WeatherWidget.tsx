/**
 * Weather Widget – Open-Meteo (kostenlos, kein API-Key).
 * Standort wird automatisch via IP erkannt oder kann manuell gesetzt werden.
 */
import React, { useState, useEffect, useCallback } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { fetchWeatherData, type WeatherResult } from '../utils/weatherApi';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

interface WeatherSettings {
  city: string;           // leer = automatisch via IP
  tempUnit: 'celsius' | 'fahrenheit';
  updateInterval: number; // minutes
}

const DEFAULT_SETTINGS: WeatherSettings = {
  city: '',
  tempUnit: 'celsius',
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

  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, handler);
    return () => { eventBus.off(`widget:openSettings:${instanceId}`, handler); };
  }, [instanceId]);

  const loadWeather = useCallback(async () => {
    try {
      const result = await fetchWeatherData(settings.city || undefined);
      setWeather(result);
      setLastUpdate(new Date());
    } catch {
      console.error('[WeatherWidget] Fehler beim Laden');
    } finally {
      setLoading(false);
    }
  }, [settings.city]);

  useEffect(() => {
    loadWeather();
    const interval = setInterval(loadWeather, settings.updateInterval * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadWeather, settings.updateInterval]);

  const displayTemp = (temp: number) =>
    settings.tempUnit === 'fahrenheit' ? `${toF(temp)}°F` : `${temp}°C`;

  const displayTempShort = (temp: number) =>
    settings.tempUnit === 'fahrenheit' ? `${toF(temp)}°` : `${temp}°`;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
        ⏳ Wetter wird geladen…
      </div>
    );
  }

  if (!weather || weather.data.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 6, color: 'var(--text-tertiary)' }}>
        <span>⚠️ Keine Wetterdaten</span>
        {weather?.error && <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--error-color, #ef4444)' }}>{weather.error}</span>}
      </div>
    );
  }

  const today = weather.data[0];
  const forecast = weather.data.slice(1);

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
          <span>
            {weather.isLive ? '🟢' : '🔴'}
            {weather.city && ` ${weather.city}`}
            {!settings.city && ' · Auto'}
          </span>
          {lastUpdate && (
            <span>{lastUpdate.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}</span>
          )}
        </div>

        {/* Aktuelles Wetter */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, flex: 1 }}>
          <span style={{ fontSize: 48 }}>{today.icon}</span>
          <div>
            <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--font-weight-bold)', color: 'var(--text-primary)' }}>
              {displayTemp(today.tempHigh)}
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>
              {today.condition}
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
              min {displayTempShort(today.tempLow)}
            </div>
          </div>
        </div>

        {/* Vorhersage */}
        <div style={{ display: 'flex', justifyContent: 'space-around', borderTop: '1px solid var(--border-color)', paddingTop: 10 }}>
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

      <WidgetSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Einstellungen: Wetter">
        <div className="settings-section">
          <div className="settings-section-title">Standort</div>
          <div className="settings-field">
            <label className="settings-label">Stadt (optional)</label>
            <input
              className="settings-input"
              type="text"
              value={settings.city}
              onChange={(e) => updateSettings(instanceId, { city: e.target.value })}
              placeholder="Leer lassen für automatische Erkennung"
            />
            <p className="settings-description" style={{ marginTop: 4 }}>
              Leer = Standort wird automatisch via IP erkannt. Oder Stadt eingeben, z.B. «Zürich» oder «Berlin».
            </p>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Anzeige</div>
          <div className="settings-field">
            <label className="settings-label">Temperatur-Einheit</label>
            <div className="settings-radio-group">
              {([{ value: 'celsius', label: '°C (Celsius)' }, { value: 'fahrenheit', label: '°F (Fahrenheit)' }] as const).map(opt => (
                <label key={opt.value} className={`settings-radio-option ${settings.tempUnit === opt.value ? 'active' : ''}`}>
                  <input type="radio" name="tempUnit" value={opt.value} checked={settings.tempUnit === opt.value} onChange={() => updateSettings(instanceId, { tempUnit: opt.value })} />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
          <div className="settings-field">
            <label className="settings-label">Update-Intervall</label>
            <select className="settings-select" value={settings.updateInterval} onChange={(e) => updateSettings(instanceId, { updateInterval: parseInt(e.target.value) })}>
              {UPDATE_INTERVALS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </div>
        </div>

        <div className="settings-info-box">
          💡 Wetterdaten von Open-Meteo – kostenlos, kein API-Key nötig.
        </div>
      </WidgetSettingsDialog>
    </>
  );
};

export const weatherWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'weather',
    name: 'Wetter',
    description: 'Wettervorhersage (automatischer Standort)',
    version: '3.0.0',
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
