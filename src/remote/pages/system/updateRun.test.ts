import { describe, expect, it } from 'vitest';
import type { UpdateProgress } from '../../api';
import { observeRun, runOutcome, START_GRACE_MS, watchTriggeredRun } from './updateRun';

const STARTING: UpdateProgress = { percent: 0, message: 'Update wird gestartet…', done: false, error: false, phase: 'start' };
const BUILDING: UpdateProgress = { percent: 40, message: 'Baue SlateDesk…', done: false, error: false, phase: 'build' };
const POLL_MS = 3_000;
const T0 = 1_000_000;

/** Polls «wird gestartet» every 3 s from the trigger until `until` (exclusive). */
function pollStarting(until: number) {
  let watch = watchTriggeredRun(T0);
  for (let at = T0 + POLL_MS; at < until; at += POLL_MS) watch = observeRun(watch, STARTING, at);
  return watch;
}

describe('runOutcome', () => {
  it('attributes the result to a run that reported progress', () => {
    const watch = observeRun(pollStarting(T0 + 9_000), BUILDING, T0 + 9_000);
    expect(runOutcome(watch, T0 + 15 * 60_000)).toBe('this-run');
  });

  it('attributes a quick result within the grace period (e.g. «bereits aktuell»)', () => {
    expect(runOutcome(pollStarting(T0 + 6_000), T0 + 6_000)).toBe('this-run');
  });

  it('reports a run that never started: «wird gestartet» turns into the previous result after the grace period', () => {
    const doneAt = T0 + START_GRACE_MS + 1_000;
    expect(runOutcome(pollStarting(doneAt), doneAt)).toBe('not-started');
  });

  it('cannot tell without continuous polling (page was in the background)', () => {
    const watch = pollStarting(T0 + 9_000);
    expect(runOutcome(watch, T0 + 10 * 60_000)).toBe('unknown');
  });

  it('follows a run seen on opening the page', () => {
    const watch = observeRun(null, BUILDING, T0);
    expect(watch.started).toBe(true);
    expect(runOutcome(watch, T0 + 60_000)).toBe('this-run');
  });
});
