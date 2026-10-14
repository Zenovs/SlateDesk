/**
 * useCursorAutoHide – hides the mouse cursor after `seconds` without input.
 *
 * Toggles only on hidden ↔ visible transitions (never per mousemove – each
 * native call is an IPC round trip). In the kiosk the native cursor is
 * switched via the Tauri window API; the `cursor-hidden` class on <html> is
 * the fallback that also works in a plain browser. 0 = never hide.
 */
import { useEffect } from 'react';
import { isTauri, setCursorVisible } from '../utils/backend';

const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
const LISTENER_OPTIONS: AddEventListenerOptions = { passive: true, capture: true };

async function setNativeCursorVisible(visible: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    await setCursorVisible(visible);
  } catch (err) {
    console.warn('Mauszeiger konnte nicht umgeschaltet werden:', err);
  }
}

export function useCursorAutoHide(seconds: number): void {
  useEffect(() => {
    if (!(seconds > 0)) return;
    const root = document.documentElement;
    const delay = seconds * 1000;
    let hidden = false;
    let lastActivity = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const setHidden = (next: boolean) => {
      if (hidden === next) return;
      hidden = next;
      root.classList.toggle('cursor-hidden', next);
      void setNativeCursorVisible(!next);
    };

    // One timer per idle period: activity only records a timestamp, the timer
    // re-arms itself for the remaining time instead of being reset per event.
    const check = () => {
      const idle = Date.now() - lastActivity;
      if (idle >= delay) {
        timer = null;
        setHidden(true);
      } else {
        timer = setTimeout(check, delay - idle);
      }
    };

    const onActivity = () => {
      lastActivity = Date.now();
      if (hidden) setHidden(false);
      if (timer === null) timer = setTimeout(check, delay);
    };

    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, onActivity, LISTENER_OPTIONS);
    timer = setTimeout(check, delay);

    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity, LISTENER_OPTIONS);
      if (timer !== null) clearTimeout(timer);
      if (hidden) {
        root.classList.remove('cursor-hidden');
        void setNativeCursorVisible(true);
      }
    };
  }, [seconds]);
}
