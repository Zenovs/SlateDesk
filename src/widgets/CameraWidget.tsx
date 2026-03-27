/**
 * Camera Widget – Gesichtserkennung mit Settings-System
 * 
 * Features:
 * - Live-Kamera-Feed via getUserMedia
 * - Gesichtserkennung mit face-api.js (TinyFaceDetector)
 * - Kamera-Auswahl (Dropdown aller verfügbaren Kameras)
 * - Start/Stop Kamera
 * - Gesichtserkennung aktivieren/deaktivieren
 * - Face Detection Threshold Slider
 * - Persistente Settings via widgetSettingsStore
 * - Klare Fehlermeldungen und Status-Anzeige
 * - Lokale Verarbeitung – keine Daten werden übertragen
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as faceapi from 'face-api.js';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

type CameraStatus = 'idle' | 'loading' | 'active' | 'error' | 'permission_needed';

interface CameraSettings {
  selectedDeviceId: string;
  faceDetectionEnabled: boolean;
  scoreThreshold: number;
  autoStart: boolean;
  inputSize: number;
}

const DEFAULT_SETTINGS: CameraSettings = {
  selectedDeviceId: '',
  faceDetectionEnabled: true,
  scoreThreshold: 0.5,
  autoStart: false,
  inputSize: 224,
};

interface CameraDevice {
  deviceId: string;
  label: string;
}

const CameraComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);

  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [faceCount, setFaceCount] = useState(0);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [availableCameras, setAvailableCameras] = useState<CameraDevice[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Settings from store
  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const settings = getSettings<CameraSettings>(instanceId, DEFAULT_SETTINGS);

  // Enumerate cameras
  const enumerateCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Kamera ${i + 1}`,
        }));
      setAvailableCameras(cameras);
      return cameras;
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
      return [];
    }
  }, []);

  // Load face-api.js models
  useEffect(() => {
    const loadModels = async () => {
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
        setModelsLoaded(true);
      } catch (err) {
        console.error('Failed to load face detection models:', err);
        setErrorMsg('Face-Detection-Modelle konnten nicht geladen werden. Bitte stelle sicher, dass die Modelle unter /public/models/ vorhanden sind.');
      }
    };
    loadModels();
  }, []);

  // Enumerate cameras on mount
  useEffect(() => {
    enumerateCameras();
  }, [enumerateCameras]);

  // Listen for settings open event from WidgetWrapper
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, handler);
    return () => {
      eventBus.off(`widget:openSettings:${instanceId}`, handler);
    };
  }, [instanceId]);

  // Auto-start if enabled
  useEffect(() => {
    if (settings.autoStart && modelsLoaded && cameraStatus === 'idle') {
      startCamera();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsLoaded, settings.autoStart]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopCamera = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setDetecting(false);
    setFaceCount(0);
    setCameraStatus('idle');
  }, []);

  const startCamera = useCallback(async () => {
    // Check if models are loaded (only needed if face detection is enabled)
    if (settings.faceDetectionEnabled && !modelsLoaded) {
      setErrorMsg('Modelle werden noch geladen...');
      return;
    }

    setCameraStatus('loading');
    setErrorMsg('');

    try {
      // Build constraints
      const videoConstraints: MediaTrackConstraints = {
        width: { ideal: 640 },
        height: { ideal: 480 },
      };

      // Use selected camera if available
      if (settings.selectedDeviceId) {
        videoConstraints.deviceId = { exact: settings.selectedDeviceId };
      } else {
        videoConstraints.facingMode = 'user';
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraStatus('active');

        if (settings.faceDetectionEnabled) {
          setDetecting(true);
        }
      }

      // Re-enumerate cameras after getting permission (labels become available)
      const cameras = await enumerateCameras();

      // Auto-select current camera if none selected
      if (!settings.selectedDeviceId && cameras.length > 0) {
        const currentTrack = stream.getVideoTracks()[0];
        const currentSettings = currentTrack.getSettings();
        if (currentSettings.deviceId) {
          updateSettings(instanceId, { selectedDeviceId: currentSettings.deviceId });
        }
      }
    } catch (err: unknown) {
      setCameraStatus('error');
      if (err instanceof DOMException) {
        switch (err.name) {
          case 'NotAllowedError':
            setCameraStatus('permission_needed');
            setErrorMsg(
              'Kamera-Zugriff verweigert. Bitte erteile die Berechtigung in den Browser-/System-Einstellungen.'
            );
            break;
          case 'NotFoundError':
            setErrorMsg(
              'Keine Kamera gefunden. Bitte schliesse eine Kamera an oder wähle eine andere in den Einstellungen.'
            );
            break;
          case 'NotReadableError':
          case 'AbortError':
            setErrorMsg(
              'Kamera wird bereits von einer anderen Anwendung verwendet. Bitte schliesse andere Programme, die die Kamera nutzen.'
            );
            break;
          case 'OverconstrainedError':
            setErrorMsg(
              'Die gewählte Kamera ist nicht verfügbar. Bitte wähle eine andere Kamera in den Einstellungen.'
            );
            break;
          default:
            setErrorMsg(`Kamera-Fehler: ${err.message}`);
        }
      } else {
        setErrorMsg('Unbekannter Fehler beim Kamera-Zugriff.');
      }
    }
  }, [modelsLoaded, settings.selectedDeviceId, settings.faceDetectionEnabled, enumerateCameras, updateSettings, instanceId]);

  // Face detection loop
  useEffect(() => {
    if (!detecting || !videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    const detect = async () => {
      if (!detecting || video.paused || video.ended) return;

      const displaySize = { width: video.videoWidth, height: video.videoHeight };
      if (displaySize.width === 0 || displaySize.height === 0) {
        animFrameRef.current = requestAnimationFrame(detect);
        return;
      }

      faceapi.matchDimensions(canvas, displaySize);

      try {
        const detections = await faceapi.detectAllFaces(
          video,
          new faceapi.TinyFaceDetectorOptions({
            inputSize: settings.inputSize,
            scoreThreshold: settings.scoreThreshold,
          })
        );

        setFaceCount(detections.length);

        // Draw bounding boxes
        const resized = faceapi.resizeResults(detections, displaySize);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          resized.forEach((det) => {
            const { x, y, width, height } = det.box;
            ctx.strokeStyle = '#ff6b35';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, width, height);
            ctx.fillStyle = '#ff6b35';
            ctx.font = '12px Lato, sans-serif';
            ctx.fillText(
              `${Math.round(det.score * 100)}%`,
              x,
              y > 14 ? y - 4 : y + height + 14
            );
          });
        }
      } catch (err) {
        console.error('Detection error:', err);
      }

      animFrameRef.current = requestAnimationFrame(detect);
    };

    animFrameRef.current = requestAnimationFrame(detect);

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [detecting, settings.scoreThreshold, settings.inputSize]);

  // Toggle face detection on/off while camera is active
  useEffect(() => {
    if (cameraStatus === 'active') {
      if (settings.faceDetectionEnabled && modelsLoaded) {
        setDetecting(true);
      } else {
        setDetecting(false);
        setFaceCount(0);
        // Clear canvas
        if (canvasRef.current) {
          const ctx = canvasRef.current.getContext('2d');
          if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        }
      }
    }
  }, [settings.faceDetectionEnabled, cameraStatus, modelsLoaded]);

  const faceDetected = faceCount > 0;

  // Request camera permission with better UX
  const requestPermission = useCallback(async () => {
    setCameraStatus('loading');
    setErrorMsg('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(t => t.stop());
      await enumerateCameras();
      setCameraStatus('idle');
      // Auto-start after permission granted
      setTimeout(() => startCamera(), 300);
    } catch {
      setCameraStatus('permission_needed');
      setErrorMsg('Kamera-Zugriff wurde verweigert. Bitte erlaube den Zugriff in den Browser-Einstellungen.');
    }
  }, [enumerateCameras, startCamera]);

  // Settings panel content
  const renderSettingsPanel = () => (
    <div>
      {/* Camera Status */}
      <div className="settings-section">
        <div className="settings-section-title">Kamera-Status</div>
        <div className="settings-field">
          <div className="settings-status">
            <div
              className="settings-status-dot"
              style={{
                backgroundColor:
                  cameraStatus === 'active'
                    ? '#4ade80'
                    : cameraStatus === 'error' || cameraStatus === 'permission_needed'
                    ? '#ef4444'
                    : 'var(--text-tertiary)',
              }}
            />
            <span>
              {cameraStatus === 'idle' && 'Kamera aus'}
              {cameraStatus === 'loading' && 'Kamera wird gestartet...'}
              {cameraStatus === 'error' && 'Fehler'}
              {cameraStatus === 'permission_needed' && 'Berechtigung erforderlich'}
              {cameraStatus === 'active' && 'Kamera aktiv'}
            </span>
          </div>
        </div>

        {/* Permission needed - Step by step guide */}
        {cameraStatus === 'permission_needed' && (
          <div className="settings-field">
            <div className="settings-info-box warning" style={{ flexDirection: 'column' }}>
              <strong>🔐 Kamera-Zugriff erforderlich</strong>
              <p style={{ margin: '8px 0 4px' }}>Um die Kamera zu nutzen, folge diesen Schritten:</p>
              <ol className="settings-steps">
                <li>Klicke auf „Kamera-Zugriff anfordern" unten</li>
                <li>Der Browser zeigt einen Berechtigungs-Dialog</li>
                <li>Klicke auf „Erlauben" / „Allow"</li>
                <li>Die Kamera startet automatisch</li>
              </ol>
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="settings-btn settings-btn-primary" onClick={requestPermission}>
                🔐 Kamera-Zugriff anfordern
              </button>
            </div>
          </div>
        )}

        {/* Error with helpful tips */}
        {cameraStatus === 'error' && (
          <div className="settings-field">
            <div className="settings-info-box error" style={{ flexDirection: 'column' }}>
              <strong>⚠️ Kamera-Fehler</strong>
              <p style={{ margin: '4px 0' }}>{errorMsg}</p>
              <p style={{ margin: '4px 0', fontSize: 'var(--font-size-xs)', opacity: 0.8 }}>
                <strong>Tipps:</strong> Prüfe ob eine andere App die Kamera nutzt. 
                Versuche eine andere Kamera auszuwählen oder starte den Browser neu.
              </p>
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <button className="settings-btn settings-btn-primary" onClick={startCamera}>
                🔄 Erneut versuchen
              </button>
            </div>
          </div>
        )}

        {/* Start/Stop Button */}
        <div className="settings-field">
          <div style={{ display: 'flex', gap: '8px' }}>
            {cameraStatus === 'active' ? (
              <button className="settings-btn settings-btn-danger" onClick={stopCamera}>
                ⏹ Kamera stoppen
              </button>
            ) : cameraStatus !== 'permission_needed' && cameraStatus !== 'error' ? (
              <button className="settings-btn settings-btn-primary" onClick={startCamera}>
                ▶ Kamera starten
              </button>
            ) : null}
            <button
              className="settings-btn"
              onClick={async () => { await enumerateCameras(); }}
            >
              🔄 Kameras aktualisieren
            </button>
          </div>
        </div>
      </div>

      {/* Camera Selection */}
      <div className="settings-section">
        <div className="settings-section-title">Kamera-Auswahl</div>
        <div className="settings-field">
          <label className="settings-label">Kamera</label>
          <p className="settings-description">
            Wähle die Kamera, die verwendet werden soll.
            {availableCameras.length === 0 && ' Starte zuerst die Kamera, um verfügbare Geräte zu sehen.'}
          </p>
          <select
            className="settings-select"
            value={settings.selectedDeviceId}
            onChange={(e) => {
              updateSettings(instanceId, { selectedDeviceId: e.target.value });
              if (cameraStatus === 'active') {
                stopCamera();
                setTimeout(() => startCamera(), 300);
              }
            }}
          >
            <option value="">Standard-Kamera</option>
            {availableCameras.map((cam) => (
              <option key={cam.deviceId} value={cam.deviceId}>
                {cam.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Face Detection */}
      <div className="settings-section">
        <div className="settings-section-title">Gesichtserkennung</div>
        
        <div className="settings-field">
          <div className="settings-toggle">
            <div>
              <div className="settings-toggle-label">Gesichtserkennung aktivieren</div>
              <div className="settings-toggle-sublabel">
                Erkennt Gesichter im Kamerabild und zeigt Markierungen
              </div>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings.faceDetectionEnabled}
                onChange={(e) =>
                  updateSettings(instanceId, { faceDetectionEnabled: e.target.checked })
                }
              />
              <span className="toggle-switch-slider" />
            </label>
          </div>
        </div>

        {settings.faceDetectionEnabled && (
          <>
            <div className="settings-field">
              <label className="settings-label">
                Erkennungs-Schwellenwert
                <span className="settings-range-value">
                  {Math.round(settings.scoreThreshold * 100)}%
                </span>
              </label>
              <p className="settings-description">
                Höhere Werte = weniger Fehlerkennungen, niedrigere Werte = mehr Erkennung
              </p>
              <input
                type="range"
                className="settings-range"
                min="0.1"
                max="0.9"
                step="0.05"
                value={settings.scoreThreshold}
                onChange={(e) =>
                  updateSettings(instanceId, { scoreThreshold: parseFloat(e.target.value) })
                }
              />
            </div>

            <div className="settings-field">
              <label className="settings-label">Eingabegrösse (Input Size)</label>
              <p className="settings-description">
                Höhere Werte = genauer aber langsamer
              </p>
              <select
                className="settings-select"
                value={settings.inputSize}
                onChange={(e) =>
                  updateSettings(instanceId, { inputSize: parseInt(e.target.value) })
                }
              >
                <option value="128">128 (Schnell)</option>
                <option value="160">160</option>
                <option value="224">224 (Standard)</option>
                <option value="320">320</option>
                <option value="416">416 (Genau)</option>
              </select>
            </div>
          </>
        )}
      </div>

      {/* Auto-Start */}
      <div className="settings-section">
        <div className="settings-section-title">Verhalten</div>
        <div className="settings-field">
          <div className="settings-toggle">
            <div>
              <div className="settings-toggle-label">Auto-Start</div>
              <div className="settings-toggle-sublabel">
                Kamera automatisch starten, wenn das Widget geladen wird
              </div>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={settings.autoStart}
                onChange={(e) =>
                  updateSettings(instanceId, { autoStart: e.target.checked })
                }
              />
              <span className="toggle-switch-slider" />
            </label>
          </div>
        </div>
      </div>

      {/* Privacy Info */}
      <div className="settings-info-box success">
        🔒 Alle Daten werden lokal verarbeitet. Es werden keine Kamera-Daten an externe Server übertragen.
      </div>
    </div>
  );

  return (
    <div style={styles.container}>
      {/* Status Bar */}
      <div style={styles.statusBar}>
        <div
          style={{
            ...styles.statusDot,
            backgroundColor:
              cameraStatus === 'active'
                ? faceDetected
                  ? '#4ade80'
                  : '#facc15'
                : cameraStatus === 'error' || cameraStatus === 'permission_needed'
                ? '#ef4444'
                : 'var(--text-secondary)',
          }}
        />
        <span style={styles.statusText}>
          {cameraStatus === 'idle' && 'Kamera aus'}
          {cameraStatus === 'loading' && 'Kamera wird gestartet...'}
          {cameraStatus === 'error' && 'Fehler'}
          {cameraStatus === 'permission_needed' && 'Berechtigung erforderlich'}
          {cameraStatus === 'active' &&
            (settings.faceDetectionEnabled
              ? faceDetected
                ? `Gesicht erkannt ✅ (${faceCount})`
                : 'Kein Gesicht ❌'
              : 'Kamera aktiv (ohne Erkennung)')}
        </span>
        <button
          onClick={cameraStatus === 'active' ? stopCamera : startCamera}
          style={styles.toggleBtn}
          title={cameraStatus === 'active' ? 'Kamera stoppen' : 'Kamera starten'}
        >
          {cameraStatus === 'active' ? '⏹' : '▶'}
        </button>
      </div>

      {/* Video Container */}
      <div style={styles.videoContainer}>
        {(cameraStatus === 'idle' || cameraStatus === 'permission_needed') && (
          <div style={styles.placeholder}>
            <span style={{ fontSize: '2rem' }}>
              {cameraStatus === 'permission_needed' ? '🔐' : '📷'}
            </span>
            <span
              style={{
                fontSize: 'var(--font-sm)',
                color:
                  cameraStatus === 'permission_needed'
                    ? '#facc15'
                    : 'var(--text-secondary)',
                marginTop: '8px',
                textAlign: 'center',
                padding: '0 8px',
              }}
            >
              {cameraStatus === 'permission_needed'
                ? 'Kamera-Zugriff erforderlich'
                : 'Kamera starten um Gesichtserkennung zu aktivieren'}
            </span>
            {cameraStatus === 'permission_needed' ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginTop: 12 }}>
                <button onClick={requestPermission} style={{ ...styles.toggleBtn, padding: '8px 16px', background: 'var(--accent-color)', color: 'white', borderColor: 'var(--accent-color)' }}>
                  🔐 Kamera-Zugriff erlauben
                </button>
                <span style={{ fontSize: 'var(--font-size-xs, 11px)', color: 'var(--text-tertiary)', textAlign: 'center' }}>
                  Der Browser wird dich fragen – klicke auf „Erlauben"
                </span>
              </div>
            ) : (
              <button onClick={startCamera} style={{ ...styles.toggleBtn, marginTop: '12px', padding: '8px 16px' }}>
                ▶ Kamera starten
              </button>
            )}
          </div>
        )}
        {cameraStatus === 'error' && (
          <div style={styles.placeholder}>
            <span style={{ fontSize: '2rem' }}>⚠️</span>
            <span
              style={{
                fontSize: 'var(--font-sm)',
                color: '#ef4444',
                marginTop: '8px',
                textAlign: 'center',
                padding: '0 8px',
              }}
            >
              {errorMsg}
            </span>
            <button onClick={startCamera} style={{ ...styles.toggleBtn, marginTop: '12px', padding: '8px 16px' }}>
              🔄 Erneut versuchen
            </button>
          </div>
        )}
        {cameraStatus === 'loading' && (
          <div style={styles.placeholder}>
            <span style={{ fontSize: '2rem' }}>⏳</span>
            <span
              style={{
                fontSize: 'var(--font-sm)',
                color: 'var(--text-secondary)',
                marginTop: '8px',
              }}
            >
              Lade...
            </span>
          </div>
        )}
        <video
          ref={videoRef}
          style={{
            ...styles.video,
            display: cameraStatus === 'active' ? 'block' : 'none',
          }}
          muted
          playsInline
        />
        <canvas
          ref={canvasRef}
          style={{
            ...styles.canvas,
            display: cameraStatus === 'active' && settings.faceDetectionEnabled ? 'block' : 'none',
          }}
        />
      </div>

      {/* Info Footer */}
      {cameraStatus === 'active' && (
        <div style={styles.footer}>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)' }}>
            🔒 Lokale Verarbeitung – keine Daten werden übertragen
          </span>
        </div>
      )}

      {/* Settings Dialog */}
      <WidgetSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Kamera – Einstellungen"
      >
        {renderSettingsPanel()}
      </WidgetSettingsDialog>
    </div>
  );
};

