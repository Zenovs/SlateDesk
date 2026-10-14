/**
 * useDisplayedWidgets – the kiosk's widgets with the positions the kiosk
 * actually shows (vertically compacted), plus their display labels.
 */
import { useMemo } from 'react';
import { useAppState } from '../../state/appState';
import type { WidgetInstance } from '../../state/types';
import { compactWidgets } from '../kioskGrid';
import { instanceLabels } from '../widgetInfo';

export interface DisplayedWidgets {
  widgets: WidgetInstance[];
  /** instanceId → «Uhr», «Uhr 2», … */
  labels: Map<string, string>;
}

export function useDisplayedWidgets(): DisplayedWidgets {
  const stored = useAppState((s) => s.state.layout.widgets);
  const cols = useAppState((s) => s.state.layout.cols);
  return useMemo(() => {
    const widgets = compactWidgets(stored, cols);
    return { widgets, labels: instanceLabels(widgets) };
  }, [stored, cols]);
}
