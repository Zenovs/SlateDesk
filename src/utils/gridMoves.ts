/**
 * Moves and resizes for the buttons of a react-grid-layout editor (the
 * dashboard layout and the tile arrangement of a widget).
 *
 * `free` is the dashboard's free placement (utils/freeGrid): up/down move by
 * one row, and what the item then overlaps moves down below it.
 *
 * Otherwise the grid compacts vertically (the tiles of a widget), so «one row
 * down» would snap right back. Up/down therefore swap with the nearest item
 * above/below (same columns); everything ends with the same compaction the
 * grid applies.
 */
import { cloneLayout, moveElement, verticalCompactor, type Layout, type LayoutItem } from 'react-grid-layout';
import { resolveOverlaps } from './freeGrid';

export type Direction = 'left' | 'right' | 'up' | 'down';

export interface Moves {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  narrower: boolean;
  wider: boolean;
  lower: boolean;
  taller: boolean;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const sharesColumns = (a: LayoutItem, b: LayoutItem): boolean => a.x < b.x + b.w && b.x < a.x + a.w;

/** Nearest item directly above/below `item` that shares a column with it. */
function neighbour(layout: Layout, item: LayoutItem, direction: 'up' | 'down'): LayoutItem | null {
  let best: LayoutItem | null = null;
  for (const other of layout) {
    if (other.i === item.i || !sharesColumns(item, other)) continue;
    if (direction === 'down' && other.y >= item.y + item.h && (!best || other.y < best.y)) best = other;
    if (direction === 'up' && other.y + other.h <= item.y && (!best || other.y + other.h > best.y + best.h)) best = other;
  }
  return best;
}

export function availableMoves(layout: Layout, id: string, cols: number, maxRows: number, free = false): Moves | null {
  const item = layout.find((l) => l.i === id);
  if (!item) return null;
  return {
    left: item.x > 0,
    right: item.x + item.w < cols,
    up: free ? item.y > 0 : neighbour(layout, item, 'up') !== null,
    down: free || neighbour(layout, item, 'down') !== null,
    narrower: item.w > Math.max(1, item.minW ?? 1),
    wider: item.w < Math.min(item.maxW ?? cols, cols - item.x),
    lower: item.h > Math.max(1, item.minH ?? 1),
    taller: item.h < Math.min(item.maxH ?? maxRows, maxRows),
  };
}

/** `layout` must be what the grid shows (compacted, or free without overlaps). */
export function moveItem(layout: Layout, id: string, direction: Direction, cols: number, free = false): Layout | null {
  const items = cloneLayout(layout);
  const item = items.find((l) => l.i === id);
  if (!item) return null;
  let { x, y } = item;
  if (direction === 'left') x -= 1;
  if (direction === 'right') x += 1;
  if (free) {
    if (direction === 'up') y = Math.max(0, y - 1);
    if (direction === 'down') y += 1;
    x = clamp(x, 0, Math.max(0, cols - item.w));
    if (x === item.x && y === item.y) return null;
    return resolveOverlaps(
      items.map((l) => (l.i === id ? { ...l, x, y } : l)),
      (l) => l.i === id,
    );
  }
  if (direction === 'up' || direction === 'down') {
    const other = neighbour(items, item, direction);
    if (!other) return null;
    // Up: take the neighbour's row (it is pushed below). Down: go below the
    // neighbour; compaction lifts it into the freed space.
    y = direction === 'up' ? other.y : other.y + other.h;
  }
  x = clamp(x, 0, Math.max(0, cols - item.w));
  if (x === item.x && y === item.y) return null;
  return verticalCompactor.compact(moveElement(items, item, x, y, false, false, 'vertical', cols), cols);
}

export function resizeItem(
  layout: Layout,
  id: string,
  dw: number,
  dh: number,
  cols: number,
  maxRows: number,
  free = false,
): Layout | null {
  const item = layout.find((l) => l.i === id);
  if (!item) return null;
  const w = clamp(item.w + dw, Math.min(Math.max(1, item.minW ?? 1), cols - item.x), Math.min(item.maxW ?? cols, cols - item.x));
  const h = clamp(item.h + dh, Math.max(1, item.minH ?? 1), Math.min(item.maxH ?? maxRows, maxRows));
  if (w === item.w && h === item.h) return null;
  const resized = layout.map((l) => (l.i === id ? { ...l, w, h } : l));
  return free ? resolveOverlaps(resized, (l) => l.i === id) : verticalCompactor.compact(resized, cols);
}
