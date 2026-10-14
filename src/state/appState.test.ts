import { describe, expect, it } from 'vitest';
import { useAppState } from './appState';
import { applyOps } from './ops';
import { HttpError } from './transport';
import type { RawState, StateEvent, StateOp, StateSnapshot, StateTransport, TransportKind } from './types';

interface Deferred {
  ops: StateOp[];
  resolve: (value: { rev: number }) => void;
  reject: (err: Error) => void;
}

/** In-memory backend with optional manual acknowledgement of writes. */
class FakeTransport implements StateTransport {
  kind: TransportKind = 'local';
  rev = 0;
  state: RawState = {};
  manual = false;
  loads = 0;
  readonly calls: StateOp[][] = [];
  readonly inFlight: Deferred[] = [];
  private readonly listeners = new Set<(event: StateEvent) => void>();
  private readonly sessionListeners = new Set<() => void>();
  /** Backend-side rewrite of incoming ops' results (like state.rs does for HTTP writes). */
  rewrite: ((state: RawState) => RawState) | null = null;
  loadError: Error | null = null;

  constructor(state: RawState = {}, rev = 0) {
    this.state = state;
    this.rev = rev;
  }

  load(): Promise<StateSnapshot> {
    this.loads += 1;
    if (this.loadError) return Promise.reject(this.loadError);
    return Promise.resolve({ rev: this.rev, state: this.state });
  }

  apply(ops: StateOp[]): Promise<{ rev: number }> {
    this.calls.push(ops);
    if (!this.manual) return Promise.resolve(this.commit(ops));
    return new Promise((resolve, reject) => this.inFlight.push({ ops, resolve, reject }));
  }

  subscribe(cb: (event: StateEvent) => void, _onStatus?: (connected: boolean) => void, onSessionLost?: () => void): () => void {
    this.listeners.add(cb);
    if (onSessionLost) this.sessionListeners.add(onSessionLost);
    return () => {
      this.listeners.delete(cb);
      if (onSessionLost) this.sessionListeners.delete(onSessionLost);
    };
  }

  get subscribers(): number {
    return this.listeners.size;
  }

  loseSession(): void {
    for (const cb of this.sessionListeners) cb();
  }

  /** Backend-side write (also used for writes from "another client"). */
  commit(ops: StateOp[]): { rev: number } {
    this.state = applyOps(this.state, ops);
    if (this.rewrite) this.state = this.rewrite(this.state);
    this.rev += 1;
    return { rev: this.rev };
  }

  emit(origin = 'remote'): void {
    for (const cb of this.listeners) cb({ rev: this.rev, state: this.state, origin });
  }

  /** Commits the oldest in-flight write and acknowledges it. */
  ack(): void {
    const next = this.inFlight.shift();
    if (!next) throw new Error('nothing in flight');
    next.resolve(this.commit(next.ops));
  }

