/**
 * Grid layout types compatible with react-grid-layout v2
 */
export interface GridLayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  static?: boolean;
  isDraggable?: boolean;
  isResizable?: boolean;
}

export type GridLayout = readonly GridLayoutItem[];

export type GridLayouts = Partial<Record<string, GridLayout>>;
