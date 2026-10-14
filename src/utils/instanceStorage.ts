/**
 * Browser storage that widgets keep per instance under
 * `slatedesk:<widget>:<instanceId>:…` (e.g. speed test and host monitor
 * history).
 *
 * The 24/7 kiosk adds and removes widgets for years: entries of instances
 * that left the dashboard – removed on the kiosk, in the web UI or by an
 * import – are deleted, so localStorage never fills up with orphans.
 */
import type { WidgetInstance } from '../state/types';

const PREFIX = 'slatedesk:';

/** Instance id part of a per-instance key, or null for other keys. */
function instanceIdOf(key: string): string | null {
  if (!key.startsWith(PREFIX)) return null;
  const parts = key.split(':');
  return parts.length >= 4 ? parts[2] : null;
}

export function forgetRemovedInstances(prev: readonly WidgetInstance[], next: readonly WidgetInstance[]): void {
  if (prev === next) return;
  const remaining = new Set(next.map((w) => w.instanceId));
  const removed = new Set(prev.map((w) => w.instanceId).filter((id) => !remaining.has(id)));
  if (removed.size === 0) return;

  try {
    const storage = window.localStorage;
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      const id = key === null ? null : instanceIdOf(key);
      if (key !== null && id !== null && removed.has(id)) doomed.push(key);
    }
    for (const key of doomed) storage.removeItem(key);
  } catch (err) {
    // No storage (plain test environment, blocked site data) – nothing to clean up.
    console.warn('Gespeicherte Daten entfernter Widgets konnten nicht gelöscht werden:', err);
  }
}
