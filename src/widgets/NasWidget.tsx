/**
 * Host-Monitor widget (id 'nas') – reachability and response time of NAS,
 * servers and services via ping, TCP connect or HTTP.
 *
 * The backend checks all hosts concurrently (`net_check`). A host only counts
 * as down after `failureThreshold` failed checks in a row; names that never
 * resolved and invalid addresses are configuration errors, not outages – a
 * DNS server that does not answer, or a name that resolved before, is an
 * outage. The history is stored per instance and per check target (kind,
 * host, port, path), so renaming a host keeps it and pointing it elsewhere
 * starts over; it is written to localStorage every few minutes, not per check.
 *
 * Outages also go beyond the tile (services/hostAlerts): a large notice over
 * the whole kiosk and a mail when a host goes down and when it is back – both
 * only from checks of this run, never from the stored history alone, and only
 * once the outage has lasted `alertAfterMinutes`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, ServerOff, Settings2 } from 'lucide-react';
import type { WidgetProps } from '../types/widget';
import { useAppState } from '../state/appState';
import { widgetSettingsActions } from '../state/dataActions';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { usePolling } from '../hooks/usePolling';
import {
  downLongEnough,
  outageMails,
  readReported,
  reportHostOutages,
  writeReported,
  type HostOutage,
  type MonitoredHostState,
} from '../services/hostAlerts';
import {
  evaluate,
  MAX_TARGETS,
  toTarget,
  type LiveResult,
  type LiveResults,
  type Target,
} from '../services/hostCheck';
import { isTauri, KIOSK_ONLY_MESSAGE, mailAlert, netCheck, type NetCheckTarget } from '../utils/backend';
import {
  ALERT_AFTER_OPTIONS,
  HOST_MONITOR_DEFAULT_SETTINGS,
  type HostMonitorSettings,
  type MonitoredHost,
} from './manifests/nas';
import { ArcGauge, TimeSparkline, type ChartTone, type SparkPoint } from './shared/charts';
import './styles/nas.css';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// ── History ──────────────────────────────────────────────────────────────────

/** [unix seconds, latency ms]: -1 = failed, null = reachable without a time. */
type Sample = [number, number | null];
type HistoryStore = Record<string, Sample[]>;

const FAILED = -1;
/** Largest `historyHours` option. */
const HISTORY_KEEP_MS = 24 * 3_600_000;
/** 24 h at 30 s are 2880 checks; a little more keeps the full window. */
const MAX_SAMPLES = 3000;
/**
 * The history is written this often (and when the page goes away), not after
 * every check: up to 32 hosts × 3000 samples are a few 100 KB to rewrite.
 */
const PERSIST_EVERY_MS = 5 * 60_000;
const HISTORY_OPTIONS = [6, 12, 24];
const INTERVAL_OPTIONS = [30, 60, 300, 900];
const LEGACY_HISTORY_KEY = 'slatedesk:nas:history';
const LEGACY_LAST_KEY = 'slatedesk:nas:last';
const historyKey = (instanceId: string): string => `slatedesk:nas:${instanceId}:history`;

function parseSamples(raw: unknown): Sample[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is Sample =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      isFiniteNumber(entry[0]) &&
      (entry[1] === null || (isFiniteNumber(entry[1]) && (entry[1] >= 0 || entry[1] === FAILED))),
  );
}

/** Entries of the old global history: `{ reachable, latency_ms, timestamp }`. */
function parseLegacySamples(raw: unknown): Sample[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): Sample[] => {
    if (!isRecord(entry) || !isFiniteNumber(entry.timestamp) || typeof entry.reachable !== 'boolean') return [];
    if (!entry.reachable) return [[entry.timestamp, FAILED]];
    return [[entry.timestamp, isFiniteNumber(entry.latency_ms) && entry.latency_ms > 0 ? entry.latency_ms : null]];
  });
}

function pruneSamples(samples: Sample[], now: number): Sample[] {
  const cutoff = (now - HISTORY_KEEP_MS) / 1000;
  const kept = samples.filter(([t]) => t >= cutoff);
  return kept.length > MAX_SAMPLES ? kept.slice(-MAX_SAMPLES) : kept;
}

