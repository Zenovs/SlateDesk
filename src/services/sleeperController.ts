/**
 * sleeperController – presence detection and display power of one Ruhemodus
 * widget instance (id 'sleeper'), outside React. The widget renders its
 * snapshot; see SleeperWidget for the behaviour in short.
 *
 * Who switched the display off decides who may switch it on again: this
 * controller (also on stop, unmount and the next app start – flag in
 * localStorage, cleared only once the display is really on), the display
 * schedule or the Fernsteuerung. A failed switch-on is retried with backoff
 * and by the next touch or detected face. The display is only switched off
 * while the camera delivers frames that are actually analysed.
 */
import { DISPLAY_SCHEDULE_EVENT, isDisplayScheduleActive, isScheduledOn } from '../hooks/useDisplaySchedule';
import { useAppState } from '../state/appState';
import { isTauri, onKioskAction, sleepDisplay, wakeDisplay, type KioskAction } from '../utils/backend';
import { eventBus } from '../utils/eventBus';
import {
  SLEEPER_CHECK_LIMITS,
  SLEEPER_DEFAULT_SETTINGS,
  SLEEPER_DIM_SECONDS,
  SLEEPER_TIMEOUT_LIMITS,
  type SleeperSettings,
} from '../widgets/manifests/sleeper';
import { CameraSession } from './cameraService';
import {
  currentPresence,
  detectFaces,
  FACE_INPUT_SIZES,
  getFaceDetectorStatus,
  isPresenceEvent,
  loadFaceDetector,
  PRESENCE_EVENT,
  subscribeFaceDetector,
} from './faceDetector';

export interface SleeperConfig {
  deviceId: string;
  timeoutMs: number;
  dimFirst: boolean;
  respectSchedule: boolean;
  checkMs: number;
  scoreThreshold: number;
  inputSize: number;
}

type DisplayPhase = 'aktiv' | 'dimmt' | 'schlaeft';
export type SleeperPhase = 'aus' | 'startet' | 'zeitplan' | 'fehler' | DisplayPhase;
/** Full-screen overlay: dim = dark before switching off, black = off, clear = swallows the waking tap. */
export type Veil = 'none' | 'dim' | 'black' | 'clear';

export interface SleeperSnapshot {
  phase: SleeperPhase;
  running: boolean;
  /** German, in phase 'fehler'. */
  error: string | null;
  /** E.g. that another camera stands in for the chosen one. */
  notice: string | null;
  /** Rounded up, only in phase 'aktiv'. */
  minutesLeft: number | null;
  present: boolean;
  veil: Veil;
  /** The last switch-off failed – a black overlay stands in. */
  displayUnavailable: boolean;
  /** Switching the display on failed – it is retried. */
  wakeFailed: boolean;
}

const TICK_MS = 1000;
const DIM_MS = SLEEPER_DIM_SECONDS * 1000;
/** After a (re)start the detection gets this long to see someone before dimming. */
const STARTUP_GRACE_MS = 60_000;
/** Switching outputs off can move the pointer – such moves must not wake the display right away. */
const POINTER_MOVE_GRACE_MS = 3000;
const CLEAR_VEIL_MS = 700;
const PERSIST_EVERY_MS = 15_000;
/** Consecutive detection errors until the Ruhemodus stops relying on the camera. */
const MAX_DETECT_FAILURES = 5;
/** Without an analysed video frame for this long the camera counts as broken. */
const NO_FRAME_MS = 30_000;
/** Retries of a failed switch-on; the last delay repeats while the widget is mounted. */
const WAKE_RETRY_MS = [5_000, 30_000, 120_000] as const;
/** A touch or detected face tries a failed switch-on again at most this often. */
const WAKE_ON_ACTIVITY_GAP_MS = 10_000;
/** After «Bildschirm aus» in the Fernsteuerung a detected face wakes the display only after this – so whoever switched it off can leave. */
const REMOTE_OFF_GRACE_MS = 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
export const DISPLAY_UNAVAILABLE = 'Bildschirm-Steuerung nicht verfügbar';
export const NO_FRAMES = 'Die Kamera liefert kein Bild.';
export const WAKE_FAILED = 'Bildschirm liess sich nicht einschalten – neuer Versuch läuft';

