/**
 * Volumio widget – the track playing on a Volumio player, with optional
 * transport and volume buttons.
 *
 * Every request goes through the backend (`http_fetch`), so neither CORS nor
 * the webview CSP get in the way. The player view is keyed by the address: a
 * new host starts with fresh state, and polls of the old one are dropped.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Minus,
  Music,
  Pause,
  Play,
  Plus,
  Settings2,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import type { WidgetProps } from '../types/widget';
import { useAppState } from '../state/appState';
import { widgetSettingsActions } from '../state/dataActions';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { usePolling } from '../hooks/usePolling';
import { httpFetch } from '../utils/backend';
import { VOLUMIO_DEFAULT_SETTINGS, type VolumioIdleView, type VolumioSettings } from './manifests/volumio';
import './styles/volumio.css';

const REQUEST_TIMEOUT_MS = 4000;
/** One lost poll is no outage – the error view only follows a second failure in a row. */
const FAILURES_BEFORE_OFFLINE = 2;
const COMMAND_ERROR_MS = 5000;
const MAX_FAILED_COVERS = 50;
const POLL_OPTIONS = [2, 3, 5, 10, 30];
const IDLE_VIEWS: readonly VolumioIdleView[] = ['logo', 'letzterTitel', 'nichts'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const errorText = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : typeof err === 'string' && err ? err : 'Unbekannter Fehler';

// ── Address ──────────────────────────────────────────────────────────────────

type Address = { base: string } | { error: string };

/** "192.168.1.20", "volumio.local", "http://host:3000/" → origin; null when empty. */
function volumioAddress(raw: unknown): Address | null {
  const input = text(raw);
  if (!input) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  try {
    const url = new URL(withScheme);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return { error: 'Ungültige Adresse' };
    return { base: url.origin };
  } catch {
    return { error: 'Ungültige Adresse' };
  }
}

// ── Player state ─────────────────────────────────────────────────────────────

type PlaybackStatus = 'play' | 'pause' | 'stop';

interface PlayerState {
  status: PlaybackStatus;
  title: string;
  artist: string;
  album: string;
  coverUrl: string | null;
  /** Position at `receivedAt`. */
  seekMs: number | null;
  durationMs: number | null;
  /** Web radio and other streams have no length. */
  isStream: boolean;
  volume: number | null;
  mute: boolean;
  volumeLocked: boolean;
  quality: string;
  /** epoch ms */
  receivedAt: number;
}

const SERVICE_LABELS: Record<string, string> = {
  webradio: 'Webradio',
  spop: 'Spotify',
  spotify: 'Spotify',
  tidal: 'Tidal',
  qobuz: 'Qobuz',
  airplay_emulation: 'AirPlay',
  shairport: 'AirPlay',
  bluetooth: 'Bluetooth',
  upnp: 'UPnP',
  youtube: 'YouTube',
  youtube2: 'YouTube',
  // Local library – nothing worth showing.
  mpd: '',
};

function coverUrl(albumart: string, base: string): string | null {
  if (!albumart) return null;
  if (/^https?:\/\//i.test(albumart) || albumart.startsWith('data:image/')) return albumart;
  // Volumio answers with paths like "/albumart?cacheid=…" relative to the player.
  return `${base}${albumart.startsWith('/') ? '' : '/'}${albumart}`;
}

function qualityText(raw: Record<string, unknown>): string {
  const service = text(raw.service).toLowerCase();
  const serviceLabel = service in SERVICE_LABELS ? SERVICE_LABELS[service] : text(raw.service);
  const trackType = text(raw.trackType);
  const format = trackType && trackType.toLowerCase() !== service ? trackType.toUpperCase() : '';
  const parts = [format, text(raw.samplerate), text(raw.bitdepth), text(raw.bitrate), serviceLabel];
  return [...new Set(parts.filter(Boolean))].join(' · ');
}

function parseState(raw: unknown, base: string, receivedAt: number): PlayerState {
  if (!isRecord(raw)) throw new Error('Unerwartete Antwort – ist das ein Volumio-Gerät?');
  const status: PlaybackStatus = raw.status === 'play' || raw.status === 'pause' ? raw.status : 'stop';
  const durationS = isFiniteNumber(raw.duration) && raw.duration > 0 ? raw.duration : null;
  const stream = raw.stream === true || (typeof raw.stream === 'string' && raw.stream !== '') || raw.service === 'webradio';
  return {
    status,
    title: text(raw.title),
    artist: text(raw.artist),
    album: text(raw.album),
    coverUrl: coverUrl(text(raw.albumart), base),
    seekMs: isFiniteNumber(raw.seek) && raw.seek >= 0 ? raw.seek : null,
    durationMs: durationS !== null ? durationS * 1000 : null,
    isStream: stream || durationS === null,
    volume: isFiniteNumber(raw.volume) ? Math.min(100, Math.max(0, Math.round(raw.volume))) : null,
    mute: raw.mute === true,
    volumeLocked: raw.disableVolumeControl === true,
    quality: qualityText(raw),
    receivedAt,
  };
}

async function volumioRequest(base: string, path: string): Promise<string> {
  const response = await httpFetch({ url: `${base}${path}`, timeoutMs: REQUEST_TIMEOUT_MS });
  if (response.status >= 400) throw new Error(`Volumio antwortet mit HTTP ${response.status}`);
  return response.body;
}

async function fetchPlayerState(base: string): Promise<PlayerState> {
  const body = await volumioRequest(base, '/api/v1/getState');
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error('Keine gültige Antwort – ist das ein Volumio-Gerät?');
  }
  return parseState(raw, base, Date.now());
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

// ── Settings ─────────────────────────────────────────────────────────────────

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number =>
  isFiniteNumber(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** Before 2.0 the widget stored `ip` and `updateInterval`. */
function legacyPatch(stored: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!stored) return null;
  const patch: Record<string, unknown> = {};
  if (stored.ip !== undefined) {
    if (stored.host === undefined && typeof stored.ip === 'string') patch.host = stored.ip.trim();
    patch.ip = undefined;
  }
  if (stored.updateInterval !== undefined) {
    if (stored.pollSeconds === undefined && POLL_OPTIONS.includes(stored.updateInterval as number)) {
      patch.pollSeconds = stored.updateInterval;
    }
    patch.updateInterval = undefined;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function effectiveSettings(settings: VolumioSettings, stored: Record<string, unknown> | undefined): VolumioSettings {
  const d = VOLUMIO_DEFAULT_SETTINGS;
  // Until the migration is stored, the old keys still apply.
  const host = stored?.host === undefined && typeof stored?.ip === 'string' ? stored.ip : settings.host;
  const poll = stored?.pollSeconds === undefined && stored?.updateInterval !== undefined ? stored.updateInterval : settings.pollSeconds;
  return {
    host: typeof host === 'string' ? host : '',
    pollSeconds: POLL_OPTIONS.includes(poll as number) ? (poll as number) : d.pollSeconds,
    showControls: settings.showControls !== false,
    showVolume: settings.showVolume !== false,
    volumeStep: Math.round(clampNumber(settings.volumeStep, 1, 25, d.volumeStep)),
    maxVolume: Math.round(clampNumber(settings.maxVolume, 1, 100, d.maxVolume)),
    showProgress: settings.showProgress !== false,
    showQuality: settings.showQuality === true,
    idleView: IDLE_VIEWS.includes(settings.idleView) ? settings.idleView : d.idleView,
    idleMinutes: clampNumber(settings.idleMinutes, 0, 24 * 60, d.idleMinutes),
  };
}

function useVolumioSettings(instanceId: string): VolumioSettings {
  const [settings] = useWidgetSettings<VolumioSettings>(instanceId, VOLUMIO_DEFAULT_SETTINGS);
  const stored = useAppState((s) => s.state.widgetSettings[instanceId]);

  useEffect(() => {
    const patch = legacyPatch(stored);
    if (patch) void widgetSettingsActions.update(instanceId, patch);
  }, [instanceId, stored]);

  return effectiveSettings(settings, stored);
}

// ── Views ────────────────────────────────────────────────────────────────────

function Message({ icon, title, detail, tone }: { icon: ReactNode; title: string; detail?: string; tone?: 'error' }) {
  return (
    <div className={`volumio-message${tone ? ` is-${tone}` : ''}`}>
      {icon}
      <strong>{title}</strong>
      {detail && <span>{detail}</span>}
    </div>
  );
}

interface ProgressProps {
  state: PlayerState;
  now: number;
}

function Progress({ state, now }: ProgressProps) {
  if (state.isStream || state.durationMs === null) {
    return (
      <div className="volumio-progress is-live">
        <span className="volumio-live-dot" />
        Live
      </div>
    );
  }
  const elapsed = state.status === 'play' ? Math.max(0, now - state.receivedAt) : 0;
  const position = Math.min(state.durationMs, (state.seekMs ?? 0) + elapsed);
  const percent = (position / state.durationMs) * 100;
  return (
    <div className="volumio-progress">
      <div
        className="volumio-progress-bar"
        role="progressbar"
        aria-label="Position im Titel"
        aria-valuemin={0}
        aria-valuemax={Math.round(state.durationMs / 1000)}
        aria-valuenow={Math.round(position / 1000)}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="volumio-progress-times">
        <span>{formatDuration(position)}</span>
        <span>{formatDuration(state.durationMs)}</span>
      </div>
    </div>
  );
}

interface PlayerProps {
  base: string;
  settings: VolumioSettings;
}

/** Where the local progress interpolation starts. */
interface SeekAnchor {
  /** Track and status – a new track, pause or resume starts a new anchor. */
  key: string;
  /** Seek as Volumio reported it. */
  serverSeek: number;
  /** epoch ms when that value was first seen. */
  at: number;
}

/**
 * Volumio may repeat a cached seek between its own updates. Counting from the
 * time a value was first seen keeps the bar from jumping back on each poll;
 * a changed value (Volumio did update) re-anchors.
 */
function anchored(state: PlayerState, anchor: SeekAnchor | null): { state: PlayerState; anchor: SeekAnchor | null } {
  if (state.seekMs === null) return { state, anchor: null };
  const key = [state.status, state.title, state.artist, state.album, state.durationMs].join('|');
  if (state.status === 'play' && anchor && anchor.key === key && anchor.serverSeek === state.seekMs) {
    return { state: { ...state, receivedAt: anchor.at }, anchor };
  }
  return { state, anchor: { key, serverSeek: state.seekMs, at: state.receivedAt } };
}

function VolumioPlayer({ base, settings }: PlayerProps) {
  const [failures, setFailures] = useState(0);
  const [stoppedSince, setStoppedSince] = useState<number | null>(null);
  const [failedCovers, setFailedCovers] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seekAnchor = useRef<SeekAnchor | null>(null);

  const polling = usePolling<PlayerState>(
    async (signal) => {
      try {
        const fetched = await fetchPlayerState(base);
        if (signal.aborted) return fetched;
        const { state, anchor } = anchored(fetched, seekAnchor.current);
        seekAnchor.current = anchor;
        setFailures(0);
        setStoppedSince((prev) => (state.status === 'stop' ? (prev ?? state.receivedAt) : null));
        return state;
      } catch (err) {
        if (!signal.aborted) setFailures((n) => n + 1);
        throw err;
      }
    },
    settings.pollSeconds * 1000,
    [base],
  );
  const state = polling.data;

  // The progress bar moves every second; otherwise only the idle switch needs a clock.
  const ticking = state?.status === 'play' && settings.showProgress && !state.isStream;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ticking ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [ticking]);

  useEffect(() => {
    if (!commandError) return;
    const timer = setTimeout(() => setCommandError(null), COMMAND_ERROR_MS);
    return () => clearTimeout(timer);
  }, [commandError]);

  const send = async (id: string, query: string) => {
    if (pending) return;
    setPending(id);
    setCommandError(null);
    try {
      await volumioRequest(base, `/api/v1/commands/?${query}`);
      polling.refresh();
    } catch (err) {
      setCommandError(`Befehl fehlgeschlagen: ${errorText(err)}`);
    } finally {
      setPending(null);
    }
  };

  const offline = failures >= FAILURES_BEFORE_OFFLINE;
  const hostLabel = base.replace(/^https?:\/\//, '');

  if (!state) {
    if (offline) {
      return (
        <Message
          tone="error"
          icon={<WifiOff aria-hidden="true" />}
          title="Volumio nicht erreichbar"
          detail={`${hostLabel}${polling.error ? ` · ${polling.error}` : ''}`}
        />
      );
    }
    return <Message icon={<Music aria-hidden="true" />} title="Verbinde mit Volumio…" detail={hostLabel} />;
  }

  const clock = Math.max(now, polling.lastUpdated ?? 0);
  const idle =
    !offline &&
    state.status === 'stop' &&
    stoppedSince !== null &&
    clock - stoppedSince >= settings.idleMinutes * 60_000 &&
    settings.idleView !== 'letzterTitel';
  const hasTrack = state.title !== '' || state.artist !== '';

  if (idle && settings.idleView === 'nichts') {
    return <div className="volumio-blank" aria-label="Volumio: Wiedergabe gestoppt" />;
  }

  // Nothing loaded at all, or stopped long enough: logo instead of a stale track.
  if (idle || (!hasTrack && state.status === 'stop')) {
    return (
      <div className="volumio-logo">
        <span className="volumio-logo-mark">
          <Music aria-hidden="true" />
        </span>
        <span className="volumio-logo-name">Volumio</span>
        <span className="volumio-logo-sub">{hasTrack ? 'Wiedergabe gestoppt' : 'Keine Wiedergabe'}</span>
        {settings.showControls && hasTrack && (
          <button
            type="button"
            className="volumio-btn is-main"
            onClick={() => void send('play', 'cmd=play')}
            disabled={pending !== null}
            aria-label="Wiedergabe starten"
            title="Wiedergabe starten"
          >
            <Play aria-hidden="true" />
          </button>
        )}
        {commandError && (
          <div className="volumio-toast" role="alert">
            {commandError}
          </div>
        )}
      </div>
    );
  }

  const cover = state.coverUrl && !failedCovers.has(state.coverUrl) ? state.coverUrl : null;
  const markCoverFailed = (url: string) =>
    setFailedCovers((prev) => {
      const next = new Set(prev.size >= MAX_FAILED_COVERS ? [] : prev);
      next.add(url);
      return next;
    });

  const volume = state.volume;
  const showVolume = settings.showVolume && volume !== null && !state.volumeLocked;
  const disabled = offline || pending !== null;
  const playing = state.status === 'play';

  return (
    <div className={`volumio is-${state.status}${offline ? ' is-offline' : ''}`}>
      <div className="volumio-cover-cell">
        <div className="volumio-cover">
          <Music className="volumio-cover-fallback" aria-hidden="true" />
          {cover && (
            <img
              key={cover}
              src={cover}
              alt=""
              draggable={false}
              decoding="async"
              onError={() => markCoverFailed(cover)}
            />
          )}
          {state.status !== 'play' && (
            <span className="volumio-badge">{state.status === 'pause' ? 'Pausiert' : 'Gestoppt'}</span>
          )}
        </div>
      </div>

      <div className="volumio-info">
        <div className="volumio-text">
          <div className="volumio-title">{state.title || state.artist || 'Unbekannter Titel'}</div>
          {state.title && state.artist && <div className="volumio-artist">{state.artist}</div>}
          {state.album && <div className="volumio-album">{state.album}</div>}
          {settings.showQuality && state.quality && <div className="volumio-quality">{state.quality}</div>}
        </div>

        {settings.showProgress && <Progress state={state} now={clock} />}

        {(settings.showControls || showVolume) && (
          <div className="volumio-controls">
            {settings.showControls && (
              <div className="volumio-transport">
                <button
                  type="button"
                  className="volumio-btn"
                  onClick={() => void send('prev', 'cmd=prev')}
                  disabled={disabled}
                  aria-label="Vorheriger Titel"
                  title="Vorheriger Titel"
                >
                  <SkipBack aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="volumio-btn is-main"
                  onClick={() => void send('toggle', 'cmd=toggle')}
                  disabled={disabled}
                  aria-label={playing ? 'Pause' : 'Wiedergabe'}
                  title={playing ? 'Pause' : 'Wiedergabe'}
                >
                  {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  className="volumio-btn"
                  onClick={() => void send('next', 'cmd=next')}
                  disabled={disabled}
                  aria-label="Nächster Titel"
                  title="Nächster Titel"
                >
                  <SkipForward aria-hidden="true" />
                </button>
              </div>
            )}
            {showVolume && volume !== null && (
              <div className="volumio-volume">
                <button
                  type="button"
                  className="volumio-btn"
                  onClick={() => void send('down', `cmd=volume&volume=${Math.max(0, volume - settings.volumeStep)}`)}
                  disabled={disabled || volume <= 0}
                  aria-label="Leiser"
                  title="Leiser"
                >
                  <Minus aria-hidden="true" />
                </button>
                <span className={`volumio-volume-value${state.mute ? ' is-muted' : ''}`} aria-label={`Lautstärke ${volume} %`}>
                  {volume}
                </span>
                <button
                  type="button"
                  className="volumio-btn"
                  onClick={() =>
                    void send('up', `cmd=volume&volume=${Math.min(settings.maxVolume, volume + settings.volumeStep)}`)
                  }
                  disabled={disabled || volume >= settings.maxVolume}
                  aria-label="Lauter"
                  title={volume >= settings.maxVolume ? `Maximum ${settings.maxVolume} % erreicht` : 'Lauter'}
                >
                  <Plus aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`volumio-btn${state.mute ? ' is-active' : ''}`}
                  onClick={() => void send('mute', `cmd=volume&volume=${state.mute ? 'unmute' : 'mute'}`)}
                  disabled={disabled}
                  aria-pressed={state.mute}
                  aria-label={state.mute ? 'Ton einschalten' : 'Stumm schalten'}
                  title={state.mute ? 'Ton einschalten' : 'Stumm schalten'}
                >
                  {state.mute ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {offline && (
        <div className="volumio-offline" role="status">
          <WifiOff aria-hidden="true" />
          Volumio nicht erreichbar
        </div>
      )}
      {commandError && (
        <div className="volumio-toast" role="alert">
          {commandError}
        </div>
      )}
    </div>
  );
}

// ── Widget ───────────────────────────────────────────────────────────────────

export function VolumioWidget({ instanceId }: WidgetProps) {
  const settings = useVolumioSettings(instanceId);
  const address = volumioAddress(settings.host);

  if (!address) {
    return (
      <Message
        icon={<Music aria-hidden="true" />}
        title="Volumio nicht eingerichtet"
        detail="In den Einstellungen die Adresse des Volumio-Geräts eintragen."
      />
    );
  }
  if ('error' in address) {
    return (
      <Message
        tone="error"
        icon={<Settings2 aria-hidden="true" />}
        title={address.error}
        detail={`«${settings.host.trim()}» – z.B. 192.168.1.20 oder volumio.local eintragen.`}
      />
    );
  }
  return <VolumioPlayer key={address.base} base={address.base} settings={settings} />;
}

// ── Settings extra (kiosk dialog) ────────────────────────────────────────────

type TestResult = { ok: true; text: string } | { ok: false; text: string };

/** Connection test right in the settings dialog. */
export function VolumioSettingsExtra({ instanceId }: { instanceId: string }) {
  const settings = useVolumioSettings(instanceId);
  const address = volumioAddress(settings.host);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ host: string; result: TestResult } | null>(null);

  const test = async () => {
    if (!address || 'error' in address) return;
    setTesting(true);
    try {
      const state = await fetchPlayerState(address.base);
      const track = [state.title, state.artist].filter(Boolean).join(' – ');
      let summary = 'Verbunden – keine Wiedergabe';
      if (track && state.status === 'play') summary = `Verbunden – spielt «${track}»`;
      else if (track && state.status === 'pause') summary = `Verbunden – pausiert bei «${track}»`;
      else if (track) summary = `Verbunden – gestoppt («${track}»)`;
      setResult({ host: settings.host, result: { ok: true, text: summary } });
    } catch (err) {
      setResult({ host: settings.host, result: { ok: false, text: `Keine Verbindung: ${errorText(err)}` } });
    } finally {
      setTesting(false);
    }
  };

  // A result belongs to the address it was made with.
  const shown = result && result.host === settings.host ? result.result : null;

  return (
    <div className="volumio-test">
      <button
        type="button"
        className="settings-btn"
        onClick={() => void test()}
        disabled={testing || !address || 'error' in address}
      >
        <Music size={16} aria-hidden="true" />
        {testing ? 'Teste…' : 'Verbindung testen'}
      </button>
      {!address && <div className="settings-description">Zuerst oben die Adresse eintragen.</div>}
      {address && 'error' in address && <div className="settings-info-box error">{address.error}</div>}
      {shown && <div className={`settings-info-box ${shown.ok ? 'success' : 'error'}`}>{shown.text}</div>}
    </div>
  );
}
