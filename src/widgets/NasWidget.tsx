/**
 * NAS Widget – Testet die Verbindung zum NAS (Ping/RTT).
 * Konfigurierbar: IP-Adresse, Messintervall.
 * Zeigt Latenz als Halbkreis-Gauge + Verlauf.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

interface NasResult {
  reachable: boolean;
  latency_ms: number;
  packet_loss_pct: number;
  timestamp: number;
}

interface NasSettings {
  ip: string;
  intervalMinutes: number;
}

const DEFAULT_SETTINGS: NasSettings = { ip: '', intervalMinutes: 60 };

const STORAGE_KEY_NAS         = 'slatedesk:nas:last';
const STORAGE_KEY_NAS_HISTORY = 'slatedesk:nas:history';
const HISTORY_WINDOW_MS       = 12 * 60 * 60 * 1000; // 12 Stunden

function pruneNasHistory(history: NasResult[]): NasResult[] {
  const cutoff = (Date.now() - HISTORY_WINDOW_MS) / 1000;
  return history.filter(r => r.timestamp >= cutoff);
}

const MAX_RETRIES   = 10;
const RETRY_DELAY_S = 15; // Sekunden zwischen Retry-Versuchen

const INTERVAL_OPTIONS = [
  { value: 5,  label: '5 Minuten' },
  { value: 10, label: '10 Minuten' },
  { value: 30, label: '30 Minuten' },
  { value: 60, label: '60 Minuten' },
];

function latencyColor(ms: number, maxMs: number, reachable: boolean): string {
  if (!reachable) return '#ef4444';
  const ratio = ms / maxMs;
  if (ratio <= 0.35) return '#22c55e';
  if (ratio <= 0.70) return '#f59e0b';
  return '#ef4444';
}

// Halbkreis-Gauge (identisches Konzept wie SpeedtestWidget)
function LatencyGauge({ ms, maxMs, reachable, size }: { ms: number; maxMs: number; reachable: boolean; size: number }) {
  const r           = size * 0.38;
  const cx          = size / 2;
  const cy          = size * 0.54;
  const circumference = Math.PI * r;
  const pct         = reachable ? Math.min(ms / maxMs, 1) : 1;
  const color       = latencyColor(ms, maxMs, reachable);
  const trackColor  = 'var(--bg-tertiary, #2a2a35)';
  const fontSize    = Math.max(size * 0.20, 12);
  const unitSize    = Math.max(size * 0.08, 8);
  const strokeWidth = Math.max(size * 0.07, 5);
  const startX = cx - r, endX = cx + r;

  return (
    <svg width={size} height={cy + strokeWidth / 2 + 2} viewBox={`0 0 ${size} ${cy + strokeWidth / 2 + 2}`}>
      {/* Track */}
      <path
        d={`M ${startX} ${cy} A ${r} ${r} 0 0 1 ${endX} ${cy}`}
        fill="none" stroke={trackColor} strokeWidth={strokeWidth} strokeLinecap="round"
      />
      {/* Farbiger Bogen */}
      <path
        d={`M ${startX} ${cy} A ${r} ${r} 0 0 1 ${endX} ${cy}`}
        fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - pct)}
        style={{ transition: 'stroke-dashoffset 1s ease, stroke 0.5s ease' }}
      />
      {/* Hauptwert */}
      <text
        x={cx} y={cy - r * 0.18}
        textAnchor="middle" fill={color} fontSize={fontSize} fontWeight="700"
        fontFamily="var(--font-family)"
        style={{ transition: 'fill 0.5s ease' }}
      >
        {reachable ? ms.toFixed(1) : '—'}
      </text>
      {/* Einheit */}
      <text
        x={cx} y={cy - r * 0.18 + unitSize + 2}
        textAnchor="middle" fill="var(--text-tertiary)" fontSize={unitSize}
        fontFamily="var(--font-family)"
      >
        ms
      </text>
    </svg>
  );
}

