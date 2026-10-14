/**
 * Camera widget ("Gesichtserkennung") – live image of the kiosk camera with
 * local face detection (face-api.js TinyFaceDetector).
 *
 * - the stream is shared with the Ruhemodus widget (services/cameraService)
 * - privacy modes: live image, blurred image, or only the number of people
 * - exactly one detection loop at `fps`, restarted (never duplicated) when a
 *   detection setting changes, stopped on stop/unmount
 * - publishes eventBus 'presence:changed' { present, count } (debounced)
 * - a detection that keeps failing or gets no frames resets the presence and
 *   says so, instead of holding the last count
 * - face boxes are drawn on a canvas covering the video element, mapped
 *   through the same object-fit geometry as the video
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, CameraOff, Play, Power, RotateCcw, ScanFace } from 'lucide-react';
import type { WidgetProps } from '../types/widget';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { useLayoutStore } from '../store/layoutStore';
import { CameraSession, type CameraSessionState } from '../services/cameraService';
import {
  detectFaces,
  FACE_INPUT_SIZES,
  getFaceDetectorStatus,
  loadFaceDetector,
  publishPresence,
  subscribeFaceDetector,
  type FaceDetectionResult,
  type PresenceEvent,
} from '../services/faceDetector';
import { useLegacyDefaults } from '../services/legacyDefaults';
import { CameraDeviceSelect } from './shared/CameraDeviceSelect';
import {
  CAMERA_DEFAULT_SETTINGS,
  CAMERA_FPS_LIMITS,
  CAMERA_LEGACY_DEFAULTS,
  type CameraPrivacy,
  type CameraSettings,
} from './manifests/camera';
import './styles/camera.css';

type CameraConfig = Omit<CameraSettings, 'autoStart'>;

/** Why the detection has not worked for DETECTION_STALL_MS: no video frame, or detection errors. */
type DetectionStall = 'kein-bild' | 'gestoert';

interface CameraSnapshot {
  running: boolean;
  camera: CameraSessionState;
  /** Number of people, held briefly when a single frame misses a face. */
  faces: number;
  /** Set while the detection does not work – `faces` is 0 then, not the last count. */
  stall: DetectionStall | null;
}

/** Used for the <video> style and the box mapping – both must agree. */
const VIDEO_FIT = 'cover';
/** A frame without a face (turned head, motion blur) does not end the presence. */
const ABSENCE_GRACE_MS = 3000;
/** Count changes are published at most this often; presence changes at once. */
const PRESENCE_THROTTLE_MS = 1000;
/** Without a successful detection for this long, the presence is reset and a hint shown. */
const DETECTION_STALL_MS = 10_000;
const MIN_LOOP_GAP_MS = 40;
const PRIVACY_MODES: readonly CameraPrivacy[] = ['vorschau', 'unscharf', 'nur-zahl'];

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

function toConfig(settings: CameraSettings): CameraConfig {
  const defaults = CAMERA_DEFAULT_SETTINGS;
  return {
    deviceId: typeof settings.deviceId === 'string' ? settings.deviceId : '',
    privacy: PRIVACY_MODES.includes(settings.privacy) ? settings.privacy : defaults.privacy,
    mirror: bool(settings.mirror, defaults.mirror),
    faceDetection: bool(settings.faceDetection, defaults.faceDetection),
    showBoxes: bool(settings.showBoxes, defaults.showBoxes),
    fps: clampNumber(settings.fps, CAMERA_FPS_LIMITS.min, CAMERA_FPS_LIMITS.max, defaults.fps),
    scoreThreshold: clampNumber(settings.scoreThreshold, 0.1, 0.9, defaults.scoreThreshold),
    inputSize: FACE_INPUT_SIZES.includes(settings.inputSize) ? settings.inputSize : defaults.inputSize,
  };
}

/** Where object-fit (centred) puts a video frame inside its element box. */
function videoFrameRect(
  fit: 'cover' | 'contain',
  boxWidth: number,
  boxHeight: number,
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number; scale: number } {
  const scaleX = boxWidth / videoWidth;
  const scaleY = boxHeight / videoHeight;
  const scale = fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  return { scale, x: (boxWidth - videoWidth * scale) / 2, y: (boxHeight - videoHeight * scale) / 2 };
}

