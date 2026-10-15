/**
 * Option providers: one shared load per provider, 60 s cache, errors next to
 * the last good options, replaced loaders never publish outdated results.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getProviderSnapshot,
  hasOptionProvider,
  invalidateOptionProvider,
  loadProviderOptions,
  OPTION_CACHE_MS,
  registerOptionProvider,
  stableJson,
  type ProviderOption,
} from './optionProviders';

const PEOPLE: ProviderOption[] = [
  { value: 'u1', label: 'Anna', hint: 'Grafik' },
  { value: 'u2', label: 'Beat' },
];

let counter = 0;
/** Every test gets its own provider name – the registry is module state. */
const freshName = (): string => `test.provider.${(counter += 1)}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T08:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('option providers', () => {
  it('loads once and reuses the options for 60 s', async () => {
    const name = freshName();
    const loader = vi.fn(async () => PEOPLE);
    registerOptionProvider(name, loader);
    expect(hasOptionProvider(name)).toBe(true);

    expect(await loadProviderOptions(name)).toEqual(PEOPLE);
    expect(getProviderSnapshot(name)).toMatchObject({ options: PEOPLE, loading: false, error: null });

    vi.setSystemTime(Date.now() + OPTION_CACHE_MS - 1);
    await loadProviderOptions(name);
    expect(loader).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2);
    await loadProviderOptions(name);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('shares a running load and reloads on demand', async () => {
    const name = freshName();
    let release: (options: ProviderOption[]) => void = () => undefined;
    const loader = vi.fn(() => new Promise<ProviderOption[]>((resolve) => (release = resolve)));
    registerOptionProvider(name, loader);

    const first = loadProviderOptions(name);
    const second = loadProviderOptions(name);
    expect(getProviderSnapshot(name).loading).toBe(true);
    await Promise.resolve();
    release(PEOPLE);
    expect(await first).toEqual(PEOPLE);
    expect(await second).toEqual(PEOPLE);
    expect(loader).toHaveBeenCalledTimes(1);

    const forced = loadProviderOptions(name, true);
    await Promise.resolve();
    release([PEOPLE[0]]);
    expect(await forced).toEqual([PEOPLE[0]]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good options next to a load error', async () => {
    const name = freshName();
    const loader = vi
      .fn<() => Promise<ProviderOption[]>>()
      .mockResolvedValueOnce(PEOPLE)
      .mockRejectedValueOnce(new Error('planbar nicht erreichbar: Zeitüberschreitung'))
      .mockResolvedValueOnce([PEOPLE[1]]);
    registerOptionProvider(name, loader);

    await loadProviderOptions(name);
    await expect(loadProviderOptions(name, true)).rejects.toThrow('Zeitüberschreitung');
    expect(getProviderSnapshot(name)).toMatchObject({
      options: PEOPLE,
      loading: false,
      error: 'planbar nicht erreichbar: Zeitüberschreitung',
    });

    await loadProviderOptions(name, true);
    expect(getProviderSnapshot(name)).toMatchObject({ options: [PEOPLE[1]], error: null });
  });

  it('does not cache a failed first load', async () => {
    const name = freshName();
    const loader = vi
      .fn<() => Promise<ProviderOption[]>>()
      .mockRejectedValueOnce('kaputt')
      .mockResolvedValueOnce(PEOPLE);
    registerOptionProvider(name, loader);

    await expect(loadProviderOptions(name)).rejects.toBe('kaputt');
    expect(getProviderSnapshot(name)).toMatchObject({ options: null, error: 'kaputt' });
    expect(await loadProviderOptions(name)).toEqual(PEOPLE);
  });

  it('turns a synchronous loader failure into a rejection', async () => {
    const name = freshName();
    registerOptionProvider(name, () => {
      throw new Error('sofort kaputt');
    });
    await expect(loadProviderOptions(name)).rejects.toThrow('sofort kaputt');
    expect(getProviderSnapshot(name).error).toBe('sofort kaputt');
  });

  it('reports an unknown provider in German', async () => {
    const name = freshName();
    expect(hasOptionProvider(name)).toBe(false);
    await expect(loadProviderOptions(name)).rejects.toThrow(`Unbekannte Auswahlliste «${name}»`);
    expect(getProviderSnapshot(name).error).toBe(`Unbekannte Auswahlliste «${name}»`);
  });

  it('drops malformed and duplicate entries of remote data', async () => {
    const name = freshName();
    const raw = [
      { value: 'u1', label: 'Anna' },
      { value: 'u1', label: 'Anna doppelt' },
      { value: 7, label: 'Zahl' },
      { value: 'u3' },
      null,
      { value: 'u2', label: 'Beat', group: 'Grafik' },
    ] as unknown as ProviderOption[];
    registerOptionProvider(name, async () => raw);
    expect(await loadProviderOptions(name)).toEqual([
      { value: 'u1', label: 'Anna' },
      { value: 'u2', label: 'Beat', group: 'Grafik' },
    ]);
  });

  it('loads again after invalidation', async () => {
    const name = freshName();
    const loader = vi.fn(async () => PEOPLE);
    registerOptionProvider(name, loader);
    await loadProviderOptions(name);
    invalidateOptionProvider(name);
    expect(getProviderSnapshot(name).options).toEqual(PEOPLE);
    await loadProviderOptions(name);
    expect(loader).toHaveBeenCalledTimes(2);

    invalidateOptionProvider();
    await loadProviderOptions(name);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('ignores the result of a loader that was replaced meanwhile', async () => {
    const name = freshName();
    let release: (options: ProviderOption[]) => void = () => undefined;
    registerOptionProvider(name, () => new Promise<ProviderOption[]>((resolve) => (release = resolve)));
    const outdated = loadProviderOptions(name);
    await Promise.resolve();

    registerOptionProvider(name, async () => [PEOPLE[1]]);
    release(PEOPLE);
    await outdated;
    expect(getProviderSnapshot(name).options).toBeNull();
    expect(await loadProviderOptions(name)).toEqual([PEOPLE[1]]);
    expect(getProviderSnapshot(name).options).toEqual([PEOPLE[1]]);
  });

  it('caches every combination of dependencies on its own', async () => {
    const name = freshName();
    const loader = vi.fn(async (deps: Readonly<Record<string, unknown>>) => [
      { value: String(deps.unternehmen ?? 'alle'), label: 'x' },
    ]);
    registerOptionProvider(name, loader);

    expect(await loadProviderOptions(name, false, { unternehmen: ['a'] })).toEqual([{ value: 'a', label: 'x' }]);
    expect(await loadProviderOptions(name, false, { unternehmen: ['b'] })).toEqual([{ value: 'b', label: 'x' }]);
    expect(await loadProviderOptions(name)).toEqual([{ value: 'alle', label: 'x' }]);
    expect(loader).toHaveBeenCalledTimes(3);
    expect(loader).toHaveBeenNthCalledWith(1, { unternehmen: ['a'] });
    // Same values in another key order – same cache entry.
    await loadProviderOptions(name, false, { b: 1, unternehmen: ['a'] });
    await loadProviderOptions(name, false, { unternehmen: ['a'], b: 1 });
    expect(loader).toHaveBeenCalledTimes(4);
    expect(getProviderSnapshot(name, { unternehmen: ['b'] }).options).toEqual([{ value: 'b', label: 'x' }]);
    expect(getProviderSnapshot(name, { unternehmen: ['c'] }).options).toBeNull();

    // Invalidation reaches every combination; registering anew forgets them.
    invalidateOptionProvider(name);
    expect(getProviderSnapshot(name, { unternehmen: ['a'] }).loadedAt).toBe(0);
    expect(getProviderSnapshot(name).loadedAt).toBe(0);
    registerOptionProvider(name, loader);
    expect(getProviderSnapshot(name, { unternehmen: ['b'] }).options).toBeNull();
  });

  it('keeps a note next to incomplete options', async () => {
    const name = freshName();
    registerOptionProvider(name, async () => ({ options: PEOPLE, warning: 'Unvollständig – wireon: nicht erreichbar' }));
    expect(await loadProviderOptions(name)).toEqual(PEOPLE);
    expect(getProviderSnapshot(name)).toMatchObject({ options: PEOPLE, warning: 'Unvollständig – wireon: nicht erreichbar' });
    registerOptionProvider(name, async () => ({ options: PEOPLE }));
    await loadProviderOptions(name);
    expect(getProviderSnapshot(name).warning).toBeNull();
  });

  it('lets an invalidation retry a failed load', async () => {
    const name = freshName();
    registerOptionProvider(name, () => Promise.reject(new Error('planbar ist nicht eingerichtet')));
    await expect(loadProviderOptions(name)).rejects.toThrow();
    expect(getProviderSnapshot(name).error).toBe('planbar ist nicht eingerichtet');
    invalidateOptionProvider(name);
    // Error cleared: an open form loads again (the change may have fixed it).
    expect(getProviderSnapshot(name)).toMatchObject({ error: null, loadedAt: 0 });
  });

  it('writes dependencies as stable JSON', () => {
    expect(stableJson({ b: [2, { d: 1, c: null }], a: 'x', u: undefined })).toBe('{"a":"x","b":[2,{"c":null,"d":1}]}');
    expect(stableJson({})).toBe('{}');
    expect(stableJson(undefined)).toBe('null');
  });
});
