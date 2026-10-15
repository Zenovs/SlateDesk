import { describe, expect, it } from 'vitest';
import type { Layout } from 'react-grid-layout';
import { availableMoves, moveItem, resizeItem } from './gridMoves';

const pick = (layout: Layout | null) => layout?.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));

describe('grid moves', () => {
  const layout: Layout = [
    { i: 'a', x: 0, y: 0, w: 1, h: 1 },
    { i: 'b', x: 1, y: 0, w: 1, h: 1 },
    { i: 'c', x: 0, y: 1, w: 2, h: 1 },
  ];

  it('moves below the neighbour (the wide one stays under «b») and not above the top', () => {
    expect(pick(moveItem(layout, 'a', 'down', 2))).toEqual([
      { i: 'a', x: 0, y: 2, w: 1, h: 1 },
      { i: 'b', x: 1, y: 0, w: 1, h: 1 },
      { i: 'c', x: 0, y: 1, w: 2, h: 1 },
    ]);
    expect(moveItem(layout, 'a', 'up', 2)).toBeNull();
    // Left onto «a» pushes it down.
    expect(pick(moveItem(layout, 'b', 'left', 2))?.find((item) => item.i === 'b')).toEqual({ i: 'b', x: 0, y: 0, w: 1, h: 1 });
  });

  it('respects the row limit when growing', () => {
    expect(availableMoves(layout, 'c', 2, 2)).toMatchObject({ wider: false, narrower: true, taller: true, lower: false });
    const taller = resizeItem(layout, 'c', 0, 1, 2, 2);
    expect(pick(taller)?.find((item) => item.i === 'c')).toEqual({ i: 'c', x: 0, y: 1, w: 2, h: 2 });
    expect(resizeItem(taller ?? [], 'c', 0, 1, 2, 2)).toBeNull();
  });
});