const peopleText = (count: number): string => (count === 1 ? '1 Person' : `${count} Personen`);

const STALL_BADGE: Record<DetectionStall, string> = { 'kein-bild': 'Kein Kamerabild', gestoert: 'Erkennung gestört' };
const STALL_NOTICE: Record<DetectionStall, string> = {
  'kein-bild': 'Die Kamera liefert kein Bild – niemand wird erkannt.',
  gestoert: 'Die Gesichtserkennung ist gestört – niemand wird erkannt.',
};

// ── Controller ───────────────────────────────────────────────────────────────

/** Camera, detection loop, presence and overlay of one widget instance – outside React. */
class CameraController {
  private readonly listeners = new Set<() => void>();
  private readonly session = new CameraSession(() => this.sync());
  private snapshot: CameraSnapshot;
  private config: CameraConfig;
  private mounted = false;
  private running = false;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private stopDetectorWatch: (() => void) | null = null;
  private loopActive = false;
  private loopGeneration = 0;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private failureLogged = false;
  /** Last successful detection, or the loop start before the first one. */
  private detectedAt = 0;
  private lastProblem: DetectionStall = 'kein-bild';
  private stall: DetectionStall | null = null;
  private detection: FaceDetectionResult | null = null;
  private faces = 0;
  private lastFaceAt = 0;
  private lastCount = 0;
  private published: PresenceEvent = { present: false, count: 0 };
  private publishedAt = 0;

  constructor(config: CameraConfig) {
    this.config = config;
    this.snapshot = { running: false, camera: this.session.current, faces: 0, stall: null };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CameraSnapshot => this.snapshot;

  setVideo = (video: HTMLVideoElement | null): void => {
    this.video = video;
    this.session.attach(video);
    this.sync();
  };

  setCanvas = (canvas: HTMLCanvasElement | null): void => {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas = canvas;
    if (canvas && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(canvas);
    }
    this.draw();
  };

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.stopDetectorWatch = subscribeFaceDetector(() => this.sync());
    this.sync();
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.stopDetectorWatch?.();
    this.stopDetectorWatch = null;
    this.sync();
  }

  configure(config: CameraConfig): void {
    const prev = this.config;
    this.config = config;
    // Detect with the new values right away instead of after the current wait.
    const detectionChanged =
      prev.fps !== config.fps || prev.scoreThreshold !== config.scoreThreshold || prev.inputSize !== config.inputSize;
    if (detectionChanged && this.loopActive) this.restartLoop();
    this.sync();
    this.draw();
  }

  start = (): void => {
    if (this.running) return;
    this.running = true;
    this.sync();
  };

  stop = (): void => {
    if (!this.running) return;
    this.running = false;
    this.sync();
  };

  retry = (): void => {
    this.session.retry();
    if (getFaceDetectorStatus().state === 'error') void loadFaceDetector();
    if (this.stall && this.loopActive) this.restartLoop();
    this.sync();
  };

  private sync(): void {
    const wantCamera = this.mounted && this.running;
    this.session.update(wantCamera, this.config.deviceId);
    const wantDetection = wantCamera && this.config.faceDetection;
    if (wantDetection && getFaceDetectorStatus().state === 'idle') void loadFaceDetector();
    const detectorReady = getFaceDetectorStatus().state === 'ready';
    this.setLoop(wantDetection && detectorReady && this.session.current.status === 'on' && this.video !== null);
    this.publish();
  }

  private setLoop(active: boolean): void {
    if (active === this.loopActive) return;
    this.loopActive = active;
    this.restartLoop();
  }

  private restartLoop(): void {
    this.loopGeneration += 1;
    if (this.loopTimer !== null) clearTimeout(this.loopTimer);
    this.loopTimer = null;
    this.detectedAt = Date.now();
    this.lastProblem = 'kein-bild';
    this.stall = null;
    if (this.loopActive) void this.detect(this.loopGeneration);
    else this.resetPresence();
  }

