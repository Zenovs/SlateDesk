/**
 * hostCheck – what the Host-Monitor widget (id 'nas') checks and how it reads
 * the `net_check` results. Pure functions, no React.
 *
 * - `toTarget` normalises a configured host (pasted URLs, "host:port",
 *   "[v6]:port"); anything that cannot work becomes a config error instead of
 *   being sent to the backend
 * - `evaluate` tells outages from configuration errors: a name that never
 *   resolved is a config error, a DNS server that does not answer – or a name
 *   that resolved before – is an outage
 */
import type { NetCheckResult, NetCheckTarget } from '../utils/backend';
import { HOST_CHECK_KINDS, type HostCheckKind } from '../widgets/manifests/nas';

// ── Targets ──────────────────────────────────────────────────────────────────

export interface Target {
  /** Identity of the check – the history belongs to it, not to the display name. */
  key: string;
  name: string;
  /** What is checked, for display. */
  address: string;
  kind: HostCheckKind;
  port: number | null;
  check: NetCheckTarget | null;
  configError: string | null;
}

/** Same rule as the backend, without IPv6 brackets (they are stripped first). */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.:-]*$/;
/** The backend checks at most this many targets per call. */
export const MAX_TARGETS = 32;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPort = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;

const isKind = (value: unknown): value is HostCheckKind => HOST_CHECK_KINDS.includes(value as HostCheckKind);

/**
 * Normalises one configured host. Accepts pasted URLs, "host:port" and
 * "[v6]:port"; everything that cannot work is reported as config error
 * instead of being sent to the backend.
 */
export function toTarget(raw: unknown, index: number): Target {
  const item = isRecord(raw) ? raw : {};
  const kind: HostCheckKind = isKind(item.kind) ? item.kind : 'ping';
  let host = typeof item.host === 'string' ? item.host.trim() : '';
  let port: number | null = isPort(item.port) ? item.port : null;
  let path = typeof item.path === 'string' && item.path.trim() ? item.path.trim() : '/';
  let configError: string | null = null;
  /** Scheme of a pasted URL – passed on, so https works on any port (e.g. DSM on 5001). */
  let scheme: 'http' | 'https' | null = null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    try {
      const url = new URL(host);
      host = url.hostname.replace(/^\[|\]$/g, '');
      if (url.protocol === 'https:') scheme = 'https';
      else if (url.protocol === 'http:') scheme = 'http';
      if (url.port) port = Number(url.port);
      else if (kind === 'http') port = scheme === 'https' ? 443 : 80;
      if (kind === 'http' && (url.pathname !== '/' || url.search)) path = `${url.pathname}${url.search}`;
    } catch {
      configError = 'Ungültige Adresse';
    }
  } else {
    host = host.replace(/\/.*$/, '');
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
    const hostPort = /^([^:]+):(\d+)$/.exec(host);
    if (v6) {
      host = v6[1];
      if (v6[2]) port = Number(v6[2]);
    } else if (hostPort) {
      host = hostPort[1];
      port = Number(hostPort[2]);
    }
  }

  if (kind === 'http' && port === null) port = 80;
  if (!path.startsWith('/')) path = `/${path}`;
  if (!configError) {
    if (!host) configError = 'Adresse fehlt';
    else if (host.length > 253 || !HOST_RE.test(host)) configError = 'Ungültige Adresse';
    else if (kind !== 'ping' && !isPort(port)) configError = port === null ? 'Port fehlt' : 'Ungültiger Port';
    else if (kind === 'http' && /[\s#]/.test(path)) configError = 'Ungültiger Pfad';
  }

  const urlHost = host.includes(':') ? `[${host}]` : host;
  let address = host;
  if (kind === 'tcp') address = `${urlHost}:${port ?? '?'}`;
  if (kind === 'http') {
    const shown = scheme ?? (port === 443 ? 'https' : 'http');
    const portPart = port === (shown === 'https' ? 443 : 80) ? '' : `:${port}`;
    address = `${shown}://${urlHost}${portPart}${path === '/' ? '' : path}`;
  }

  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : host || `Host ${index + 1}`;
  const check: NetCheckTarget | null = configError
    ? null
    : {
        host,
        kind,
        ...(kind !== 'ping' && port !== null ? { port } : {}),
        ...(kind === 'http' ? { path, ...(scheme ? { scheme } : {}) } : {}),
      };
  const key = [kind, host.toLowerCase(), kind === 'ping' ? '' : String(port), kind === 'http' ? path : ''].join('|');
  // https on another port than 443 is a check of its own (it used to be a config error, so
  // no history exists); every other key stays as before.
  const keyed = kind === 'http' && scheme === 'https' && port !== 443 ? `${key}|https` : key;
  return { key: keyed, name, address: address || '–', kind, port, check, configError };
}

// ── Check results ────────────────────────────────────────────────────────────

export interface LiveResult {
  ok: boolean;
  latencyMs: number | null;
  lossPct: number | null;
  httpStatus: number | null;
  /** Why the host did not answer. */
  error: string | null;
  /** The check itself cannot work (name not resolvable, invalid input) – no outage. */
  configError: string | null;
}

export type LiveResults = Record<string, LiveResult>;

const DNS_ERROR_RE = /nicht auflösbar|lookup address|dns error|name or service not known|no address associated|name resolution/i;
/** getaddrinfo EAI_AGAIN: the DNS server did not answer – the network is down, the name may be fine. */
const DNS_UNREACHABLE_RE = /temporary failure in name resolution|dns nicht erreichbar/i;
const CONFIG_ERROR_RE = /ungültig|port fehlt|nicht erlaubt|berechtigung/i;

/** Rust error texts end with "(os error 111)" – noise on a wall display. */
const cleanError = (message: string): string => message.replace(/\s*\(os error \d+\)/gi, '').trim();

/**
 * `resolvedBefore`: the target answered within the kept history – so its name
 * existed, and failing to resolve it now is an outage (DNS server or the
 * device's name gone), not a typo.
 */
export function evaluate(result: NetCheckResult, host: string, resolvedBefore = false): LiveResult {
  const base = { latencyMs: result.latencyMs, lossPct: result.packetLossPct, httpStatus: result.status };
  const error = result.error ? cleanError(result.error) : null;
  if (error && DNS_UNREACHABLE_RE.test(error)) {
    return { ...base, ok: false, error: 'Nicht erreichbar (DNS antwortet nicht)', configError: null };
  }
  if (error && DNS_ERROR_RE.test(error)) {
    // An mDNS name disappears when the device is off – that is an outage, not a typo.
    if (/\.local$/i.test(host)) return { ...base, ok: false, error: 'Nicht erreichbar (Name im Netz nicht gefunden)', configError: null };
    if (resolvedBefore) return { ...base, ok: false, error: 'Nicht erreichbar (Name nicht auflösbar)', configError: null };
    return { ...base, ok: false, error: null, configError: 'Hostname nicht auflösbar' };
  }
  if (error && CONFIG_ERROR_RE.test(error)) return { ...base, ok: false, error: null, configError: error };
  if (result.reachable && result.status !== null && result.status >= 500) {
    return { ...base, ok: false, error: `Serverfehler HTTP ${result.status}`, configError: null };
  }
  if (!result.reachable) return { ...base, ok: false, error: error ?? 'Keine Antwort', configError: null };
  return { ...base, ok: true, error: null, configError: null };
}
