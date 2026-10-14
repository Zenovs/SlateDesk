/**
 * sleeperController – display power of the Ruhemodus with a fake camera,
 * detector and display backend (fake timers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KioskAction } from '../utils/backend';
import type { FaceDetectionResult } from './faceDetector';
import { NO_FRAMES, SleeperController } from './sleeperController';

const mocks = vi.hoisted(() => ({
  wakeDisplay: vi.fn<() => Promise<string>>(),
  sleepDisplay: vi.fn<() => Promise<string>>(),
  detectFaces: vi.fn<() => Promise<FaceDetectionResult | null>>(),
  kioskAction: null as ((action: KioskAction) => void) | null,
}));

vi.mock('../utils/backend', () => ({
  isTauri: () => true,
  wakeDisplay: mocks.wakeDisplay,
  sleepDisplay: mocks.sleepDisplay,
  onKioskAction: (handler: (action: KioskAction) => void) => {
    mocks.kioskAction = handler;
    return () => {
      mocks.kioskAction = null;
    };
  },
}));

vi.mock('../hooks/useDisplaySchedule', () => ({
  DISPLAY_SCHEDULE_EVENT: 'display:schedule',
  isDisplayScheduleActive: () => true,
  isScheduledOn: () => true,
}));

vi.mock('../state/appState', () => ({
  useAppState: { getState: () => ({ state: { kiosk: { displaySchedule: { enabled: false } } } }) },
}));

vi.mock('./cameraService', () => ({
  CameraSession: class {
    private wanted = false;
    get current() {
      return { status: this.wanted ? 'on' : 'off', error: null, notice: null, label: '' };
    }
    update(wanted: boolean): void {
      this.wanted = wanted;
    }
    retry(): void {}
    attach(): void {}
  },
}));

vi.mock('./faceDetector', () => ({
  FACE_INPUT_SIZES: [128, 160, 224, 320, 416],
  PRESENCE_EVENT: 'presence:changed',
  currentPresence: () => ({ present: false, count: 0 }),
  isPresenceEvent: () => false,
  detectFaces: mocks.detectFaces,
  getFaceDetectorStatus: () => ({ state: 'ready', error: null }),
  loadFaceDetector: () => Promise.resolve(true),
  subscribeFaceDetector: () => () => {},
}));

type Controller = SleeperController;

const ASLEEP_KEY = 'slatedesk:sleeper:sleeper-1:asleep';
const TIMEOUT_MS = 60_000;
const nobody: FaceDetectionResult = { faces: [], width: 640, height: 480 };
const someone: FaceDetectionResult = { faces: [{ x: 1, y: 1, width: 50, height: 50, score: 0.9 }], width: 640, height: 480 };

class MemoryStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

let fakeWindow: EventTarget & { localStorage: MemoryStorage };
let controller: Controller | null = null;

function startController(): Controller {
  const c = new SleeperController('sleeper-1', {
    deviceId: '',
    timeoutMs: TIMEOUT_MS,
    dimFirst: false,
    respectSchedule: true,
    checkMs: 1000,
    scoreThreshold: 0.4,
    inputSize: 160,
  });
  c.mount();
  c.setVideo({} as HTMLVideoElement);
  c.start();
  controller = c;
  return c;
}

/** Runs until the display was switched off by the timeout. */
async function untilAsleep(c: Controller): Promise<void> {
  await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 2000);
  expect(c.getSnapshot().phase).toBe('schlaeft');
  expect(mocks.sleepDisplay).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-13T10:00:00'));
  fakeWindow = Object.assign(new EventTarget(), { localStorage: new MemoryStorage() });
  vi.stubGlobal('window', fakeWindow);
  mocks.wakeDisplay.mockReset().mockResolvedValue('gnome-mutter');
  mocks.sleepDisplay.mockReset().mockResolvedValue('gnome-mutter');
  mocks.detectFaces.mockReset().mockResolvedValue(nobody);
});

