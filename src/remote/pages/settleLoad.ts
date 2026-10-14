/** Loading helper for pages that query a service through the kiosk (lagra, planbar). */
import { handleSessionError } from '../api';

/** Pause before the single retry – long enough for the kiosk to store a just-saved setting. */
const SETTLE_MS = 1500;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Abgebrochen', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Abgebrochen', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs a request through the kiosk. Right after the service was switched on
 * (or its key entered) here, the first request can overtake that save and
 * the kiosk still answers «nicht eingerichtet» (`notConfigured`) – one retry
 * bridges this. An expired web UI session switches to the login page.
 */
export async function loadSettled<T>(
  load: () => Promise<T>,
  signal: AbortSignal,
  notConfigured: (err: unknown) => boolean,
): Promise<T> {
  try {
    try {
      return await load();
    } catch (err) {
      if (!notConfigured(err)) throw err;
      await wait(SETTLE_MS, signal);
      return await load();
    }
  } catch (err) {
    handleSessionError(err);
    throw err;
  }
}
