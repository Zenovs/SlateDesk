/**
 * Display helpers for widget instances (names, positions) shared by the
 * layout editor, the widget list and the mini-map.
 */
import type { WidgetInstance } from '../state/types';
import { getManifest } from '../widgets/catalog';

const widgetName = (widgetId: string): string => getManifest(widgetId)?.name ?? `Unbekanntes Widget (${widgetId})`;

/** Reading order on the kiosk: top to bottom, left to right. */
export function sortByPosition<T extends Pick<WidgetInstance, 'x' | 'y'>>(widgets: readonly T[]): T[] {
  return [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
}

/** instanceId → label; several instances of one widget are numbered in reading order («Uhr 2»). */
export function instanceLabels(widgets: readonly WidgetInstance[]): Map<string, string> {
  const totals = new Map<string, number>();
  for (const widget of widgets) totals.set(widget.widgetId, (totals.get(widget.widgetId) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const widget of sortByPosition(widgets)) {
    const name = widgetName(widget.widgetId);
    if ((totals.get(widget.widgetId) ?? 0) > 1) {
      const index = (seen.get(widget.widgetId) ?? 0) + 1;
      seen.set(widget.widgetId, index);
      labels.set(widget.instanceId, `${name} ${index}`);
    } else {
      labels.set(widget.instanceId, name);
    }
  }
  return labels;
}

/** «4×3» (columns × rows). */
export const sizeText = (widget: Pick<WidgetInstance, 'w' | 'h'>): string => `${widget.w}×${widget.h}`;

/** «Zeile 2 · Spalte 5» (1-based). */
export const positionText = (widget: Pick<WidgetInstance, 'x' | 'y'>): string =>
  `Zeile ${widget.y + 1} · Spalte ${widget.x + 1}`;
