/**
 * Option providers – choices for `select` / `multiselect` settings fields that
 * are loaded at runtime (e.g. the people of an organisation). A field names
 * its provider in `optionsProvider`; modules register the loader under that
 * name (src/planbar/options.ts, imported by the manifests that use it).
 *
 * A field may make its choices depend on other values of the same form
 * (`optionsDependsOn`, e.g. the people of the selected Unternehmen): the
 * loader receives them as `deps`, and every combination is cached on its own.
 *
 * Results are shared by all forms and kept 60 s, so opening a dialog does not
 * fetch again; a failed load keeps the last good options next to the error.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { SettingsChoice } from '../../types/settings';

export type ProviderOption = SettingsChoice;
/** Values of the form fields a provider depends on (`optionsDependsOn`). */
export type ProviderDeps = Readonly<Record<string, unknown>>;
/** Options plus a note that they are incomplete (e.g. one Unternehmen did not answer). */
export interface ProviderResult {
  options: readonly ProviderOption[];
  warning?: string | null;
}
export type OptionLoader = (deps: ProviderDeps) => Promise<readonly ProviderOption[] | ProviderResult>;

/** How long loaded options are reused before a form loads them again. */
export const OPTION_CACHE_MS = 60_000;

export interface ProviderSnapshot {
  /** null until the first successful load. */
  options: readonly ProviderOption[] | null;
  loading: boolean;
  /** German message of the last failed load; null after a success. */
  error: string | null;
  /** The last load succeeded but is incomplete – German note, else null. */
  warning: string | null;
  /** epoch ms of the last successful load, 0 = never / invalidated. */
  loadedAt: number;
}

const IDLE: ProviderSnapshot = Object.freeze({ options: null, loading: false, error: null, warning: null, loadedAt: 0 });
const NO_OPTIONS: readonly ProviderOption[] = Object.freeze([]);
const NO_DEPS: ProviderDeps = Object.freeze({});

const loaders = new Map<string, OptionLoader>();
/** Keyed by `cacheKey(name, deps)`. */
const snapshots = new Map<string, ProviderSnapshot>();
const running = new Map<string, Promise<readonly ProviderOption[]>>();
const listeners = new Set<() => void>();

/** JSON with sorted object keys – equal deps give equal text whatever their key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item ?? null)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null) ?? 'null';
}

const SEPARATOR = '\u0000';
const EMPTY_DEPS_JSON = '{}';

const keyOf = (name: string, depsJson: string): string =>
  depsJson === EMPTY_DEPS_JSON ? name : `${name}${SEPARATOR}${depsJson}`;

const cacheKey = (name: string, deps: ProviderDeps): string => keyOf(name, stableJson(deps));

/** Every cached variant (deps) of provider `name`. */
const keysOf = (name: string): string[] =>
  [...new Set([...snapshots.keys(), ...running.keys()])].filter(
    (key) => key === name || key.startsWith(`${name}${SEPARATOR}`),
  );

