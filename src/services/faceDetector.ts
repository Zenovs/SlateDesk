/**
 * faceDetector – face-api.js TinyFaceDetector, shared by all widgets.
 *
 * face-api.js (with TensorFlow.js about 0.9 MB) is imported on first use, so
 * the kiosk starts without it. The weights from /models are loaded once:
 * loading them per widget mount downloaded them again and leaked the replaced
 * tensors. A failed load is retried with backoff while someone subscribes to
 * the status, and by every `loadFaceDetector()` call.
 *
 * Also home of the presence event: the camera widget publishes whether it
 * sees people, other widgets (Ruhemodus) listen.
 */
import type * as FaceApi from 'face-api.js';
import { eventBus } from '../utils/eventBus';

export type FaceDetectorState = 'idle' | 'loading' | 'ready' | 'error';

export interface FaceDetectorStatus {
  state: FaceDetectorState;
  /** German, set in state 'error'. */
  error: string | null;
}

export interface FaceDetectOptions {
  /** Model input size in px (multiple of 32). */
  inputSize: number;
  /** 0..1 */
  scoreThreshold: number;
}

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

export interface FaceDetectionResult {
  faces: FaceBox[];
  /** Video frame size the boxes refer to. */
  width: number;
  height: number;
}

/** Input sizes offered in the settings (TinyFaceDetector needs multiples of 32). */
export const FACE_INPUT_SIZES: readonly number[] = [128, 160, 224, 320, 416];

const MODEL_URL = `${import.meta.env.BASE_URL}models`;
const LOAD_ERROR = 'Die Gesichtserkennung konnte nicht geladen werden.';
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** HTMLMediaElement.HAVE_FUTURE_DATA */
const HAVE_FUTURE_DATA = 3;

type FaceApiModule = typeof FaceApi;

let api: FaceApiModule | null = null;
let loading: Promise<FaceApiModule> | null = null;
let status: FaceDetectorStatus = { state: 'idle', error: null };
let failures = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const statusListeners = new Set<() => void>();
let detectQueue: Promise<unknown> = Promise.resolve();

function setStatus(next: FaceDetectorStatus): void {
  status = next;
  for (const listener of [...statusListeners]) listener();
}

export const getFaceDetectorStatus = (): FaceDetectorStatus => status;

/** For useSyncExternalStore; keeps automatic retries alive while subscribed. */
export function subscribeFaceDetector(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
    if (statusListeners.size === 0 && retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
}

function scheduleRetry(): void {
  if (retryTimer !== null || statusListeners.size === 0) return;
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (statusListeners.size > 0) void loadFaceDetector();
  }, delay);
}

async function importAndLoad(): Promise<FaceApiModule> {
  const faceapi = await import('face-api.js');
  if (!faceapi.nets.tinyFaceDetector.isLoaded) await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  return faceapi;
}

/** Loads face-api.js and the weights once. Resolves true when ready; never rejects. */
export function loadFaceDetector(): Promise<boolean> {
  if (api) return Promise.resolve(true);
  if (!loading) {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    const attempt = importAndLoad();
    loading = attempt;
    setStatus({ state: 'loading', error: null });
    attempt.then(
      (faceapi) => {
        api = faceapi;
        failures = 0;
        setStatus({ state: 'ready', error: null });
      },
      (err: unknown) => {
        console.error('Gesichtserkennung konnte nicht geladen werden:', err);
        if (loading === attempt) loading = null;
        failures += 1;
        setStatus({ state: 'error', error: LOAD_ERROR });
        scheduleRetry();
      },
    );
  }
  return loading.then(
    () => true,
    () => false,
  );
}

const normalizeInputSize = (size: number): number =>
  FACE_INPUT_SIZES.includes(size) ? size : 224;

const normalizeThreshold = (threshold: number): number =>
  Number.isFinite(threshold) ? Math.min(0.95, Math.max(0.05, threshold)) : 0.5;

async function runDetection(video: HTMLVideoElement, options: FaceDetectOptions): Promise<FaceDetectionResult | null> {
  const faceapi = api;
  if (!faceapi) throw new Error('Gesichtserkennung ist nicht geladen.');
  // face-api waits for a 'load' event that a <video> never fires – with
  // readyState < 3 the call would hang forever.
  if (video.readyState < HAVE_FUTURE_DATA || video.videoWidth === 0 || video.videoHeight === 0) {
    // A stream whose play() was refused never gets a frame – ask again.
    if (video.paused && video.srcObject) video.play().catch(() => undefined);
    return null;
  }
  const width = video.videoWidth;
  const height = video.videoHeight;
  const detections = await faceapi.detectAllFaces(
    video,
    new faceapi.TinyFaceDetectorOptions({
      inputSize: normalizeInputSize(options.inputSize),
      scoreThreshold: normalizeThreshold(options.scoreThreshold),
    }),
  );
  return {
    faces: detections.map((d) => ({ x: d.box.x, y: d.box.y, width: d.box.width, height: d.box.height, score: d.score })),
    width,
    height,
  };
}

/**
 * Detects faces in the current video frame. Resolves null while the video has
 * no frame – callers must not take that as "nobody there" for long. Calls from
 * all widgets run one after another (one model, one GPU context).
 */
export function detectFaces(video: HTMLVideoElement, options: FaceDetectOptions): Promise<FaceDetectionResult | null> {
  const run = detectQueue.then(() => runDetection(video, options));
  detectQueue = run.catch(() => undefined);
  return run;
}

// ── Presence ─────────────────────────────────────────────────────────────────

/** eventBus event of the camera widget: whether it currently sees people. */
export const PRESENCE_EVENT = 'presence:changed';

export interface PresenceEvent {
  present: boolean;
  count: number;
}

let presence: PresenceEvent = { present: false, count: 0 };

/** Last published presence – for widgets mounted later. */
export const currentPresence = (): PresenceEvent => presence;

export function isPresenceEvent(data: unknown): data is PresenceEvent {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as PresenceEvent).present === 'boolean' &&
    typeof (data as PresenceEvent).count === 'number'
  );
}

/** Emits PRESENCE_EVENT when presence or count changed (debouncing is up to the caller). */
export function publishPresence(next: PresenceEvent): void {
  if (next.present === presence.present && next.count === presence.count) return;
  presence = { present: next.present, count: next.count };
  eventBus.emit(PRESENCE_EVENT, presence);
}
