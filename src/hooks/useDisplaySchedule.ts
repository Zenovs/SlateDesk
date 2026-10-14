/**
 * useDisplaySchedule – switches the display off outside the configured
 * on-times (kiosk.displaySchedule) and on again when they start.
 *
 * - backend calls at transitions (plus once at start, to recover from a
 *   previous instance that left the display off); re-evaluated every 30 s
 * - any input while it is scheduled off – touch, key, wheel or a real pointer
 *   move (the compositor wakes the panel on those by itself) – counts as a
 *   wake for 5 minutes (extended while it is being used)
 * - while scheduled off, the display is switched off again every 10 minutes:
 *   something the hook never heard of (input outside the webview, the web
 *   UI's «Bildschirm an») may have woken it. Not while the camera sees
 *   someone – the Ruhemodus may have woken it for them.
 * - `display:switched` `{ on }` on the eventBus: someone else (the web UI)
 *   switched the display – «an» counts like a touch, «aus» holds it off until
 *   it is touched or the next on-time starts
 * - emits eventBus `display:schedule` `{ active }` on every transition;
 *   `active` = the display is on
 * - outside Tauri, or when no display backend works, a black overlay stands
 *   in for the switched-off display
 */
import { useEffect, useRef, useState } from 'react';
import { currentPresence, isPresenceEvent, PRESENCE_EVENT } from '../services/faceDetector';
import type { DisplaySchedule } from '../state/types';
import { isTauri, sleepDisplay, wakeDisplay } from '../utils/backend';
import { eventBus } from '../utils/eventBus';

export const DISPLAY_SCHEDULE_EVENT = 'display:schedule';
/** Emitted (App.tsx) when the display was switched outside this hook, e.g. from the web UI. */
export const DISPLAY_SWITCHED_EVENT = 'display:switched';

export interface DisplayScheduleEvent {
  /** true = display on (inside the on-times or woken by touch). */
  active: boolean;
}

export interface DisplaySwitchedEvent {
  on: boolean;
}

export interface DisplayScheduleStatus {
  /** Display is on. When false, a (transparent) overlay swallows the waking touch. */
  active: boolean;
  /** The display could not be switched off – show black instead. */
  blackout: boolean;
}

const EVALUATE_INTERVAL_MS = 30_000;
const TOUCH_WAKE_MS = 5 * 60_000;
/** Switching outputs off can move the pointer – such moves are no wake-up (as in the Ruhemodus). */
const POINTER_MOVE_GRACE_MS = 3000;
/** Switching off is idempotent – repeat it this often while the display should be off. */
const REASSERT_OFF_MS = 10 * 60_000;
/** After a failed switch-on, input retries at most this often (pointer moves come in bursts). */
const WAKE_RETRY_MS = 10_000;

let currentActive = true;

/** Last state emitted as `display:schedule` – for widgets mounted later. */
export const isDisplayScheduleActive = (): boolean => currentActive;

const isSwitchedEvent = (data: unknown): data is DisplaySwitchedEvent =>
  typeof data === 'object' && data !== null && typeof (data as DisplaySwitchedEvent).on === 'boolean';

const minutesOf = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

/** Whether the schedule wants the display on at `now`. */
export function isScheduledOn(schedule: DisplaySchedule, now: Date): boolean {
  if (!schedule.enabled) return true;
  const on = minutesOf(schedule.on);
  const off = minutesOf(schedule.off);
  const minute = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  if (on === off) return schedule.days.includes(today);
  if (on < off) return schedule.days.includes(today) && minute >= on && minute < off;
  // Overnight window (e.g. 18:00–02:00) belongs to the day it starts on.
  return (schedule.days.includes(today) && minute >= on) || (schedule.days.includes(yesterday) && minute < off);
}

/** What survives a schedule change (the effect restarts, the display state does not). */
export interface DisplayScheduleMemory {
  /** Display state last requested; null = never touched the display. */
  applied: boolean | null;
  /** Woken by input until then (epoch ms). */
  wakeUntil: number;
  /** Bumped on every switch – a late failure of an older request is ignored. */
  sequence: number;
}

export interface DisplayScheduleEnv {
  /** Where input is observed (window). */
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** false: no display control – the black overlay stands in. */
  canSwitch: boolean;
  sleep: () => Promise<unknown>;
  wake: () => Promise<unknown>;
  setStatus: (status: DisplayScheduleStatus) => void;
}

