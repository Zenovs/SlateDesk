/**
 * hostAlerts – what the Host-Monitor (widget id 'nas') reports beyond its own
 * tile: the full-screen notice on the kiosk and the outage mails.
 *
 * - `useHostAlertStore`: current outages per widget instance; the
 *   HostAlertOverlay shows them all until the hosts answer again
 * - `outageMails`: compares the hosts that are down with those already
 *   reported and returns the mails to send – one when a host goes down, one
 *   when it answers again. The reported outages are kept in localStorage per
 *   instance, so a reload or an update never sends a mail twice.
 */
import { create } from 'zustand';

export interface HostOutage {
  key: string;
  name: string;
  address: string;
  /** Why the host did not answer. */
  message: string | null;
  /** Start of the outage (first failed check); null when unknown. */
  since: number | null;
}

// ── Full-screen notice ───────────────────────────────────────────────────────

interface HostAlertState {
  outages: Record<string /* instanceId */, HostOutage[]>;
}

export const useHostAlertStore = create<HostAlertState>(() => ({ outages: {} }));

export function reportHostOutages(instanceId: string, outages: HostOutage[]): void {
  useHostAlertStore.setState((state) => {
    const rest = { ...state.outages };
    delete rest[instanceId];
    return { outages: outages.length > 0 ? { ...rest, [instanceId]: outages } : rest };
  });
}

/** All outages, each check target once (two widgets may watch the same host), oldest first. */
export function allOutages(byInstance: Record<string, HostOutage[]>): HostOutage[] {
  const seen = new Map<string, HostOutage>();
  for (const outages of Object.values(byInstance)) {
    for (const outage of outages) if (!seen.has(outage.key)) seen.set(outage.key, outage);
  }
  return [...seen.values()].sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
}

/**
 * Unreachable for at least `afterMs` since its first failed check – then the
 * notice and the mail come. An unknown start counts as long enough.
 */
export function downLongEnough(since: number | null, now: number, afterMs: number): boolean {
  return since === null || now - since >= afterMs;
}

// ── Mails ────────────────────────────────────────────────────────────────────

/** Hosts reported as down: check key → start of the outage (ms). */
export type ReportedOutages = Record<string, number>;

export interface MonitoredHostState {
  key: string;
  name: string;
  address: string;
  state: 'pending' | 'up' | 'unstable' | 'down' | 'config';
  message: string | null;
  /** Start of the current up/down state; null when no change was observed. */
  since: number | null;
}

export interface OutageMail {
  subject: string;
  body: string;
}

const reportedKey = (instanceId: string): string => `slatedesk:nas:${instanceId}:reported`;

export function readReported(instanceId: string): ReportedOutages {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(reportedKey(instanceId)) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    );
  } catch {
    return {};
  }
}

export function writeReported(instanceId: string, reported: ReportedOutages): void {
  try {
    if (Object.keys(reported).length === 0) localStorage.removeItem(reportedKey(instanceId));
    else localStorage.setItem(reportedKey(instanceId), JSON.stringify(reported));
  } catch (err) {
    console.warn('Gemeldete Ausfälle konnten nicht gespeichert werden:', err);
  }
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('de-CH', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** «unter 1 Min.», «33 Min.», «2 Std. 5 Min.», «1 Tag 3 Std.» */
export function formatOutageDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'unter 1 Min.';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return `${days} ${days === 1 ? 'Tag' : 'Tage'}${hours > 0 ? ` ${hours} Std.` : ''}`;
  if (hours > 0) return `${hours} Std.${rest > 0 ? ` ${rest} Min.` : ''}`;
  return `${rest} Min.`;
}

function downMail(host: MonitoredHostState, since: number, kioskName: string): OutageMail {
  return {
    subject: `${host.name} nicht erreichbar`,
    body: [
      `${host.name} ist nicht erreichbar.`,
      '',
      `Adresse: ${host.address}`,
      `Grund: ${host.message ?? 'Keine Antwort'}`,
      `Seit: ${formatDateTime(since)}`,
      '',
      `Gemeldet vom SlateDesk-Bildschirm «${kioskName}». Sobald ${host.name} wieder antwortet, folgt eine weitere Mail.`,
    ].join('\n'),
  };
}

function recoveryMail(host: MonitoredHostState, since: number, until: number, kioskName: string): OutageMail {
  return {
    subject: `${host.name} wieder erreichbar`,
    body: [
      `${host.name} ist wieder erreichbar.`,
      '',
      `Adresse: ${host.address}`,
      `Ausfall: ${formatDateTime(since)} bis ${formatDateTime(until)} (${formatOutageDuration(until - since)})`,
      '',
      `Gemeldet vom SlateDesk-Bildschirm «${kioskName}».`,
    ].join('\n'),
  };
}

/**
 * Mails for what changed since the last report. A host removed from the
 * settings or turned into a configuration error is forgotten without a mail;
 * one that is still being checked (`pending`) stays reported.
 */
export function outageMails(
  reported: ReportedOutages,
  hosts: readonly MonitoredHostState[],
  now: number,
  kioskName: string,
): { reported: ReportedOutages; mails: OutageMail[] } {
  const next: ReportedOutages = {};
  const mails: OutageMail[] = [];
  const byKey = new Map<string, MonitoredHostState>();
  for (const host of hosts) if (!byKey.has(host.key)) byKey.set(host.key, host);

  for (const [key, since] of Object.entries(reported)) {
    const host = byKey.get(key);
    if (!host || host.state === 'config') continue;
    if (host.state === 'up' || host.state === 'unstable') {
      const until = host.state === 'up' && host.since !== null && host.since >= since ? host.since : now;
      mails.push(recoveryMail(host, since, until, kioskName));
    } else {
      next[key] = since;
    }
  }
  for (const host of byKey.values()) {
    if (host.state !== 'down' || host.key in next) continue;
    const since = host.since ?? now;
    next[host.key] = since;
    mails.push(downMail(host, since, kioskName));
  }
  return { reported: next, mails };
}
