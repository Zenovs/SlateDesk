/**
 * cameraService – one shared, ref-counted MediaStream per camera.
 *
 * The camera and the Ruhemodus widget use the same webcam, and a second
 * getUserMedia on a busy V4L2 device fails with NotReadableError. So every
 * user takes a lease: the first lease opens the camera, the last release
 * stops its tracks.
 *
 * - deviceId '' = default camera. It is never pinned to a concrete deviceId
 *   (ids change with WebKit's salt and USB re-enumeration) and shares any
 *   camera that is already open.
 * - getUserMedia calls run one after another, never concurrently.
 * - a camera whose track ends (unplugged, driver error) is dropped and its
 *   holders are told via `onEnded`; plugging devices in or out is forwarded
 *   by `onCameraDevicesChange`.
 *
 * `CameraSession` wraps a lease for a widget: keeps the camera open while
 * wanted, retries with backoff and binds the stream to a <video> element.
 */

export type CameraErrorKind = 'unsupported' | 'denied' | 'not-found' | 'busy' | 'aborted' | 'failed';

export class CameraError extends Error {
  readonly kind: CameraErrorKind;

  constructor(kind: CameraErrorKind, message: string) {
    super(message);
    this.name = 'CameraError';
    this.kind = kind;
  }
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export interface CameraLease {
  readonly stream: MediaStream;
  /** Device delivering the stream; '' when the browser does not report it. */
  readonly deviceId: string;
  readonly label: string;
  /** The requested camera could not be opened – another one is used instead. */
  readonly fallback: boolean;
  /** Called once when the camera stops delivering (unplugged, driver error). */
  onEnded(listener: () => void): () => void;
  /** Idempotent. The camera switches off when its last lease is released. */
  release(): void;
}

interface OpenCamera {
  stream: MediaStream;
  deviceId: string;
  label: string;
  /** Opened without a deviceId. */
  isDefault: boolean;
  refs: number;
  ended: boolean;
  endedListeners: Set<() => void>;
}

/** The next open waits at most this long for a hanging getUserMedia. */
const OPEN_SLOT_MS = 20_000;

const openCameras = new Set<OpenCamera>();
let openQueue: Promise<void> = Promise.resolve();
const deviceListeners = new Set<() => void>();

const noop = (): void => {};

function mediaDevices(): MediaDevices | null {
  if (typeof navigator === 'undefined') return null;
  const devices = navigator.mediaDevices as MediaDevices | undefined;
  return devices && typeof devices.getUserMedia === 'function' ? devices : null;
}

const abortError = (): CameraError => new CameraError('aborted', 'Kamerastart abgebrochen.');

function errorName(err: unknown): string {
  return typeof err === 'object' && err !== null && 'name' in err && typeof err.name === 'string' ? err.name : '';
}

/** Maps getUserMedia errors to German messages. `deviceId` = the requested camera. */
function toCameraError(err: unknown, deviceId = ''): CameraError {
  if (err instanceof CameraError) return err;
  switch (errorName(err)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return new CameraError('denied', 'Kamerazugriff verweigert – die Berechtigung im System erlauben.');
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new CameraError(
        'not-found',
        deviceId ? 'Die gewählte Kamera ist nicht angeschlossen.' : 'Keine Kamera gefunden – bitte eine Kamera anschliessen.',
      );
    case 'NotReadableError':
    case 'TrackStartError':
      return new CameraError(
        'busy',
        'Die Kamera ist belegt oder liefert kein Bild – wird sie von einem anderen Programm verwendet?',
      );
    default: {
      // Browser messages are English – keep them only as a hint for the technician.
      const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
      return new CameraError(
        'failed',
        detail ? `Die Kamera konnte nicht gestartet werden (${detail}).` : 'Die Kamera konnte nicht gestartet werden.',
      );
    }
  }
}

function constraintsFor(deviceId: string): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      // One stream serves the preview and the detection; 15 fps keep the decoding cheap.
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 15 },
    },
  };
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function notifyDevices(): void {
  for (const listener of [...deviceListeners]) {
    try {
      listener();
    } catch (err) {
      console.error('Fehler im Kamera-Geräte-Listener:', err);
    }
  }
}

function markEnded(camera: OpenCamera): void {
  if (camera.ended) return;
  camera.ended = true;
  openCameras.delete(camera);
  stopStream(camera.stream);
  for (const listener of [...camera.endedListeners]) listener();
  camera.endedListeners.clear();
}

function isLive(camera: OpenCamera): boolean {
  return !camera.ended && camera.stream.getVideoTracks().some((track) => track.readyState === 'live');
}

/** '' shares whatever camera is open (preferring one opened as default). */
function findOpen(deviceId: string): OpenCamera | undefined {
  const live = [...openCameras].filter(isLive);
  if (!deviceId) return live.find((camera) => camera.isDefault) ?? live[0];
  return live.find((camera) => camera.deviceId === deviceId);
}