export const OFF_SNAPSHOT: SleeperSnapshot = {
  phase: 'aus',
  running: false,
  error: null,
  notice: null,
  minutesLeft: null,
  present: false,
  veil: 'none',
  displayUnavailable: false,
  wakeFailed: false,
};

export const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

export function toConfig(settings: SleeperSettings): SleeperConfig {
  const defaults = SLEEPER_DEFAULT_SETTINGS;
  const timeoutMinutes = clampNumber(
    settings.timeoutMinutes,
    SLEEPER_TIMEOUT_LIMITS.min,
    SLEEPER_TIMEOUT_LIMITS.max,
    defaults.timeoutMinutes,
  );
  const checkSeconds = clampNumber(
    settings.checkEverySeconds,
    SLEEPER_CHECK_LIMITS.min,
    SLEEPER_CHECK_LIMITS.max,
    defaults.checkEverySeconds,
  );
  return {
    deviceId: typeof settings.deviceId === 'string' ? settings.deviceId : '',
    timeoutMs: timeoutMinutes * 60_000,
    dimFirst: bool(settings.dimFirst, defaults.dimFirst),
    respectSchedule: bool(settings.respectSchedule, defaults.respectSchedule),
    checkMs: checkSeconds * 1000,
    scoreThreshold: clampNumber(settings.scoreThreshold, 0.1, 0.9, defaults.scoreThreshold),
    inputSize: FACE_INPUT_SIZES.includes(settings.inputSize) ? settings.inputSize : defaults.inputSize,
  };
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: only the recovery after a restart is lost.
  }
}

function scheduleEventActive(data: unknown): boolean {
  if (typeof data === 'object' && data !== null && 'active' in data && typeof data.active === 'boolean') {
    return data.active;
  }
  return isDisplayScheduleActive();
}

// ── Controller ───────────────────────────────────────────────────────────────

/** Presence detection and display power of one widget instance – outside React. */
export class SleeperController {
  private readonly listeners = new Set<() => void>();
  private readonly session = new CameraSession(() => this.sync());
  private readonly asleepKey: string;
  private readonly lastSeenKey: string;
  private snapshot: SleeperSnapshot = OFF_SNAPSHOT;
  private config: SleeperConfig;
  private mounted = false;
  private running = false;
  private startedBefore = false;
  private video: HTMLVideoElement | null = null;
  private teardown: (() => void) | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private scheduleActive = true;
  /** Last 'presence:changed' of the camera widget. */
  private cameraPresent = false;
  private faces = 0;
  private lastSeen = 0;
  private persistedSeen = 0;
  /** Camera and detection work, so the display may be switched off. */
  private watching = false;
  private displayPhase: DisplayPhase = 'aktiv';
  private dimUntil = 0;
  private sleptAt = 0;
  /**
   * Who has the display off: this widget (switch it on again when done), the schedule
   * (only a detected person may wake it, with respectSchedule off), the Fernsteuerung
   * (a touch or detected person may wake it) or nobody. Stays set until a switch-on
   * has succeeded.
   */
  private displayOff: 'sleeper' | 'schedule' | 'remote' | null = null;
  private displayRequest = 0;
  private displayQueue: Promise<unknown> = Promise.resolve();
  private displayUnavailable = false;
  /** The last switch-on failed: the display is probably still off. */
  private wakeFailed = false;
  private wakeAttempts = 0;
  private wakeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastWakeAt = 0;
  /** Until then a detected face does not wake a display the Fernsteuerung switched off. */
  private remoteOffUntil = 0;
  private veil: Veil = 'none';
  private veilTimer: ReturnType<typeof setTimeout> | null = null;
  private loopActive = false;
  private loopGeneration = 0;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private detectFailures = 0;
  /** Last analysed video frame, or the loop start before the first one. */
  private frameAt = 0;
  private framesSeen = false;
  /** The camera is on but has delivered no frame for NO_FRAME_MS. */
  private noFrames = false;

