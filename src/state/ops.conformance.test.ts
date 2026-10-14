/**
 * Conformance with the Rust backend: the cases in ops.conformance.json are
 * also run by `state.rs` (cargo test), so both sides of the optimistic
 * state handling compute the same result for every op.
 */
import { describe, expect, it } from 'vitest';
import raw from './ops.conformance.json?raw';
import { applyOps } from './ops';
import type { RawState, StateOp } from './types';

interface ConformanceCase {
  name: string;
  state: RawState;
  ops: StateOp[];
  expect?: RawState;
  error?: boolean;
}

const { cases } = JSON.parse(raw) as { cases: ConformanceCase[] };

describe('ops conformance with state.rs', () => {
  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) expect(c.error === true || c.expect !== undefined, c.name).toBe(true);
  });

  for (const c of cases) {
    it(c.name, () => {
      const before = JSON.stringify(c.state);
      if (c.error) {
        expect(() => applyOps(c.state, c.ops)).toThrow();
      } else {
        expect(applyOps(c.state, c.ops)).toEqual(c.expect);
      }
      // Rejected or not, the input is never touched.
      expect(JSON.stringify(c.state)).toBe(before);
    });
  }
});