async function openCamera(deviceId: string): Promise<OpenCamera> {
  const devices = mediaDevices();
  if (!devices) {
    throw new CameraError('unsupported', 'Kein Kamerazugriff möglich – diese Umgebung unterstützt keine Kameras.');
  }
  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia(constraintsFor(deviceId));
  } catch (err) {
    throw toCameraError(err, deviceId);
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopStream(stream);
    throw new CameraError('failed', 'Die Kamera liefert kein Videobild.');
  }
  const camera: OpenCamera = {
    stream,
    deviceId: track.getSettings().deviceId ?? '',
    label: track.label,
    isDefault: !deviceId,
    refs: 0,
    ended: false,
    endedListeners: new Set(),
  };
  track.addEventListener('ended', () => markEnded(camera), { once: true });
  openCameras.add(camera);
  // Device labels are only visible after the first successful open – let pickers reload.
  setTimeout(notifyDevices, 0);
  return camera;
}

function createLease(camera: OpenCamera, fallback: boolean): CameraLease {
  camera.refs += 1;
  let released = false;
  const own = new Set<() => void>();
  return {
    stream: camera.stream,
    deviceId: camera.deviceId,
    label: camera.label,
    fallback,
    onEnded(listener) {
      if (released) return noop;
      if (camera.ended) {
        queueMicrotask(listener);
        return noop;
      }
      own.add(listener);
      camera.endedListeners.add(listener);
      return () => {
        own.delete(listener);
        camera.endedListeners.delete(listener);
      };
    },
    release() {
      if (released) return;
      released = true;
      for (const listener of own) camera.endedListeners.delete(listener);
      own.clear();
      camera.refs -= 1;
      if (camera.refs > 0) return;
      openCameras.delete(camera);
      stopStream(camera.stream);
    },
  };
}

async function acquireInQueue(deviceId: string): Promise<CameraLease> {
  const shared = findOpen(deviceId);
  if (shared) return createLease(shared, false);
  try {
    return createLease(await openCamera(deviceId), false);
  } catch (err) {
    const error = toCameraError(err, deviceId);
    const missing = deviceId !== '' && error.kind === 'not-found';
    if (error.kind === 'busy' || missing) {
      // Busy: most likely our own stream under another id. Missing: any camera beats none.
      const other = findOpen('');
      if (other) return createLease(other, true);
      if (missing) return createLease(await openCamera(''), true);
    }
    throw error;
  }
}

/**
 * Leases the camera `deviceId` ('' = default). Aborting the signal rejects at
 * once; a camera opened after that is released again right away.
 */
