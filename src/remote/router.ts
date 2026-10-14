/**
 * Tiny hash router of the web UI: `#/<page>/<param>…`. The hash is the whole
 * route, so links are plain `<a href={href(…)}>` and reloads keep the page.
 */
import { useMemo, useSyncExternalStore } from 'react';

export type RouteName =
  | 'uebersicht'
  | 'layout'
  | 'widgets'
  | 'inhalte'
  | 'lagra'
  | 'planbar'
  | 'kiosk'
  | 'system'
  | 'mehr';

const ROUTE_NAMES: readonly RouteName[] = [
  'uebersicht',
  'layout',
  'widgets',
  'inhalte',
  'lagra',
  'planbar',
  'kiosk',
  'system',
  'mehr',
];

export const DEFAULT_ROUTE: RouteName = 'uebersicht';

export interface Route {
  name: RouteName;
  /** Decoded path segments after the page, e.g. the instanceId of `#/widgets/<id>`. */
  params: string[];
}

const isRouteName = (value: string): value is RouteName => (ROUTE_NAMES as readonly string[]).includes(value);

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `null` for an unknown page; an empty hash is the default page. */
function parseHash(hash: string): Route | null {
  const segments = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeSegment);
  if (segments.length === 0) return { name: DEFAULT_ROUTE, params: [] };
  const [name, ...params] = segments;
  return isRouteName(name) ? { name, params } : null;
}

/** Link target, e.g. `href('widgets', id)` → `#/widgets/<id>`. */
export function href(name: RouteName, ...params: string[]): string {
  return `#/${[name, ...params].map(encodeURIComponent).join('/')}`;
}

// replaceState fires no hashchange – subscribers are notified directly.
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('hashchange', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', listener);
  };
}

const currentHash = (): string => window.location.hash;

/** Goes to `target` (a `#/…` hash); `replace` keeps the current history entry. */
export function navigate(target: string, options: { replace?: boolean } = {}): void {
  const hash = target.startsWith('#') ? target : `#${target}`;
  if (window.location.hash === hash) return;
  if (options.replace) {
    window.history.replaceState(window.history.state, '', hash);
    for (const listener of listeners) listener();
  } else {
    window.location.hash = hash;
  }
}

/** Current route; `null` while the hash names an unknown page. */
export function useRoute(): Route | null {
  const hash = useSyncExternalStore(subscribe, currentHash, () => '');
  return useMemo(() => parseHash(hash), [hash]);
}
