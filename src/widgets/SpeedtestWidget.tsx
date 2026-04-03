/**
 * Speedtest Widget – Misst alle 5 Minuten Download- und Upload-Geschwindigkeit.
 * Erkennt automatisch ob LAN oder WLAN verwendet wird.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

interface SpeedResult {
  download_mbps: number;
  upload_mbps: number;
  interface: string;
  interface_type: string;
  timestamp: number;
}

interface SpeedtestSettings {
  intervalMinutes: number;
}

const DEFAULT_SETTINGS: SpeedtestSettings = { intervalMinutes: 30 };

const INTERVAL_OPTIONS = [
  { value: 1,  label: '1 Minute' },
  { value: 5,  label: '5 Minuten' },
  { value: 10, label: '10 Minuten' },
  { value: 30, label: '30 Minuten' },
];

// Max-Wert für Balkenanzeige
const MAX_MBPS = 1000;

function speedColor(mbps: number): string {
  if (mbps >= 100) return '#22c55e'; // grün
  if (mbps >= 25)  return '#f59e0b'; // gelb
  return '#ef4444';                  // rot
}

function SpeedBar({ mbps, label }: { mbps: number; label: string }) {
  const pct = Math.min(mbps / MAX_MBPS, 1) * 100;
  const color = speedColor(mbps);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>{label}</span>
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color }}>
          {mbps.toFixed(1)} <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 400, color: 'var(--text-tertiary)' }}>Mbit/s</span>
        </span>
      </div>
      <div style={{
        height: 10,
        background: 'var(--bg-tertiary)',
        borderRadius: 5,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${pct}%`,
          background: color,
          borderRadius: 5,
          transition: 'width 0.8s ease',
        }} />
      </div>
    </div>
  );
}

function Sparkline({ history, key: _ }: { history: SpeedResult[] }) {
  if (history.length < 2) return null;
  const w = 200, h = 32, pad = 2;
  const maxDl = Math.max(...history.map(r => r.download_mbps), 1);
  const points = history.map((r, i) => {
    const x = pad + (i / (history.length - 1)) * (w - pad * 2);
    const y = h - pad - (r.download_mbps / maxDl) * (h - pad * 2);
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} style={{ opacity: 0.6 }}>
      <polyline points={points} fill="none" stroke="var(--accent-color)" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

const SpeedtestComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const [running, setRunning]       = useState(false);
  const [latest, setLatest]         = useState<SpeedResult | null>(null);
  const [history, setHistory]       = useState<SpeedResult[]>([]);
  const [error, setError]           = useState<string | null>(null);
  const [countdown, setCountdown]   = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const settings = getSettings<SpeedtestSettings>(instanceId, DEFAULT_SETTINGS);

  useEffect(() => {
    const h = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, h);
    return () => { eventBus.off(`widget:openSettings:${instanceId}`, h); };
  }, [instanceId]);

  const runTest = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await invoke<SpeedResult>('run_speed_test');
      setLatest(result);
      setHistory(prev => [...prev.slice(-11), result]); // max 12 Einträge
    } catch (e) {
      setError(e as string);
    } finally {
      setRunning(false);
    }
  }, []);

  // Interval + Countdown
  useEffect(() => {
    const intervalSec = settings.intervalMinutes * 60;

    // Erster Test sofort
    runTest();
    setCountdown(intervalSec);

    timerRef.current = setInterval(() => {
      runTest();
      setCountdown(intervalSec);
    }, intervalSec * 1000);

    countRef.current = setInterval(() => {
      setCountdown(prev => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countRef.current) clearInterval(countRef.current);
    };
  }, [runTest, settings.intervalMinutes]);

  const formatCountdown = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}:${s.toString().padStart(2, '0')} min` : `${s}s`;
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>

        {/* Header: Interface-Badge + Uhrzeit */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {latest ? (
            <span style={{
              fontSize: 'var(--font-size-xs)',
              background: latest.interface_type === 'WLAN' ? 'rgba(99,102,241,0.15)' : 'rgba(34,197,94,0.15)',
              color: latest.interface_type === 'WLAN' ? '#818cf8' : '#22c55e',
              borderRadius: 4,
              padding: '2px 8px',
              fontWeight: 600,
            }}>
              {latest.interface_type} · {latest.interface}
            </span>
          ) : <span />}
          {latest && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
              {formatTime(latest.timestamp)}
            </span>
          )}
        </div>

        {/* Messung läuft */}
        {running && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, color: 'var(--text-tertiary)' }}>
            <span style={{ fontSize: 20, animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>⟳</span>
            <span style={{ fontSize: 'var(--font-size-sm)' }}>Messe Geschwindigkeit…</span>
          </div>
        )}

        {/* Fehler */}
        {!running && error && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 6 }}>
            <span style={{ fontSize: 24 }}>⚠️</span>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--error-color, #ef4444)', textAlign: 'center' }}>{error}</span>
          </div>
        )}

        {/* Ergebnis */}
        {!running && latest && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <SpeedBar mbps={latest.download_mbps} label="↓ Download" />
            <SpeedBar mbps={latest.upload_mbps}   label="↑ Upload" />
          </div>
        )}

        {/* Sparkline Verlauf */}
        {history.length >= 2 && !running && (
          <div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', marginBottom: 2 }}>
              Download-Verlauf
            </div>
            <Sparkline history={history} />
          </div>
        )}

        {/* Footer: Countdown */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: 6 }}>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
            {running ? 'Läuft…' : `Nächster Test in ${formatCountdown(countdown)}`}
          </span>
          <button
            onClick={runTest}
            disabled={running}
            style={{
              background: 'none',
              border: 'none',
              cursor: running ? 'default' : 'pointer',
              fontSize: 'var(--font-size-xs)',
              color: running ? 'var(--text-tertiary)' : 'var(--accent-color)',
              padding: 0,
            }}
          >
            {running ? '' : 'Jetzt messen'}
          </button>
        </div>
      </div>

      <WidgetSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Einstellungen: Speedtest"
      >
        <div className="settings-section">
          <div className="settings-section-title">Messintervall</div>
          <div className="settings-field">
            <label className="settings-label">Alle</label>
            <select
              className="settings-select"
              value={settings.intervalMinutes}
              onChange={(e) => updateSettings(instanceId, { intervalMinutes: parseInt(e.target.value) })}
            >
              {INTERVAL_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="settings-info-box">
          💡 Jede Messung lädt ~15 MB Daten. Bei 5-Minuten-Intervall sind das ca. 4 GB/Tag.
          Für Kiosk-Betrieb empfehlen sich 30 Minuten.
        </div>
      </WidgetSettingsDialog>
    </>
  );
};

export const speedtestWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'speedtest',
    name: 'Speedtest',
    description: 'LAN/WLAN Download- & Upload-Geschwindigkeit',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 3,
    minHeight: 3,
    defaultWidth: 4,
    defaultHeight: 4,
    permissions: ['network'],
    hasSettings: true,
  },
  component: SpeedtestComponent,
};