function publish(key: string, snapshot: ProviderSnapshot): void {
  snapshots.set(key, snapshot);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Registers (or replaces) the loader for `name` and forgets what the old one loaded. */
export function registerOptionProvider(name: string, loader: OptionLoader): void {
  loaders.set(name, loader);
  const keys = keysOf(name);
  for (const key of keys) running.delete(key);
  for (const key of keys.includes(name) ? keys : [...keys, name]) publish(key, IDLE);
}

export const hasOptionProvider = (name: string): boolean => loaders.has(name);

export const getProviderSnapshot = (name: string, deps: ProviderDeps = NO_DEPS): ProviderSnapshot =>
  snapshots.get(cacheKey(name, deps)) ?? IDLE;

/**
 * Marks the cached options of `name` (all its deps, or every provider) as
 * outdated, e.g. after a new API key. Open forms load them again – also after
 * a failed load, which the change may have fixed.
 */
export function invalidateOptionProvider(name?: string): void {
  const keys = name === undefined ? [...snapshots.keys()] : keysOf(name);
  for (const key of keys) {
    const snapshot = snapshots.get(key);
    if (snapshot && (snapshot.loadedAt !== 0 || snapshot.error !== null)) {
      publish(key, { ...snapshot, loadedAt: 0, error: null });
    }
  }
}

/** Only well-formed entries, each value once – loaders return remote data. */
function cleanOptions(raw: readonly ProviderOption[]): ProviderOption[] {
  const seen = new Set<string>();
  const out: ProviderOption[] = [];
  for (const option of raw) {
    if (typeof option?.value !== 'string' || typeof option.label !== 'string' || seen.has(option.value)) continue;
    seen.add(option.value);
    out.push(option);
  }
  return out;
}

function toResult(raw: readonly ProviderOption[] | ProviderResult): { options: ProviderOption[]; warning: string | null } {
  if (Array.isArray(raw)) return { options: cleanOptions(raw), warning: null };
  const result = raw as ProviderResult;
  const options = Array.isArray(result?.options) ? cleanOptions(result.options) : [];
  const warning = typeof result?.warning === 'string' && result.warning.trim() ? result.warning : null;
  return { options, warning };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'Auswahl konnte nicht geladen werden';
}

/**
 * Options of `name` for `deps`: cached ones while younger than 60 s (unless
 * `force`), otherwise a fresh load – concurrent callers share it. Rejects when
 * the load fails; the error is also kept in the provider's snapshot.
 */
export function loadProviderOptions(
  name: string,
  force = false,
  deps: ProviderDeps = NO_DEPS,
): Promise<readonly ProviderOption[]> {
  const key = cacheKey(name, deps);
  const loader = loaders.get(name);
  if (!loader) {
    const error = `Unbekannte Auswahlliste «${name}»`;
    publish(key, { ...(snapshots.get(key) ?? IDLE), loading: false, error });
    return Promise.reject(new Error(error));
  }
  const current = snapshots.get(key) ?? IDLE;
  if (!force && current.options && current.loadedAt > 0 && Date.now() - current.loadedAt < OPTION_CACHE_MS) {
    return Promise.resolve(current.options);
  }
  const pending = running.get(key);
  if (pending) return pending;

  // A loader replaced meanwhile (registerOptionProvider) must not publish its outdated result.
  const stillRegistered = (): boolean => loaders.get(name) === loader && running.get(key) === load;
  const load: Promise<readonly ProviderOption[]> = Promise.resolve()
    .then(() => loader(deps))
    .then(
      (raw) => {
        const { options, warning } = toResult(raw);
        if (stillRegistered()) publish(key, { options, loading: false, error: null, warning, loadedAt: Date.now() });
        return options;
      },
      (err: unknown) => {
        if (stillRegistered()) {
          publish(key, { ...(snapshots.get(key) ?? IDLE), loading: false, error: errorMessage(err) });
        }
        throw err;
      },
    )
    .finally(() => {
      if (running.get(key) === load) running.delete(key);
    });
  running.set(key, load);
  publish(key, { ...current, loading: true });
  return load;
}

export interface ProviderOptionsState {
  /** Last successfully loaded options ([] before the first load). */
  options: readonly ProviderOption[];
  /** The options are known – ids missing from them are really unknown. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** The options are incomplete (German note). */
  warning: string | null;
  /** Loads again, ignoring the cache («Neu laden»). */
  reload: () => void;
}

const ignore = (): void => undefined;

/**
 * Options of a provider for a form field; loads them on mount when the cache
 * is empty or older than 60 s, and again when `deps` change or the provider
 * is invalidated. `name` undefined = field without provider.
 */
export function useProviderOptions(name: string | undefined, deps: ProviderDeps = NO_DEPS): ProviderOptionsState {
  const depsJson = stableJson(deps);
  const key = name === undefined ? undefined : keyOf(name, depsJson);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (key ? (snapshots.get(key) ?? IDLE) : IDLE),
    () => IDLE,
  );
  // Never loaded, or invalidated: load (again). After a failure only «Neu laden» retries.
  const stale = name !== undefined && snapshot.loadedAt === 0 && !snapshot.loading && snapshot.error === null;

  useEffect(() => {
    // Errors land in the snapshot; nothing else to do with the rejection here.
    if (name) loadProviderOptions(name, false, JSON.parse(depsJson) as ProviderDeps).catch(ignore);
  }, [name, depsJson, stale]);

  const reload = useCallback(() => {
    if (name) loadProviderOptions(name, true, JSON.parse(depsJson) as ProviderDeps).catch(ignore);
  }, [name, depsJson]);

  return {
    options: snapshot.options ?? NO_OPTIONS,
    loaded: snapshot.options !== null,
    // Before the first load starts (mount effect pending) the field already shows «lädt».
    loading: snapshot.loading || (name !== undefined && snapshot.options === null && snapshot.error === null),
    error: snapshot.error,
    warning: snapshot.warning,
    reload,
  };
}
