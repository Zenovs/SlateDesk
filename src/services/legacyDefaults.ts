/**
 * legacyDefaults – old defaults for widget instances imported from the
 * pre-backend kiosk.
 *
 * The old settings store saved only the keys a user had changed, and
 * state/migrate copies them unchanged. Where a default has changed since
 * (camera and Ruhemodus did not start on their own, the Ruhemodus waited
 * 180 minutes), an imported instance would silently pick up the new value
 * through useWidgetSettings. So an instance from the old layout gets the old
 * defaults of the keys it lacks – applied at once and written to the state
 * once; newly added instances keep the new defaults.
 */
import { useEffect, useMemo } from 'react';
import { useAppState } from '../state/appState';
import { widgetSettingsActions } from '../state/dataActions';
import { LEGACY_KEYS } from '../state/migrate';
import { isPlainObject } from '../state/ops';

type ReadableStorage = Pick<Storage, 'getItem'>;

function browserStorage(): ReadableStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether the old localStorage layout (still kept, never written again) contained this instance. */
export function wasInLegacyLayout(
  widgetId: string,
  instanceId: string,
  storage: ReadableStorage | null = browserStorage(),
): boolean {
  let layout: unknown = null;
  try {
    const text = storage?.getItem(LEGACY_KEYS.layout);
    layout = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return false;
  }
  return (
    Array.isArray(layout) &&
    layout.some((item) => isPlainObject(item) && item.instanceId === instanceId && item.widgetId === widgetId)
  );
}

/**
 * The old defaults an imported instance still lacks, or null when there is
 * nothing to do (all keys stored, or not an imported instance).
 */
export function legacyDefaultsPatch(
  widgetId: string,
  instanceId: string,
  stored: Record<string, unknown> | undefined,
  oldDefaults: Record<string, unknown>,
  storage?: ReadableStorage | null,
): Record<string, unknown> | null {
  const missing = Object.entries(oldDefaults).filter(([key]) => stored?.[key] === undefined);
  if (missing.length === 0) return null;
  if (!wasInLegacyLayout(widgetId, instanceId, storage)) return null;
  return Object.fromEntries(missing);
}

/**
 * Returns `settings` with the old defaults of an imported instance applied,
 * and writes them once. `oldDefaults` must be a module-level constant.
 */
export function useLegacyDefaults<T extends object>(
  widgetId: string,
  instanceId: string,
  settings: T,
  oldDefaults: Partial<T>,
): T {
  const stored = useAppState((s) => s.state.widgetSettings[instanceId]);
  const patch = useMemo(
    () => legacyDefaultsPatch(widgetId, instanceId, stored, oldDefaults as Record<string, unknown>),
    [widgetId, instanceId, stored, oldDefaults],
  );

  useEffect(() => {
    if (patch) void widgetSettingsActions.update(instanceId, patch);
  }, [instanceId, patch]);

  return useMemo(() => (patch ? ({ ...settings, ...patch } as T) : settings), [settings, patch]);
}
