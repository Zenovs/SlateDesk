import { describe, expect, it } from 'vitest';
import type { Layout } from 'react-grid-layout';
import { createFreeCompactor, resolveOverlaps } from './freeGrid';

const pick = (layout: Layout) => layout.map(({ i, x, y }) => ({ i, x, y }));

describe('resolveOverlaps', () => {
  it('keeps gaps and unchanged items', () => {
    const items = [
      { i: 'a', x: 0, y: 0, w: 2, h: 2 },
      { i: 'middle', x: 4, y: 5, w: 2, h: 2 },
    ];
    const out = resolveOverlaps(items);
    expect(out).toEqual(items);
    expect(out[1]).toBe(items[1]);
  });

  it('moves an overlapping item below the one it hits, in a chain', () => {
    const out = resolveOverlaps([
      { i: 'a', x: 0, y: 0, w: 2, h: 2 },
      { i: 'b', x: 1, y: 1, w: 2, h: 2 },
      { i: 'c', x: 2, y: 3, w: 1, h: 1 },
    ]);
    expect(out.map(({ i, y }) => [i, y])).toEqual([
      ['a', 0],
      ['b', 2],
      ['c', 4],
    ]);
  });

  it('never moves a fixed item', () => {
    const out = resolveOverlaps(
      [
        { i: 'a', x: 0, y: 0, w: 2, h: 2 },
        { i: 'dragged', x: 0, y: 1, w: 2, h: 1 },
      ],
      (item) => item.i === 'dragged',
    );
    expect(out.map(({ i, y }) => [i, y])).toEqual([
      ['a', 2],
      ['dragged', 1],
    ]);
  });
});

describe('createFreeCompactor', () => {
  const start: Layout = [
    { i: 'a', x: 0, y: 0, w: 2, h: 2 },
    { i: 'b', x: 0, y: 4, w: 2, h: 2 },
  ];

  it('pushes aside while dragging and puts back what the dragged item has passed', () => {
    const compactor = createFreeCompactor();
    compactor.begin(start, 'a');
    // «a» dragged onto «b»: «b» moves below it.
    const over = compactor.compact([{ ...start[0], y: 4, moved: true }, start[1]], 2);
    expect(pick(over)).toEqual([
      { i: 'a', x: 0, y: 4 },
      { i: 'b', x: 0, y: 6 },
    ]);
    expect(over.every((item) => !item.moved)).toBe(true);
    // Further down, past «b»: it is back at its place.
    const past = compactor.compact([{ ...over[0], y: 7 }, over[1]], 2);
    expect(pick(past)).toEqual([
      { i: 'a', x: 0, y: 7 },
      { i: 'b', x: 0, y: 4 },
    ]);
    compactor.end();
    // Without a drag, positions stay as they are.
    expect(pick(compactor.compact([{ ...start[0], y: 2 }, start[1]], 2))).toEqual([
      { i: 'a', x: 0, y: 2 },
      { i: 'b', x: 0, y: 4 },
    ]);
  });
});
