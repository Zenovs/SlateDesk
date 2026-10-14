/**
 * useWidgetSettings – settings of one widget instance, merged over defaults.
 *
 * Subscribes only to this instance's settings, and the returned object keeps
 * its identity until they change – safe to use in effect dependencies.
 * `defaults` must be stable (a module-level constant, e.g. the manifest's
 * defaultSettings), otherwise the result is recomputed on every render.
 */
import { useCallback, useMemo } from 'react';
import { useAppState } from '../state/appState';
import { widgetSettingsActions } from '../state/dataActions';

export function useWidgetSettings<T extends object>(
  instanceId: string,
  defaults: T,
): [T, (patch: Partial<T>) => void] {
  const stored = useAppState((s) => s.state.widgetSettings[instanceId]);

  const settings = useMemo(() => (stored ? ({ ...defaults, ...stored } as T) : { ...defaults }), [stored, defaults]);

  const update = useCallback(
    (patch: Partial<T>) => {
      void widgetSettingsActions.update(instanceId, patch as Record<string, unknown>);
    },
    [instanceId],
  );

  return [settings, update];
}
