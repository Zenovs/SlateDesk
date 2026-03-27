/**
 * Camera Widget – Gesichtserkennung (Phase 1)
 * 
 * Features:
 * - Live-Kamera-Feed via getUserMedia
 * - Gesichtserkennung mit face-api.js (TinyFaceDetector)
 * - Status-Anzeige: Gesicht erkannt / Kein Gesicht
 * - Anzahl erkannter Gesichter
 * - Start/Stop Kamera
 * - Lokale Verarbeitung – keine Daten werden übertragen
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as faceapi from 'face-api.js';
import type { WidgetProps, WidgetDefinition } from '../types/widget';

type CameraStatus = 'idle' | 'loading' | 'active' | 'error';

const CameraComponent: React.FC<WidgetProps> = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number>(0);

  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [faceCount, setFaceCount] = useState(0);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [detecting, setDetecting] = useState(false);

  // Load face-api.js models
  useEffect(() => {
    const loadModels = async () => {
      try {
        await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
        setModelsLoaded(true);
      } catch (err) {
        console.error('Failed to load face detection models:', err);
        setErrorMsg('Modelle konnten nicht geladen werden');
      }
    };
    loadModels();
  }, []);

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
      streamRef.current.getTracks().forEach(t => t.stop());
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
    if (!modelsLoaded) {
      setErrorMsg('Modelle werden noch geladen...');
      return;
    }
    setCameraStatus('loading');
    setErrorMsg('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraStatus('active');
        setDetecting(true);
      }
    } catch (err: unknown) {
      setCameraStatus('error');
      if (err instanceof DOMException) {
        if (err.name === 'NotAllowedError') {
          setErrorMsg('Kamera-Zugriff verweigert. Bitte Berechtigung erteilen.');
        } else if (err.name === 'NotFoundError') {
          setErrorMsg('Keine Kamera gefunden.');
        } else {
          setErrorMsg(`Kamera-Fehler: ${err.message}`);
        }
      } else {
        setErrorMsg('Unbekannter Fehler beim Kamera-Zugriff.');
      }
    }
  }, [modelsLoaded]);

  // Face detection loop
  useEffect(() => {
    if (!detecting || !videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    const detect = async () => {
      if (!detecting || video.paused || video.ended) return;

      // Match canvas to video dimensions
      const displaySize = { width: video.videoWidth, height: video.videoHeight };
      if (displaySize.width === 0 || displaySize.height === 0) {
        animFrameRef.current = requestAnimationFrame(detect);
        return;
      }

      faceapi.matchDimensions(canvas, displaySize);

      try {
        const detections = await faceapi.detectAllFaces(
          video,
          new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 })
        );

        setFaceCount(detections.length);

        // Draw bounding boxes
        const resized = faceapi.resizeResults(detections, displaySize);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          resized.forEach(det => {
            const { x, y, width, height } = det.box;
            ctx.strokeStyle = '#ff6b35';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, width, height);
            // Confidence label
            ctx.fillStyle = '#ff6b35';
            ctx.font = '12px Lato, sans-serif';
            ctx.fillText(`${Math.round(det.score * 100)}%`, x, y > 14 ? y - 4 : y + height + 14);
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
  }, [detecting]);

  const faceDetected = faceCount > 0;

  return (
    <div style={styles.container}>
      {/* Status Bar */}
      <div style={styles.statusBar}>
        <div style={{
          ...styles.statusDot,
          backgroundColor: cameraStatus === 'active'
            ? (faceDetected ? '#4ade80' : '#facc15')
            : cameraStatus === 'error' ? '#ef4444' : 'var(--text-secondary)'
        }} />
        <span style={styles.statusText}>
          {cameraStatus === 'idle' && 'Kamera aus'}
          {cameraStatus === 'loading' && 'Kamera wird gestartet...'}
          {cameraStatus === 'error' && 'Fehler'}
          {cameraStatus === 'active' && (faceDetected
            ? `Gesicht erkannt ✅ (${faceCount})`
            : 'Kein Gesicht ❌'
          )}
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
        {cameraStatus === 'idle' && (
          <div style={styles.placeholder}>
            <span style={{ fontSize: '2rem' }}>📷</span>
            <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', marginTop: '8px' }}>
              Kamera starten um Gesichtserkennung zu aktivieren
            </span>
          </div>
        )}
        {cameraStatus === 'error' && (
          <div style={styles.placeholder}>
            <span style={{ fontSize: '2rem' }}>⚠️</span>
            <span style={{ fontSize: 'var(--font-sm)', color: '#ef4444', marginTop: '8px', textAlign: 'center' }}>
              {errorMsg}
            </span>
          </div>
        )}
        {cameraStatus === 'loading' && (
          <div style={styles.placeholder}>
            <span style={{ fontSize: '2rem' }}>⏳</span>
            <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-secondary)', marginTop: '8px' }}>
              Lade...
            </span>
          </div>
        )}
        <video
          ref={videoRef}
          style={{
            ...styles.video,
            display: cameraStatus === 'active' ? 'block' : 'none'
          }}
          muted
          playsInline
        />
        <canvas
          ref={canvasRef}
          style={{
            ...styles.canvas,
            display: cameraStatus === 'active' ? 'block' : 'none'
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
    </div>
  );
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
    transform: 'scaleX(-1)', // mirror
  },
  canvas: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    transform: 'scaleX(-1)', // mirror to match video
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
    description: 'Live-Kamera mit Gesichtserkennung (Phase 1)',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 2,
    minHeight: 3,
    defaultWidth: 3,
    defaultHeight: 4,
    permissions: ['camera'],
    refreshInterval: 0,
  },
  component: CameraComponent,
};
