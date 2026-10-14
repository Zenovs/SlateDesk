/**
 * Widget Settings Store – generic settings for all widgets, keyed by instanceId.
 * Mirrors `state.widgetSettings` of the backend state (useAppState); writes
 * go through widgetSettingsActions.
 *
 * New code should prefer `useWidgetSettings(instanceId, defaults)` from
 * src/hooks/useWidgetSettings.ts (selector-based, re-renders only the owner).
 */
import { create } from 'zustand';
import { useAppState } from '../state/appState';
import { widgetSettingsActions } from '../state/dataActions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WidgetSettings = Record<string, any>;

interface WidgetSettingsState {
  /** Map of instanceId -> settings object */
  settings: Record<string, WidgetSettings>;
  /**
   * Get settings for a specific widget instance (defaults + stored values).
   * Returns the same object as long as the stored settings and the `defaults`
   * object are unchanged – pass a module-level constant as defaults.
   */
  getSettings: <T extends WidgetSettings>(instanceId: string, defaults?: T) => T;
  /** Update settings for a specific widget instance (merges with existing) */
  updateSettings: (instanceId: string, patch: WidgetSettings) => void;
  /** Replace all settings for a specific widget instance */
  setSettings: (instanceId: string, settings: WidgetSettings) => void;
  /** Remove settings for a specific widget instance */
  removeSettings: (instanceId: string) => void;
}

const EMPTY: WidgetSettings = Object.freeze({});

interface CacheEntry {
  stored: WidgetSettings;
  defaults: WidgetSettings | undefined;
  result: WidgetSettings;
}

// Memo for getSettings: widgets use the result in effect dependencies, a new
// object per render would re-run those effects (refetch, restart timers).
const cache = new Map<string, CacheEntry>();

export const useWidgetSettingsStore = create<WidgetSettingsState>()((_set, get) => ({
  settings: useAppState.getState().state.widgetSettings,

  getSettings: <T extends WidgetSettings>(instanceId: string, defaults?: T): T => {
    const stored = get().settings[instanceId] ?? EMPTY;
    const hit = cache.get(instanceId);
    if (hit && hit.stored === stored && hit.defaults === defaults) return hit.result as T;
    const result = { ...(defaults ?? {}), ...stored };
    cache.set(instanceId, { stored, defaults, result });
    return result as T;
  },

  updateSettings: (instanceId, patch) => {
    void widgetSettingsActions.update(instanceId, patch);
  },

  setSettings: (instanceId, settings) => {
    void widgetSettingsActions.replace(instanceId, settings);
  },

  removeSettings: (instanceId) => {
    void widgetSettingsActions.remove(instanceId);
  },
}));

const unsubscribe = useAppState.subscribe((next, prev) => {
  const settings = next.state.widgetSettings;
  if (settings === prev.state.widgetSettings && next.state.layout.widgets === prev.state.layout.widgets) return;
  const placed = new Set(next.state.layout.widgets.map((w) => w.instanceId));
  for (const [instanceId, entry] of cache) {
    const stale = entry.stored !== (settings[instanceId] ?? EMPTY);
    if (stale || (!placed.has(instanceId) && settings[instanceId] === undefined)) cache.delete(instanceId);
  }
  if (settings !== prev.state.widgetSettings) useWidgetSettingsStore.setState({ settings });
});
import.meta.hot?.dispose(unsubscribe);
