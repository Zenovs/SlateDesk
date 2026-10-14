/**
 * Speedtest widget – download, upload, ping and jitter of the internet line.
 *
 * The measurement runs in the backend (`run_speed_test`). The schedule counts
 * from the last measurement, which is stored per instance, so an app restart
 * neither skips nor repeats a run. Failed runs are shown as errors and kept as
 * gaps in the history – never as 0 Mbit/s.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Network, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import type { WidgetProps } from '../types/widget';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { isTauri, KIOSK_ONLY_MESSAGE, runSpeedTest, type SpeedTestResult } from '../utils/backend';
import {
  SPEEDTEST_DEFAULT_SETTINGS,
  SPEEDTEST_INTERVAL_OPTIONS,
  type SpeedtestSettings,
} from './manifests/speedtest';
import { ArcGauge, TimeSparkline, type ChartTone, type SparkPoint } from './shared/charts';
import './styles/speedtest.css';

// ── Storage ──────────────────────────────────────────────────────────────────

/** One run: a measurement or the reason it failed. `t` is epoch ms. */
type Sample = { t: number; down: number; up: number; ping: number | null } | { t: number; error: string };

interface SpeedStore {
  /** Last successful measurement – kept beyond the history window for the gauges. */
  last: SpeedTestResult | null;
  /** Oldest first. */
  history: Sample[];
}

const LEGACY_LAST_KEY = 'slatedesk:speedtest:last';
const LEGACY_HISTORY_KEY = 'slatedesk:speedtest:history';
const lastKey = (instanceId: string): string => `slatedesk:speedtest:${instanceId}:last`;
const historyKey = (instanceId: string): string => `slatedesk:speedtest:${instanceId}:history`;

/** Largest `historyHours` option – switching the window must not lose data. */
const HISTORY_KEEP_MS = 48 * 3_600_000;
const MAX_SAMPLES = 600;
/** Overdue runs after a (re)start wait a moment: the UI and the network come up first. */
const STARTUP_DELAY_MS = 15_000;
/** After a failure the next attempt comes sooner than the regular interval. */
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
/** Another instance is measuring – the backend allows one run at a time. */
const BUSY_MESSAGE = 'Es läuft bereits ein Speedtest';
const BUSY_RETRY_MS = 60_000;
const HISTORY_OPTIONS = [6, 12, 24, 48];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isFailure = (sample: Sample): sample is { t: number; error: string } => 'error' in sample;

/** Old builds stored failed runs as 0 Mbit/s – those are no measurements. */
function parseResult(raw: unknown): SpeedTestResult | null {
  if (!isRecord(raw)) return null;
  const { download_mbps, upload_mbps, timestamp } = raw;
  if (!isFiniteNumber(download_mbps) || !isFiniteNumber(upload_mbps) || !isFiniteNumber(timestamp)) return null;
  if (download_mbps <= 0 || upload_mbps <= 0) return null;
  return {
    download_mbps,
    upload_mbps,
    ping_ms: isFiniteNumber(raw.ping_ms) ? raw.ping_ms : null,
    jitter_ms: isFiniteNumber(raw.jitter_ms) ? raw.jitter_ms : null,
    interface: typeof raw.interface === 'string' ? raw.interface : '',
    interface_type: typeof raw.interface_type === 'string' ? raw.interface_type : '',
    timestamp,
  };
}

const toSample = (result: SpeedTestResult): Sample => ({
  t: result.timestamp * 1000,
  down: result.download_mbps,
  up: result.upload_mbps,
  ping: result.ping_ms,
});

function parseSample(raw: unknown): Sample | null {
  if (!isRecord(raw) || !isFiniteNumber(raw.t)) return null;
  if (typeof raw.error === 'string') return { t: raw.t, error: raw.error };
  if (isFiniteNumber(raw.down) && isFiniteNumber(raw.up) && raw.down > 0 && raw.up > 0) {
    return { t: raw.t, down: raw.down, up: raw.up, ping: isFiniteNumber(raw.ping) ? raw.ping : null };
  }
  return null;
}