// Gefüllte Sparkline für Latenz-Verlauf – X-Achse = echte 12h-Zeitachse
function LatencySparkline({ history, width }: { history: NasResult[]; width: number }) {
  const reachable = history.filter(r => r.reachable);
  if (reachable.length < 2) return null;
  const h = 36, pad = 2;
  const maxMs = Math.max(...reachable.map(r => r.latency_ms), 1);
  const now = Date.now() / 1000;
  const windowSec = 12 * 60 * 60;
  const earliest = now - windowSec;
  const pts = history.map(r => ({
    x: pad + (Math.max(r.timestamp - earliest, 0) / windowSec) * (width - pad * 2),
    y: r.reachable
      ? h - pad - (r.latency_ms / maxMs) * (h - pad * 2 - 4)
      : h - pad,
  }));
  const line = pts.map(p => `${p.x},${p.y}`).join(' ');
  const area = `${pts[0].x},${h} ` + line + ` ${pts[pts.length - 1].x},${h}`;

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${width} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="nasSparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent-color)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--accent-color)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#nasSparkGrad)" />
      <polyline points={line} fill="none" stroke="var(--accent-color)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

const NasComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const [running, setRunning]             = useState(false);
  const [latest, setLatest]               = useState<NasResult | null>(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY_NAS) || 'null'); } catch { return null; }
  });
  const [history, setHistory]             = useState<NasResult[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_NAS_HISTORY) || '[]');
      return pruneNasHistory(stored);
    } catch { return []; }
  });
  const [error, setError]                 = useState<string | null>(null);
  const [countdown, setCountdown]         = useState(0);
  const [settingsOpen, setSettingsOpen]   = useState(false);
  const [containerSize, setContainerSize] = useState({ w: 320, h: 220 });
  const [retryCount, setRetryCount]       = useState(0);
  const [offlineBanner, setOfflineBanner] = useState(false);
  const containerRef  = useRef<HTMLDivElement>(null);
  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const countRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const settings = getSettings<NasSettings>(instanceId, DEFAULT_SETTINGS);

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      const { width: w, height: h } = entries[0].contentRect;
      setContainerSize({ w, h });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const h = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, h);
    return () => { eventBus.off(`widget:openSettings:${instanceId}`, h); };
  }, [instanceId]);

  const runTest = useCallback(async (isRetry = false) => {
    if (!settings.ip.trim()) { setError('Bitte IP-Adresse in Einstellungen eintragen'); return; }
    setRunning(true);
    if (!isRetry) setError(null);
    try {
      const result = await invoke<NasResult>('test_nas_connection', { ip: settings.ip.trim() });
      setLatest(result);
      setHistory(prev => {
        const updated = pruneNasHistory([...prev, result]);
        localStorage.setItem(STORAGE_KEY_NAS_HISTORY, JSON.stringify(updated));
        return updated;
      });
      localStorage.setItem(STORAGE_KEY_NAS, JSON.stringify(result));

      if (result.reachable) {
        // NAS wieder erreichbar – alles zurücksetzen
        setRetryCount(0);
        setOfflineBanner(false);
        if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      } else {
        // NAS nicht erreichbar – Retry planen
        setRetryCount(prev => {
          const next = prev + 1;
          if (next >= MAX_RETRIES) {
            setOfflineBanner(true);
          } else {
            retryTimerRef.current = setTimeout(() => runTest(true), RETRY_DELAY_S * 1000);
          }
          return next;
        });
      }
    } catch (e) {
      setError(e as string);
    } finally {
      setRunning(false);
    }
  }, [settings.ip]);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (countRef.current) clearInterval(countRef.current);
    const intervalSec = settings.intervalMinutes * 60;
    runTest();
    setCountdown(intervalSec);
    timerRef.current = setInterval(() => { runTest(); setCountdown(intervalSec); }, intervalSec * 1000);
    countRef.current = setInterval(() => setCountdown(prev => prev > 0 ? prev - 1 : 0), 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countRef.current) clearInterval(countRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [runTest, settings.intervalMinutes]);

  const gaugeSize = Math.round(Math.min(containerSize.w * 0.55, containerSize.h * 0.62));

  // Dynamische Skala: schlechtester (höchster) Ping aus History, mindestens 2 ms
  const maxMs = Math.max(
    ...history.filter(r => r.reachable).map(r => r.latency_ms),
    latest?.reachable ? latest.latency_ms : 0,
    2,
  );

  const formatCountdown = (sec: number) => {
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `${s}s`;
  };

  const formatTime = (ts: number) =>
    new Date(ts * 1000).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

  return (
    <>
      <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6 }}>

        {/* Offline-Banner */}
        {offlineBanner && (
          <div style={{
            background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.4)',
            borderRadius: 6, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 18 }}>🔴</span>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#ef4444' }}>NAS nicht erreichbar!</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>
                {settings.ip} · {MAX_RETRIES} Versuche fehlgeschlagen
              </div>
            </div>
          </div>
        )}

        {/* Retry-Hinweis */}
        {!offlineBanner && retryCount > 0 && retryCount < MAX_RETRIES && (
          <div style={{
            background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)',
            borderRadius: 6, padding: '6px 10px', fontSize: 11, color: '#f59e0b',
          }}>
            ⚠️ Kein Ping – Versuch {retryCount}/{MAX_RETRIES}, nächster in {RETRY_DELAY_S}s…
          </div>
        )}

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {latest !== null ? (
            <span style={{
              fontSize: 11, fontWeight: 600, borderRadius: 4, padding: '2px 8px',
              background: latest.reachable ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
              color: latest.reachable ? '#22c55e' : '#ef4444',
            }}>
              {latest.reachable ? '● Online' : '● Offline'}
              {latest.reachable && latest.packet_loss_pct > 0 && ` · ${latest.packet_loss_pct}% Verlust`}
            </span>
          ) : <span />}
          {settings.ip && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{settings.ip}</span>
          )}
          {latest && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{formatTime(latest.timestamp)}</span>
          )}
        </div>

        {/* Gauge */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 4 }}>
          {!settings.ip.trim() ? (
            <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>
              ⚙️ NAS-IP in Einstellungen eintragen
            </div>
          ) : running ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--text-tertiary)' }}>
              <span style={{ fontSize: 28, animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>⟳</span>
              <span style={{ fontSize: 12 }}>Messe…</span>
            </div>
          ) : error ? (
            <div style={{ textAlign: 'center', color: 'var(--error-color, #ef4444)', fontSize: 12 }}>⚠️ {error}</div>
          ) : latest !== null ? (
            <>
              <LatencyGauge ms={latest.latency_ms} maxMs={maxMs} reachable={latest.reachable} size={gaugeSize} />
              <span style={{ fontSize: Math.max(gaugeSize * 0.09, 9), color: 'var(--text-tertiary)', letterSpacing: 0.5 }}>
                PING · ROUND TRIP
              </span>
            </>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Bereit…</span>
          )}
        </div>

        {/* Sparkline */}
        {history.length >= 2 && !running && (
          <div style={{ paddingTop: 2 }}>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Latenz-Verlauf
            </div>
            <LatencySparkline history={history} width={containerSize.w - 16} />
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-color)', paddingTop: 5 }}>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {running ? 'Messe…' : `Nächster Test: ${formatCountdown(countdown)}`}
          </span>
          {!running && settings.ip && (
            <button onClick={() => runTest()} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--accent-color)', padding: 0 }}>
              Jetzt messen
            </button>
          )}
        </div>
      </div>

      <WidgetSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Einstellungen: NAS-Verbindung">
        <div className="settings-section">
          <div className="settings-section-title">NAS-Adresse</div>
          <div className="settings-field">
            <label className="settings-label">IP-Adresse</label>
            <input
              className="settings-input"
              type="text"
              placeholder="z.B. 192.168.1.100"
              value={settings.ip}
              onChange={(e) => updateSettings(instanceId, { ip: e.target.value })}
            />
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-section-title">Messintervall</div>
          <div className="settings-field">
            <label className="settings-label">Alle</label>
            <select
              className="settings-select"
              value={settings.intervalMinutes}
              onChange={(e) => updateSettings(instanceId, { intervalMinutes: parseInt(e.target.value) })}
            >
              {INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div className="settings-info-box">
          💡 Pingt das NAS 4× und zeigt die durchschnittliche Antwortzeit (RTT).
        </div>
      </WidgetSettingsDialog>
    </>
  );
};

export const nasWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'nas',
    name: 'NAS-Verbindung',
    description: 'Ping-Latenz zum lokalen NAS',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 2,
    minHeight: 3,
    defaultWidth: 3,
    defaultHeight: 4,
    permissions: ['network'],
    hasSettings: true,
  },
  component: NasComponent,
};
