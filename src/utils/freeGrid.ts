/**
 * Free placement for the dashboard grid: a widget stays where it is put – it
 * can stand alone in the middle of the screen, nothing moves up into a gap
 * (the vertical compaction of react-grid-layout did). Only overlaps are
 * resolved: the widget that is hit moves down below the one hitting it.
 *
 * While a widget is dragged or resized it keeps its place, and the widgets it
 * pushes aside go back to where they were once it has passed – one drag across
 * the screen must not shove the whole dashboard down.
 */
import type { Compactor, Layout } from 'react-grid-layout/core';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * `items` without overlaps: top to bottom, then left to right, an item that
 * overlaps one already placed moves down below it. `isFixed` items are placed
 * first and stay put. Unchanged items keep their object identity.
 */
export function resolveOverlaps<T extends Box>(items: readonly T[], isFixed: (item: T) => boolean = () => false): T[] {
  const order = items
    .map((item, index) => ({ item, index, fixed: isFixed(item) }))
    .sort((a, b) => Number(b.fixed) - Number(a.fixed) || a.item.y - b.item.y || a.item.x - b.item.x);
  const placed: Box[] = [];
  const out = [...items];
  for (const { item, index } of order) {
    let y = item.y;
    let hit = placed.find((other) => overlaps({ ...item, y }, other));
    while (hit) {
      y = hit.y + hit.h;
      hit = placed.find((other) => overlaps({ ...item, y }, other));
    }
    const next = y === item.y ? item : { ...item, y };
    placed.push(next);
    out[index] = next;
  }
  return out;
}

export interface FreeCompactor extends Compactor {
  /** Drag or resize of `id` starts on `layout`: it stays put, the others return to these places when it moves on. */
  begin(layout: Layout, id: string): void;
  end(): void;
}

/**
 * Compactor for a GridLayout with free placement. `allowOverlap` keeps
 * react-grid-layout from pushing items itself (in its non-compacting mode it
 * swaps them around); `compact` resolves the overlaps instead.
 */
export function createFreeCompactor(): FreeCompactor {
  let origin: Map<string, { x: number; y: number }> | null = null;
  let active: string | null = null;
  return {
    type: null,
    allowOverlap: true,
    compact(layout: Layout): Layout {
      const start = origin;
      const base = start
        ? layout.map((item) => {
            const at = item.i === active ? undefined : start.get(item.i);
            return at && (at.x !== item.x || at.y !== item.y) ? { ...item, x: at.x, y: at.y } : item;
          })
        : layout;
      return resolveOverlaps(base, (item) => item.i === active).map((item) => (item.moved ? { ...item, moved: false } : item));
    },
    begin(layout, id) {
      origin = new Map(layout.map((item) => [item.i, { x: item.x, y: item.y }]));
      active = id;
    },
    end() {
      origin = null;
      active = null;
    },
  };
}
