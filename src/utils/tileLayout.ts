/**
 * Own arrangement of the tiles inside a widget (e.g. the sections of the
 * lagra Übersicht): a small grid like the dashboard's, stored in the widget
 * settings and edited in the settings form (TileLayoutControl). Pure
 * functions – shared by the widget and the editor.
 *
 * The rows share the widget's height evenly; a tile spans `w` columns and
 * `h` rows. `null` instead of a layout means automatic: the widget flows its
 * tiles by its size.
 */
import { isPlainObject } from '../state/ops';

export interface TileLayoutItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileLayout {
  columns: number;
  items: TileLayoutItem[];
}

export const TILE_COLUMNS_MIN = 1;
export const TILE_COLUMNS_MAX = 6;
/** Height of one tile in rows. */
export const TILE_ROWS_MAX = 6;
/** Stored positions below this are garbage. */
const TILE_Y_MAX = 48;

const toInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** A stored layout, cleaned up; anything unusable → null (automatic). */
export function parseTileLayout(value: unknown): TileLayout | null {
  if (!isPlainObject(value) || !Array.isArray(value.items)) return null;
  const rawColumns = toInt(value.columns);
  if (rawColumns === null) return null;
  const columns = clamp(rawColumns, TILE_COLUMNS_MIN, TILE_COLUMNS_MAX);
  const seen = new Set<string>();
  const items: TileLayoutItem[] = [];
  for (const raw of value.items) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || raw.id === '' || seen.has(raw.id)) continue;
    const [x, y, w, h] = [toInt(raw.x), toInt(raw.y), toInt(raw.w), toInt(raw.h)];
    if (x === null || y === null || w === null || h === null) continue;
    seen.add(raw.id);
    const width = clamp(w, 1, columns);
    items.push({
      id: raw.id,
      x: clamp(x, 0, columns - width),
      y: clamp(y, 0, TILE_Y_MAX),
      w: width,
      h: clamp(h, 1, TILE_ROWS_MAX),
    });
  }
  return { columns, items };
}

const cellKey = (x: number, y: number): string => `${x},${y}`;

const overlaps = (a: TileLayoutItem, b: TileLayoutItem): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Moves every tile up as far as it goes (top to bottom), like the editor's
 * grid does – a switched-off tile leaves no gap. Input must not overlap.
 */
function compactTiles(items: readonly TileLayoutItem[]): TileLayoutItem[] {
  const done: TileLayoutItem[] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let y = item.y;
    while (y > 0 && !done.some((other) => overlaps({ ...item, y: y - 1 }, other))) y--;
    done.push({ ...item, y });
  }
  return done.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The tiles to show, in reading order and compacted: the stored places of
 * the active tiles; active tiles without one (newly switched on) or whose
 * place is taken go to the first free cell, 1×1.
 */
export function resolveTileLayout(layout: TileLayout, active: readonly string[]): TileLayoutItem[] {
  const wanted = new Set(active);
  const taken = new Set<string>();
  const placed: TileLayoutItem[] = [];
  const cells = (item: TileLayoutItem): string[] => {
    const keys: string[] = [];
    for (let dy = 0; dy < item.h; dy++) for (let dx = 0; dx < item.w; dx++) keys.push(cellKey(item.x + dx, item.y + dy));
    return keys;
  };
  const place = (item: TileLayoutItem): void => {
    for (const key of cells(item)) taken.add(key);
    placed.push(item);
  };

  for (const item of layout.items) {
    if (!wanted.has(item.id) || placed.some((p) => p.id === item.id)) continue;
    if (cells(item).every((key) => !taken.has(key))) place(item);
  }
  for (const id of active) {
    if (placed.some((p) => p.id === id)) continue;
    let y = 0;
    for (;;) {
      const x = Array.from({ length: layout.columns }, (_, i) => i).find((col) => !taken.has(cellKey(col, y)));
      if (x !== undefined) {
        place({ id, x, y, w: 1, h: 1 });
        break;
      }
      y++;
    }
  }
  return compactTiles(placed);
}

/** Starting point for an own arrangement: the active tiles side by side, 1×1, in up to two rows. */
export function initialTileLayout(active: readonly string[]): TileLayout {
  const count = Math.max(1, active.length);
  const columns = clamp(count <= 4 ? count : Math.ceil(count / 2), TILE_COLUMNS_MIN, TILE_COLUMNS_MAX);
  return {
    columns,
    items: active.map((id, index) => ({ id, x: index % columns, y: Math.floor(index / columns), w: 1, h: 1 })),
  };
}

/** Rows the tiles take (at least one). */
export const tileRows = (items: readonly TileLayoutItem[]): number =>
  items.reduce((rows, item) => Math.max(rows, item.y + item.h), 1);
