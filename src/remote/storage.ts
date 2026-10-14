/**
 * localStorage access for per-browser preferences of the web UI (theme,
 * zoom). Never throws: private windows and blocked storage just forget.
 */

export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `null` removes the key. */
export function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Preference is kept for this page view only.
  }
}