export function acquireCamera(deviceId: string, signal?: AbortSignal): Promise<CameraLease> {
  if (signal?.aborted) return Promise.reject(abortError());

  const task = openQueue.then(() => {
    if (signal?.aborted) throw abortError();
    return acquireInQueue(deviceId);
  });
  openQueue = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, OPEN_SLOT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    task.then(done, done);
  });

  return new Promise<CameraLease>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    task.then(
      (lease) => {
        signal?.removeEventListener('abort', onAbort);
        // The caller is gone – the camera must not stay on.
        if (signal?.aborted) lease.release();
        else resolve(lease);
      },
      (err: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Video inputs with a usable deviceId; labels may be generic before the first open. */
export async function listCameras(): Promise<CameraDevice[]> {
  const devices = mediaDevices();
  if (!devices || typeof devices.enumerateDevices !== 'function') return [];
  const inputs = (await devices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
  return inputs.map((d, index) => ({ deviceId: d.deviceId, label: d.label.trim() || `Kamera ${index + 1}` }));
}

/** Cameras plugged in or out (and labels becoming visible). Returns the unsubscribe function. */
export function onCameraDevicesChange(listener: () => void): () => void {
  const devices = mediaDevices();
  deviceListeners.add(listener);
  if (deviceListeners.size === 1) devices?.addEventListener('devicechange', notifyDevices);
  return () => {
    if (!deviceListeners.delete(listener)) return;
    if (deviceListeners.size === 0) devices?.removeEventListener('devicechange', notifyDevices);
  };
}

// ── CameraSession ────────────────────────────────────────────────────────────

export type CameraSessionStatus = 'off' | 'starting' | 'on' | 'error';

export interface CameraSessionState {
  status: CameraSessionStatus;
  /** German; set while status is 'error' (also while an automatic retry runs). */
  error: string | null;
  /** Hint while running, e.g. that another camera stands in for the chosen one. */
  notice: string | null;
  /** Label of the camera in use. */
  label: string;
}

const SESSION_OFF: CameraSessionState = { status: 'off', error: null, notice: null, label: '' };
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Keeps a camera lease while wanted. `onChange` fires for changes the session
 * makes on its own (camera opened, failed, lost, retried) – never from
 * `update()`/`retry()`, whose effect callers read from `current` afterwards.
 */
export class CameraSession {
  private readonly onChange: () => void;
  private wanted = false;
  private deviceId = '';
  private lease: CameraLease | null = null;
  private pending: AbortController | null = null;
  private stopEnded: (() => void) | null = null;
  private stopDevices: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private lastError: CameraError | null = null;
  private video: HTMLVideoElement | null = null;
  private state: CameraSessionState = SESSION_OFF;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  get current(): CameraSessionState {
    return this.state;
  }

  /** Opens, keeps or closes the camera. Idempotent; another deviceId reopens it. */
  update(wanted: boolean, deviceId: string): void {
    if (wanted === this.wanted && deviceId === this.deviceId) return;
    const deviceChanged = deviceId !== this.deviceId;
    this.wanted = wanted;
    this.deviceId = deviceId;
    if (!wanted || deviceChanged) {
      this.close();
      this.resetErrors();
    }
    if (wanted) {
      this.watchDevices();
      this.open();
    } else {
      this.stopDevices?.();
      this.stopDevices = null;
    }
    this.refresh();
  }

  /** Tries again right away (after an error, or to leave a fallback camera). */
  retry(): void {
    if (!this.wanted) return;
    this.close();
    this.resetErrors();
    this.open();
    this.refresh();
  }

  /** The stream is shown in / detected from this element (null detaches it). */
  attach(video: HTMLVideoElement | null): void {
    if (video === this.video) return;
    if (this.video) this.video.srcObject = null;
    this.video = video;
    this.bindVideo();
  }

  dispose(): void {
    this.update(false, this.deviceId);
    this.attach(null);
  }

  private open(): void {
    if (!this.wanted || this.lease || this.pending || this.retryTimer) return;
    const pending = new AbortController();
    const deviceId = this.deviceId;
    this.pending = pending;
    acquireCamera(deviceId, pending.signal).then(
      (lease) => {
        if (this.pending !== pending) {
          lease.release();
          return;
        }
        this.pending = null;
        this.lease = lease;
        this.failures = 0;
        this.lastError = null;
        this.stopEnded = lease.onEnded(() => this.handleEnded(lease));
        this.bindVideo();
        this.changed();
      },
      (err: unknown) => {
        if (this.pending !== pending) return;
        this.pending = null;
        this.fail(toCameraError(err, deviceId));
      },
    );
  }

  private fail(error: CameraError): void {
    this.lastError = error;
    this.failures += 1;
    // A denial does not go away by itself – retried on device changes or by hand.
    if (error.kind !== 'denied' && error.kind !== 'unsupported') {
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1));
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.open();
        this.changed();
      }, delay);
    }
    this.changed();
  }

  private handleEnded(lease: CameraLease): void {
    if (lease !== this.lease) return;
    this.close();
    this.fail(new CameraError('failed', 'Die Verbindung zur Kamera ist unterbrochen.'));
  }

  private close(): void {
    this.pending?.abort();
    this.pending = null;
    this.stopEnded?.();
    this.stopEnded = null;
    if (this.video && this.lease && this.video.srcObject === this.lease.stream) this.video.srcObject = null;
    this.lease?.release();
    this.lease = null;
  }

  private resetErrors(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failures = 0;
    this.lastError = null;
  }

  private bindVideo(): void {
    const video = this.video;
    if (!video) return;
    const stream = this.lease?.stream ?? null;
    if (video.srcObject === stream) return;
    video.srcObject = stream;
    if (stream) {
      // Rejects when the stream is swapped before playback started – harmless.
      video.play().catch(noop);
    }
  }

  private watchDevices(): void {
    if (this.stopDevices) return;
    this.stopDevices = onCameraDevicesChange(() => {
      if (!this.wanted || this.pending) return;
      if (!this.lease) {
        // A camera was plugged in: retry now instead of waiting for the backoff.
        if (this.lastError) {
          this.retry();
          this.onChange();
        }
        return;
      }
      if (!this.lease.fallback || !this.deviceId) return;
      const wantedId = this.deviceId;
      listCameras()
        .then((cameras) => {
          if (this.lease?.fallback && this.deviceId === wantedId && cameras.some((c) => c.deviceId === wantedId)) {
            this.retry();
            this.onChange();
          }
        })
        .catch(noop);
    });
  }

  private changed(): void {
    this.refresh();
    this.onChange();
  }

  private refresh(): void {
    const lease = this.lease;
    let next: CameraSessionState;
    if (lease) {
      next = {
        status: 'on',
        error: null,
        notice: lease.fallback && this.deviceId ? 'Die gewählte Kamera ist nicht verfügbar – eine andere springt ein.' : null,
        label: lease.label,
      };
    } else if (this.lastError) {
      next = { status: 'error', error: this.lastError.message, notice: null, label: '' };
    } else if (this.wanted) {
      next = { status: 'starting', error: null, notice: null, label: '' };
    } else {
      next = SESSION_OFF;
    }
    const prev = this.state;
    if (
      prev.status !== next.status ||
      prev.error !== next.error ||
      prev.notice !== next.notice ||
      prev.label !== next.label
    ) {
      this.state = next;
    }
  }
}