/** Entries of the old global history had the backend result shape. */
function parseLegacySample(raw: unknown): Sample | null {
  const result = parseResult(raw);
  return result ? toSample(result) : null;
}

function prune(history: Sample[], now: number): Sample[] {
  const cutoff = now - HISTORY_KEEP_MS;
  const kept = history.filter((sample) => sample.t >= cutoff).sort((a, b) => a.t - b.t);
  return kept.length > MAX_SAMPLES ? kept.slice(-MAX_SAMPLES) : kept;
}

/** undefined = missing or unreadable. */
function readJson(key: string): unknown {
  try {
    const text = localStorage.getItem(key);
    return text === null ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('Speedtest-Verlauf konnte nicht gespeichert werden:', err);
  }
}

/** The old global keys go to the first instance without own data (only one may take them). */
let legacyClaimedBy: string | null = null;

function loadStore(instanceId: string, now: number): { store: SpeedStore; fromLegacy: boolean } {
  let rawLast = readJson(lastKey(instanceId));
  let rawHistory = readJson(historyKey(instanceId));
  let fromLegacy = false;
  if (rawLast === undefined && rawHistory === undefined && (legacyClaimedBy === null || legacyClaimedBy === instanceId)) {
    const legacyLast = readJson(LEGACY_LAST_KEY);
    const legacyHistory = readJson(LEGACY_HISTORY_KEY);
    if (legacyLast !== undefined || legacyHistory !== undefined) {
      legacyClaimedBy = instanceId;
      fromLegacy = true;
      rawLast = legacyLast;
      rawHistory = legacyHistory;
    }
  }
  const parse = fromLegacy ? parseLegacySample : parseSample;
  const history = Array.isArray(rawHistory)
    ? rawHistory.map(parse).filter((sample): sample is Sample => sample !== null)
    : [];
  return { store: { last: parseResult(rawLast), history: prune(history, now) }, fromLegacy };
}

const withResult = (store: SpeedStore, result: SpeedTestResult): SpeedStore => ({
  last: result,
  history: prune([...store.history, toSample(result)], result.timestamp * 1000),
});

const withFailure = (store: SpeedStore, at: number, error: string): SpeedStore => ({
  last: store.last,
  history: prune([...store.history, { t: at, error }], at),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const errorText = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : typeof err === 'string' && err ? err : 'Unbekannter Fehler';

/** Old settings allowed 1–10 minutes; the next allowed step keeps the intent. */
function normalizeInterval(minutes: unknown): number {
  if (!isFiniteNumber(minutes) || minutes < 0) return SPEEDTEST_DEFAULT_SETTINGS.intervalMinutes;
  if (SPEEDTEST_INTERVAL_OPTIONS.includes(minutes)) return minutes;
  if (minutes === 0) return 0;
  return SPEEDTEST_INTERVAL_OPTIONS.find((option) => option >= minutes) ?? Math.max(...SPEEDTEST_INTERVAL_OPTIONS);
}

const positive = (value: unknown, fallback: number): number => (isFiniteNumber(value) && value > 0 ? value : fallback);
const nonNegative = (value: unknown, fallback: number): number => (isFiniteNumber(value) && value >= 0 ? value : fallback);

const formatMbps = (mbps: number): string => (mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1));

/** Configured values: no trailing ".0". */
const formatLimit = (mbps: number): string => (Number.isInteger(mbps) ? String(mbps) : mbps.toFixed(1));

const formatMs = (ms: number): string => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));

function formatClock(ms: number, now: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  if (new Date(now).toDateString() === date.toDateString()) return time;
  return `${date.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })} ${time}`;
}

/** Absolute colours: red below the «langsam» limit, yellow below half the subscribed speed. */
function speedTone(mbps: number, slow: number, expected: number): ChartTone {
  if (mbps < slow) return 'crit';
  if (mbps < expected * 0.5) return 'warn';
  return 'ok';
}

