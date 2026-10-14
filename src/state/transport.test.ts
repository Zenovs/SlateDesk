/**
 * HttpTransport against the web server contract (web.rs): request headers,
 * error shape and the SSE stream (`event: state`, origin "sync" on connect).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, HttpError, HttpTransport, isAbortError, TIMEOUT_MESSAGE } from './transport';
import type { StateEvent } from './types';

type Listener = (event: MessageEvent<string> | Event) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  /** 0 connecting, 1 open, 2 closed (the browser gave up, e.g. HTTP 401). */
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  dispatch(type: string, data?: unknown): void {
    const event = data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeEventSource.instances = [];
  fetchMock = vi.fn(async () => json({ rev: 1, state: {} }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('HttpTransport requests', () => {
  it('posts ops with the CSRF header and the session cookie', async () => {
    fetchMock.mockResolvedValueOnce(json({ rev: 8 }));
    const result = await new HttpTransport().apply([{ op: 'set', path: ['theme', 'mode'], value: 'light' }]);

    expect(result).toEqual({ rev: 8 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/state/ops');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['X-SlateDesk']).toBe('1');
    expect(JSON.parse(init.body as string)).toEqual({ ops: [{ op: 'set', path: ['theme', 'mode'], value: 'light' }] });
  });

  it('gives up on a request that never settles', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = new HttpTransport().apply([{ op: 'set', path: ['theme', 'mode'], value: 'light' }]);
    const failure = pending.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(20_000);
    const err = await failure;

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(0);
    expect((err as HttpError).message).toBe(TIMEOUT_MESSAGE);
  });

  it("passes the caller's abort through as AbortError", async () => {
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const controller = new AbortController();
    const failure = apiRequest('/api/system', { signal: controller.signal }).catch((err: unknown) => err);
    controller.abort();

    expect(isAbortError(await failure)).toBe(true);
  });

  it("surfaces the server's German { error } with its status", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Nicht angemeldet' }, 401));
    const failure = await new HttpTransport().load().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(HttpError);
    expect((failure as HttpError).status).toBe(401);
    expect((failure as HttpError).message).toBe('Nicht angemeldet');
  });
});

describe('HttpTransport events', () => {
  it('treats the full state sent on connect (origin "sync") as a resync', () => {
    const events: StateEvent[] = [];
    const stop = new HttpTransport().subscribe((event) => events.push(event));
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe('/api/events');

    source.dispatch('state', { rev: 3, state: { theme: { mode: 'dark' } }, origin: 'sync' });
    source.dispatch('state', { rev: 4, state: { theme: { mode: 'light' } }, origin: 'kiosk' });
    source.dispatch('ping', {});

    expect(events).toEqual([
      { rev: 3, state: { theme: { mode: 'dark' } }, origin: 'sync', resync: true },
      { rev: 4, state: { theme: { mode: 'light' } }, origin: 'kiosk' },
    ]);
    stop();
    expect(source.closed).toBe(true);
  });

  it('reconnects with backoff after an error and reports the connection state', () => {
    vi.useFakeTimers();
    const status: boolean[] = [];
    const stop = new HttpTransport().subscribe(
      () => {},
      (connected) => status.push(connected),
    );
    const first = FakeEventSource.instances[0];
    first.dispatch('open');
    first.dispatch('error');

    expect(first.closed).toBe(true);
    expect(status).toEqual([true, false]);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('reconnects when the stream falls silent (no ping) although it never reported an error', () => {
    vi.useFakeTimers();
    const status: boolean[] = [];
    const stop = new HttpTransport().subscribe(
      () => {},
      (connected) => status.push(connected),
    );
    const first = FakeEventSource.instances[0];
    first.readyState = 1;
    first.dispatch('open');
    // Pings keep it alive …
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(20_000);
      first.dispatch('ping', {});
    }
    expect(first.closed).toBe(false);
    // … a half-open connection just stops delivering them.
    vi.advanceTimersByTime(45_000);
    expect(first.closed).toBe(true);
    expect(status).toEqual([true, false]);
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2);
    stop();
  });

  it('stops reconnecting once the session is gone (stream refused, auth status false)', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/auth/status' ? json({ authenticated: false, name: 'SlateDesk' }) : json({ error: 'Nicht angemeldet' }, 401),
    );
    let lost = 0;
    const stop = new HttpTransport().subscribe(
      () => {},
      () => {},
      () => {
        lost += 1;
      },
    );
    const first = FakeEventSource.instances[0];
    first.readyState = 2;
    first.dispatch('error');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(lost).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    stop();
  });

  it('keeps reconnecting after a refused stream while the session is valid', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (url: string) =>
      url === '/api/auth/status' ? json({ authenticated: true, name: 'SlateDesk' }) : json({ rev: 1, state: {} }),
    );
    let lost = 0;
    const stop = new HttpTransport().subscribe(
      () => {},
      () => {},
      () => {
        lost += 1;
      },
    );
    const first = FakeEventSource.instances[0];
    first.readyState = 2;
    first.dispatch('error');
    await vi.advanceTimersByTimeAsync(1000);

    expect(lost).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(2);
    stop();
  });
});
