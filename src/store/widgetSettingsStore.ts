/**
 * Widget Settings Store – Generic settings management for all widgets.
 * Each widget can store arbitrary settings keyed by instanceId.
 * Settings are persisted to localStorage.
 */
import { create } from 'zustand';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WidgetSettings = Record<string, any>;

interface WidgetSettingsState {
  /** Map of instanceId -> settings object */
  settings: Record<string, WidgetSettings>;
  /** Get settings for a specific widget instance */
  getSettings: <T extends WidgetSettings>(instanceId: string, defaults?: T) => T;
  /** Update settings for a specific widget instance (merges with existing) */
  updateSettings: (instanceId: string, patch: WidgetSettings) => void;
  /** Replace all settings for a specific widget instance */
  setSettings: (instanceId: string, settings: WidgetSettings) => void;
  /** Remove settings for a specific widget instance */
  removeSettings: (instanceId: string) => void;
}

const STORAGE_KEY = 'slatedesk-widget-settings';

const loadSettings = (): Record<string, WidgetSettings> => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return {};
};

const saveSettings = (settings: Record<string, WidgetSettings>) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
};

export const useWidgetSettingsStore = create<WidgetSettingsState>((set, get) => ({
  settings: loadSettings(),

  getSettings: <T extends WidgetSettings>(instanceId: string, defaults?: T): T => {
    const current = get().settings[instanceId] || {};
    return { ...(defaults || {}), ...current } as T;
  },

  updateSettings: (instanceId, patch) =>
    set((state) => {
      const current = state.settings[instanceId] || {};
      const next = {
        ...state.settings,
        [instanceId]: { ...current, ...patch },
      };
      saveSettings(next);
      return { settings: next };
    }),

  setSettings: (instanceId, settings) =>
    set((state) => {
      const next = { ...state.settings, [instanceId]: settings };
      saveSettings(next);
      return { settings: next };
    }),

  removeSettings: (instanceId) =>
    set((state) => {
      const next = { ...state.settings };
      delete next[instanceId];
      saveSettings(next);
      return { settings: next };
    }),
}));
