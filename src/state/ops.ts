/**
 * State operations – pure, same semantics as the Rust backend (state.rs).
 *
 * - Never mutates its input: containers along the path are copied, all other
 *   subtrees keep their identity (cheap change detection for selectors).
 * - Values are stored as JSON (cloned, `undefined` dropped, non-finite → null),
 *   exactly what the backend holds after the round trip.
 * - Writing creates missing or `null` steps as objects; on a list the next
 *   free index (=== length) is allowed too, anything beyond is an error.
 *   A number addresses an object key as its string; a list accepts integer
 *   numbers and canonical numeric strings ("3", not "03").
 * - `merge` onto a non-object replaces it with the patch; `delete` of
 *   anything missing is a no-op, and so is `merge` with `create: false`.
 * - After all ops the top level is validated (known keys, `version` an
 *   integer, every other section an object). A batch is all or nothing.
 * - Invalid paths throw a German Error; callers treat that as "rejected".
 */
import type { Path, RawState, StateOp } from './types';

export const ALLOWED_TOP_LEVEL_KEYS: readonly string[] = [
  'version',
  'layout',
  'widgetSettings',
  'theme',
  'kiosk',
  'lagra',
  'planbar',
  'data',
];

// Own property named __proto__ would turn later `obj[key] = …` assignments
// into prototype changes – the only JS-specific restriction vs. Rust.
const FORBIDDEN_KEY = '__proto__';

const NO_CHANGE: unique symbol = Symbol('unverändert');
const REMOVE: unique symbol = Symbol('entfernen');

/**
 * Computes the new value of the addressed slot (or NO_CHANGE / REMOVE).
 * `current` is undefined when the slot does not exist.
 */
type Leaf = (current: unknown, exists: boolean) => unknown;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const formatPath = (path: Path): string =>
  path.length === 0 ? '(Wurzel)' : path.map((segment) => String(segment)).join('.');

function invalid(message: string): never {
  throw new Error(message);
}

function pathError(path: Path, reason: string): never {
  return invalid(`Ungültiger Pfad «${formatPath(path)}»: ${reason}`);
}

/** JSON clone so local state matches what the backend stores. */
function toJsonValue(value: unknown, path: Path): unknown {
  if (value === undefined) pathError(path, 'Wert fehlt');
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    pathError(path, 'Wert ist nicht als JSON darstellbar');
  }
  if (text === undefined) pathError(path, 'Wert ist nicht als JSON darstellbar');
  return JSON.parse(text) as unknown;
}

function arrayIndex(segment: string | number): number | null {
  if (typeof segment === 'number') return segment;
  return /^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : null;
}

function objectKey(segment: string | number, path: Path): string {
  const key = String(segment);
  if (key === FORBIDDEN_KEY) pathError(path, `Schlüssel «${key}» ist nicht erlaubt`);
  return key;
}

/**
 * Walks `path` below `node` and replaces the addressed slot with
 * `leaf(current)`. Returns the new node or NO_CHANGE. Without `create`
 * (delete), anything missing or mistyped on the way is a no-op.
 */
function updateIn(node: unknown, path: Path, depth: number, leaf: Leaf, create: boolean): unknown {
  const segment = path[depth];
  const isLast = depth === path.length - 1;
  const here = path.slice(0, depth);

  if (Array.isArray(node)) {
    const index = arrayIndex(segment);
    if (index === null) {
      if (!create) return NO_CHANGE;
      return pathError(path, `«${formatPath(here)}» ist eine Liste, «${String(segment)}» ist kein Index`);
    }
    if (index > node.length) {
      if (!create) return NO_CHANGE;
      return pathError(path, `Index ${index} liegt ausserhalb von «${formatPath(here)}»`);
    }
    const exists = index < node.length;
    const current = exists ? node[index] : undefined;
    let next: unknown;
    if (isLast) next = leaf(current, exists);
    else if (current === undefined || current === null) next = create ? updateIn({}, path, depth + 1, leaf, create) : NO_CHANGE;
    else next = updateIn(current, path, depth + 1, leaf, create);

    if (next === NO_CHANGE) return NO_CHANGE;
    const copy = node.slice();
    if (next === REMOVE) {
      if (!exists) return NO_CHANGE;
      copy.splice(index, 1);
    } else {
      copy[index] = next;
    }
    return copy;
  }

  if (isPlainObject(node)) {
    const key = objectKey(segment, path);
    const exists = Object.prototype.hasOwnProperty.call(node, key);
    const current = exists ? node[key] : undefined;
    let next: unknown;
    if (isLast) next = leaf(current, exists);
    else if (current === undefined || current === null) next = create ? updateIn({}, path, depth + 1, leaf, create) : NO_CHANGE;
    else next = updateIn(current, path, depth + 1, leaf, create);

    if (next === NO_CHANGE) return NO_CHANGE;
    if (next === REMOVE) {
      if (!exists) return NO_CHANGE;
      const copy = { ...node };
      delete copy[key];
      return copy;
    }
    return { ...node, [key]: next };
  }

  if (!create) return NO_CHANGE;
  return pathError(path, `«${formatPath(here)}» ist weder Objekt noch Liste`);
}

