/**
 * Grid layout types (react-grid-layout v2 ships its own) and the grid
 * metrics shared by the kiosk dashboard and the web UI layout preview.
 */
export type { Layout as GridLayout, LayoutItem as GridLayoutItem } from 'react-grid-layout';

/** [horizontal, vertical] gap between widgets in px. */
export const GRID_MARGIN: readonly [number, number] = [12, 12];
/** [horizontal, vertical] padding inside the grid container in px. */
export const GRID_CONTAINER_PADDING: readonly [number, number] = [12, 12];
/** Lower bound for a computed row height (tiny screens / huge fitRows). */
export const MIN_FIT_ROW_HEIGHT = 16;

/**
 * Row height (px) at which exactly `rows` rows fill `height` px, including
 * the gaps between them and the container padding. Rounded down to 1/100 px
 * so rounding never produces a scrollbar.
 */
export function fitRowHeight(
  height: number,
  rows: number,
  margin: readonly [number, number] = GRID_MARGIN,
  padding: readonly [number, number] = GRID_CONTAINER_PADDING,
): number {
  if (!(rows > 0) || !(height > 0)) return MIN_FIT_ROW_HEIGHT;
  const available = height - 2 * padding[1] - (rows - 1) * margin[1];
  return Math.max(MIN_FIT_ROW_HEIGHT, Math.floor((available / rows) * 100) / 100);
}
