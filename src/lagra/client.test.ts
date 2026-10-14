/** lagra client: the /pruefen fallback asks lagra rarely – lagra logs every call. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppState } from '../state/appState';
import { withDefaults } from '../state/defaults';
import { fetchPruefenFallback, PRUEFEN_FALLBACK_MAX_AGE_MS } from './client';
import type { LagraPruefen } from './types';

const PRUEFEN: LagraPruefen = {
  eingerichtet: true,
  erreichbar: true,
  version: 'ClamAV 1.4.1',
  signaturen: '27412',
  signaturenStand: 'Mon Oct 12 08:00:00 2026',
  grund: null,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let lagraCount = 0;

/** Every test talks to its own lagra – answers kept by an earlier test do not count. */
function useLagra(): void {
  lagraCount += 1;
  useAppState.setState({
    ready: true,
    state: withDefaults({ lagra: { enabled: true, url: `http://lagra-${lagraCount}.test`, token: '__gesetzt__' } }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-13T08:00:00Z'));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  useLagra();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchPruefenFallback', () => {
  it('asks lagra once per interval and shares the request in flight', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(PRUEFEN)));

    const [first, second] = await Promise.all([fetchPruefenFallback(), fetchPruefenFallback()]);
    expect(first).toEqual(PRUEFEN);
    expect(second).toEqual(PRUEFEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/lagra/pruefen');

    vi.advanceTimersByTime(PRUEFEN_FALLBACK_MAX_AGE_MS - 1);
    await expect(fetchPruefenFallback()).resolves.toEqual(PRUEFEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await fetchPruefenFallback();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps «lagra has no /pruefen either» as null', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('<html>404</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })),
    );

    await expect(fetchPruefenFallback()).resolves.toBeNull();
    await expect(fetchPruefenFallback()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not keep failures', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ fehler: 'Interner Fehler' }, 500))
      .mockResolvedValueOnce(json(PRUEFEN));

    await expect(fetchPruefenFallback()).rejects.toMatchObject({ kind: 'unreachable' });
    await expect(fetchPruefenFallback()).resolves.toEqual(PRUEFEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks again for another lagra', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(PRUEFEN)));

    await fetchPruefenFallback();
    useLagra();
    await fetchPruefenFallback();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('lets one caller stop waiting without cancelling the answer for the others', async () => {
    let answer!: (res: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));

    const controller = new AbortController();
    const aborted = fetchPruefenFallback({ signal: controller.signal });
    const other = fetchPruefenFallback();
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

    answer(json(PRUEFEN));
    await expect(other).resolves.toEqual(PRUEFEN);
    await expect(fetchPruefenFallback()).resolves.toEqual(PRUEFEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