const isOfflineError = (message: string): boolean => /keine internetverbindung|keine verbindung|netzwerkroute/i.test(message);

// ── Gauge ────────────────────────────────────────────────────────────────────

interface SpeedGaugeProps {
  direction: 'down' | 'up';
  mbps: number;
  expected: number;
  slow: number;
}

function SpeedGauge({ direction, mbps, expected, slow }: SpeedGaugeProps) {
  const label = direction === 'down' ? 'Download' : 'Upload';
  const Icon = direction === 'down' ? ArrowDown : ArrowUp;
  const percent = Math.round((mbps / expected) * 100);
  return (
    <div className="speedtest-gauge">
      <div className="speedtest-gauge-svg">
        <ArcGauge
          fraction={mbps / expected}
          tone={speedTone(mbps, slow, expected)}
          value={formatMbps(mbps)}
          unit="Mbit/s"
          label={`${label}: ${formatMbps(mbps)} Mbit/s`}
        />
      </div>
      <div className="speedtest-gauge-caption">
        <Icon size="1em" aria-hidden="true" />
        {label}
      </div>
      <div className="speedtest-gauge-scale">
        {percent} % von {formatLimit(expected)}
      </div>
    </div>
  );
}

// ── Widget ───────────────────────────────────────────────────────────────────

