/**
 * Volumio Widget – Zeigt aktuell spielenden Titel von Volumio.
 * Settings: IP-Adresse des Volumio-Geräts, Update-Intervall.
 */
import React, { useState, useEffect, useCallback } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

interface VolumioSettings {
  ip: string;
  updateInterval: number; // seconds
}

interface VolumioState {
  title?: string;
  artist?: string;
  album?: string;
  albumart?: string;
  status?: 'play' | 'pause' | 'stop';
}

const DEFAULT_SETTINGS: VolumioSettings = {
  ip: '',
  updateInterval: 5,
};

const UPDATE_INTERVALS = [
  { value: 3, label: '3 Sekunden' },
  { value: 5, label: '5 Sekunden' },
  { value: 10, label: '10 Sekunden' },
  { value: 30, label: '30 Sekunden' },
];

const VolumioComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const [state, setState] = useState<VolumioState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [coverError, setCoverError] = useState(false);

  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const settings = getSettings<VolumioSettings>(instanceId, DEFAULT_SETTINGS);

  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, handler);
    return () => { eventBus.off(`widget:openSettings:${instanceId}`, handler); };
  }, [instanceId]);

  const fetchState = useCallback(async () => {
    if (!settings.ip.trim()) return;

    try {
      setError(null);
      const response = await fetch(`http://${settings.ip}/api/v1/getstate`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as VolumioState;
      setState(data);
      setCoverError(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verbindungsfehler');
    } finally {
      setLoading(false);
    }
  }, [settings.ip]);

  useEffect(() => {
    if (!settings.ip.trim()) {
      setState(null);
      setError(null);
      return;
    }
    setLoading(true);
    fetchState();
    const interval = setInterval(fetchState, settings.updateInterval * 1000);
    return () => clearInterval(interval);
  }, [fetchState, settings.updateInterval, settings.ip]);

  const coverUrl = state?.albumart
    ? state.albumart.startsWith('http')
      ? state.albumart
      : `http://${settings.ip}${state.albumart}`
    : null;

  const renderContent = () => {
    if (!settings.ip.trim()) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-tertiary)' }}>
          <span style={{ fontSize: 32 }}>🎵</span>
          <span style={{ fontSize: 'var(--font-size-sm)' }}>IP-Adresse in den Einstellungen konfigurieren</span>
        </div>
      );
    }

    if (loading && !state) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
          ⏳ Verbinde mit Volumio...
        </div>
      );
    }

    if (error) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
          <span style={{ fontSize: 28 }}>⚠️</span>
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>Keine Verbindung</span>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>{settings.ip}</span>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--error-color, #ef4444)' }}>{error}</span>
        </div>
      );
    }

    if (!state || (!state.title && !state.artist)) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-tertiary)' }}>
          <span style={{ fontSize: 32 }}>⏹</span>
          <span style={{ fontSize: 'var(--font-size-sm)' }}>Nichts wird gespielt</span>
        </div>
      );
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'row', height: '100%', gap: 24, alignItems: 'center' }}>
        {/* Cover Art – quadratisch, so hoch wie das Widget */}
        <div style={{ flexShrink: 0, height: '100%', aspectRatio: '1 / 1' }}>
          {coverUrl && !coverError ? (
            <img
              src={coverUrl}
              alt="Album Cover"
              onError={() => setCoverError(true)}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                borderRadius: 'var(--radius-md, 8px)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                display: 'block',
              }}
            />
          ) : (
            <div style={{
              width: '100%',
              height: '100%',
              borderRadius: 'var(--radius-md, 8px)',
              background: 'var(--bg-secondary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 48,
            }}>
              🎵
            </div>
          )}
        </div>

        {/* Track Info */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4 }}>
          <div style={{
            fontSize: 'var(--font-size-3xl)',
            fontWeight: 'var(--font-weight-bold)',
            color: 'var(--text-primary)',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            lineHeight: 1.2,
          }}>
            {state.title || '–'}
          </div>
          <div style={{
            fontSize: 'var(--font-size-xl)',
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {state.artist || '–'}
          </div>
          {state.album && (
            <div style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--text-tertiary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {state.album}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      {renderContent()}

      <WidgetSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Einstellungen: Volumio"
      >
        <div className="settings-section">
          <div className="settings-section-title">Verbindung</div>
          <div className="settings-field">
            <label className="settings-label">IP-Adresse</label>
            <input
              className="settings-input"
              type="text"
              value={settings.ip}
              onChange={(e) => updateSettings(instanceId, { ip: e.target.value })}
              placeholder="z.B. 192.168.1.100"
            />
            <p className="settings-description" style={{ marginTop: 4 }}>
              Interne IP-Adresse deines Volumio-Geräts im lokalen Netzwerk.
            </p>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Aktualisierung</div>
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

        <div className="settings-info-box">
          💡 Volumio muss im gleichen Netzwerk erreichbar sein. Die IP findest du unter
          Volumio → Einstellungen → Netzwerk.
        </div>
      </WidgetSettingsDialog>
    </>
  );
};

export const volumioWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'volumio',
    name: 'Volumio',
    description: 'Aktuell spielender Titel von Volumio',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 2,
    minHeight: 3,
    defaultWidth: 3,
    defaultHeight: 4,
    permissions: ['network'],
    refreshInterval: 5,
    hasSettings: true,
  },
  component: VolumioComponent,
};