function readJson(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text === null ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** The old global keys go to the first instance without own history (only one may take them). */
let legacyClaimedBy: string | null = null;

function loadHistory(instanceId: string, targets: Target[], now: number): { history: HistoryStore; fromLegacy: boolean } {
  const own = readJson(historyKey(instanceId));
  const history: HistoryStore = {};
  if (isRecord(own) && isRecord(own.hosts)) {
    for (const [key, samples] of Object.entries(own.hosts)) history[key] = pruneSamples(parseSamples(samples), now);
    return { history, fromLegacy: false };
  }
  if (own !== undefined || (legacyClaimedBy !== null && legacyClaimedBy !== instanceId)) return { history, fromLegacy: false };
  const legacy = readJson(LEGACY_HISTORY_KEY);
  if (legacy === undefined && readJson(LEGACY_LAST_KEY) === undefined) return { history, fromLegacy: false };
  legacyClaimedBy = instanceId;
  // The old widget pinged exactly one host.
  const target = targets.find((t) => t.kind === 'ping' && t.check !== null);
  if (target) history[target.key] = pruneSamples(parseLegacySamples(legacy), now);
  return { history, fromLegacy: true };
}

/** Whether the target ever answered within the kept history. */
const answeredBefore = (samples: readonly Sample[] | undefined): boolean =>
  samples !== undefined && samples.some(([, ms]) => ms !== FAILED);

function recordSamples(prev: HistoryStore, live: LiveResults, keys: readonly string[], at: number): HistoryStore {
  const next: HistoryStore = {};
  const t = Math.round(at / 1000);
  for (const key of keys) {
    const samples = pruneSamples(prev[key] ?? [], at);
    const result = live[key];
    if (result && !result.configError) {
      const latency = result.ok && result.latencyMs !== null ? Math.round(result.latencyMs * 10) / 10 : null;
      samples.push([t, result.ok ? latency : FAILED]);
    }
    next[key] = samples;
  }
  return next;
}

// ── Status ───────────────────────────────────────────────────────────────────

type HostState = 'pending' | 'up' | 'unstable' | 'down' | 'config';

interface HostStatus {
  target: Target;
  state: HostState;
  latencyMs: number | null;
  lossPct: number | null;
  httpStatus: number | null;
  /** Error to show (config error or why the host did not answer). */
  message: string | null;
  /** Start of the current up/down state; null when no change was observed. */
  since: number | null;
  failures: number;
  uptimePct: number | null;
  points: SparkPoint[];
  marks: number[];
}

/**
 * Walks the history with the failure threshold: `down` after `threshold`
 * failures in a row, `up` again with the first success. «seit» is only known
 * for a down state or after an observed recovery.
 */
function analyse(samples: readonly Sample[], threshold: number) {
  let state: 'up' | 'down' | null = null;
  let since: number | null = null;
  let failures = 0;
  let streakStart: number | null = null;
  for (const [t, ms] of samples) {
    const at = t * 1000;
    if (ms === FAILED) {
      if (failures === 0) streakStart = at;
      failures += 1;
      if (failures >= threshold && state !== 'down') {
        state = 'down';
        since = streakStart;
      }
    } else {
      if (state === 'down') since = at;
      else if (state === null) since = null;
      state = 'up';
      failures = 0;
      streakStart = null;
    }
  }
  return { state, since, failures };
}

function hostStatus(
  target: Target,
  samples: readonly Sample[],
  live: LiveResult | undefined,
  threshold: number,
  windowFrom: number,
): HostStatus {
  const inWindow = samples.filter(([t]) => t * 1000 >= windowFrom);
  const okCount = inWindow.filter(([, ms]) => ms !== FAILED).length;
  const last = samples.length > 0 ? samples[samples.length - 1] : null;
  const { state, since, failures } = analyse(samples, threshold);
  const status: HostStatus = {
    target,
    state: 'pending',
    latencyMs: live ? (live.ok ? live.latencyMs : null) : last && last[1] !== FAILED ? last[1] : null,
    lossPct: live?.lossPct ?? null,
    httpStatus: live?.httpStatus ?? null,
    message: null,
    since,
    failures,
    uptimePct: inWindow.length > 0 ? (okCount / inWindow.length) * 100 : null,
    points: inWindow.map(([t, ms]) => ({ t: t * 1000, v: ms === FAILED ? null : ms })),
    marks: inWindow.filter(([, ms]) => ms === FAILED).map(([t]) => t * 1000),
  };
  const configError = target.configError ?? live?.configError ?? null;
  if (configError) return { ...status, state: 'config', message: configError, since: null };
  if (state === 'down') return { ...status, state: 'down', message: live?.error ?? 'Keine Antwort' };
  if (failures > 0) return { ...status, state: 'unstable', message: live?.error ?? 'Keine Antwort' };
  if (state === 'up') return { ...status, state: 'up' };
  return status;
}

function latencyTone(ms: number | null, lossPct: number | null, warn: number, crit: number): ChartTone {
  if (ms !== null && ms >= crit) return 'crit';
  if ((ms !== null && ms >= warn) || (lossPct ?? 0) > 0) return 'warn';
  return 'ok';
}

function statusTone(status: HostStatus, warn: number, crit: number): ChartTone {
  switch (status.state) {
    case 'down':
      return 'crit';
    case 'unstable':
    case 'config':
      return 'warn';
    case 'pending':
      return 'muted';
    case 'up':
      return latencyTone(status.latencyMs, status.lossPct, warn, crit);
  }
}

const formatMs = (ms: number): string => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));

