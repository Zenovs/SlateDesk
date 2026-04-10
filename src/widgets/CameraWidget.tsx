/**
 * Camera Widget – Live-Kamerabild mit optionaler Gesichtserkennung.
 * Nutzt face-api.js (TinyFaceDetector), lokal, keine externen Server.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as faceapi from 'face-api.js';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

// ─── Typen ───────────────────────────────────────────────────────────────────

type Status = 'idle' | 'loading' | 'active' | 'error' | 'no_permission';

interface CameraSettings {
  deviceId: string;
  faceDetection: boolean;
  scoreThreshold: number;
  inputSize: number;
  autoStart: boolean;
  mirror: boolean;
}

const DEFAULT: CameraSettings = {
  deviceId: '',
  faceDetection: true,
  scoreThreshold: 0.5,
  inputSize: 224,
  autoStart: false,
  mirror: true,
};

// ─── Hilfsfunktion: Kameraliste ───────────────────────────────────────────────

async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(d => d.kind === 'videoinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Kamera ${i + 1}` }));
  } catch {
    return [];
  }
}

// ─── Komponente ───────────────────────────────────────────────────────────────

const CameraComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const videoRef     = useRef<HTMLVideoElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const loopRef      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectingRef = useRef(false); // Ref statt State – kein Closure-Bug
  const containerRef = useRef<HTMLDivElement>(null);

  const [status, setStatus]           = useState<Status>('idle');
  const [errorMsg, setErrorMsg]       = useState('');
  const [faceCount, setFaceCount]     = useState(0);
  const [modelsReady, setModelsReady] = useState(false);
  const [cameras, setCameras]         = useState<{ id: string; label: string }[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [containerW, setContainerW]   = useState(320);

  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const s = getSettings<CameraSettings>(instanceId, DEFAULT);

  // ─── Container-Breite beobachten ───────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(([e]) => setContainerW(e.contentRect.width));
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ─── Settings-Dialog öffnen ────────────────────────────────────────────────
  useEffect(() => {
    const h = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, h);
    return () => eventBus.off(`widget:openSettings:${instanceId}`, h);
  }, [instanceId]);

  // ─── Modelle laden ─────────────────────────────────────────────────────────
  useEffect(() => {
    faceapi.nets.tinyFaceDetector.loadFromUri('/models')
      .then(() => setModelsReady(true))
      .catch(() => setErrorMsg('Face-Detection-Modelle konnten nicht geladen werden (/public/models/).'));
  }, []);

  // ─── Kamera stoppen ────────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    detectingRef.current = false;
    if (loopRef.current) { clearTimeout(loopRef.current); loopRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d');
      ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    }
    setFaceCount(0);
    setStatus('idle');
  }, []);

  // ─── Detektions-Loop (~5 fps) ─────────────────────────────────────────────
  const runDetection = useCallback(async () => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!detectingRef.current || !video || !canvas) return;
    if (video.readyState < 2 || video.videoWidth === 0) {
      loopRef.current = setTimeout(runDetection, 200);
      return;
    }

    // Canvas-Pixel-Dimensionen = intrinsische Video-Auflösung
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width  = vw;
      canvas.height = vh;
    }

    try {
      const detections = await faceapi.detectAllFaces(
        video,
        new faceapi.TinyFaceDetectorOptions({
          inputSize:       s.inputSize as 128 | 160 | 224 | 320 | 416 | 608,
          scoreThreshold:  s.scoreThreshold,
        })
      );
      setFaceCount(detections.length);

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, vw, vh);
        detections.forEach(d => {
          const { x, y, width, height } = d.box;
          // Box spiegeln wenn Mirror aktiv (damit Box zum gespiegelten Video passt)
          const drawX = s.mirror ? vw - x - width : x;
          ctx.strokeStyle = '#ff6b35';
          ctx.lineWidth   = Math.max(2, vw / 200);
          ctx.strokeRect(drawX, y, width, height);

          // Score-Label
          ctx.fillStyle = '#ff6b35';
          ctx.font      = `bold ${Math.max(12, vw / 40)}px Lato, sans-serif`;
          const label   = `${Math.round(d.score * 100)}%`;
          const lx      = drawX;
          const ly      = y > 20 ? y - 6 : y + height + 16;
          ctx.fillText(label, lx, ly);
        });
      }
    } catch { /* ignorieren */ }

    if (detectingRef.current) loopRef.current = setTimeout(runDetection, 200);
  }, [s.inputSize, s.scoreThreshold, s.mirror]);

  // ─── Detection starten/stoppen je nach Settings ───────────────────────────
  useEffect(() => {
    if (status !== 'active') return;
    if (s.faceDetection && modelsReady) {
      detectingRef.current = true;
      runDetection();
    } else {
      detectingRef.current = false;
      if (loopRef.current) clearTimeout(loopRef.current);
      setFaceCount(0);
      const canvas = canvasRef.current;
      if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    }
    return () => {
      if (loopRef.current) clearTimeout(loopRef.current);
    };
  }, [status, s.faceDetection, modelsReady, runDetection]);

  // ─── Kamera starten ────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    if (status === 'active') return;
    setStatus('loading');
    setErrorMsg('');

    const constraints: MediaStreamConstraints = {
      video: {
        width:  { ideal: 1280 },
        height: { ideal: 720 },
        ...(s.deviceId ? { deviceId: { exact: s.deviceId } } : { facingMode: 'user' }),
      },
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      setStatus('active');

      // Kameraliste aktualisieren (Labels werden erst nach Permission sichtbar)
      const updated = await listCameras();
      setCameras(updated);

      // Aktive Kamera in Settings merken
      if (!s.deviceId) {
        const tid = stream.getVideoTracks()[0]?.getSettings().deviceId;
        if (tid) updateSettings(instanceId, { deviceId: tid });
      }
    } catch (err: unknown) {
      const e = err as DOMException;
      setStatus(e?.name === 'NotAllowedError' ? 'no_permission' : 'error');
      setErrorMsg(
        e?.name === 'NotAllowedError'  ? 'Kamera-Zugriff verweigert. Bitte in den System-Einstellungen erlauben.' :
        e?.name === 'NotFoundError'    ? 'Keine Kamera gefunden.' :
        e?.name === 'NotReadableError' ? 'Kamera wird von einer anderen App verwendet.' :
        e?.name === 'OverconstrainedError' ? 'Gewählte Kamera nicht verfügbar. Andere Kamera wählen.' :
        `Kamera-Fehler: ${e?.message ?? 'Unbekannt'}`
      );
    }
  }, [status, s.deviceId, instanceId, updateSettings]);

  // ─── Auto-Start ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (s.autoStart && status === 'idle') startCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.autoStart]);

  // ─── Kamera-Enumeration beim Mount ────────────────────────────────────────
  useEffect(() => {
    listCameras().then(setCameras);
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── UI Helpers ───────────────────────────────────────────────────────────
  const mirrorStyle = s.mirror ? 'scaleX(-1)' : 'none';
  const isActive    = status === 'active';
  const dotColor    =
    status === 'active'       ? (faceCount > 0 ? '#22c55e' : '#f59e0b') :
    status === 'error' || status === 'no_permission' ? '#ef4444' : 'var(--text-tertiary)';

  const statusText =
    status === 'idle'         ? 'Kamera aus' :
    status === 'loading'      ? 'Wird gestartet…' :
    status === 'no_permission'? 'Zugriff verweigert' :
    status === 'error'        ? 'Fehler' :
    s.faceDetection           ? (faceCount > 0 ? `${faceCount} Gesicht${faceCount > 1 ? 'er' : ''} erkannt ✓` : 'Kein Gesicht') :
                                'Kamera aktiv';

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6 }}>

        {/* Status-Bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 12, color: 'var(--text-primary)' }}>{statusText}</span>
          <button
            onClick={isActive ? stopCamera : startCamera}
            style={{
              background: isActive ? 'rgba(239,68,68,0.12)' : 'var(--accent-color)',
              border: isActive ? '1px solid rgba(239,68,68,0.4)' : 'none',
              color: isActive ? '#ef4444' : '#fff',
              borderRadius: 6, padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 600,
            }}
          >
            {isActive ? '⏹ Stop' : '▶ Start'}
          </button>
        </div>

        {/* Video-Container */}
        <div style={{ flex: 1, position: 'relative', borderRadius: 8, overflow: 'hidden', background: '#000', minHeight: 100 }}>
          {/* Placeholder */}
          {!isActive && status !== 'loading' && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16,
            }}>
              <span style={{ fontSize: 36 }}>
                {status === 'no_permission' ? '🔐' : status === 'error' ? '⚠️' : '📷'}
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' }}>
                {status === 'no_permission' || status === 'error' ? errorMsg : 'Kamera starten'}
              </span>
              {(status === 'error' || status === 'no_permission') && (
                <button onClick={startCamera} style={{
                  marginTop: 4, background: 'var(--accent-color)', color: '#fff',
                  border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 11, cursor: 'pointer',
                }}>
                  🔄 Erneut versuchen
                </button>
              )}
            </div>
          )}

          {/* Loading */}
          {status === 'loading' && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 28, color: 'var(--text-tertiary)' }}>⏳</span>
            </div>
          )}

          {/* Video */}
          <video
            ref={videoRef}
            muted playsInline
            style={{
              display: isActive ? 'block' : 'none',
              width: '100%', height: '100%', objectFit: 'cover',
              transform: mirrorStyle,
            }}
          />

          {/* Canvas Overlay – NICHT CSS-gespiegelt, Box-Koordinaten werden im Code gespiegelt */}
          <canvas
            ref={canvasRef}
            style={{
              display: isActive && s.faceDetection ? 'block' : 'none',
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              pointerEvents: 'none',
            }}
          />

          {/* Gesichts-Badge */}
          {isActive && s.faceDetection && faceCount > 0 && (
            <div style={{
              position: 'absolute', top: 8, right: 8,
              background: 'rgba(34,197,94,0.85)', borderRadius: 12,
              padding: '2px 10px', fontSize: 11, color: '#fff', fontWeight: 700,
            }}>
              {faceCount} Gesicht{faceCount > 1 ? 'er' : ''}
            </div>
          )}
        </div>

        {/* Footer */}
        {isActive && (
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'center' }}>
            🔒 Lokale Verarbeitung · {Math.round(containerW)}px
            {s.faceDetection && ` · TinyFaceDetector ${s.inputSize}px`}
          </div>
        )}
      </div>

      {/* Settings Dialog */}
      <WidgetSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Einstellungen: Kamera">
        {/* Status */}
        <div className="settings-section">
          <div className="settings-section-title">Status</div>
          <div className="settings-field" style={{ display: 'flex', gap: 8 }}>
            {isActive ? (
              <button className="settings-btn settings-btn-danger" onClick={stopCamera}>⏹ Kamera stoppen</button>
            ) : (
              <button className="settings-btn settings-btn-primary" onClick={startCamera}>▶ Kamera starten</button>
            )}
            <button className="settings-btn" onClick={() => listCameras().then(setCameras)}>🔄 Aktualisieren</button>
          </div>
        </div>

        {/* Kamera-Auswahl */}
        <div className="settings-section">
          <div className="settings-section-title">Kamera</div>
          <div className="settings-field">
            <label className="settings-label">Gerät</label>
            <select
              className="settings-select"
              value={s.deviceId}
              onChange={e => {
                updateSettings(instanceId, { deviceId: e.target.value });
                if (isActive) { stopCamera(); setTimeout(startCamera, 300); }
              }}
            >
              <option value="">Standard</option>
              {cameras.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            {cameras.length === 0 && (
              <p className="settings-description">Starte die Kamera einmal, damit Geräte-Labels erscheinen.</p>
            )}
          </div>
          <div className="settings-field">
            <div className="settings-toggle">
              <div>
                <div className="settings-toggle-label">Spiegeln</div>
                <div className="settings-toggle-sublabel">Bild horizontal spiegeln (für Selfie-Kameras)</div>
              </div>
              <label className="toggle-switch">
                <input type="checkbox" checked={s.mirror}
                  onChange={e => updateSettings(instanceId, { mirror: e.target.checked })} />
                <span className="toggle-switch-slider" />
              </label>
            </div>
          </div>
        </div>

        {/* Gesichtserkennung */}
        <div className="settings-section">
          <div className="settings-section-title">Gesichtserkennung</div>
          <div className="settings-field">
            <div className="settings-toggle">
              <div>
                <div className="settings-toggle-label">Gesichtserkennung</div>
                <div className="settings-toggle-sublabel">
                  {modelsReady ? 'Modelle geladen ✓' : 'Modelle werden geladen…'}
                </div>
              </div>
              <label className="toggle-switch">
                <input type="checkbox" checked={s.faceDetection}
                  onChange={e => updateSettings(instanceId, { faceDetection: e.target.checked })} />
                <span className="toggle-switch-slider" />
              </label>
            </div>
          </div>

          {s.faceDetection && (
            <>
              <div className="settings-field">
                <label className="settings-label">
                  Erkennungsschwelle
                  <span className="settings-range-value">{Math.round(s.scoreThreshold * 100)}%</span>
                </label>
                <p className="settings-description">Höher = weniger Fehlerkennungen</p>
                <input type="range" className="settings-range"
                  min="0.1" max="0.9" step="0.05" value={s.scoreThreshold}
                  onChange={e => updateSettings(instanceId, { scoreThreshold: parseFloat(e.target.value) })} />
              </div>
              <div className="settings-field">
                <label className="settings-label">Modell-Auflösung</label>
                <select className="settings-select" value={s.inputSize}
                  onChange={e => updateSettings(instanceId, { inputSize: parseInt(e.target.value) })}>
                  <option value="128">128px – Schnellst</option>
                  <option value="160">160px – Schnell</option>
                  <option value="224">224px – Standard</option>
                  <option value="320">320px – Genau</option>
                  <option value="416">416px – Sehr genau</option>
                </select>
              </div>
            </>
          )}
        </div>

        {/* Verhalten */}
        <div className="settings-section">
          <div className="settings-section-title">Verhalten</div>
          <div className="settings-field">
            <div className="settings-toggle">
              <div>
                <div className="settings-toggle-label">Auto-Start</div>
                <div className="settings-toggle-sublabel">Kamera beim App-Start automatisch aktivieren</div>
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
          🔒 Alle Daten werden lokal verarbeitet – keine Übertragung an externe Server.
        </div>
      </WidgetSettingsDialog>
    </>
  );
};

export const cameraWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'camera',
    name: 'Gesichtserkennung',
    description: 'Live-Kamerabild mit lokaler Gesichtserkennung',
    version: '3.0.0',
    author: 'SlateDesk',
    minWidth: 2,
    minHeight: 3,
    defaultWidth: 3,
    defaultHeight: 4,
    permissions: ['camera'],
    hasSettings: true,
  },
  component: CameraComponent,
};
