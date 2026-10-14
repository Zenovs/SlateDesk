import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { publishPresence } from '../services/faceDetector';
import type { DisplaySchedule } from '../state/types';
import { eventBus } from '../utils/eventBus';
import { DISPLAY_SWITCHED_EVENT, isScheduledOn, runDisplaySchedule, type DisplayScheduleStatus } from './useDisplaySchedule';

const weekdays: DisplaySchedule = { enabled: true, on: '07:00', off: '19:00', days: [1, 2, 3, 4, 5] };
// 2026-10-12 is a Monday.
const at = (day: number, time: string) => new Date(`2026-10-${String(12 + day).padStart(2, '0')}T${time}:00`);

describe('isScheduledOn', () => {
  it('is always on when the schedule is disabled', () => {
    expect(isScheduledOn({ ...weekdays, enabled: false }, at(6, '03:00'))).toBe(true);
  });

  it('follows the daytime window on scheduled days', () => {
    expect(isScheduledOn(weekdays, at(0, '06:59'))).toBe(false);
    expect(isScheduledOn(weekdays, at(0, '07:00'))).toBe(true);
    expect(isScheduledOn(weekdays, at(0, '18:59'))).toBe(true);
    expect(isScheduledOn(weekdays, at(0, '19:00'))).toBe(false);
  });

  it('stays off on days that are not scheduled', () => {
    expect(isScheduledOn(weekdays, at(5, '12:00'))).toBe(false); // Saturday
    expect(isScheduledOn(weekdays, at(6, '12:00'))).toBe(false); // Sunday
  });

  it('assigns an overnight window to the day it starts on', () => {
    const night: DisplaySchedule = { enabled: true, on: '18:00', off: '02:00', days: [5] }; // Friday night
    expect(isScheduledOn(night, at(4, '17:59'))).toBe(false);
    expect(isScheduledOn(night, at(4, '23:00'))).toBe(true);
    expect(isScheduledOn(night, at(5, '01:59'))).toBe(true); // Saturday early morning
    expect(isScheduledOn(night, at(5, '02:00'))).toBe(false);
    expect(isScheduledOn(night, at(5, '20:00'))).toBe(false);
  });

  it('treats identical on/off times as on all day', () => {
    expect(isScheduledOn({ ...weekdays, on: '08:00', off: '08:00' }, at(2, '03:00'))).toBe(true);
    expect(isScheduledOn({ ...weekdays, on: '08:00', off: '08:00' }, at(6, '03:00'))).toBe(false);
  });
});

describe('runDisplaySchedule', () => {
  const MINUTE = 60_000;
  let stop: (() => void) | null = null;
  let target: EventTarget;
  let statuses: DisplayScheduleStatus[];
  let sleep: Mock<() => Promise<unknown>>;
  let wake: Mock<() => Promise<unknown>>;

  const start = (schedule: DisplaySchedule = weekdays) => {
    stop = runDisplaySchedule(
      schedule,
      { applied: null, wakeUntil: 0, sequence: 0 },
      { target, canSwitch: true, sleep, wake, setStatus: (status) => statuses.push(status) },
    );
    vi.advanceTimersByTime(0);
  };
  const move = (x: number, y: number) => target.dispatchEvent(Object.assign(new Event('pointermove'), { screenX: x, screenY: y }));
  const last = () => statuses[statuses.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(0, '22:00')); // Monday night – scheduled off
    target = new EventTarget();
    statuses = [];
    sleep = vi.fn(() => Promise.resolve('test'));
    wake = vi.fn(() => Promise.resolve('test'));
  });

  afterEach(() => {
    stop?.();
    stop = null;
    publishPresence({ present: false, count: 0 });
    vi.useRealTimers();
  });

  it('switches off outside the on-times and repeats it while off', () => {
    start();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(last()).toEqual({ active: false, blackout: false });
    // Woken behind its back (web UI, input outside the webview): switched off again.
    vi.advanceTimersByTime(10 * MINUTE);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(wake).not.toHaveBeenCalled();
  });

  it('does not repeat switching off while the camera sees someone', () => {
    start();
    publishPresence({ present: true, count: 1 });
    vi.advanceTimersByTime(20 * MINUTE);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('wakes on a real pointer move, not on a resting pointer', () => {
    start();
    vi.advanceTimersByTime(5000);
    move(10, 10);
    move(10, 10);
    expect(wake).not.toHaveBeenCalled();
    move(14, 10);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(last()).toEqual({ active: true, blackout: false });
    // Back off once nobody uses it for 5 minutes.
    vi.advanceTimersByTime(5 * MINUTE + 30_000);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(last().active).toBe(false);
  });

  it('ignores pointer moves right after switching off', () => {
    start();
    move(10, 10);
    move(40, 40);
    expect(wake).not.toHaveBeenCalled();
  });

  it('wakes on the mouse wheel', () => {
    start();
    target.dispatchEvent(new Event('wheel'));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('retries a failed switch-on, but not on every pointer move', async () => {
    start();
    wake.mockImplementationOnce(() => Promise.reject(new Error('kein Ausgang')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    target.dispatchEvent(new Event('wheel'));
    expect(wake).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);

    // A burst of input right after the failure does not hammer the backend.
    target.dispatchEvent(new Event('wheel'));
    target.dispatchEvent(new Event('pointerdown'));
    expect(wake).toHaveBeenCalledTimes(1);

    // The next evaluation tries again (the touch still counts), and then it stays on.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(last().active).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('follows the web UI: «an» wakes like a touch, «aus» holds the display off until touched', () => {
    start();
    eventBus.emit(DISPLAY_SWITCHED_EVENT, { on: true });
    expect(last().active).toBe(true);

    vi.setSystemTime(at(1, '10:00')); // Tuesday, scheduled on
    vi.advanceTimersByTime(30_000);
    expect(last().active).toBe(true);
    eventBus.emit(DISPLAY_SWITCHED_EVENT, { on: false });
    expect(last().active).toBe(false);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(last().active).toBe(false);
    target.dispatchEvent(new Event('pointerdown'));
    expect(last().active).toBe(true);
  });
});
