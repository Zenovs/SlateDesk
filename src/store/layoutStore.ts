/**
 * Layout Store – Manages widget layout positions and sizes.
 * Persists layout configuration to localStorage.
 */
import { create } from 'zustand';
import type { WidgetInstance } from '../types/widget';
import type { GridLayoutItem } from '../types/grid';

interface LayoutState {
  widgets: WidgetInstance[];
  cols: number;
  rowHeight: number;
  editMode: boolean;
  addWidget: (widget: WidgetInstance) => void;
  removeWidget: (instanceId: string) => void;
  updateLayout: (layout: readonly GridLayoutItem[]) => void;
  setEditMode: (mode: boolean) => void;
  toggleEditMode: () => void;
}

const STORAGE_KEY = 'slatedesk-layout';

const getDefaultWidgets = (): WidgetInstance[] => [
  { instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 3, h: 3 },
  { instanceId: 'calendar-1', widgetId: 'calendar', x: 3, y: 0, w: 5, h: 6 },
  { instanceId: 'weather-1', widgetId: 'weather', x: 8, y: 0, w: 4, h: 3 },
  { instanceId: 'messages-1', widgetId: 'messages', x: 0, y: 3, w: 3, h: 3 },
  { instanceId: 'todo-1', widgetId: 'todo', x: 8, y: 3, w: 4, h: 3 },
];

const loadWidgets = (): WidgetInstance[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return getDefaultWidgets();
};

const saveWidgets = (widgets: WidgetInstance[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets));
};

export const useLayoutStore = create<LayoutState>((set) => ({
  widgets: loadWidgets(),
  cols: 12,
  rowHeight: 80,
  editMode: false,
  addWidget: (widget) =>
    set((state) => {
      const next = [...state.widgets, widget];
      saveWidgets(next);
      return { widgets: next };
    }),
  removeWidget: (instanceId) =>
    set((state) => {
      const next = state.widgets.filter((w) => w.instanceId !== instanceId);
      saveWidgets(next);
      return { widgets: next };
    }),
  updateLayout: (layout) =>
    set((state) => {
      const next = state.widgets.map((w) => {
        const item = layout.find((l) => l.i === w.instanceId);
        if (item) {
          return { ...w, x: item.x, y: item.y, w: item.w, h: item.h };
        }
        return w;
      });
      saveWidgets(next);
      return { widgets: next };
    }),
  setEditMode: (mode) => set({ editMode: mode }),
  toggleEditMode: () => set((state) => ({ editMode: !state.editMode })),
}));
