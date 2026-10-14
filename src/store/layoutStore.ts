/**
 * Layout Store – widget positions and sizes.
 * Mirrors `state.layout` of the backend state (useAppState); writes go
 * through layoutActions. Only `editMode` is local to this webview.
 */
import { create } from 'zustand';
import { useAppState } from '../state/appState';
import { layoutActions, type LayoutItemLike } from '../state/dataActions';
import type { LayoutData, WidgetInstance } from '../state/types';
import { forgetRemovedInstances } from '../utils/instanceStorage';

interface LayoutState {
  widgets: WidgetInstance[];
  cols: number;
  rowHeight: number;
  /** 0 = off; > 0: rowHeight is computed so that many rows fill the screen height. */
  fitRows: number;
  editMode: boolean;
  /** Widget just added on this kiosk – its wrapper scrolls it into view once rendered. */
  revealId: string | null;
  /** A non-finite y (e.g. Infinity) places the widget below all others. */
  addWidget: (widget: WidgetInstance) => void;
  /** Clears `revealId` if it still is `instanceId`. */
  clearReveal: (instanceId: string) => void;
  /** Also deletes the instance's widget settings. */
  removeWidget: (instanceId: string) => void;
  /** Persists only when a position or size actually changed. */
  updateLayout: (layout: readonly LayoutItemLike[]) => void;
  setEditMode: (mode: boolean) => void;
  toggleEditMode: () => void;
}

const fromLayout = (layout: LayoutData) => ({
  widgets: layout.widgets,
  cols: layout.cols,
  rowHeight: layout.rowHeight,
  fitRows: layout.fitRows,
});

export const useLayoutStore = create<LayoutState>()((set) => ({
  ...fromLayout(useAppState.getState().state.layout),
  editMode: false,
  revealId: null,
  addWidget: (widget) => {
    // Before the write: the new wrapper mounts in the render it triggers.
    set({ revealId: widget.instanceId });
    layoutActions.add(widget);
  },
  clearReveal: (instanceId) => set((state) => (state.revealId === instanceId ? { revealId: null } : state)),
  removeWidget: (instanceId) => {
    void layoutActions.remove(instanceId);
  },
  updateLayout: (layout) => {
    void layoutActions.update(layout);
  },
  setEditMode: (mode) => set({ editMode: mode }),
  toggleEditMode: () => set((state) => ({ editMode: !state.editMode })),
}));

const unsubscribe = useAppState.subscribe((next, prev) => {
  if (next.state.layout === prev.state.layout) return;
  useLayoutStore.setState(fromLayout(next.state.layout));
  // Only removals while running – not the switch from the defaults to the loaded state.
  if (prev.ready && next.ready) forgetRemovedInstances(prev.state.layout.widgets, next.state.layout.widgets);
});
import.meta.hot?.dispose(unsubscribe);
