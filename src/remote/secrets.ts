/**
 * Secrets in the web UI. The server never sends them (non-empty values
 * arrive as «__gesetzt__»), and it clears a stored secret when the URL/host
 * next to it changes over HTTP without the secret being re-entered in the
 * same request (state.rs, anti-exfiltration).
 */
import { isPlainObject, jsonEqual } from '../state/ops';
import { isSecretKey, REDACTED_SECRET, type SettingsField, type ValueField } from '../types/settings';

/** Same rule as state.rs `is_endpoint_key`. */
const isEndpointKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  return lower.endsWith('url') || lower.endsWith('host');
};

export const isSecretSet = (value: unknown): boolean =>
  value === REDACTED_SECRET || (typeof value === 'string' && value !== '');

const valueFields = (schema: readonly SettingsField[]): ValueField[] =>
  schema.filter((field): field is ValueField => field.type !== 'section');

/** The schema (or a list inside it) has a secret field. */
export function hasSecretField(schema: readonly SettingsField[]): boolean {
  return valueFields(schema).some(
    (field) => field.type === 'secret' || (field.type === 'list' && hasSecretField(field.itemFields)),
  );
}

/** A secret shares its object with a URL/host field – changing that address clears the secret. */
export function hasSecretNextToEndpoint(schema: readonly SettingsField[]): boolean {
  const fields = valueFields(schema);
  if (fields.some((f) => f.type === 'secret') && fields.some((f) => isEndpointKey(f.key))) return true;
  return fields.some((field) => field.type === 'list' && hasSecretNextToEndpoint(field.itemFields));
}

/** Labels of the top-level secrets the server clears when `patch` is saved. */
export function secretsClearedBy(
  schema: readonly SettingsField[],
  values: Record<string, unknown>,
  patch: Record<string, unknown>,
): string[] {
  const endpointChanged = Object.entries(patch).some(
    ([key, value]) => isEndpointKey(key) && !jsonEqual(values[key], value),
  );
  if (!endpointChanged) return [];
  return valueFields(schema)
    .filter((field) => field.type === 'secret' && !(field.key in patch) && isSecretSet(values[field.key]))
    .map((field) => field.label);
}

/**
 * Deep copy with every secret emptied – stored secrets can't be copied over
 * HTTP (the server only has them at their original place). `dropped` tells
 * whether a set secret was left behind.
 */
export function withoutSecrets<T>(value: T): { value: T; dropped: boolean } {
  let dropped = false;
  const strip = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(strip);
    if (!isPlainObject(input)) return input;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input)) {
      if (isSecretKey(key) && typeof child === 'string') {
        if (child !== '') dropped = true;
        out[key] = '';
      } else {
        out[key] = strip(child);
      }
    }
    return out;
  };
  const result = strip(value) as T;
  return { value: result, dropped };
}