  fail(message: string): void {
    const next = this.inFlight.shift();
    if (!next) throw new Error('nothing in flight');
    next.reject(new Error(message));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const app = () => useAppState.getState();
const setMode = (mode: string): StateOp[] => [{ op: 'set', path: ['theme', 'mode'], value: mode }];

async function start(transport: FakeTransport): Promise<void> {
  await app().init(transport);
}

describe('useAppState', () => {
  it('loads and fills defaults', async () => {
    const transport = new FakeTransport({ kiosk: { name: 'Empfang' } }, 4);
    await start(transport);
    expect(app().ready).toBe(true);
    expect(app().rev).toBe(4);
    expect(app().state.kiosk.name).toBe('Empfang');
    expect(app().state.kiosk.showTopBar).toBe(true);
    expect(app().state.layout.widgets.length).toBeGreaterThan(0);
  });

  it('applies optimistically and confirms without waiting for the event', async () => {
    const transport = new FakeTransport();
    await start(transport);
    const result = app().apply(setMode('light'));
    expect(app().state.theme.mode).toBe('light');
    await expect(result).resolves.toBe(true);
    expect(transport.calls).toHaveLength(1);
    expect(app().rev).toBe(1);
    transport.emit();
    expect(app().state.theme.mode).toBe('light');
  });

  it('sends writes in order and batches those queued meanwhile', async () => {
    const transport = new FakeTransport();
    transport.manual = true;
    await start(transport);
    void app().apply([{ op: 'set', path: ['kiosk', 'name'], value: 'A' }]);
    void app().apply([{ op: 'set', path: ['kiosk', 'name'], value: 'AB' }]);
    void app().apply([{ op: 'set', path: ['kiosk', 'name'], value: 'ABC' }]);
    expect(transport.calls).toHaveLength(1);
    transport.ack();
    await settle();
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]).toHaveLength(2);
    transport.ack();
    await settle();
    expect(transport.state).toEqual({ kiosk: { name: 'ABC' } });
    expect(app().state.kiosk.name).toBe('ABC');
  });

  it('keeps unconfirmed writes on top of newer remote state', async () => {
    const transport = new FakeTransport();
    transport.manual = true;
    await start(transport);
    void app().apply(setMode('light'));
    // Another client writes before our write reaches the backend.
    transport.commit([{ op: 'set', path: ['kiosk', 'name'], value: 'Remote' }]);
    transport.emit();
    expect(app().state.kiosk.name).toBe('Remote');
    expect(app().state.theme.mode).toBe('light');
    transport.ack();
    await settle();
    transport.emit();
    expect(app().rev).toBe(2);
    expect(app().state.kiosk.name).toBe('Remote');
    expect(app().state.theme.mode).toBe('light');
  });

  it('ignores events that are not newer', async () => {
    const transport = new FakeTransport({ theme: { mode: 'light' } }, 3);
    await start(transport);
    const stale = { rev: 3, state: { theme: { mode: 'dark' } }, origin: 'remote' };
    transport['listeners'].forEach((cb) => cb(stale));
    expect(app().state.theme.mode).toBe('light');
  });

  it('rolls back a rejected write and reloads', async () => {
    const transport = new FakeTransport({ theme: { mode: 'dark' } });
    transport.manual = true;
    await start(transport);
    const loadsBefore = transport.loads;
    const result = app().apply(setMode('light'));
    expect(app().state.theme.mode).toBe('light');
    transport.fail('Zustand ist zu gross');
    await expect(result).resolves.toBe(false);
    await settle();
    expect(app().state.theme.mode).toBe('dark');
    expect(app().error).toBe('Zustand ist zu gross');
    expect(transport.loads).toBe(loadsBefore + 1);
  });

  it('rejects invalid ops locally', async () => {
    const transport = new FakeTransport();
    await start(transport);
    await expect(app().apply([{ op: 'set', path: ['unbekannt'], value: 1 }])).resolves.toBe(false);
    expect(app().error).toMatch(/Unbekannter Schlüssel/);
    expect(transport.calls).toHaveLength(0);
  });

  it('does not send writes that change nothing', async () => {
    const transport = new FakeTransport({ theme: { mode: 'dark', accent: null } });
    await start(transport);
    await expect(app().apply([{ op: 'merge', path: ['theme'], value: { mode: 'dark' } }])).resolves.toBe(true);
    expect(transport.calls).toHaveLength(0);
  });

  it('keeps object identity of untouched parts', async () => {
    const transport = new FakeTransport({ widgetSettings: { a: { x: 1 }, b: { y: 2 } } });
    await start(transport);
    const before = app().state;
    await app().apply([{ op: 'merge', path: ['widgetSettings', 'a'], value: { x: 5 } }]);
    const after = app().state;
    expect(after.widgetSettings.b).toBe(before.widgetSettings.b);
    expect(after.layout).toBe(before.layout);
    // A full replacement with equal content keeps identities too.
    transport.emit();
    transport.commit([{ op: 'set', path: ['kiosk', 'name'], value: 'Neu' }]);
    transport.emit();
    expect(app().state.widgetSettings).toBe(after.widgetSettings);
  });

  it('over HTTP takes the result from the event, not from replaying its own ops', async () => {
    const transport = new FakeTransport({ lagra: { url: 'https://a.ch', token: '__gesetzt__' } }, 10);
    transport.kind = 'http';
    // Like state.rs: a new url over HTTP clears the token next to it.
    transport.rewrite = (state) => {
      const lagra = state.lagra as Record<string, unknown>;
      return lagra.url === 'https://a.ch' ? state : { ...state, lagra: { ...lagra, token: '' } };
    };
    await start(transport);

    // The acknowledgement arrives before the event (separate connections).
    await expect(app().apply([{ op: 'merge', path: ['lagra'], value: { url: 'https://b.ch' } }])).resolves.toBe(true);
    expect(app().state.lagra.token).toBe('__gesetzt__');
    transport.emit();
    expect(app().rev).toBe(11);
    expect(app().state.lagra).toMatchObject({ url: 'https://b.ch', token: '' });
  });

  it('stops syncing when the session is gone but keeps the loaded state', async () => {
    const transport = new FakeTransport({ kiosk: { name: 'Empfang' } }, 2);
    transport.kind = 'http';
    await start(transport);
    expect(transport.subscribers).toBe(1);

    transport.loseSession();
    expect(app().unauthorized).toBe(true);
    expect(transport.subscribers).toBe(0);
    expect(app().state.kiosk.name).toBe('Empfang');
    // Writes go nowhere until the next init (after login).
    await expect(app().apply(setMode('light'))).resolves.toBe(false);
    expect(transport.calls).toHaveLength(0);
  });

  it('does not leave the event subscription behind when the first load gets a 401', async () => {
    const transport = new FakeTransport();
    transport.kind = 'http';
    transport.loadError = new HttpError(401, 'Nicht angemeldet');
    await expect(app().init(transport)).rejects.toThrow('Nicht angemeldet');
    expect(app().unauthorized).toBe(true);
    expect(transport.subscribers).toBe(0);
  });
});
