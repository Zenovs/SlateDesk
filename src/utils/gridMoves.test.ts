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

describe('grid moves with free placement', () => {
  const layout: Layout = [
    { i: 'a', x: 0, y: 0, w: 2, h: 2 },
    { i: 'b', x: 0, y: 4, w: 2, h: 1 },
  ];

  it('moves one row at a time and leaves the gap', () => {
    expect(availableMoves(layout, 'a', 4, 10, true)).toMatchObject({ up: false, down: true });
    expect(pick(moveItem(layout, 'a', 'down', 4, true))?.[0]).toEqual({ i: 'a', x: 0, y: 1, w: 2, h: 2 });
    expect(pick(moveItem(layout, 'b', 'up', 4, true))?.[1]).toEqual({ i: 'b', x: 0, y: 3, w: 2, h: 1 });
    expect(moveItem(layout, 'a', 'up', 4, true)).toBeNull();
  });

  it('pushes what it runs into below it', () => {
    let current: Layout = layout;
    for (let step = 0; step < 3; step += 1) current = moveItem(current, 'b', 'up', 4, true) ?? current;
    // «b» at row 1 overlaps «a», which moves below it.
    expect(pick(current)).toEqual([
      { i: 'a', x: 0, y: 2, w: 2, h: 2 },
      { i: 'b', x: 0, y: 1, w: 2, h: 1 },
    ]);
  });

  it('pushes neighbours down when growing', () => {
    const taller = pick(resizeItem(layout, 'a', 0, 3, 4, 10, true));
    expect(taller).toEqual([
      { i: 'a', x: 0, y: 0, w: 2, h: 5 },
      { i: 'b', x: 0, y: 5, w: 2, h: 1 },
    ]);
  });
});

