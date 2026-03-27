/**
 * Clock Widget – Displays current time and date with configurable settings.
 * Settings: Time format (12h/24h), timezone, show seconds, date format.
 */
import React, { useEffect, useState, useCallback } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

interface ClockSettings {
  timeFormat: '24h' | '12h';
  timezone: string;
  showSeconds: boolean;
  dateFormat: 'DD.MM.YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD.MM.YY';
}

const DEFAULT_SETTINGS: ClockSettings = {
  timeFormat: '24h',
  timezone: 'Europe/Zurich',
  showSeconds: false,
  dateFormat: 'DD.MM.YY',
};

const TIMEZONES = [
  { value: 'Europe/Zurich', label: 'Zürich (MEZ)' },
  { value: 'Europe/Berlin', label: 'Berlin (MEZ)' },
  { value: 'Europe/Vienna', label: 'Wien (MEZ)' },
  { value: 'Europe/London', label: 'London (GMT)' },
  { value: 'Europe/Paris', label: 'Paris (MEZ)' },
  { value: 'Europe/Rome', label: 'Rom (MEZ)' },
  { value: 'America/New_York', label: 'New York (EST)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PST)' },
  { value: 'America/Chicago', label: 'Chicago (CST)' },
  { value: 'Asia/Tokyo', label: 'Tokio (JST)' },
  { value: 'Asia/Shanghai', label: 'Shanghai (CST)' },
  { value: 'Asia/Dubai', label: 'Dubai (GST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
  { value: 'UTC', label: 'UTC' },
];

const DATE_FORMATS = [
  { value: 'DD.MM.YY', label: 'DD.MM.YY (z.B. 27.03.26)' },
  { value: 'DD.MM.YYYY', label: 'DD.MM.YYYY (z.B. 27.03.2026)' },
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (z.B. 03/27/2026)' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (z.B. 2026-03-27)' },
];

const ClockComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const [now, setNow] = useState(new Date());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const settings = getSettings<ClockSettings>(instanceId, DEFAULT_SETTINGS);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Listen for settings open event
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, handler);
    return () => { eventBus.off(`widget:openSettings:${instanceId}`, handler); };
  }, [instanceId]);

  const formatTime = useCallback((d: Date) => {
    const opts: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      minute: '2-digit',
      hour12: settings.timeFormat === '12h',
      timeZone: settings.timezone,
    };
    if (settings.showSeconds) opts.second = '2-digit';
    return d.toLocaleTimeString('de-CH', opts);
  }, [settings.timeFormat, settings.timezone, settings.showSeconds]);

  const formatDate = useCallback((d: Date) => {
    const opts: Intl.DateTimeFormatOptions = { timeZone: settings.timezone };
    const tzDate = new Date(d.toLocaleString('en-US', opts));
    const days = ['SO', 'MO', 'DI', 'MI', 'DO', 'FR', 'SA'];
    const day = days[tzDate.getDay()];
    const dd = String(tzDate.getDate()).padStart(2, '0');
    const mm = String(tzDate.getMonth() + 1).padStart(2, '0');
    const yyyy = String(tzDate.getFullYear());
    const yy = yyyy.slice(-2);

    switch (settings.dateFormat) {
      case 'DD.MM.YYYY': return `${day}  ${dd}.${mm}.${yyyy}`;
      case 'MM/DD/YYYY': return `${day}  ${mm}/${dd}/${yyyy}`;
      case 'YYYY-MM-DD': return `${day}  ${yyyy}-${mm}-${dd}`;
      default: return `${day}  ${dd}.${mm}.${yy}`;
    }
  }, [settings.timezone, settings.dateFormat]);

  const handleSettingChange = (key: keyof ClockSettings, value: string | boolean) => {
    updateSettings(instanceId, { [key]: value });
  };

  return (
    <>
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 4,
      }}>
        <div style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--text-tertiary)',
          letterSpacing: 2,
          fontWeight: 'var(--font-weight-medium)',
        }}>
          {formatDate(now)}
        </div>
        <div style={{
          fontSize: 'var(--font-size-3xl)',
          fontWeight: 'var(--font-weight-light)',
          color: 'var(--text-primary)',
          letterSpacing: 2,
          lineHeight: 1,
        }}>
          {formatTime(now)}
        </div>
        {settings.timezone !== 'Europe/Zurich' && (
          <div style={{
            fontSize: 'var(--font-size-xs)',
            color: 'var(--text-accent)',
            marginTop: 4,
          }}>
            {TIMEZONES.find(t => t.value === settings.timezone)?.label || settings.timezone}
          </div>
        )}
      </div>

      <WidgetSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Einstellungen: Uhr"
      >
        {/* Time Format */}
        <div className="settings-section">
          <div className="settings-section-title">Zeitanzeige</div>
          
          <div className="settings-field">
            <label className="settings-label">Zeitformat</label>
            <div className="settings-radio-group">
              {(['24h', '12h'] as const).map(fmt => (
                <label
                  key={fmt}
                  className={`settings-radio-option ${settings.timeFormat === fmt ? 'active' : ''}`}
                >
                  <input
                    type="radio"
                    name="timeFormat"
                    value={fmt}
                    checked={settings.timeFormat === fmt}
                    onChange={() => handleSettingChange('timeFormat', fmt)}
                  />
                  {fmt === '24h' ? '24-Stunden' : '12-Stunden (AM/PM)'}
                </label>
              ))}
            </div>
          </div>

          <div className="settings-field">
            <div className="settings-toggle">
              <div>
                <div className="settings-toggle-label">Sekunden anzeigen</div>
                <div className="settings-toggle-sublabel">Zeigt zusätzlich die Sekunden an</div>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.showSeconds}
                  onChange={(e) => handleSettingChange('showSeconds', e.target.checked)}
                />
                <span className="toggle-switch-slider" />
              </label>
            </div>
          </div>
        </div>

        {/* Timezone */}
        <div className="settings-section">
          <div className="settings-section-title">Zeitzone</div>
          <div className="settings-field">
            <label className="settings-label">Zeitzone auswählen</label>
            <select
              className="settings-select"
              value={settings.timezone}
              onChange={(e) => handleSettingChange('timezone', e.target.value)}
            >
              {TIMEZONES.map(tz => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Date Format */}
        <div className="settings-section">
          <div className="settings-section-title">Datum</div>
          <div className="settings-field">
            <label className="settings-label">Datumsformat</label>
            <select
              className="settings-select"
              value={settings.dateFormat}
              onChange={(e) => handleSettingChange('dateFormat', e.target.value)}
            >
              {DATE_FORMATS.map(f => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
        </div>
      </WidgetSettingsDialog>
    </>
  );
};

export const clockWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'clock',
    name: 'Uhr',
    description: 'Aktuelle Uhrzeit und Datum',
    version: '2.0.0',
    author: 'SlateDesk',
    minWidth: 2,
    minHeight: 2,
    defaultWidth: 3,
    defaultHeight: 3,
    permissions: [],
    hasSettings: true,
  },
  component: ClockComponent,
};