function formatPct(pct: number): string {
  const rounded = Math.round(pct * 10) / 10;
  // An availability with failures is never rounded up to 100 %.
  const shown = pct < 100 && rounded >= 100 ? 99.9 : rounded;
  return Number.isInteger(shown) ? String(shown) : shown.toFixed(1);
}

function formatClock(ms: number, now: number, withSeconds = false): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString('de-CH', {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  return `${date.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })} ${time}`;
}

function stateLabel(status: HostStatus, threshold: number): string {
  switch (status.state) {
    case 'up':
      return 'Online';
    case 'down':
      return 'Offline';
    case 'unstable':
      return `Instabil (${status.failures}/${threshold})`;
    case 'config':
      return 'Konfiguration prüfen';
    case 'pending':
      return 'Prüfe…';
  }
}

function latencyText(status: HostStatus): string {
  switch (status.state) {
    case 'down':
      return 'offline';
    case 'pending':
      return '…';
    case 'config':
    case 'unstable':
      return '–';
    case 'up':
      // Reachable, but the check reported no time (e.g. ping without summary line).
      return status.latencyMs !== null ? `${formatMs(status.latencyMs)} ms` : 'ok';
  }
}

function kindCaption(status: HostStatus): string {
  const { kind, port } = status.target;
  if (kind === 'tcp') return `TCP ${port ?? ''} · Verbindungsaufbau`;
  if (kind === 'http') return `HTTP${status.httpStatus !== null ? ` ${status.httpStatus}` : ''} · Antwortzeit`;
  return 'Ping · Antwortzeit';
}

// ── Settings access ──────────────────────────────────────────────────────────

const positive = (value: unknown, fallback: number): number => (isFiniteNumber(value) && value > 0 ? value : fallback);

/** Before the Host-Monitor, the widget pinged one `ip`. */
function legacyHost(stored: Record<string, unknown> | undefined): MonitoredHost | null {
  if (!stored || stored.hosts !== undefined || typeof stored.ip !== 'string' || !stored.ip.trim()) return null;
  return { name: 'NAS', host: stored.ip.trim(), kind: 'ping', port: 445, path: '/' };
}

function useHostMonitor(instanceId: string) {
  const [settings] = useWidgetSettings<HostMonitorSettings>(instanceId, HOST_MONITOR_DEFAULT_SETTINGS);
  const stored = useAppState((s) => s.state.widgetSettings[instanceId]);
  const legacy = legacyHost(stored);
  const hosts = legacy ? [legacy] : Array.isArray(settings.hosts) ? settings.hosts : [];
  // Keyed by content: the settings object changes on every unrelated edit.
  const hostsJson = JSON.stringify(hosts);
  const targets = useMemo(
    () => (JSON.parse(hostsJson) as unknown[]).slice(0, MAX_TARGETS).map(toTarget),
    [hostsJson],
  );
  const warn = positive(settings.warnLatencyMs, HOST_MONITOR_DEFAULT_SETTINGS.warnLatencyMs);
  return {
    settings,
    stored,
    targets,
    overflow: hosts.length > MAX_TARGETS,
    intervalSeconds: INTERVAL_OPTIONS.includes(settings.intervalSeconds)
      ? settings.intervalSeconds
      : HOST_MONITOR_DEFAULT_SETTINGS.intervalSeconds,
    warn,
    crit: Math.max(warn, positive(settings.critLatencyMs, HOST_MONITOR_DEFAULT_SETTINGS.critLatencyMs)),
    threshold: Math.min(10, Math.max(1, Math.round(positive(settings.failureThreshold, HOST_MONITOR_DEFAULT_SETTINGS.failureThreshold)))),
    historyHours: HISTORY_OPTIONS.includes(settings.historyHours) ? settings.historyHours : HOST_MONITOR_DEFAULT_SETTINGS.historyHours,
  };
}

/** Unique checks – the same target configured twice is checked once. */
function uniqueChecks(targets: readonly Target[]): { key: string; host: string; check: NetCheckTarget }[] {
  const seen = new Set<string>();
  const checks: { key: string; host: string; check: NetCheckTarget }[] = [];
  for (const target of targets) {
    if (!target.check || seen.has(target.key)) continue;
    seen.add(target.key);
    checks.push({ key: target.key, host: target.check.host, check: target.check });
  }
  return checks;
}

// ── Views ────────────────────────────────────────────────────────────────────

interface ViewProps {
  statuses: HostStatus[];
  warn: number;
  crit: number;
  threshold: number;
  showSparkline: boolean;
  windowFrom: number;
  windowTo: number;
  maxGapMs: number;
  historyHours: number;
  now: number;
}

function SingleHostView({ statuses, warn, crit, threshold, showSparkline, windowFrom, windowTo, maxGapMs, historyHours, now }: ViewProps) {
  const status = statuses[0];
  const tone = statusTone(status, warn, crit);
  // Square-root scale up to 1.5 × «kritisch»: LAN pings below 1 ms stay visible,
  // and the thresholds sit at fixed places on the arc.
  const scaleMax = crit * 1.5;
  const fraction = status.latencyMs !== null && status.state !== 'down' ? Math.sqrt(Math.min(status.latencyMs, scaleMax) / scaleMax) : 0;
  const sparkMax = Math.max(warn, ...status.points.map((p) => p.v ?? 0)) * 1.1;

  return (
    <>
      <div className="hostmon-single-head">
        <span className={`hostmon-pill chart-tone-${tone}`}>
          <span className="hostmon-dot" />
          {stateLabel(status, threshold)}
        </span>
        <span className="hostmon-address" title={status.target.address}>
          {status.target.address}
        </span>
      </div>

      <div className="hostmon-main">
        {status.state === 'config' ? (
          <div className="hostmon-config">
            <Settings2 aria-hidden="true" />
            <strong>{status.message}</strong>
            <span>Adresse in den Einstellungen prüfen</span>
          </div>
        ) : (
          <div className="hostmon-gauge">
            <ArcGauge
              fraction={fraction}
              tone={status.state === 'down' ? 'crit' : status.state === 'pending' ? 'muted' : tone}
              value={status.latencyMs !== null && status.state !== 'down' ? formatMs(status.latencyMs) : '—'}
              unit={status.state === 'down' ? 'offline' : 'ms'}
              label={`${status.target.name}: ${stateLabel(status, threshold)}`}
            />
          </div>
        )}

        <div className="hostmon-caption">
          <strong>{status.target.name}</strong>
          <span>{kindCaption(status)}</span>
        </div>

        <div className="hostmon-stats">
          {status.uptimePct !== null && (
            <span>
              Verfügbar {formatPct(status.uptimePct)} % ({historyHours} h)
            </span>
          )}
          {status.target.kind === 'ping' && status.lossPct !== null && status.lossPct > 0 && status.state !== 'down' && (
            <span className="is-warn">Verlust {formatPct(status.lossPct)} %</span>
          )}
          {status.since !== null && (status.state === 'up' || status.state === 'down') && (
            <span>seit {formatClock(status.since, now)}</span>
          )}
          {(status.state === 'down' || status.state === 'unstable') && status.message && (
            <span className="is-error">{status.message}</span>
          )}
        </div>
      </div>

      {showSparkline && status.points.length >= 2 && (
        <div className="hostmon-spark">
          <TimeSparkline
            from={windowFrom}
            to={windowTo}
            maxGapMs={maxGapMs}
            marks={status.marks}
            series={[{ id: 'latency', points: status.points, max: sparkMax, tone: 'accent', fill: true }]}
            label={`Antwortzeit der letzten ${historyHours} Stunden`}
          />
        </div>
      )}
    </>
  );
}

function HostListView({ statuses, warn, crit, threshold, showSparkline, windowFrom, windowTo, maxGapMs, now }: ViewProps) {
  return (
    <ul className="hostmon-list">
      {statuses.map((status, index) => {
        const tone = statusTone(status, warn, crit);
        const sparkMax = Math.max(warn, ...status.points.map((p) => p.v ?? 0)) * 1.1;
        let detail = status.target.address;
        if (status.state === 'config' || status.state === 'down' || status.state === 'unstable') {
          detail = status.message ?? detail;
        }
        if (status.since !== null && (status.state === 'up' || status.state === 'down')) {
          detail = `${detail} · seit ${formatClock(status.since, now)}`;
        }
        return (
          <li key={`${status.target.key}#${index}`} className={`hostmon-row chart-tone-${tone} is-${status.state}`}>
            <span className="hostmon-dot" title={stateLabel(status, threshold)} />
            <div className="hostmon-row-main">
              <span className="hostmon-row-name">{status.target.name}</span>
              <span className="hostmon-row-detail">{detail}</span>
            </div>
            {showSparkline && status.points.length >= 2 && (
              <div className="hostmon-row-spark">
                <TimeSparkline
                  from={windowFrom}
                  to={windowTo}
                  maxGapMs={maxGapMs}
                  marks={status.marks}
                  series={[{ id: 'latency', points: status.points, max: sparkMax, tone: 'accent' }]}
                  label={`Antwortzeit ${status.target.name}`}
                />
              </div>
            )}
            <div className="hostmon-row-values">
              <span className="hostmon-row-latency">{latencyText(status)}</span>
              {status.uptimePct !== null && <span className="hostmon-row-uptime">{formatPct(status.uptimePct)} %</span>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ── Widget ───────────────────────────────────────────────────────────────────

export function NasWidget({ instanceId }: WidgetProps) {
  const monitor = useHostMonitor(instanceId);
  const { settings, stored, targets, intervalSeconds, warn, crit, threshold, historyHours } = monitor;
  const [initial] = useState(() => loadHistory(instanceId, targets, Date.now()));
  const [history, setHistory] = useState<HistoryStore>(initial.history);
  const [now, setNow] = useState(() => Date.now());
  const available = isTauri();
  const latestHistory = useRef(history);
  /** History changed since it was last written. */
  const unsaved = useRef(initial.fromLegacy);

  // Old single-host settings become a host list once, so the web UI shows them too.
  useEffect(() => {
    const legacy = legacyHost(stored);
    if (legacy) void widgetSettingsActions.update(instanceId, { hosts: [legacy], ip: undefined, intervalMinutes: undefined });
  }, [instanceId, stored]);

  useEffect(() => {
    if (latestHistory.current === history) return;
    latestHistory.current = history;
    unsaved.current = true;
  }, [history]);

  useEffect(() => {
    const save = () => {
      if (!unsaved.current) return;
      unsaved.current = false;
      // A removed widget's storage was just deleted (instanceStorage) – don't write it back.
      if (!useAppState.getState().state.layout.widgets.some((w) => w.instanceId === instanceId)) return;
      try {
        localStorage.setItem(historyKey(instanceId), JSON.stringify({ v: 1, hosts: latestHistory.current }));
        if (initial.fromLegacy) {
          localStorage.removeItem(LEGACY_HISTORY_KEY);
          localStorage.removeItem(LEGACY_LAST_KEY);
        }
      } catch (err) {
        console.warn('Host-Monitor-Verlauf konnte nicht gespeichert werden:', err);
      }
    };
    const saveWhenHidden = () => {
      if (document.visibilityState === 'hidden') save();
    };
    const timer = setInterval(save, PERSIST_EVERY_MS);
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', saveWhenHidden);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', saveWhenHidden);
      save();
    };
  }, [instanceId, initial.fromLegacy]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const checks = useMemo(() => uniqueChecks(targets), [targets]);
  const checksKey = checks.map((c) => c.key).join('\n');
  const targetKeys = useMemo(() => [...new Set(targets.map((t) => t.key))], [targets]);

  const polling = usePolling<LiveResults>(
    async (signal) => {
      const results = await netCheck(checks.map((c) => c.check));
      if (signal.aborted) return {};
      const at = Date.now();
      const live: LiveResults = {};
      results.forEach((result, i) => {
        const check = checks[i];
        if (check) live[check.key] = evaluate(result, check.host, answeredBefore(latestHistory.current[check.key]));
      });
      setHistory((prev) => recordSamples(prev, live, targetKeys, at));
      setNow(at);
      return live;
    },
    intervalSeconds * 1000,
    [checksKey],
    { enabled: available && checks.length > 0 },
  );

  const latestSample = useMemo(() => {
    let latest = 0;
    for (const samples of Object.values(history)) {
      const last = samples[samples.length - 1];
      if (last) latest = Math.max(latest, last[0] * 1000);
    }
    return latest;
  }, [history]);

  const windowTo = Math.max(now, latestSample);
  const windowFrom = windowTo - historyHours * 3_600_000;
  const live = polling.data;
  const statuses = useMemo(
    () => targets.map((target) => hostStatus(target, history[target.key] ?? [], live?.[target.key], threshold, windowFrom)),
    [targets, history, live, threshold, windowFrom],
  );

  // ── Outage notice and mails ──
  const kioskName = useAppState((s) => s.state.kiosk.name);
  /** A check of this run answered – before that, the statuses come from the stored history. */
  const checked = polling.lastUpdated !== null;
  const alertScreen = settings.alertScreen !== false;
  const alertMail = settings.alertMail !== false;
  const alertAfterMs =
    (ALERT_AFTER_OPTIONS.includes(settings.alertAfterMinutes)
      ? settings.alertAfterMinutes
      : HOST_MONITOR_DEFAULT_SETTINGS.alertAfterMinutes) * 60_000;
  /** Down long enough for the notice and the mail; `now` moves on every minute. */
  const alarming = (s: HostStatus) => s.state === 'down' && downLongEnough(s.since, now, alertAfterMs);
  // Keyed by content: the statuses are rebuilt every minute (time window).
  const outagesJson = JSON.stringify(
    statuses
      .filter(alarming)
      .map((s): HostOutage => ({
        key: s.target.key,
        name: s.target.name,
        address: s.target.address,
        message: s.message,
        since: s.since,
      })),
  );
  const hostStatesJson = JSON.stringify(
    statuses.map((s): MonitoredHostState => ({
      key: s.target.key,
      name: s.target.name,
      address: s.target.address,
      // Not down long enough yet: no mail – and if it answers again before, none at all.
      state: s.state === 'down' && !alarming(s) ? 'pending' : s.state,
      message: s.message,
      since: s.since,
    })),
  );

  useEffect(() => {
    const show = available && checked && alertScreen;
    reportHostOutages(instanceId, show ? (JSON.parse(outagesJson) as HostOutage[]) : []);
  }, [instanceId, available, checked, alertScreen, outagesJson]);

  useEffect(() => () => reportHostOutages(instanceId, []), [instanceId]);

  useEffect(() => {
    if (!available || !checked) return;
    if (!alertMail) {
      writeReported(instanceId, {});
      return;
    }
    const hosts = JSON.parse(hostStatesJson) as MonitoredHostState[];
    const { reported, mails } = outageMails(readReported(instanceId), hosts, Date.now(), kioskName);
    writeReported(instanceId, reported);
    for (const mail of mails) {
      mailAlert(mail.subject, mail.body).catch((err: unknown) => console.warn('Ausfall-Mail nicht übergeben:', err));
    }
  }, [instanceId, available, checked, alertMail, hostStatesJson, kioskName]);

  if (targets.length === 0) {
    return (
      <div className="hostmon">
        <div className="hostmon-empty">
          <ServerOff aria-hidden="true" />
          <strong>Keine Hosts eingerichtet</strong>
          <span>In den Einstellungen Hosts hinzufügen – z.B. NAS, Router oder Drucker.</span>
        </div>
      </div>
    );
  }

  const down = statuses.filter((s) => s.state === 'down');
  const firstDownSince = down.reduce<number | null>(
    (min, s) => (s.since !== null && (min === null || s.since < min) ? s.since : min),
    null,
  );
  const viewProps: ViewProps = {
    statuses,
    warn,
    crit,
    threshold,
    showSparkline: settings.showSparkline !== false,
    windowFrom,
    windowTo,
    // A missed check or two are no gap; longer pauses (app off) are.
    maxGapMs: intervalSeconds * 1000 * 3.5,
    historyHours,
    now,
  };

  let footer: string;
  if (!available) footer = KIOSK_ONLY_MESSAGE;
  else if (polling.error) footer = `Prüfung fehlgeschlagen: ${polling.error}`;
  else if (polling.lastUpdated !== null) footer = `Geprüft ${formatClock(polling.lastUpdated, now, true)}`;
  else if (checks.length === 0) footer = 'Keine gültige Adresse';
  else footer = 'Prüfe…';

  return (
    <div className={`hostmon${targets.length === 1 ? ' is-single' : ' is-list'}`}>
      {down.length > 0 && (
        <div className="hostmon-banner" role="alert">
          <AlertTriangle className="hostmon-banner-icon" aria-hidden="true" />
          <div className="hostmon-banner-text">
            <strong>
              {down.length === 1 ? `${down[0].target.name} nicht erreichbar` : `${down.length} Hosts nicht erreichbar`}
            </strong>
            <span>
              {down.length > 1 ? `${down.map((s) => s.target.name).join(', ')}` : ''}
              {down.length > 1 && firstDownSince !== null ? ' · ' : ''}
              {firstDownSince !== null ? `seit ${formatClock(firstDownSince, now)}` : ''}
            </span>
          </div>
        </div>
      )}

      {targets.length === 1 ? <SingleHostView {...viewProps} /> : <HostListView {...viewProps} />}

      <div className="hostmon-foot">
        <span className={`hostmon-foot-status${polling.error ? ' is-error' : ''}`}>
          {footer}
          {monitor.overflow ? ` · nur die ersten ${MAX_TARGETS} Hosts` : ''}
        </span>
        <button
          type="button"
          className="hostmon-button"
          onClick={polling.refresh}
          disabled={!available || checks.length === 0 || polling.loading}
          aria-label="Jetzt prüfen"
        >
          <RefreshCw size="1.1em" className={polling.loading ? 'hostmon-spin' : undefined} aria-hidden="true" />
          <span className="hostmon-button-label">Jetzt prüfen</span>
        </button>
      </div>
    </div>
  );
}

// ── Settings extra (kiosk dialog) ────────────────────────────────────────────

interface TestRow {
  name: string;
  address: string;
  ok: boolean;
  text: string;
}

/** Checks the configured hosts once, right from the settings dialog. */
export function NasSettingsExtra({ instanceId }: { instanceId: string }) {
  const { targets } = useHostMonitor(instanceId);
  const [rows, setRows] = useState<TestRow[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const test = async () => {
    setTesting(true);
    setError(null);
    try {
      const checks = uniqueChecks(targets);
      const results = checks.length > 0 ? await netCheck(checks.map((c) => c.check)) : [];
      const live: LiveResults = {};
      results.forEach((result, i) => {
        if (checks[i]) live[checks[i].key] = evaluate(result, checks[i].host);
      });
      setRows(
        targets.map((target) => {
          const result = live[target.key];
          const configError = target.configError ?? result?.configError ?? null;
          if (configError) return { name: target.name, address: target.address, ok: false, text: configError };
          if (!result) return { name: target.name, address: target.address, ok: false, text: 'Nicht geprüft' };
          if (!result.ok) return { name: target.name, address: target.address, ok: false, text: result.error ?? 'Keine Antwort' };
          const latency = result.latencyMs !== null ? ` · ${formatMs(result.latencyMs)} ms` : '';
          const http = result.httpStatus !== null ? ` · HTTP ${result.httpStatus}` : '';
          return { name: target.name, address: target.address, ok: true, text: `Erreichbar${latency}${http}` };
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="hostmon-test">
      <button type="button" className="settings-btn" onClick={() => void test()} disabled={testing || targets.length === 0}>
        <RefreshCw size={16} className={testing ? 'hostmon-spin' : undefined} aria-hidden="true" />
        {testing ? 'Prüfe…' : 'Alle Hosts jetzt prüfen'}
      </button>
      {targets.length === 0 && <div className="settings-description">Zuerst oben einen Host hinzufügen.</div>}
      {error && <div className="settings-info-box error">{error}</div>}
      {rows && (
        <ul className="hostmon-test-list">
          {rows.map((row, index) => (
            <li key={index} className="settings-status">
              <span className={`settings-status-dot hostmon-test-dot${row.ok ? ' is-ok' : ''}`} />
              <span className="hostmon-test-name">{row.name}</span>
              <span className="hostmon-test-text">
                {row.text}
                <small>{row.address}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
