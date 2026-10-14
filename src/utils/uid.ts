/**
 * Unique ID generator.
 *
 * Uses crypto.getRandomValues (also available outside secure contexts, i.e.
 * the web UI over plain http in the LAN – unlike crypto.randomUUID) with a
 * Math.random fallback. Call from event handlers, never during render.
 */
function randomPart(): string {
  const cryptoApi = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).slice(2, 12).padEnd(10, '0');
}

/** Time-prefixed random id, e.g. `mgk3x1a2-9f3c2b7d1e0a4c55`. */
export const uid = (): string => `${Date.now().toString(36)}-${randomPart()}`;