export function SpeedtestWidget({ instanceId }: WidgetProps) {
  const [settings, updateSettings] = useWidgetSettings<SpeedtestSettings>(instanceId, SPEEDTEST_DEFAULT_SETTINGS);
  const [initial] = useState(() => loadStore(instanceId, Date.now()));
  const [store, setStore] = useState<SpeedStore>(initial.store);
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [runningSince, setRunningSince] = useState<number | null>(null);
  const [startupPending, setStartupPending] = useState(settings.runOnStartup === true);
  const [busyUntil, setBusyUntil] = useState<number | null>(null);
  const runningRef = useRef(false);
  const aliveRef = useRef(true);
  const available = isTauri();

  const intervalMinutes = normalizeInterval(settings.intervalMinutes);
  const intervalMs = intervalMinutes * 60_000;
  const expectedDown = positive(settings.expectedDownloadMbps, SPEEDTEST_DEFAULT_SETTINGS.expectedDownloadMbps);
  const expectedUp = positive(settings.expectedUploadMbps, SPEEDTEST_DEFAULT_SETTINGS.expectedUploadMbps);
  const slowDown = nonNegative(settings.slowDownloadMbps, SPEEDTEST_DEFAULT_SETTINGS.slowDownloadMbps);
  const slowUp = nonNegative(settings.slowUploadMbps, SPEEDTEST_DEFAULT_SETTINGS.slowUploadMbps);
  const historyHours = HISTORY_OPTIONS.includes(settings.historyHours)
    ? settings.historyHours
    : SPEEDTEST_DEFAULT_SETTINGS.historyHours;

  // Old settings (1/5/10 min) are not offered anymore: store the replacement once.
  useEffect(() => {
    if (settings.intervalMinutes !== intervalMinutes) updateSettings({ intervalMinutes });
  }, [settings.intervalMinutes, intervalMinutes, updateSettings]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    writeJson(lastKey(instanceId), store.last);
    writeJson(historyKey(instanceId), store.history);
    if (initial.fromLegacy) {
      try {
        localStorage.removeItem(LEGACY_LAST_KEY);
        localStorage.removeItem(LEGACY_HISTORY_KEY);
      } catch {
        // Storage unavailable – the keys stay, but only this instance claims them.
      }
    }
  }, [instanceId, store, initial.fromLegacy]);

  // Seconds while measuring, otherwise just enough for the time axis.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), runningSince !== null ? 1000 : 60_000);
    return () => clearInterval(timer);
  }, [runningSince]);

  const measure = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const startedAt = Date.now();
    setRunningSince(startedAt);
    setNow(startedAt);
    setStartupPending(false);
    setBusyUntil(null);
    try {
      const result = await runSpeedTest();
      if (aliveRef.current) setStore((prev) => withResult(prev, result));
    } catch (err) {
      if (aliveRef.current) {
        const message = errorText(err);
        const at = Date.now();
        if (message.startsWith(BUSY_MESSAGE)) setBusyUntil(at + BUSY_RETRY_MS);
        else setStore((prev) => withFailure(prev, at, message));
      }
    } finally {
      runningRef.current = false;
      if (aliveRef.current) {
        setRunningSince(null);
        setNow(Date.now());
      }
    }
  }, []);

  const history = store.history;
  const lastSample = history.length > 0 ? history[history.length - 1] : null;
  const lastAttempt = lastSample
    ? { t: lastSample.t, ok: !isFailure(lastSample) }
    : store.last
      ? { t: store.last.timestamp * 1000, ok: true }
      : null;

  let dueAt: number | null = null;
  if (available) {
    if (startupPending) {
      dueAt = mountedAt + STARTUP_DELAY_MS;
    } else if (intervalMs > 0) {
      const regular = lastAttempt
        ? lastAttempt.t + (lastAttempt.ok ? intervalMs : Math.min(intervalMs, RETRY_AFTER_FAILURE_MS))
        : mountedAt;
      dueAt = Math.max(regular, mountedAt + STARTUP_DELAY_MS);
    }
    if (dueAt !== null && busyUntil !== null) dueAt = Math.max(dueAt, busyUntil);
  }

  useEffect(() => {
    if (runningSince !== null || dueAt === null) return;
    const timer = setTimeout(() => void measure(), Math.max(0, dueAt - Date.now()));
    return () => clearTimeout(timer);
  }, [dueAt, runningSince, measure]);

  const last = store.last;
  const failure = lastSample && isFailure(lastSample) && (!last || lastSample.t > last.timestamp * 1000) ? lastSample : null;
  const failingSince = useMemo(() => {
    let since: number | null = null;
    for (let i = history.length - 1; i >= 0 && isFailure(history[i]); i--) since = history[i].t;
    return since;
  }, [history]);

  const windowTo = Math.max(now, lastSample?.t ?? 0);
  const windowFrom = windowTo - historyHours * 3_600_000;
  const chart = useMemo(() => {
    const samples = history.filter((s) => s.t >= windowFrom && s.t <= windowTo);
    const down: SparkPoint[] = samples.map((s) => ({ t: s.t, v: isFailure(s) ? null : s.down }));
    const up: SparkPoint[] = samples.map((s) => ({ t: s.t, v: isFailure(s) ? null : s.up }));
    const successes = samples.filter((s): s is Exclude<Sample, { error: string }> => !isFailure(s));
    return {
      count: samples.length,
      down,
      up,
      // Each line on its own scale (the subscribed speed), so an asymmetric line keeps both readable.
      maxDown: Math.max(expectedDown, ...successes.map((s) => s.down)),
      maxUp: Math.max(expectedUp, ...successes.map((s) => s.up)),
      marks: samples.filter(isFailure).map((s) => s.t),
    };
  }, [history, windowFrom, windowTo, expectedDown, expectedUp]);

  const running = runningSince !== null;
  const elapsed = running ? Math.max(0, Math.round((now - runningSince) / 1000)) : 0;
  const slowDownNow = last !== null && last.download_mbps < slowDown;
  const slowUpNow = last !== null && last.upload_mbps < slowUp;
  const offline = failure !== null && isOfflineError(failure.error);

  let banner = null;
  if (failure) {
    banner = (
      <div className="speedtest-banner is-error" role="alert">
        <WifiOff className="speedtest-banner-icon" aria-hidden="true" />
        <div className="speedtest-banner-text">
          <strong>{offline ? 'Keine Internetverbindung' : 'Speedtest fehlgeschlagen'}</strong>
          <span>
            {offline ? '' : `${failure.error} · `}seit {formatClock(failingSince ?? failure.t, now)}
          </span>
        </div>
      </div>
    );
  } else if (last && (slowDownNow || slowUpNow)) {
    banner = (
      <div className="speedtest-banner is-warning" role="status">
        <AlertTriangle className="speedtest-banner-icon" aria-hidden="true" />
        <div className="speedtest-banner-text">
          <strong>Internet langsam</strong>
          <span>
            {[
              slowDownNow ? `↓ ${formatMbps(last.download_mbps)} Mbit/s` : null,
              slowUpNow ? `↑ ${formatMbps(last.upload_mbps)} Mbit/s` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      </div>
    );
  }

  const wlan = last?.interface_type === 'WLAN';
  const InterfaceIcon = wlan ? Wifi : Network;

  let status: string;
  if (!available) status = KIOSK_ONLY_MESSAGE;
  else if (running) status = `Messung läuft… ${elapsed} s`;
  else if (dueAt !== null) status = `Nächste Messung ${formatClock(dueAt, now)}`;
  else status = 'Nur manuelle Messung';

  return (
    <div className="speedtest">
      {banner}

      {last && (
        <div className="speedtest-head">
          <span className={`speedtest-interface${wlan ? ' is-wlan' : ''}`}>
            <InterfaceIcon size="1em" aria-hidden="true" />
            {[last.interface_type, last.interface].filter(Boolean).join(' · ')}
          </span>
          {settings.showPing && last.ping_ms !== null && (
            <span className="speedtest-ping">
              Ping {formatMs(last.ping_ms)} ms
              {last.jitter_ms !== null && <> · Jitter {formatMs(last.jitter_ms)} ms</>}
            </span>
          )}
          <span className="speedtest-time">{formatClock(last.timestamp * 1000, now)}</span>
        </div>
      )}

      <div className={`speedtest-gauges${running ? ' is-running' : ''}`}>
        {last ? (
          <>
            <SpeedGauge direction="down" mbps={last.download_mbps} expected={expectedDown} slow={slowDown} />
            <SpeedGauge direction="up" mbps={last.upload_mbps} expected={expectedUp} slow={slowUp} />
          </>
        ) : !running ? (
          <div className="speedtest-empty">
            {failure ? (
              <>
                <WifiOff aria-hidden="true" />
                <span>Noch keine erfolgreiche Messung</span>
              </>
            ) : (
              <>
                <RefreshCw aria-hidden="true" />
                <span>{available ? 'Noch keine Messung' : KIOSK_ONLY_MESSAGE}</span>
              </>
            )}
          </div>
        ) : null}
        {running && (
          <div className="speedtest-running" role="status">
            <RefreshCw className="speedtest-spin" aria-hidden="true" />
            <span>Messe… {elapsed} s</span>
          </div>
        )}
      </div>

      {chart.count >= 2 && (
        <div className="speedtest-history">
          <div className="speedtest-history-legend">
            <span className="speedtest-legend-down">↓ Download</span>
            <span className="speedtest-legend-up">↑ Upload</span>
            <span className="speedtest-legend-window">{historyHours} h</span>
          </div>
          <div className="speedtest-history-chart">
            <TimeSparkline
              from={windowFrom}
              to={windowTo}
              maxGapMs={intervalMs > 0 ? intervalMs * 2.5 : Infinity}
              marks={chart.marks}
              series={[
                { id: 'down', points: chart.down, max: chart.maxDown, tone: 'accent', fill: true },
                { id: 'up', points: chart.up, max: chart.maxUp, tone: 'info' },
              ]}
              label={`Verlauf der letzten ${historyHours} Stunden`}
            />
          </div>
        </div>
      )}

      <div className="speedtest-foot">
        <span className="speedtest-status">{status}</span>
        <button
          type="button"
          className="speedtest-button"
          onClick={() => void measure()}
          disabled={running || !available}
        >
          <RefreshCw size="1.1em" className={running ? 'speedtest-spin' : undefined} aria-hidden="true" />
          {running ? `${elapsed} s` : 'Jetzt messen'}
        </button>
      </div>
    </div>
  );
}