  private async detect(generation: number): Promise<void> {
    const video = this.video;
    if (!video || generation !== this.loopGeneration) return;
    const started = performance.now();
    try {
      const result = await detectFaces(video, {
        inputSize: this.config.inputSize,
        scoreThreshold: this.config.scoreThreshold,
      });
      if (generation !== this.loopGeneration) return;
      this.failureLogged = false;
      if (result) {
        this.detectedAt = Date.now();
        this.stall = null;
        this.detection = result;
        this.notePresence(result.faces.length);
        this.draw();
      } else {
        // The video has no frame (yet).
        this.lastProblem = 'kein-bild';
      }
    } catch (err) {
      if (generation !== this.loopGeneration) return;
      if (!this.failureLogged) console.warn('Gesichtserkennung fehlgeschlagen:', err);
      this.failureLogged = true;
      this.lastProblem = 'gestoert';
    }
    this.checkStall();
    const wait = 1000 / this.config.fps - (performance.now() - started);
    this.loopTimer = setTimeout(() => void this.detect(generation), Math.max(MIN_LOOP_GAP_MS, wait));
  }

  /** A detection that keeps failing must not hold the last count (and presence) for hours. */
  private checkStall(): void {
    if (this.stall === this.lastProblem || Date.now() - this.detectedAt < DETECTION_STALL_MS) return;
    this.stall = this.lastProblem;
    this.resetPresence();
    this.publish();
  }

  private notePresence(count: number): void {
    const now = Date.now();
    if (count > 0) {
      this.lastFaceAt = now;
      this.lastCount = count;
    }
    const present = count > 0 || now - this.lastFaceAt < ABSENCE_GRACE_MS;
    this.faces = count > 0 ? count : present ? this.lastCount : 0;
    const countDue = this.faces !== this.published.count && now - this.publishedAt >= PRESENCE_THROTTLE_MS;
    if (present !== this.published.present || countDue) {
      this.published = { present, count: this.faces };
      this.publishedAt = now;
      publishPresence(this.published);
    }
    this.publish();
  }

  private resetPresence(): void {
    this.detection = null;
    this.faces = 0;
    this.lastFaceAt = 0;
    this.lastCount = 0;
    if (this.published.present || this.published.count !== 0) {
      this.published = { present: false, count: 0 };
      this.publishedAt = Date.now();
      publishPresence(this.published);
    }
    this.draw();
  }

  private draw(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const detection = this.detection;
    const { faceDetection, showBoxes, privacy, mirror } = this.config;
    if (!detection || !faceDetection || !showBoxes || privacy === 'nur-zahl' || width === 0 || height === 0) return;

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const frame = videoFrameRect(VIDEO_FIT, width, height, detection.width, detection.height);
    ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--accent-color').trim() || '#e8642b';
    ctx.lineWidth = Math.max(2, Math.min(width, height) / 160);
    ctx.lineJoin = 'round';
    for (const face of detection.faces) {
      const boxWidth = face.width * frame.scale;
      const boxHeight = face.height * frame.scale;
      const x = frame.x + face.x * frame.scale;
      // CSS mirrors the video around its centre – mirror the box the same way.
      const left = mirror ? width - x - boxWidth : x;
      const top = frame.y + face.y * frame.scale;
      ctx.beginPath();
      ctx.roundRect(left, top, boxWidth, boxHeight, Math.min(boxWidth, boxHeight) * 0.12);
      ctx.stroke();
    }
  }

  private publish(): void {
    const camera = this.session.current;
    const prev = this.snapshot;
    if (
      prev.running === this.running &&
      prev.camera === camera &&
      prev.faces === this.faces &&
      prev.stall === this.stall
    ) {
      return;
    }
    this.snapshot = { running: this.running, camera, faces: this.faces, stall: this.stall };
    for (const listener of [...this.listeners]) listener();
  }
}

// ── Registry (widget ↔ its settings extra) ───────────────────────────────────

const controllers = new Map<string, CameraController>();
const registryListeners = new Set<() => void>();

function setRegistered(instanceId: string, controller: CameraController, registered: boolean): void {
  if (registered) controllers.set(instanceId, controller);
  else if (controllers.get(instanceId) === controller) controllers.delete(instanceId);
  else return;
  for (const listener of [...registryListeners]) listener();
}

function subscribeRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

function useRegisteredController(instanceId: string): CameraController | null {
  return useSyncExternalStore(subscribeRegistry, () => controllers.get(instanceId) ?? null);
}