/** Runs the schedule until the returned cleanup is called. */
export function runDisplaySchedule(
  config: DisplaySchedule,
  memory: DisplayScheduleMemory,
  env: DisplayScheduleEnv,
): () => void {
  /** Last request to switch off (also the repeated ones). */
  let sleptAt = 0;
  let sleepFailed = false;
  /** Last failed switch-on – input retries are spaced by WAKE_RETRY_MS. */
  let wakeFailedAt = 0;
  /** Switched off from outside during the on-times: stays off until touched or the next on-time. */
  let heldOff = false;
  let wasScheduledOn: boolean | null = null;
  let pointer: { x: number; y: number } | null = null;
  let lastPresenceAt = currentPresence().present ? Date.now() : 0;

  const sendSleep = () => {
    const id = memory.sequence;
    sleptAt = Date.now();
    sleepFailed = false;
    env.sleep().catch((err: unknown) => {
      console.warn('Bildschirm konnte nicht ausgeschaltet werden:', err);
      if (id !== memory.sequence) return;
      sleepFailed = true;
      env.setStatus({ active: false, blackout: true });
    });
  };

  const switchDisplay = (displayOn: boolean) => {
    memory.applied = displayOn;
    memory.sequence += 1;
    currentActive = displayOn;
    eventBus.emit(DISPLAY_SCHEDULE_EVENT, { active: displayOn } satisfies DisplayScheduleEvent);

    if (!env.canSwitch) {
      if (!displayOn) sleptAt = Date.now();
      env.setStatus({ active: displayOn, blackout: !displayOn });
      return;
    }
    env.setStatus({ active: displayOn, blackout: false });
    if (!displayOn) {
      sendSleep();
      return;
    }
    const id = memory.sequence;
    env.wake().catch((err: unknown) => {
      console.warn('Bildschirm konnte nicht eingeschaltet werden:', err);
      if (id !== memory.sequence) return;
      // Still off as far as we know: the next evaluate() (or a touch) tries again.
      memory.applied = false;
      wakeFailedAt = Date.now();
    });
  };

  const someonePresent = (now: number): boolean =>
    currentPresence().present || now - lastPresenceAt < TOUCH_WAKE_MS;

  const evaluate = () => {
    if (!config.enabled) {
      // Only undo what this hook did – never fight other display users (Sleeper).
      if (memory.applied === false) switchDisplay(true);
      return;
    }
    const now = Date.now();
    const scheduled = isScheduledOn(config, new Date(now));
    if (scheduled && wasScheduledOn === false) heldOff = false;
    wasScheduledOn = scheduled;
    const displayOn = !heldOff && (scheduled || now < memory.wakeUntil);
    if (displayOn !== memory.applied) {
      switchDisplay(displayOn);
    } else if (!displayOn && env.canSwitch && !sleepFailed && now - sleptAt >= REASSERT_OFF_MS && !someonePresent(now)) {
      sendSleep();
    }
  };

  const onActivity = () => {
    if (!config.enabled) return;
    if (memory.applied === false) {
      heldOff = false;
      memory.wakeUntil = Date.now() + TOUCH_WAKE_MS;
      if (Date.now() - wakeFailedAt < WAKE_RETRY_MS) return;
      evaluate();
    } else if (memory.wakeUntil > Date.now()) {
      memory.wakeUntil = Date.now() + TOUCH_WAKE_MS;
    }
  };

  const onPointerMove = (event: Event) => {
    const { screenX, screenY } = event as PointerEvent;
    // Only real movement: WebKit also reports a move when the page changes under a resting pointer.
    const moved = pointer !== null && (pointer.x !== screenX || pointer.y !== screenY);
    pointer = { x: screenX, y: screenY };
    if (!moved) return;
    if (memory.applied === false && Date.now() - sleptAt < POINTER_MOVE_GRACE_MS) return;
    onActivity();
  };

  const onPresence = (data: unknown) => {
    if (isPresenceEvent(data) && data.present) lastPresenceAt = Date.now();
  };

  const onSwitched = (data: unknown) => {
    if (!config.enabled || !isSwitchedEvent(data)) return;
    if (data.on) {
      onActivity();
    } else if (memory.applied !== false) {
      heldOff = true;
      memory.wakeUntil = 0;
      evaluate();
    }
  };

  const listenerOptions: AddEventListenerOptions = { capture: true, passive: true };
  env.target.addEventListener('pointerdown', onActivity, listenerOptions);
  env.target.addEventListener('keydown', onActivity, listenerOptions);
  env.target.addEventListener('wheel', onActivity, listenerOptions);
  env.target.addEventListener('pointermove', onPointerMove, listenerOptions);
  eventBus.on(PRESENCE_EVENT, onPresence);
  eventBus.on(DISPLAY_SWITCHED_EVENT, onSwitched);
  const first = setTimeout(evaluate, 0);
  const interval = setInterval(evaluate, EVALUATE_INTERVAL_MS);

  return () => {
    env.target.removeEventListener('pointerdown', onActivity, listenerOptions);
    env.target.removeEventListener('keydown', onActivity, listenerOptions);
    env.target.removeEventListener('wheel', onActivity, listenerOptions);
    env.target.removeEventListener('pointermove', onPointerMove, listenerOptions);
    eventBus.off(PRESENCE_EVENT, onPresence);
    eventBus.off(DISPLAY_SWITCHED_EVENT, onSwitched);
    clearTimeout(first);
    clearInterval(interval);
  };
}

export function useDisplaySchedule(schedule: DisplaySchedule): DisplayScheduleStatus {
  const [status, setStatus] = useState<DisplayScheduleStatus>({ active: true, blackout: false });
  const memory = useRef<DisplayScheduleMemory>({ applied: null, wakeUntil: 0, sequence: 0 });

  const { enabled, on, off } = schedule;
  const daysKey = schedule.days.join(',');

  useEffect(() => {
    const config: DisplaySchedule = {
      enabled,
      on,
      off,
      days: daysKey ? daysKey.split(',').map(Number) : [],
    };
    return runDisplaySchedule(config, memory.current, {
      target: window,
      canSwitch: isTauri(),
      sleep: sleepDisplay,
      wake: wakeDisplay,
      setStatus,
    });
  }, [enabled, on, off, daysKey]);

  return status;
}