  constructor(instanceId: string, config: SleeperConfig) {
    this.asleepKey = `slatedesk:sleeper:${instanceId}:asleep`;
    this.lastSeenKey = `slatedesk:sleeper:${instanceId}:lastSeen`;
    this.config = config;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SleeperSnapshot => this.snapshot;

  setVideo = (video: HTMLVideoElement | null): void => {
    this.video = video;
    this.session.attach(video);
    this.sync();
  };

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.scheduleActive = isDisplayScheduleActive();
    this.cameraPresent = currentPresence().present;
    this.restoreDisplay(Date.now());

    const options: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, this.onActivity, options);
    eventBus.on(PRESENCE_EVENT, this.onPresence);
    eventBus.on(DISPLAY_SCHEDULE_EVENT, this.onSchedule);
    const stopDetectorWatch = subscribeFaceDetector(() => this.sync());
    const stopKioskActions = onKioskAction(this.onKioskAction);
    this.teardown = () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, this.onActivity, options);
      eventBus.off(PRESENCE_EVENT, this.onPresence);
      eventBus.off(DISPLAY_SCHEDULE_EVENT, this.onSchedule);
      stopDetectorWatch();
      stopKioskActions();
    };
    this.sync();
  }

  unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;
    this.teardown?.();
    this.teardown = null;
    // Releases the camera and switches a display this widget turned off on again.
    this.sync();
    this.setVeil('none');
    writeStorage(this.lastSeenKey, null);
  }

  configure(config: SleeperConfig): void {
    const prev = this.config;
    this.config = config;
    // Detect with the new values right away instead of after the current wait.
    const detectionChanged =
      prev.checkMs !== config.checkMs ||
      prev.scoreThreshold !== config.scoreThreshold ||
      prev.inputSize !== config.inputSize;
    if (detectionChanged && this.loopActive) this.restartLoop();
    // The timeout is read on every tick, so a change applies at once.
    this.sync();
  }

  /** Manual start: the countdown starts from now. */
  start = (): void => this.begin(false);

  /** Auto-start continues the countdown of the previous run (app restart). */
  autoStart = (): void => this.begin(true);

  stop = (): void => {
    if (!this.running) return;
    this.running = false;
    this.sync();
  };

  retry = (): void => {
    this.session.retry();
    if (getFaceDetectorStatus().state === 'error') void loadFaceDetector();
    if (this.noFrames) this.resetFrames();
    if (this.detectFailures > 0 && this.loopActive) this.restartLoop();
    this.sync();
  };

  /** Switches the display off right away (to test the display control). */
  sleepNow = (): void => {
    if (!this.watching || this.displayPhase === 'schlaeft') return;
    this.enterSleep(Date.now());
    this.publish();
  };

  private begin(keepLastSeen: boolean): void {
    if (this.running) return;
    this.running = true;
    if (!keepLastSeen || this.startedBefore) this.lastSeen = Date.now();
    this.startedBefore = true;
    this.sync();
  }

  /** A previous run (crash, restart, reload) may have left the display off. */
  private restoreDisplay(now: number): void {
    if (readStorage(this.asleepKey) === '1') {
      const schedule = useAppState.getState().state.kiosk.displaySchedule;
      if (isScheduledOn(schedule, new Date(now))) {
        // The flag is cleared once the display is really on.
        this.displayOff = 'sleeper';
        this.requestDisplay(true);
      } else {
        // While the schedule wants it off, waking it would race with the schedule switching it off.
        writeStorage(this.asleepKey, null);
      }
    }
    const stored = Number(readStorage(this.lastSeenKey));
    this.lastSeen = Number.isFinite(stored) && stored > 0 && stored <= now ? stored : now;
    this.persistedSeen = this.lastSeen;
  }

  private isPaused(): boolean {
    return this.config.respectSchedule && !this.scheduleActive;
  }

  private sync(): void {
    const wantCamera = this.mounted && this.running && !this.isPaused();
    this.session.update(wantCamera, this.config.deviceId);
    if (wantCamera && getFaceDetectorStatus().state === 'idle') void loadFaceDetector();
    const detectorReady = getFaceDetectorStatus().state === 'ready';
    this.setLoop(wantCamera && detectorReady && this.session.current.status === 'on' && this.video !== null);
    this.setTicking(wantCamera);
    this.updateWatching();
    this.publish();
  }

  private updateWatching(): void {
    // Only once a frame was analysed – a camera without image would otherwise switch the display off.
    const watching =
      this.mounted &&
      this.running &&
      !this.isPaused() &&
      this.loopActive &&
      this.framesSeen &&
      !this.noFrames &&
      this.detectFailures < MAX_DETECT_FAILURES;
    if (watching === this.watching) return;
    this.watching = watching;
    if (watching) {
      const now = Date.now();
      this.lastSeen = Math.max(this.lastSeen, now - this.config.timeoutMs + STARTUP_GRACE_MS);
      // Only reachable with respectSchedule off (otherwise the schedule pauses us).
      if (!this.scheduleActive) this.adoptDisplayOff('schedule', now);
      return;
    }
    // Without detection nobody could wake the display – switch it back on. Unless the
    // schedule paused us: it has switched the display off itself and owns it now.
    const pausedBySchedule = this.mounted && this.running && this.isPaused();
    this.leaveDisplayPhase(!pausedBySchedule);
  }

  private setTicking(on: boolean): void {
    if (on && this.tickTimer === null) {
      this.tickTimer = setInterval(this.tick, TICK_MS);
    } else if (!on && this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private tick = (): void => {
    if (!this.watching) return;
    const now = Date.now();
    // The camera widget still sees someone (it only reports changes).
    if (this.cameraPresent) this.notePresence(now, false);
    if (this.displayPhase === 'aktiv' && now - this.lastSeen >= this.config.timeoutMs) {
      if (this.config.dimFirst) this.enterDim(now);
      else this.enterSleep(now);
    } else if (this.displayPhase === 'dimmt' && now >= this.dimUntil) {
      this.enterSleep(now);
    }
    this.persistLastSeen(false);
    this.publish();
  };

  private onActivity = (event: Event): void => {
    const now = Date.now();
    if (!this.watching) {
      this.retryFailedWake(now);
      return;
    }
    if (event.type === 'pointermove' && this.displayPhase === 'schlaeft' && now - this.sleptAt < POINTER_MOVE_GRACE_MS) {
      return;
    }
    this.notePresence(now, true);
  };

  private onPresence = (data: unknown): void => {
    if (!isPresenceEvent(data)) return;
    this.cameraPresent = data.present;
    if (data.present) this.notePresence(Date.now(), false);
  };

  private onSchedule = (data: unknown): void => {
    const active = scheduleEventActive(data);
    if (active === this.scheduleActive) return;
    this.scheduleActive = active;
    const now = Date.now();
    if (active) {
      // The schedule has switched the display on: count from now, lift our veil and
      // stop a switch-on of ours that is still pending or failed.
      this.lastSeen = now;
      if (this.displayPhase !== 'aktiv' || this.displayOff !== null) this.leaveDisplayPhase(false);
    } else if (this.watching && !this.config.respectSchedule) {
      this.adoptDisplayOff('schedule', now);
    }
    // With respectSchedule the schedule now pauses us (and owns the display).
    this.sync();
  };

  /**
   * «Bildschirm an/aus» from the Fernsteuerung – the backend has already switched
   * the display; without this the Ruhemodus would not know it.
   */
  private onKioskAction = ({ action }: KioskAction): void => {
    const name: string = action;
    const now = Date.now();
    if (name === 'display-wake') {
      // Someone wants to see the dashboard: lift the veil and count from now.
      this.lastSeen = now;
      this.leaveDisplayPhase(false);
    } else if (name === 'display-sleep') {
      if (!this.watching) return;
      // Like an own switch-off, except that stopping the Ruhemodus leaves the display off.
      this.remoteOffUntil = now + REMOTE_OFF_GRACE_MS;
      this.adoptDisplayOff('remote', now);
    } else {
      return;
    }
    this.publish();
  };

  private notePresence(now: number, byInput: boolean): void {
    if (!this.watching) return;
    this.lastSeen = now;
    if (this.displayPhase === 'aktiv') {
      this.retryFailedWake(now);
      return;
    }
    if (!byInput && this.displayOff === 'remote' && now < this.remoteOffUntil) return;
    this.wake(byInput);
    this.publish();
  }

  private persistLastSeen(force: boolean): void {
    if (!force && this.lastSeen - this.persistedSeen < PERSIST_EVERY_MS) return;
    this.persistedSeen = this.lastSeen;
    writeStorage(this.lastSeenKey, String(this.lastSeen));
  }

  // ── Display ──

  private enterDim(now: number): void {
    this.displayPhase = 'dimmt';
    this.dimUntil = now + DIM_MS;
    this.setVeil('dim');
  }

  private enterSleep(now: number): void {
    this.displayPhase = 'schlaeft';
    this.sleptAt = now;
    this.setVeil('black');
    writeStorage(this.asleepKey, '1');
    this.persistLastSeen(true);
    this.requestDisplay(false);
  }

  /**
   * The schedule (with respectSchedule off) or the Fernsteuerung has switched the
   * display off – a detected person or a touch may wake it.
   */
  private adoptDisplayOff(owner: 'schedule' | 'remote', now: number): void {
    if (this.displayPhase === 'schlaeft') return;
    // A pending or failed switch-on of ours must not wake it again.
    writeStorage(this.asleepKey, null);
    this.releaseDisplay();
    this.displayOff = owner;
    this.displayPhase = 'schlaeft';
    this.sleptAt = now;
    this.setVeil('black');
  }

  private wake(byInput: boolean): void {
    this.displayPhase = 'aktiv';
    // After a touch the veil stays (clear) for a moment, so the tap does not hit a widget underneath.
    this.setVeil(byInput ? 'clear' : 'none');
    // The asleep flag is cleared once the display is really on.
    if (this.displayOff) this.requestDisplay(true);
    else writeStorage(this.asleepKey, null);
  }

  /**
   * Back to 'aktiv' without a detected person (stop, error, unmount, schedule,
   * Fernsteuerung). `switchOn`: switch a display this widget turned off on again.
   * One the schedule or the Fernsteuerung turned off is left to them.
   */
  private leaveDisplayPhase(switchOn: boolean): void {
    this.displayPhase = 'aktiv';
    this.setVeil('none');
    if (this.displayOff === 'sleeper' && switchOn) {
      this.requestDisplay(true);
    } else {
      writeStorage(this.asleepKey, null);
      if (this.displayOff) this.releaseDisplay();
    }
  }

  /** The display is no longer ours to switch on: drops pending requests and retries. */
  private releaseDisplay(): void {
    this.displayOff = null;
    this.displayRequest += 1;
    this.clearWakeRetry();
    this.wakeFailed = false;
    this.wakeAttempts = 0;
  }

  /** A touch or detected face after a failed switch-on: the display is probably still off. */
  private retryFailedWake(now: number): void {
    if (!this.wakeFailed || this.displayOff === null || now - this.lastWakeAt < WAKE_ON_ACTIVITY_GAP_MS) return;
    this.requestDisplay(true);
  }

  private scheduleWakeRetry(): void {
    // After unmount only the first retries run; the asleep flag covers the next app start.
    if (!this.mounted && this.wakeAttempts >= WAKE_RETRY_MS.length) return;
    const delay = WAKE_RETRY_MS[Math.min(this.wakeAttempts, WAKE_RETRY_MS.length - 1)];
    this.wakeAttempts += 1;
    this.wakeRetryTimer = setTimeout(() => {
      this.wakeRetryTimer = null;
      if (this.wakeFailed && this.displayOff !== null) this.requestDisplay(true);
    }, delay);
  }

  private clearWakeRetry(): void {
    if (this.wakeRetryTimer !== null) clearTimeout(this.wakeRetryTimer);
    this.wakeRetryTimer = null;
  }

  /** Requests run one after the other, so the last one wins. */
  private requestDisplay(on: boolean): void {
    const request = ++this.displayRequest;
    this.clearWakeRetry();
    if (on) {
      this.lastWakeAt = Date.now();
    } else {
      this.displayOff = 'sleeper';
      this.wakeFailed = false;
      this.wakeAttempts = 0;
    }
    const run = this.displayQueue.then(() => (on ? wakeDisplay() : sleepDisplay()));
    this.displayQueue = run.catch(() => undefined);
    run.then(
      () => {
        if (request !== this.displayRequest) return;
        if (on) {
          this.displayOff = null;
          this.wakeFailed = false;
          this.wakeAttempts = 0;
          writeStorage(this.asleepKey, null);
        } else {
          this.displayUnavailable = false;
        }
        this.publish();
      },
      (err: unknown) => {
        if (isTauri()) console.warn(`Bildschirm konnte nicht ${on ? 'eingeschaltet' : 'ausgeschaltet'} werden:`, err);
        if (request !== this.displayRequest) return;
        if (on && isTauri()) {
          // The display stays off: try again – and with the next touch or detected face.
          this.wakeFailed = true;
          this.scheduleWakeRetry();
        } else {
          // Nothing is off (no display control outside the kiosk, or the switch-off
          // failed) – the black veil stands in for the switched-off display.
          this.displayOff = null;
          writeStorage(this.asleepKey, null);
          if (!on) this.displayUnavailable = true;
        }
        this.publish();
      },
    );
  }

  private setVeil(veil: Veil): void {
    if (this.veilTimer !== null) clearTimeout(this.veilTimer);
    this.veilTimer = null;
    this.veil = veil;
    if (veil !== 'clear') return;
    this.veilTimer = setTimeout(() => {
      this.veilTimer = null;
      this.veil = 'none';
      this.publish();
    }, CLEAR_VEIL_MS);
  }

  // ── Detection ──

  private setLoop(active: boolean): void {
    if (active === this.loopActive) return;
    this.loopActive = active;
    this.resetFrames();
    this.restartLoop();
  }

  /** A (re)started camera has to deliver a frame before the display may be switched off. */
  private resetFrames(): void {
    this.frameAt = Date.now();
    this.framesSeen = false;
    this.noFrames = false;
  }

  /** Also for changed detection settings – the frames keep coming then. */
  private restartLoop(): void {
    this.loopGeneration += 1;
    if (this.loopTimer !== null) clearTimeout(this.loopTimer);
    this.loopTimer = null;
    this.detectFailures = 0;
    this.faces = 0;
    if (this.loopActive) void this.detect(this.loopGeneration);
  }

  private async detect(generation: number): Promise<void> {
    const video = this.video;
    if (!video || generation !== this.loopGeneration) return;
    try {
      const result = await detectFaces(video, {
        inputSize: this.config.inputSize,
        scoreThreshold: this.config.scoreThreshold,
      });
      if (generation !== this.loopGeneration) return;
      this.detectFailures = 0;
      const now = Date.now();
      if (result) {
        this.frameAt = now;
        this.framesSeen = true;
        this.noFrames = false;
        this.faces = result.faces.length;
        // The first frame starts the watching – and its face already counts.
        this.updateWatching();
        if (this.faces > 0) this.notePresence(now, false);
      } else {
        // No frame (yet): nobody can be seen, so this must not count as "nobody there".
        this.noFrames = now - this.frameAt >= NO_FRAME_MS;
      }
    } catch (err) {
      if (generation !== this.loopGeneration) return;
      this.detectFailures += 1;
      if (this.detectFailures === 1) console.warn('Gesichtserkennung fehlgeschlagen:', err);
    }
    this.updateWatching();
    this.publish();
    this.loopTimer = setTimeout(() => void this.detect(generation), this.config.checkMs);
  }

  // ── Snapshot ──

  private publish(): void {
    const next = this.buildSnapshot();
    const prev = this.snapshot;
    const keys = Object.keys(next) as (keyof SleeperSnapshot)[];
    if (keys.every((key) => prev[key] === next[key])) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }

  private buildSnapshot(): SleeperSnapshot {
    const camera = this.session.current;
    const detector = getFaceDetectorStatus();
    let phase: SleeperPhase;
    let error: string | null = null;
    if (!this.running) {
      phase = 'aus';
    } else if (this.isPaused()) {
      phase = 'zeitplan';
    } else if (camera.status === 'error') {
      phase = 'fehler';
      error = camera.error;
    } else if (detector.state === 'error') {
      phase = 'fehler';
      error = detector.error;
    } else if (this.detectFailures >= MAX_DETECT_FAILURES) {
      phase = 'fehler';
      error = 'Die Gesichtserkennung ist gestört – neuer Versuch läuft.';
    } else if (this.noFrames) {
      phase = 'fehler';
      error = NO_FRAMES;
    } else if (!this.watching) {
      phase = 'startet';
    } else {
      phase = this.displayPhase;
    }
    const remainingMs = this.lastSeen + this.config.timeoutMs - Date.now();
    return {
      phase,
      running: this.running,
      error,
      notice: camera.notice,
      minutesLeft: phase === 'aktiv' ? Math.max(1, Math.ceil(remainingMs / 60_000)) : null,
      present: this.watching && (this.faces > 0 || this.cameraPresent),
      veil: this.veil,
      displayUnavailable: this.displayUnavailable,
      wakeFailed: this.wakeFailed,
    };
  }
}
