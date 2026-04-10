/**
 * Sleeper Widget – Presence detection via camera.
 * Runs face detection silently in the background.
 * After a configurable timeout of no presence, the display sleeps.
 * Any face detection or user interaction wakes it back up.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import * as faceapi from 'face-api.js';
import { invoke } from '@tauri-apps/api/core';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

// ─── Types ────────────────────────────────────────────────────────────────────

type SleeperState = 'idle' | 'watching' | 'sleeping' | 'error';

interface SleeperSettings {
  autoStart: boolean;
  timeoutMinutes: number;
  scoreThreshold: number;
  inputSize: number;
  deviceId: string;
}

const DEFAULT: SleeperSettings = {
  autoStart: false,
  timeoutMinutes: 180,
  scoreThreshold: 0.4,
  inputSize: 160,
  deviceId: '',
};

// ─── Sleep Overlay ────────────────────────────────────────────────────────────

interface SleepOverlayProps {
  onWake: () => void;
}

const SleepOverlay: React.FC<SleepOverlayProps> = ({ onWake }) => {
  const overlay = (
    <div
      className="sleeper-overlay"
      onClick={onWake}
      onKeyDown={onWake}
      role="button"
      tabIndex={0}
      aria-label="Zum Aufwecken klicken"
    >
      <div className="sleeper-overlay-hint">Tippen zum Aufwecken</div>
    </div>
  );
  return createPortal(overlay, document.body);
};

// ─── Component ────────────────────────────────────────────────────────────────

const SleeperComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const videoRef      = useRef<HTMLVideoElement>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const loopRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timerRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const detectingRef  = useRef(false);
  const lastSeenRef   = useRef<number>(Date.now());

  const [state, setState]             = useState<SleeperState>('idle');
  const [modelsReady, setModelsReady] = useState(false);
  const [errorMsg, setErrorMsg]       = useState('');
  const [faceCount, setFaceCount]     = useState(0);
  const [timeUntilSleep, setTimeUntilSleep] = useState(0); // seconds
  const [settingsOpen, setSettingsOpen]     = useState(false);

  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const s = getSettings<SleeperSettings>(instanceId, DEFAULT);

  // ─── Settings event ──────────────────────────────────────────────────────
  useEffect(() => {
    const h = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, h);
    return () => eventBus.off(`widget:openSettings:${instanceId}`, h);
  }, [instanceId]);

  // ─── Load models ─────────────────────────────────────────────────────────
  useEffect(() => {
    faceapi.nets.tinyFaceDetector.loadFromUri('/models')
      .then(() => setModelsReady(true))
      .catch(() => setErrorMsg('Face-Detection-Modelle konnten nicht geladen werden (/public/models/).'));
  }, []);

  // ─── Stop watching ───────────────────────────────────────────────────────
  const stopWatching = useCallback(() => {
    detectingRef.current = false;
    if (loopRef.current)  { clearTimeout(loopRef.current);  loopRef.current  = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setFaceCount(0);
    setTimeUntilSleep(0);
    setState('idle');
  }, []);

  // ─── Wake up ─────────────────────────────────────────────────────────────
  const wakeUp = useCallback(async () => {
    if (state !== 'sleeping') return;
    lastSeenRef.current = Date.now();
    setState('watching');
    try { await invoke('wake_display'); } catch { /* ignore if not available */ }
  }, [state]);

  // ─── Detection loop (~3 fps is enough for presence) ──────────────────────
  const runDetection = useCallback(async () => {
    const video = videoRef.current;
    if (!detectingRef.current || !video) return;
    if (video.readyState < 2 || video.videoWidth === 0) {
      loopRef.current = setTimeout(runDetection, 300);
      return;
    }

    try {
      const detections = await faceapi.detectAllFaces(
        video,
        new faceapi.TinyFaceDetectorOptions({
          inputSize:      s.inputSize as 128 | 160 | 224 | 320,
          scoreThreshold: s.scoreThreshold,
        })
      );
      const count = detections.length;
      setFaceCount(count);

      if (count > 0) {
        lastSeenRef.current = Date.now();
        // Wake display if sleeping
        setState(prev => {
          if (prev === 'sleeping') {
            invoke('wake_display').catch(() => {});
            return 'watching';
          }
          return prev;
        });
      }
    } catch { /* ignore */ }

    if (detectingRef.current) loopRef.current = setTimeout(runDetection, 333);
  }, [s.inputSize, s.scoreThreshold]);

  // ─── Start watching ──────────────────────────────────────────────────────
  const startWatching = useCallback(async () => {
    if (state === 'watching' || !modelsReady) return;
    setErrorMsg('');
    lastSeenRef.current = Date.now();

    const constraints: MediaStreamConstraints = {
      video: {
        width:  { ideal: 320 },
        height: { ideal: 240 },
        ...(s.deviceId ? { deviceId: { exact: s.deviceId } } : { facingMode: 'user' }),
      },
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current  = stream;
      const video        = videoRef.current!;
      video.srcObject    = stream;
      await video.play();

      detectingRef.current = true;
      setState('watching');
      runDetection();

      // Sleep check every 30 seconds
      const timeoutMs = s.timeoutMinutes * 60 * 1000;
      timerRef.current = setInterval(async () => {
        const elapsed = Date.now() - lastSeenRef.current;
        const remaining = Math.max(0, timeoutMs - elapsed);
        setTimeUntilSleep(Math.round(remaining / 1000));

        if (elapsed >= timeoutMs) {
          setState(prev => {
            if (prev === 'watching') {
              invoke('sleep_display').catch(() => {});
              return 'sleeping';
            }
            return prev;
          });
        }
      }, 30_000);

      // Also update countdown every minute
      setTimeUntilSleep(timeoutMs / 1000);
    } catch (err: unknown) {
      const e = err as DOMException;
      setErrorMsg(
        e?.name === 'NotAllowedError'  ? 'Kamera-Zugriff verweigert.' :
        e?.name === 'NotFoundError'    ? 'Keine Kamera gefunden.' :
        `Kamera-Fehler: ${e?.message ?? 'Unbekannt'}`
      );
      setState('error');
    }
  }, [state, modelsReady, s.deviceId, s.timeoutMinutes, runDetection]);

  // ─── Re-start detection loop when settings change ────────────────────────
  useEffect(() => {
    if (state !== 'watching') return;
    if (loopRef.current) clearTimeout(loopRef.current);
    runDetection();
    return () => { if (loopRef.current) clearTimeout(loopRef.current); };
  }, [state, runDetection]);

  // ─── Auto-start ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (s.autoStart && state === 'idle' && modelsReady) startWatching();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.autoStart, modelsReady]);

  // ─── Cleanup on unmount ──────────────────────────────────────────────────
  useEffect(() => () => stopWatching(), [stopWatching]);

  // ─── Countdown display ───────────────────────────────────────────────────
  const formatCountdown = (seconds: number): string => {
    if (seconds <= 0) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  const dotColor =
    state === 'watching' ? (faceCount > 0 ? '#22c55e' : '#f59e0b') :
    state === 'sleeping' ? '#6366f1' :
    state === 'error'    ? '#ef4444' :
    'var(--text-tertiary)';

  const stateLabel =
    state === 'idle'     ? 'Gestoppt' :
    state === 'watching' ? (faceCount > 0 ? `${faceCount} Person${faceCount > 1 ? 'en' : ''} erkannt` : 'Kein Gesicht') :
    state === 'sleeping' ? 'Display schläft' :
    `Fehler: ${errorMsg}`;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* Hidden video element – never shown to user */}
      <video ref={videoRef} muted playsInline style={{ display: 'none' }} />

      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10 }}>

        {/* Status row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`sleeper-dot${state === 'watching' && faceCount > 0 ? ' sleeper-dot-pulse' : ''}`}
            style={{ background: dotColor }} />
          <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}>
            {stateLabel}
          </span>
        </div>

        {/* Presence icon */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <span style={{ fontSize: 40, lineHeight: 1, filter: state === 'sleeping' ? 'grayscale(1) opacity(0.4)' : 'none' }}>
            {state === 'sleeping' ? '😴' : state === 'watching' && faceCount > 0 ? '👤' : state === 'watching' ? '👁' : '💤'}
          </span>
          {state === 'watching' && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              Schlaf in {formatCountdown(timeUntilSleep)}
            </span>
          )}
          {state === 'sleeping' && (
            <span style={{ fontSize: 11, color: '#6366f1' }}>
              Gesicht → aufwecken
            </span>
          )}
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', gap: 6 }}>
          {state === 'idle' || state === 'error' ? (
            <button
              onClick={startWatching}
              disabled={!modelsReady}
              style={{
                flex: 1, background: modelsReady ? 'var(--accent-color)' : 'var(--bg-secondary)',
                border: 'none', color: modelsReady ? '#fff' : 'var(--text-tertiary)',
                borderRadius: 6, padding: '5px 0', fontSize: 11, cursor: modelsReady ? 'pointer' : 'not-allowed', fontWeight: 600,
              }}
            >
              {modelsReady ? '▶ Starten' : '⏳ Laden…'}
            </button>
          ) : state === 'sleeping' ? (
            <button
              onClick={wakeUp}
              style={{
                flex: 1, background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)',
                color: '#818cf8', borderRadius: 6, padding: '5px 0', fontSize: 11, cursor: 'pointer', fontWeight: 600,
              }}
            >
              ☀ Aufwecken
            </button>
          ) : (
            <button
              onClick={stopWatching}
              style={{
                flex: 1, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                color: '#ef4444', borderRadius: 6, padding: '5px 0', fontSize: 11, cursor: 'pointer', fontWeight: 600,
              }}
            >
              ⏹ Stoppen
            </button>
          )}
        </div>

        {/* Models status */}
        {!modelsReady && (
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'center' }}>
            Face-Detection-Modelle werden geladen…
          </div>
        )}
      </div>

      {/* Sleep overlay */}
      {state === 'sleeping' && <SleepOverlay onWake={wakeUp} />}

      {/* Settings */}
      <WidgetSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Einstellungen: Sleeper">

        {/* Status */}
        <div className="settings-section">
          <div className="settings-section-title">Status</div>
          <div className="settings-field" style={{ display: 'flex', gap: 8 }}>
            {state === 'watching' || state === 'sleeping' ? (
              <button className="settings-btn settings-btn-danger" onClick={stopWatching}>⏹ Stoppen</button>
            ) : (
              <button className="settings-btn settings-btn-primary" onClick={startWatching} disabled={!modelsReady}>
                {modelsReady ? '▶ Starten' : '⏳ Laden…'}
              </button>
            )}
          </div>
        </div>

        {/* Timeout */}
        <div className="settings-section">
          <div className="settings-section-title">Schlaf-Timeout</div>
          <div className="settings-field">
            <label className="settings-label">
              Keine Präsenz seit
              <span className="settings-range-value">{s.timeoutMinutes} Min</span>
            </label>
            <p className="settings-description">Nach dieser Zeit ohne erkanntes Gesicht schläft der Display ein.</p>
            <input type="range" className="settings-range"
              min="1" max="360" step="1" value={s.timeoutMinutes}
              onChange={e => updateSettings(instanceId, { timeoutMinutes: parseInt(e.target.value) })} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>
              <span>1 Min</span><span>1h</span><span>3h</span><span>6h</span>
            </div>
          </div>
        </div>

        {/* Detection */}
        <div className="settings-section">
          <div className="settings-section-title">Gesichtserkennung</div>
          <div className="settings-field">
            <label className="settings-label">
              Erkennungsschwelle
              <span className="settings-range-value">{Math.round(s.scoreThreshold * 100)}%</span>
            </label>
            <input type="range" className="settings-range"
              min="0.1" max="0.9" step="0.05" value={s.scoreThreshold}
              onChange={e => updateSettings(instanceId, { scoreThreshold: parseFloat(e.target.value) })} />
          </div>
          <div className="settings-field">
            <label className="settings-label">Modell-Auflösung</label>
            <select className="settings-select" value={s.inputSize}
              onChange={e => updateSettings(instanceId, { inputSize: parseInt(e.target.value) })}>
              <option value="128">128px – Schnellst (weniger CPU)</option>
              <option value="160">160px – Schnell</option>
              <option value="224">224px – Standard</option>
              <option value="320">320px – Genau (mehr CPU)</option>
            </select>
          </div>
        </div>

        {/* Behaviour */}
        <div className="settings-section">
          <div className="settings-section-title">Verhalten</div>
          <div className="settings-field">
            <div className="settings-toggle">
              <div>
                <div className="settings-toggle-label">Auto-Start</div>
                <div className="settings-toggle-sublabel">Presence-Erkennung beim App-Start aktivieren</div>
              </div>
              <label className="toggle-switch">
                <input type="checkbox" checked={s.autoStart}
                  onChange={e => updateSettings(instanceId, { autoStart: e.target.checked })} />
                <span className="toggle-switch-slider" />
              </label>
            </div>
          </div>
        </div>

        <div className="settings-info-box">
          🔒 Gesichtserkennung läuft lokal – keine Daten verlassen das Gerät. Der Kamerastream wird nicht angezeigt.
        </div>
      </WidgetSettingsDialog>
    </>
  );
};

// ─── Widget Definition ────────────────────────────────────────────────────────

export const sleeperWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'sleeper',
    name: 'Sleeper',
    description: 'Display-Schlafmodus bei fehlender Präsenz',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 2,
    minHeight: 2,
    defaultWidth: 2,
    defaultHeight: 3,
    permissions: ['camera'],
    hasSettings: true,
  },
  component: SleeperComponent,
};