function checkPath(path: unknown): Path {
  if (!Array.isArray(path)) invalid('Ungültige Operation: Pfad fehlt');
  for (const segment of path) {
    const valid =
      typeof segment === 'string' || (typeof segment === 'number' && Number.isInteger(segment) && segment >= 0);
    if (!valid) pathError(path as Path, `«${String(segment)}» ist kein gültiges Pfadsegment`);
  }
  return path as Path;
}

function checkMergeKeys(value: Record<string, unknown>, path: Path): void {
  for (const key of Object.keys(value)) objectKey(key, [...path, key]);
}

function applyOne(state: RawState, op: StateOp): unknown {
  if (!op || typeof op !== 'object') invalid('Ungültige Operation');
  const path = checkPath((op as { path?: unknown }).path);

  switch (op.op) {
    case 'set': {
      const value = toJsonValue(op.value, path);
      if (path.length === 0) return value;
      return updateIn(state, path, 0, () => value, true);
    }
    case 'merge': {
      const value = toJsonValue(op.value, path);
      if (!isPlainObject(value)) invalid(`merge bei «${formatPath(path)}» erwartet ein Objekt`);
      checkMergeKeys(value, path);
      const merge = (current: unknown) => (isPlainObject(current) ? { ...current, ...value } : value);
      if (path.length === 0) return merge(state);
      if (op.create === false) {
        const next = updateIn(state, path, 0, (current, exists) => (exists ? merge(current) : NO_CHANGE), false);
        return next === NO_CHANGE ? state : next;
      }
      return updateIn(state, path, 0, merge, true);
    }
    case 'delete': {
      if (path.length === 0) invalid('delete auf die Wurzel ist nicht erlaubt');
      const next = updateIn(state, path, 0, (_current, exists) => (exists ? REMOVE : NO_CHANGE), false);
      return next === NO_CHANGE ? state : next;
    }
    case 'push': {
      if (path.length === 0) invalid('push auf die Wurzel ist nicht erlaubt');
      const value = toJsonValue(op.value, path);
      return updateIn(
        state,
        path,
        0,
        (current) => {
          if (current === undefined || current === null) return [value];
          if (!Array.isArray(current)) invalid(`push bei «${formatPath(path)}» erwartet eine Liste`);
          return [...current, value];
        },
        true,
      );
    }
    default:
      return invalid(`Unbekannte Operation «${String((op as { op: unknown }).op)}»`);
  }
}

/** Top-level shape check (same as the backend); deeper defaults are withDefaults()' job. */
export function validateState(state: unknown): asserts state is RawState {
  if (!isPlainObject(state)) invalid('Der Zustand muss ein Objekt sein');
  for (const [key, value] of Object.entries(state)) {
    if (key === 'version') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        invalid('«version» muss eine ganze Zahl sein');
      }
    } else if (ALLOWED_TOP_LEVEL_KEYS.includes(key)) {
      if (!isPlainObject(value)) invalid(`«${key}» muss ein Objekt sein`);
    } else {
      invalid(`Unbekannter Schlüssel im Zustand: «${key}»`);
    }
  }
}

/** Drops unknown or mistyped top-level keys, like the backend does when loading state.json. */
export function dropInvalidTopLevel(state: RawState): RawState {
  const out: RawState = {};
  for (const [key, value] of Object.entries(state)) {
    const keep =
      key === 'version'
        ? typeof value === 'number' && Number.isInteger(value) && value >= 0
        : ALLOWED_TOP_LEVEL_KEYS.includes(key) && isPlainObject(value);
    if (keep) out[key] = value;
  }
  return out;
}

/** Applies all ops in order, then validates. Throws (and changes nothing) if one is invalid. */
export function applyOps(state: RawState, ops: readonly StateOp[]): RawState {
  let next: unknown = state;
  for (const op of ops) next = applyOne(next as RawState, op);
  if (next === state) return state;
  validateState(next);
  return next;
}

export function applyOp(state: RawState, op: StateOp): RawState {
  return applyOps(state, [op]);
}

/**
 * Returns `next`, but re-uses every subtree of `prev` that is deep-equal.
 * Keeps object identity stable across full-state replacements (events,
 * defaults), so memoized selectors and effects don't fire for nothing.
 */
export function shareStructure<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;

  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = next.map((item, i) => {
      const shared = i < prev.length ? shareStructure(prev[i], item) : item;
      if (shared !== prev[i]) same = false;
      return shared;
    });
    return (same ? prev : out) as T;
  }

  if (isPlainObject(prev) && isPlainObject(next)) {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    let same = prevKeys.length === nextKeys.length;
    const out: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const has = Object.prototype.hasOwnProperty.call(prev, key);
      const shared = has ? shareStructure(prev[key], next[key]) : next[key];
      if (!has || shared !== prev[key]) same = false;
      out[key] = shared;
    }
    return (same ? prev : out) as T;
  }

  return next;
}

/** Structural equality for JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return shareStructure(a, b) === a;
}
