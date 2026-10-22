import { describe, expect, it } from 'vitest';
import { allOutages, formatOutageDuration, outageMails, type MonitoredHostState } from './hostAlerts';

const T0 = Date.UTC(2026, 9, 22, 12, 0);
const MIN = 60_000;

const host = (patch: Partial<MonitoredHostState> = {}): MonitoredHostState => ({
  key: 'ping|nas.local||',
  name: 'NAS',
  address: 'nas.local',
  state: 'up',
  message: null,
  since: null,
  ...patch,
});

describe('outageMails', () => {
  it('reports a host once when it goes down', () => {
    const down = host({ state: 'down', message: 'Keine Antwort', since: T0 });
    const first = outageMails({}, [down], T0 + 3 * MIN, 'Büro');
    expect(first.reported).toEqual({ 'ping|nas.local||': T0 });
    expect(first.mails).toHaveLength(1);
    expect(first.mails[0].subject).toBe('NAS nicht erreichbar');
    expect(first.mails[0].body).toContain('Adresse: nas.local');
    expect(first.mails[0].body).toContain('Grund: Keine Antwort');
    expect(first.mails[0].body).toContain('«Büro»');

    const again = outageMails(first.reported, [down], T0 + 10 * MIN, 'Büro');
    expect(again).toEqual({ reported: first.reported, mails: [] });
  });

  it('sends the recovery with the length of the outage', () => {
    const result = outageMails({ 'ping|nas.local||': T0 }, [host({ state: 'up', since: T0 + 33 * MIN })], T0 + 40 * MIN, 'Büro');
    expect(result.reported).toEqual({});
    expect(result.mails).toHaveLength(1);
    expect(result.mails[0].subject).toBe('NAS wieder erreichbar');
    expect(result.mails[0].body).toContain('(33 Min.)');
  });

  it('counts a single failed check after the recovery as recovered', () => {
    const result = outageMails({ 'ping|nas.local||': T0 }, [host({ state: 'unstable' })], T0 + 5 * MIN, 'Büro');
    expect(result.reported).toEqual({});
    expect(result.mails.map((m) => m.subject)).toEqual(['NAS wieder erreichbar']);
    expect(result.mails[0].body).toContain('(5 Min.)');
  });

  it('keeps hosts that are still being checked and forgets removed or misconfigured ones', () => {
    const reported = { a: T0, b: T0, c: T0 };
    const result = outageMails(
      reported,
      [host({ key: 'a', state: 'pending' }), host({ key: 'b', state: 'config' })],
      T0 + MIN,
      'Büro',
    );
    expect(result).toEqual({ reported: { a: T0 }, mails: [] });
  });

  it('mails nothing for hosts that are up and uses the check time when the start is unknown', () => {
    expect(outageMails({}, [host(), host({ key: 'x', state: 'unstable' })], T0, 'Büro').mails).toEqual([]);
    const result = outageMails({}, [host({ state: 'down', since: null })], T0, 'Büro');
    expect(result.reported).toEqual({ 'ping|nas.local||': T0 });
  });

  it('reports a target configured twice once', () => {
    const down = host({ state: 'down', since: T0 });
    expect(outageMails({}, [down, { ...down, name: 'NAS 2' }], T0, 'Büro').mails).toHaveLength(1);
  });
});

describe('formatOutageDuration', () => {
  it('reads like the rest of the kiosk', () => {
    expect(formatOutageDuration(30_000)).toBe('unter 1 Min.');
    expect(formatOutageDuration(33 * MIN)).toBe('33 Min.');
    expect(formatOutageDuration(60 * MIN)).toBe('1 Std.');
    expect(formatOutageDuration(125 * MIN)).toBe('2 Std. 5 Min.');
    expect(formatOutageDuration(27 * 60 * MIN)).toBe('1 Tag 3 Std.');
    expect(formatOutageDuration(48 * 60 * MIN)).toBe('2 Tage');
  });
});

describe('allOutages', () => {
  it('lists each target once, oldest first', () => {
    const nas = { key: 'a', name: 'NAS', address: 'nas', message: null, since: T0 + MIN };
    const router = { key: 'b', name: 'Router', address: 'router', message: null, since: T0 };
    const printer = { key: 'c', name: 'Drucker', address: 'drucker', message: null, since: null };
    expect(allOutages({ one: [nas, printer], two: [router, nas] }).map((o) => o.name)).toEqual(['Router', 'NAS', 'Drucker']);
  });
});
