/** The address as http(s) URL without trailing slashes, or null when it is not one. */
export function httpUrlOrNull(text: string): string | null {
  try {
    const url = new URL(text.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
    return text.trim().replace(/\/+$/, '');
  } catch {
    return null;
  }
}
