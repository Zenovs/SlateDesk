/**
 * Kiosk grid geometry for the web UI: the same metrics as the kiosk
 * Dashboard, so the mini-map and the layout editor show the kiosk screen
 * true to scale.
 */
import { bottomOf } from '../state/defaults';
import type { LayoutData, WidgetInstance } from '../state/types';
import { fitRowHeight, GRID_CONTAINER_PADDING, GRID_MARGIN } from '../types/grid';
import { resolveOverlaps } from '../utils/freeGrid';
import { getManifest } from '../widgets/catalog';

export interface Viewport {
  width: number;
  height: number;
}

/** Assumed grid area (16:9) while the kiosk has not reported its size. */
const FALLBACK_VIEWPORT: Viewport = { width: 1920, height: 1080 };

export const usableViewport = (viewport: Viewport | null | undefined): Viewport =>
  viewport && viewport.width > 0 && viewport.height > 0 ? viewport : FALLBACK_VIEWPORT;

/** Row height in kiosk px – fitted to the screen when `fitRows` > 0, like the kiosk does. */
export function kioskRowHeight(layout: Pick<LayoutData, 'rowHeight' | 'fitRows'>, viewport: Viewport): number {
  return layout.fitRows > 0 ? fitRowHeight(viewport.height, layout.fitRows) : layout.rowHeight;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Position and size of a widget on the kiosk screen in px. */
export function widgetRect(
  widget: Pick<WidgetInstance, 'x' | 'y' | 'w' | 'h'>,
  cols: number,
  rowHeight: number,
  viewport: Viewport,
): Rect {
  const [marginX, marginY] = GRID_MARGIN;
  const [paddingX, paddingY] = GRID_CONTAINER_PADDING;
  const colWidth = (viewport.width - 2 * paddingX - (cols - 1) * marginX) / cols;
  return {
    left: paddingX + widget.x * (colWidth + marginX),
    top: paddingY + widget.y * (rowHeight + marginY),
    width: widget.w * colWidth + (widget.w - 1) * marginX,
    height: widget.h * rowHeight + (widget.h - 1) * marginY,
  };
}

/** Height of the grid content including padding in kiosk px (0 without widgets). */
export function contentHeight(widgets: readonly Pick<WidgetInstance, 'y' | 'h'>[], rowHeight: number): number {
  const rows = bottomOf(widgets);
  if (rows === 0) return 0;
  return 2 * GRID_CONTAINER_PADDING[1] + rows * rowHeight + (rows - 1) * GRID_MARGIN[1];
}

/**
 * Positions as the kiosk shows them: placement is free (utils/freeGrid), only
 * widgets that overlap another are moved below it. Unchanged items keep their
 * object identity.
 */
export function shownWidgets(widgets: readonly WidgetInstance[]): WidgetInstance[] {
  return resolveOverlaps(widgets);
}

/** Rows of `rowHeight` px that fit on a screen `height` px high (with the grid's padding and gaps). */
export function rowsOnScreen(height: number, rowHeight: number): number {
  const usable = height - 2 * GRID_CONTAINER_PADDING[1] + GRID_MARGIN[1];
  return Math.max(0, Math.floor(usable / (rowHeight + GRID_MARGIN[1])));
}

interface Span {
  start: number;
  end: number;
  minWidth: number;
}

/**
 * New position of every column boundary 0…fromCols: proportional, adjusted
 * so each span keeps its minimum width. A widget's edges are boundaries, and
 * the mapping is monotonic – widgets that sat side by side still do. null when
 * the minimum widths cannot fit side by side in `toCols`.
 */
function scaleBoundaries(spans: readonly Span[], fromCols: number, toCols: number): number[] | null {
  const factor = toCols / fromCols;
  const boundary = Array.from({ length: fromCols + 1 }, (_, edge) => Math.round(edge * factor));
  // Left to right: right edges move right until every span is wide enough …
  for (let edge = 1; edge <= fromCols; edge += 1) {
    boundary[edge] = Math.max(boundary[edge], boundary[edge - 1]);
    for (const span of spans) {
      if (span.end === edge) boundary[edge] = Math.max(boundary[edge], boundary[span.start] + span.minWidth);
    }
  }
  // … then right to left from the screen edge: left edges move left to make room.
  boundary[fromCols] = Math.min(boundary[fromCols], toCols);
  for (let edge = fromCols - 1; edge >= 0; edge -= 1) {
    boundary[edge] = Math.min(boundary[edge], boundary[edge + 1]);
    for (const span of spans) {
      if (span.start === edge) boundary[edge] = Math.min(boundary[edge], boundary[span.end] - span.minWidth);
    }
  }
  return boundary[0] < 0 ? null : boundary;
}

/**
 * The widgets for a new column count: the left and right edge of every
 * widget scale proportionally (it keeps its share of the screen width); rows
 * stay as they are.
 *
 * Edges are mapped, not position and width rounded separately: the mapping
 * is monotonic, so x + w of a widget never passes x of its right neighbour
 * and nothing is pushed down a row. Minimum widths (manifest) are made room
 * for by moving neighbouring edges; only when they do not fit side by side at
 * all (e.g. three wide widgets in 6 columns) a widget overlaps its neighbour
 * and moves down below it.
 */
export function rescaleWidgets(widgets: readonly WidgetInstance[], fromCols: number, toCols: number): WidgetInstance[] {
  if (fromCols === toCols || fromCols <= 0 || toCols <= 0) return [...widgets];
  const spans: Span[] = widgets.map((widget) => {
    const start = Math.min(fromCols, Math.max(0, widget.x));
    return {
      start,
      end: Math.min(fromCols, Math.max(start, widget.x + widget.w)),
      minWidth: Math.min(toCols, Math.max(1, getManifest(widget.widgetId)?.minWidth ?? 1)),
    };
  });
  const boundary = scaleBoundaries(spans, fromCols, toCols);
  const factor = toCols / fromCols;
  const scaled = widgets.map((widget, index) => {
    const { start, end, minWidth } = spans[index];
    const left = boundary ? boundary[start] : Math.round(start * factor);
    const right = boundary ? boundary[end] : Math.round(end * factor);
    const w = Math.min(toCols, Math.max(minWidth, right - left));
    const x = Math.min(toCols - w, Math.max(0, left));
    return { ...widget, x, w };
  });
  return shownWidgets(scaled);
}