// Wrap CameraComponent to expose settings opener
const CameraWidgetWithSettings: React.FC<WidgetProps> = (props) => {
  return <CameraComponent {...props} />;
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    gap: '8px',
    padding: '8px',
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 0',
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  statusText: {
    fontSize: 'var(--font-sm)',
    color: 'var(--text-primary)',
    flex: 1,
  },
  toggleBtn: {
    background: 'var(--card-bg)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    padding: '4px 10px',
    fontSize: 'var(--font-sm)',
    flexShrink: 0,
  },
  videoContainer: {
    position: 'relative',
    flex: 1,
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
    backgroundColor: '#000',
    minHeight: '120px',
  },
  video: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transform: 'scaleX(-1)',
  },
  canvas: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    transform: 'scaleX(-1)',
    pointerEvents: 'none',
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '16px',
    color: 'var(--text-secondary)',
  },
  footer: {
    textAlign: 'center',
    padding: '2px 0',
  },
};

export const cameraWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'camera',
    name: 'Gesichtserkennung',
    description: 'Live-Kamera mit Gesichtserkennung und Einstellungen',
    version: '2.0.0',
    author: 'SlateDesk',
    minWidth: 2,
    minHeight: 3,
    defaultWidth: 3,
    defaultHeight: 4,
    permissions: ['camera'],
    refreshInterval: 0,
    hasSettings: true,
  },
  component: CameraWidgetWithSettings,
};
