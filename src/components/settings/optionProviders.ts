/**
 * Option providers – choices for `select` / `multiselect` settings fields that
 * are loaded at runtime (e.g. the people of an organisation). A field names
 * its provider in `optionsProvider`; modules register the loader under that
 * name (src/planbar/options.ts, imported by the manifests that use it).
 *
 * Results are shared by all forms and kept 60 s, so opening a dialog does not
 * fetch again; a failed load keeps the last good options next to the error.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { SettingsChoice } from '../../types/settings';

export type ProviderOption = SettingsChoice;
export type OptionLoader = () => Promise<readonly ProviderOption[]>;

/** How long loaded options are reused before a form loads them again. */
export const OPTION_CACHE_MS = 60_000;

export interface ProviderSnapshot {
  /** null until the first successful load. */
  options: readonly ProviderOption[] | null;
  loading: boolean;
  /** German message of the last failed load; null after a success. */
  error: string | null;
  /** epoch ms of the last successful load, 0 = never / invalidated. */
  loadedAt: number;
}

const IDLE: ProviderSnapshot = Object.freeze({ options: null, loading: false, error: null, loadedAt: 0 });
const NO_OPTIONS: readonly ProviderOption[] = Object.freeze([]);

const loaders = new Map<string, OptionLoader>();
const snapshots = new Map<string, ProviderSnapshot>();
const running = new Map<string, Promise<readonly ProviderOption[]>>();
const listeners = new Set<() => void>();

function publish(name: string, snapshot: ProviderSnapshot): void {
  snapshots.set(name, snapshot);
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
  running.delete(name);
  publish(name, IDLE);
}

export const hasOptionProvider = (name: string): boolean => loaders.has(name);

export const getProviderSnapshot = (name: string): ProviderSnapshot => snapshots.get(name) ?? IDLE;

/** Marks the cached options of `name` (or of every provider) as outdated, e.g. after a new API key. */
export function invalidateOptionProvider(name?: string): void {
  for (const key of name === undefined ? [...snapshots.keys()] : [name]) {
    const snapshot = snapshots.get(key);
    if (snapshot && snapshot.loadedAt !== 0) publish(key, { ...snapshot, loadedAt: 0 });
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

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'Auswahl konnte nicht geladen werden';
}

/**
 * Options of `name`: cached ones while younger than 60 s (unless `force`),
 * otherwise a fresh load – concurrent callers share it. Rejects when the load
 * fails; the error is also kept in the provider's snapshot.
 */
export function loadProviderOptions(name: string, force = false): Promise<readonly ProviderOption[]> {
  const loader = loaders.get(name);
  if (!loader) {
    const error = `Unbekannte Auswahlliste «${name}»`;
    publish(name, { ...getProviderSnapshot(name), loading: false, error });
    return Promise.reject(new Error(error));
  }
  const current = getProviderSnapshot(name);
  if (!force && current.options && current.loadedAt > 0 && Date.now() - current.loadedAt < OPTION_CACHE_MS) {
    return Promise.resolve(current.options);
  }
  const pending = running.get(name);
  if (pending) return pending;

  // A loader replaced meanwhile (registerOptionProvider) must not publish its outdated result.
  const stillRegistered = (): boolean => loaders.get(name) === loader;
  const load: Promise<readonly ProviderOption[]> = Promise.resolve()
    .then(loader)
    .then(
      (raw) => {
        const options = cleanOptions(raw);
        if (stillRegistered()) publish(name, { options, loading: false, error: null, loadedAt: Date.now() });
        return options;
      },
      (err: unknown) => {
        if (stillRegistered()) publish(name, { ...getProviderSnapshot(name), loading: false, error: errorMessage(err) });
        throw err;
      },
    )
    .finally(() => {
      if (running.get(name) === load) running.delete(name);
    });
  running.set(name, load);
  publish(name, { ...current, loading: true });
  return load;
}

export interface ProviderOptionsState {
  /** Last successfully loaded options ([] before the first load). */
  options: readonly ProviderOption[];
  /** The options are known – ids missing from them are really unknown. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Loads again, ignoring the cache («Neu laden»). */
  reload: () => void;
}

const ignore = (): void => undefined;

/**
 * Options of a provider for a form field; loads them on mount when the cache
 * is empty or older than 60 s. `name` undefined = field without provider.
 */
export function useProviderOptions(name: string | undefined): ProviderOptionsState {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (name ? getProviderSnapshot(name) : IDLE),
    () => IDLE,
  );

  useEffect(() => {
    // Errors land in the snapshot; nothing else to do with the rejection here.
    if (name) loadProviderOptions(name).catch(ignore);
  }, [name]);

  const reload = useCallback(() => {
    if (name) loadProviderOptions(name, true).catch(ignore);
  }, [name]);

  return {
    options: snapshot.options ?? NO_OPTIONS,
    loaded: snapshot.options !== null,
    // Before the first load starts (mount effect pending) the field already shows «lädt».
    loading: snapshot.loading || (name !== undefined && snapshot.options === null && snapshot.error === null),
    error: snapshot.error,
    reload,
  };
}