afterEach(() => {
  controller?.unmount();
  controller = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SleeperController – switching on', () => {
  it('retries a failed switch-on and keeps the asleep flag until the display is on', async () => {
    const c = startController();
    await untilAsleep(c);
    expect(fakeWindow.localStorage.getItem(ASLEEP_KEY)).toBe('1');

    mocks.wakeDisplay.mockRejectedValueOnce(new Error('gdbus: Zeitüberschreitung'));
    mocks.detectFaces.mockResolvedValue(someone);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.wakeDisplay).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toMatchObject({ phase: 'aktiv', wakeFailed: true });
    // Still off – an app restart has to switch it on.
    expect(fakeWindow.localStorage.getItem(ASLEEP_KEY)).toBe('1');

    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.wakeDisplay).toHaveBeenCalledTimes(2);
    expect(c.getSnapshot().wakeFailed).toBe(false);
    expect(fakeWindow.localStorage.getItem(ASLEEP_KEY)).toBeNull();
  });

  it('lets a touch try a failed switch-on again – also in phase aktiv', async () => {
    const c = startController();
    await untilAsleep(c);
    mocks.wakeDisplay.mockRejectedValue(new Error('gdbus: Zeitüberschreitung'));
    const touch = async () => {
      fakeWindow.dispatchEvent(new Event('pointerdown'));
      await vi.advanceTimersByTimeAsync(0);
    };
    await touch();
    expect(mocks.wakeDisplay).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toMatchObject({ phase: 'aktiv', wakeFailed: true });

    // First automatic retry after 5 s, the next one only after 30 s more.
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.wakeDisplay).toHaveBeenCalledTimes(2);
    // Touches right after an attempt do not hammer the backend.
    await vi.advanceTimersByTimeAsync(1000);
    await touch();
    expect(mocks.wakeDisplay).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(9000);
    mocks.wakeDisplay.mockResolvedValue('gnome-mutter');
    await touch();
    expect(mocks.wakeDisplay).toHaveBeenCalledTimes(3);
    expect(c.getSnapshot().wakeFailed).toBe(false);
    expect(fakeWindow.localStorage.getItem(ASLEEP_KEY)).toBeNull();
  });
});

describe('SleeperController – camera without image', () => {
  it('never switches the display off without an analysed frame', async () => {
    mocks.detectFaces.mockResolvedValue(null);
    const c = startController();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.getSnapshot().phase).toBe('startet');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(c.getSnapshot()).toMatchObject({ phase: 'fehler', error: NO_FRAMES });
    await vi.advanceTimersByTimeAsync(10 * TIMEOUT_MS);
    expect(mocks.sleepDisplay).not.toHaveBeenCalled();
  });

  it('switches the display on again when the frames stop while it is off', async () => {
    const c = startController();
    await untilAsleep(c);
    mocks.detectFaces.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(c.getSnapshot().phase).toBe('fehler');
    expect(mocks.wakeDisplay).toHaveBeenCalledTimes(1);

    // Frames again: the Ruhemodus watches again.
    mocks.detectFaces.mockResolvedValue(nobody);
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.getSnapshot().phase).toBe('aktiv');
  });
});

describe('SleeperController – Fernsteuerung', () => {
  it('lifts its veil when the display is switched on remotely', async () => {
    const c = startController();
    await untilAsleep(c);
    mocks.kioskAction?.({ action: 'display-wake' as KioskAction['action'] });
    expect(c.getSnapshot()).toMatchObject({ phase: 'aktiv', veil: 'none' });
    expect(fakeWindow.localStorage.getItem(ASLEEP_KEY)).toBeNull();
    // The backend already switched it on.
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.wakeDisplay).not.toHaveBeenCalled();
    // And the countdown starts over.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 5000);
    expect(mocks.sleepDisplay).toHaveBeenCalledTimes(1);
  });

  it('takes over a remote switch-off: a person wakes it after a moment, stopping leaves it off', async () => {
    const c = startController();
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.getSnapshot().phase).toBe('aktiv');
    mocks.detectFaces.mockResolvedValue(someone);
    mocks.kioskAction?.({ action: 'display-sleep' as KioskAction['action'] });
    expect(c.getSnapshot().phase).toBe('schlaeft');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.wakeDisplay).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(mocks.wakeDisplay).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().phase).toBe('aktiv');
    expect(mocks.sleepDisplay).not.toHaveBeenCalled();
  });

  it('does not switch a remotely switched-off display on when stopped', async () => {
    const c = startController();
    await vi.advanceTimersByTimeAsync(2000);
    mocks.kioskAction?.({ action: 'display-sleep' as KioskAction['action'] });
    c.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.wakeDisplay).not.toHaveBeenCalled();
    expect(c.getSnapshot().phase).toBe('aus');
  });
});
