import { describe, expect, it } from 'vitest';
import type { UpdateCheck } from '../utils/backend';
import { updateReducer, type UpdateState } from './useUpdater';

const info = (available: boolean): UpdateCheck => ({
  available,
  current_commit: 'a'.repeat(40),
  remote_commit: 'b'.repeat(40),
  short_current: 'aaaaaaa',
  short_remote: 'bbbbbbb',
  behind: available ? 1 : 0,
});

const failed = (state: UpdateState, background: boolean): UpdateState =>
  updateReducer(updateReducer(state, { type: 'check' }), { type: 'failed', message: 'Keine Verbindung', background });

describe('updateReducer', () => {
  it('keeps a failed scheduled check silent and falls back to what was known', () => {
    expect(failed({ phase: 'idle' }, true)).toEqual({ phase: 'idle' });
    expect(failed({ phase: 'current', info: info(false) }, true)).toEqual({ phase: 'current', info: info(false) });
    expect(failed({ phase: 'available', info: info(true), confirming: false }, true)).toEqual({
      phase: 'available',
      info: info(true),
      confirming: false,
    });
  });

  it('shows the error of a check the user started', () => {
    expect(failed({ phase: 'idle' }, false)).toEqual({ phase: 'error', message: 'Keine Verbindung' });
  });

  it('does not let a scheduled failure end a running update', () => {
    const running: UpdateState = { phase: 'running', startedAt: 0, percent: 40, message: 'Baut…', sawProgress: true };
    expect(updateReducer(running, { type: 'failed', message: 'x', background: true })).toBe(running);
  });
});
