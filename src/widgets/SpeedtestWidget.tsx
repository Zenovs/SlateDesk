/**
 * Speedtest Widget – Elegante Halbkreis-Gauges für Download & Upload.
 * Passt sich an die Widget-Grösse an.
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

const MAX_MBPS = 1000;

function speedColor(mbps: number): string {
  if (mbps >= 100) return '#22c55e';
  if (mbps >= 25)  return '#f59e0b';
  return '#ef4444';
}

// SVG Halbkreis-Gauge (180°, oben)
function Gauge({ mbps, label, size }: { mbps: number; label: string; size: number }) {
  const r = size * 0.38;
  const cx = size / 2;
  const cy = size * 0.54;
  const circumference = Math.PI * r;
  const pct = Math.min(mbps / MAX_MBPS, 1);
  const color = speedColor(mbps);
  const trackColor = 'var(--bg-tertiary, #2a2a35)';
  const fontSize = Math.max(size * 0.18, 12);
  const labelSize = Math.max(size * 0.09, 9);
  const unitSize = Math.max(size * 0.08, 8);
  const strokeWidth = Math.max(size * 0.07, 5);

  // Halbkreis: links nach rechts (oben)
  const startX = cx - r;
  const startY = cy;
  const endX   = cx + r;
  const endY   = cy;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <svg width={size} height={cy + strokeWidth / 2 + 2} viewBox={`0 0 ${size} ${cy + strokeWidth / 2 + 2}`}>
        {/* Track */}
        <path
          d={`M ${startX} ${startY} A ${r} ${r} 0 0 1 ${endX} ${endY}`}
          fill="none"
          stroke={trackColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Farbiger Bogen */}
        <path
          d={`M ${startX} ${startY} A ${r} ${r} 0 0 1 ${endX} ${endY}`}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct)}
          style={{ transition: 'stroke-dashoffset 1s ease, stroke 0.5s ease' }}
        />
        {/* Wert */}
        <text
          x={cx}
          y={cy - r * 0.18}
          textAnchor="middle"
          fill={color}
          fontSize={fontSize}
          fontWeight="700"
          fontFamily="var(--font-family)"
          style={{ transition: 'fill 0.5s ease' }}
        >
          {mbps.toFixed(1)}
        </text>
        {/* Einheit */}
        <text
          x={cx}
          y={cy - r * 0.18 + unitSize + 2}
          textAnchor="middle"
          fill="var(--text-tertiary)"
          fontSize={unitSize}
          fontFamily="var(--font-family)"
        >
          Mbit/s
        </text>
      </svg>
      {/* Label */}
      <span style={{ fontSize: labelSize, color: 'var(--text-tertiary)', marginTop: 2, letterSpacing: 0.5 }}>
        {label}
      </span>
    </div>
  );
}

// Gefüllte Sparkline
function Sparkline({ history, width }: { history: SpeedResult[]; width: number }) {
  if (history.length < 2) return null;
  const h = 36, pad = 2;
  const maxDl = Math.max(...history.map(r => r.download_mbps), 1);
  const pts = history.map((r, i) => ({
    x: pad + (i / (history.length - 1)) * (width - pad * 2),
    y: h - pad - (r.download_mbps / maxDl) * (h - pad * 2 - 4),
  }));
  const line = pts.map(p => `${p.x},${p.y}`).join(' ');
  const area = `${pts[0].x},${h} ` + line + ` ${pts[pts.length - 1].x},${h}`;

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${width} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-color)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--accent-color)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#sparkGrad)" />
      <polyline points={line} fill="none" stroke="var(--accent-color)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

const SpeedtestComponent: React.FC<WidgetProps> = ({ instanceId, width, height }) => {
  const [running, setRunning]           = useState(false);
  const [latest, setLatest]             = useState<SpeedResult | null>(null);
  const [history, setHistory]           = useState<SpeedResult[]>([]);
  const [error, setError]               = useState<string | null>(null);
  const [countdown, setCountdown]       = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const settings = getSettings<SpeedtestSettings>(instanceId, DEFAULT_SETTINGS);

  // Gauge-Grösse aus Widget-Breite ableiten
  const gaugeSize = Math.min(Math.floor((width * 8 - 48) / 2), Math.floor(height * 32 * 0.55));

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
      setHistory(prev => [...prev.slice(-11), result]);
    } catch (e) {
      setError(e as string);
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    const intervalSec = settings.intervalMinutes * 60;
    runTest();
    setCountdown(intervalSec);
    timerRef.current = setInterval(() => { runTest(); setCountdown(intervalSec); }, intervalSec * 1000);
    countRef.current = setInterval(() => setCountdown(prev => prev > 0 ? prev - 1 : 0), 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countRef.current) clearInterval(countRef.current);
    };
  }, [runTest, settings.intervalMinutes]);

  const formatCountdown = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`;
  };

  const formatTime = (ts: number) =>
    new Date(ts * 1000).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6 }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {latest ? (
            <span style={{
              fontSize: 11, fontWeight: 600, borderRadius: 4, padding: '2px 8px',
              background: latest.interface_type === 'WLAN' ? 'rgba(99,102,241,0.15)' : 'rgba(34,197,94,0.12)',
              color: latest.interface_type === 'WLAN' ? '#818cf8' : '#22c55e',
            }}>
              {latest.interface_type} · {latest.interface}
            </span>
          ) : <span />}
          {latest && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{formatTime(latest.timestamp)}</span>}
        </div>

        {/* Gauges */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-around' }}>
          {running ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--text-tertiary)' }}>
              <span style={{ fontSize: 28, animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>⟳</span>
              <span style={{ fontSize: 12 }}>Messe…</span>
            </div>
          ) : error ? (
            <div style={{ textAlign: 'center', color: 'var(--error-color, #ef4444)', fontSize: 12 }}>⚠️ {error}</div>
          ) : latest ? (
            <>
              <Gauge mbps={latest.download_mbps} label="↓ DOWNLOAD" size={gaugeSize} />
              <Gauge mbps={latest.upload_mbps}   label="↑ UPLOAD"   size={gaugeSize} />
            </>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Bereit…</span>
          )}
        </div>

        {/* Sparkline */}
        {history.length >= 2 && !running && (
          <div style={{ paddingTop: 2 }}>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Download-Verlauf
            </div>
            <Sparkline history={history} width={width * 8 - 32} />
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {running ? 'Läuft…' : `Nächster Test: ${formatCountdown(countdown)}`}
          </span>
          {!running && (
            <button onClick={runTest} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--accent-color)', padding: 0 }}>
              Jetzt messen
            </button>
          )}
        </div>
      </div>

      <WidgetSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Einstellungen: Speedtest">
        <div className="settings-section">
          <div className="settings-section-title">Messintervall</div>
          <div className="settings-field">
            <label className="settings-label">Alle</label>
            <select className="settings-select" value={settings.intervalMinutes} onChange={(e) => updateSettings(instanceId, { intervalMinutes: parseInt(e.target.value) })}>
              {INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div className="settings-info-box">
          💡 Jede Messung lädt ~15 MB. Bei 30 Minuten ca. 720 MB/Tag.
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
    version: '2.0.0',
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
