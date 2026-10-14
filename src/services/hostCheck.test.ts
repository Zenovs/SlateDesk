import { describe, expect, it } from 'vitest';
import type { NetCheckResult } from '../utils/backend';
import { evaluate, toTarget } from './hostCheck';

const failed = (host: string, error: string, kind: NetCheckResult['kind'] = 'tcp'): NetCheckResult => ({
  host,
  port: kind === 'ping' ? null : 445,
  kind,
  reachable: false,
  latencyMs: null,
  packetLossPct: null,
  status: null,
  error,
  timestamp: 1_760_000_000,
});

describe('evaluate', () => {
  it('reports a name that never resolved as configuration error', () => {
    const result = evaluate(failed('nas.firma.lan', 'Hostname nicht auflösbar', 'ping'), 'nas.firma.lan');
    expect(result).toMatchObject({ ok: false, error: null, configError: 'Hostname nicht auflösbar' });
  });

  it('reports a DNS server that does not answer as outage', () => {
    for (const error of [
      'Verbindung fehlgeschlagen: failed to lookup address information: Temporary failure in name resolution',
      'keine Verbindung (failed to lookup address information: Temporary failure in name resolution)',
      'DNS nicht erreichbar',
    ]) {
      const result = evaluate(failed('nas.firma.lan', error), 'nas.firma.lan');
      expect(result.configError, error).toBeNull();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/DNS/);
    }
  });

  it('reports a name that resolved before as outage', () => {
    const result = evaluate(failed('drucker', 'Hostname nicht auflösbar', 'ping'), 'drucker', true);
    expect(result).toMatchObject({ ok: false, configError: null });
    expect(result.error).toMatch(/Nicht erreichbar/);
  });

  it('keeps mDNS names an outage and cleans os error codes', () => {
    expect(evaluate(failed('nas.local', 'Hostname nicht auflösbar', 'ping'), 'nas.local').configError).toBeNull();
    const refused = evaluate(failed('10.0.0.5', 'Verbindung fehlgeschlagen: Connection refused (os error 111)'), '10.0.0.5');
    expect(refused).toMatchObject({ ok: false, configError: null, error: 'Verbindung fehlgeschlagen: Connection refused' });
  });
});

describe('toTarget', () => {
  it('keeps https of a pasted URL on port 443', () => {
    const target = toTarget({ name: 'Webseite', host: 'https://example.ch/status', kind: 'http' }, 0);
    expect(target.configError).toBeNull();
    expect(target.check).toEqual({ host: 'example.ch', kind: 'http', port: 443, path: '/status', scheme: 'https' });
    expect(target.address).toBe('https://example.ch/status');
    expect(target.key).toBe('http|example.ch|443|/status');
  });

  it('probes a pasted https URL on another port with https', () => {
    const target = toTarget({ name: 'NAS', host: 'https://nas.local:5001', kind: 'http' }, 0);
    expect(target.configError).toBeNull();
    expect(target.check).toEqual({ host: 'nas.local', kind: 'http', port: 5001, path: '/', scheme: 'https' });
    expect(target.address).toBe('https://nas.local:5001');
    expect(target.key).not.toBe(toTarget({ host: 'http://nas.local:5001', kind: 'http' }, 0).key);
  });

  it('passes a pasted http scheme on and leaves plain hosts to the backend', () => {
    expect(toTarget({ host: 'http://pve:8006', kind: 'http' }, 0).check).toEqual({
      host: 'pve',
      kind: 'http',
      port: 8006,
      path: '/',
      scheme: 'http',
    });
    expect(toTarget({ host: 'pve', port: 8006, kind: 'http' }, 0).check).toEqual({ host: 'pve', kind: 'http', port: 8006, path: '/' });
  });

  it('accepts the same address as TCP check', () => {
    const target = toTarget({ name: 'NAS', host: 'https://nas.local:5001', kind: 'tcp' }, 0);
    expect(target.configError).toBeNull();
    expect(target.check).toEqual({ host: 'nas.local', kind: 'tcp', port: 5001 });
  });

  it('shows plain http addresses as before', () => {
    expect(toTarget({ host: 'http://drucker:8080/', kind: 'http' }, 0).address).toBe('http://drucker:8080');
    expect(toTarget({ host: 'router', kind: 'http', port: 443 }, 0).address).toBe('https://router');
    expect(toTarget({ host: 'router', kind: 'http' }, 0).address).toBe('http://router');
  });
});