const OFF_SNAPSHOT: CameraSnapshot = {
  running: false,
  camera: { status: 'off', error: null, notice: null, label: '' },
  faces: 0,
  stall: null,
};
const subscribeNothing = (): (() => void) => () => {};
const getOffSnapshot = (): CameraSnapshot => OFF_SNAPSHOT;

// ── Widget ───────────────────────────────────────────────────────────────────

function CameraComponent({ instanceId }: WidgetProps) {
  const [merged] = useWidgetSettings(instanceId, CAMERA_DEFAULT_SETTINGS);
  // An instance from the old kiosk keeps its old default: no auto-start.
  const settings = useLegacyDefaults('camera', instanceId, merged, CAMERA_LEGACY_DEFAULTS);
  const config = useMemo(() => toConfig(settings), [settings]);
  const autoStart = bool(settings.autoStart, CAMERA_DEFAULT_SETTINGS.autoStart);
  const [controller] = useState(() => new CameraController(config));
  const { running, camera, faces, stall } = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const detector = useSyncExternalStore(subscribeFaceDetector, getFaceDetectorStatus);
  const editMode = useLayoutStore((s) => s.editMode);
  const videoRef = useCallback((video: HTMLVideoElement | null) => controller.setVideo(video), [controller]);
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => controller.setCanvas(canvas), [controller]);

  useEffect(() => {
    controller.mount();
    setRegistered(instanceId, controller, true);
    return () => {
      setRegistered(instanceId, controller, false);
      controller.unmount();
    };
  }, [controller, instanceId]);

  useEffect(() => controller.configure(config), [controller, config]);

  // Switching auto-start on starts the camera; switching it off leaves a running camera alone.
  useEffect(() => {
    if (autoStart) controller.start();
  }, [controller, autoStart]);

  const live = camera.status === 'on';
  const countOnly = config.privacy === 'nur-zahl';
  const showImage = live && !countOnly;
  const detectorError = config.faceDetection && detector.state === 'error';
  const detecting = config.faceDetection && detector.state === 'ready';
  const stalled = detecting && live ? stall : null;

  let badge = 'Live';
  let badgeTone = 'neutral';
  if (config.faceDetection) {
    if (detectorError) {
      badge = 'Erkennung nicht verfügbar';
      badgeTone = 'error';
    } else if (!detecting) {
      badge = 'Erkennung startet …';
    } else if (stalled) {
      badge = STALL_BADGE[stalled];
      badgeTone = 'error';
    } else if (faces > 0) {
      badge = peopleText(faces);
      badgeTone = 'present';
    } else {
      badge = 'Niemand erkannt';
    }
  }

  const notice =
    camera.notice ?? (live && detectorError ? detector.error : stalled ? STALL_NOTICE[stalled] : null);

  const videoClass = [
    'camera-video',
    showImage && 'visible',
    config.mirror && 'mirrored',
    config.privacy === 'unscharf' && 'blurred',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="camera">
      <div className={`camera-stage${showImage ? ' dark' : ''}`}>
        <video
          ref={videoRef}
          className={videoClass}
          style={{ objectFit: VIDEO_FIT }}
          muted
          playsInline
          autoPlay
          aria-hidden="true"
        />
        {showImage && config.faceDetection && config.showBoxes && (
          <canvas ref={canvasRef} className="camera-overlay" aria-hidden="true" />
        )}

        {showImage && (
          <div className="camera-badge" role="status">
            <span className={`camera-dot ${badgeTone}`} />
            <span className="camera-badge-text">{badge}</span>
          </div>
        )}

        {live && countOnly && (
          <div className="camera-count" role="status">
            {detecting && !stalled ? (
              <>
                <span className="camera-count-value">{faces}</span>
                <span className="camera-count-label">{faces === 1 ? 'Person' : 'Personen'}</span>
              </>
            ) : (
              <span className="camera-message">
                {!config.faceDetection
                  ? 'Gesichtserkennung ist ausgeschaltet.'
                  : detectorError
                    ? detector.error
                    : stalled
                      ? STALL_BADGE[stalled]
                      : 'Erkennung startet …'}
              </span>
            )}
          </div>
        )}

        {!live && (
          <div className="camera-placeholder" role="status">
            {camera.status === 'error' ? (
              <AlertTriangle className="camera-placeholder-icon error" aria-hidden="true" />
            ) : camera.status === 'starting' ? (
              <ScanFace className="camera-placeholder-icon pulse" aria-hidden="true" />
            ) : (
              <CameraOff className="camera-placeholder-icon" aria-hidden="true" />
            )}
            <span className="camera-message">
              {camera.status === 'error'
                ? camera.error
                : camera.status === 'starting'
                  ? 'Kamera startet …'
                  : 'Kamera aus'}
            </span>
            {camera.status === 'error' && (
              <button type="button" className="camera-button" onClick={controller.retry}>
                <RotateCcw size={16} aria-hidden="true" />
                Erneut versuchen
              </button>
            )}
            {!running && (
              <button type="button" className="camera-button" onClick={controller.start}>
                <Play size={16} aria-hidden="true" />
                Kamera starten
              </button>
            )}
          </div>
        )}

        {(notice || (running && editMode)) && (
          <div className="camera-footer">
            {notice && (
              <span className="camera-notice">
                {notice}
                {(detectorError || stalled) && live && !camera.notice && (
                  <button type="button" className="camera-notice-action" onClick={controller.retry}>
                    Erneut versuchen
                  </button>
                )}
              </span>
            )}
            {running && editMode && (
              <button
                type="button"
                className="camera-power"
                onClick={controller.stop}
                title="Kamera ausschalten"
                aria-label="Kamera ausschalten"
              >
                <Power size={18} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Settings extra (kiosk only) ──────────────────────────────────────────────

export function CameraSettingsExtra({ instanceId }: { instanceId: string }) {
  const [settings, update] = useWidgetSettings(instanceId, CAMERA_DEFAULT_SETTINGS);
  const controller = useRegisteredController(instanceId);
  const { running, camera, faces, stall } = useSyncExternalStore(
    controller?.subscribe ?? subscribeNothing,
    controller?.getSnapshot ?? getOffSnapshot,
  );
  const detector = useSyncExternalStore(subscribeFaceDetector, getFaceDetectorStatus);

  let status: string;
  if (!controller) {
    status = 'Das Widget ist nicht aktiv.';
  } else if (camera.status === 'on') {
    const parts = ['Läuft', camera.label || 'Kamera'];
    if (bool(settings.faceDetection, CAMERA_DEFAULT_SETTINGS.faceDetection)) {
      if (detector.state === 'ready') parts.push(stall ? STALL_BADGE[stall] : `${peopleText(faces)} erkannt`);
      else parts.push(detector.state === 'error' ? 'Erkennung nicht verfügbar' : 'Erkennung startet …');
    }
    status = parts.join(' · ');
  } else if (camera.status === 'error') {
    status = camera.error ?? 'Kamerafehler';
  } else {
    status = camera.status === 'starting' ? 'Kamera startet …' : 'Kamera aus';
  }

  return (
    <section className="settings-section">
      <div className="settings-section-title">Kamera am Kiosk</div>
      <CameraDeviceSelect
        value={typeof settings.deviceId === 'string' ? settings.deviceId : ''}
        onChange={(deviceId) => update({ deviceId })}
      />
      <div className="settings-field">
        <div className="settings-status" role="status">
          <span className={`settings-status-dot camera-status-${controller ? camera.status : 'off'}`} />
          <span>{status}</span>
        </div>
        {camera.notice && <p className="settings-description">{camera.notice}</p>}
      </div>
      {controller && (
        <div className="camera-extra-actions">
          {running ? (
            <button type="button" className="settings-btn settings-btn-danger" onClick={controller.stop}>
              <Power size={16} aria-hidden="true" />
              Kamera ausschalten
            </button>
          ) : (
            <button type="button" className="settings-btn settings-btn-primary" onClick={controller.start}>
              <Play size={16} aria-hidden="true" />
              Kamera starten
            </button>
          )}
          {(camera.status === 'error' || camera.notice || detector.state === 'error' || stall) && running && (
            <button type="button" className="settings-btn" onClick={controller.retry}>
              <RotateCcw size={16} aria-hidden="true" />
              Erneut versuchen
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export const CameraWidget = CameraComponent;
