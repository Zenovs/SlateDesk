/**
 * Ruhemodus widget (id 'sleeper') – switches the display off when the camera
 * has not seen anyone for `timeoutMinutes`, and on again as soon as a face is
 * detected or the screen is used.
 *
 * - shares the camera with the camera widget (services/cameraService) and also
 *   counts its 'presence:changed' events as presence
 * - detection keeps running while the display is off, so a face wakes it every time
 * - optional dark overlay for SLEEPER_DIM_SECONDS before switching off
 * - respectSchedule: never wakes a display the display schedule has switched off
 * - a display this widget switched off is switched on again on stop, unmount
 *   and the next app start (flag in localStorage, cleared only once the display
 *   is on); a failed switch-on is retried, and by the next touch or face
 * - «Bildschirm an/aus» from the Fernsteuerung is followed: on lifts the veil
 *   and restarts the countdown, off is taken over like an own switch-off
 * - the display is only switched off while the camera really delivers frames
 * - without a working display backend a black overlay stands in
 *
 * The controller behind it lives in services/sleeperController.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  CalendarClock,
  CameraOff,
  Eye,
  Moon,
  MoonStar,
  Play,
  Power,
  RotateCcw,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import type { WidgetProps } from '../types/widget';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { useLayoutStore } from '../store/layoutStore';
import { useLegacyDefaults } from '../services/legacyDefaults';
import {
  bool,
  DISPLAY_UNAVAILABLE,
  OFF_SNAPSHOT,
  SleeperController,
  toConfig,
  WAKE_FAILED,
  type SleeperSnapshot,
  type Veil,
} from '../services/sleeperController';
import { displayCapabilities, type DisplayCapabilities } from '../utils/backend';
import { CameraDeviceSelect } from './shared/CameraDeviceSelect';
import { SLEEPER_DEFAULT_SETTINGS, SLEEPER_LEGACY_DEFAULTS } from './manifests/sleeper';
import './styles/sleeper.css';

// ── Registry (widget ↔ its settings extra) ───────────────────────────────────

const controllers = new Map<string, SleeperController>();
const registryListeners = new Set<() => void>();

function setRegistered(instanceId: string, controller: SleeperController, registered: boolean): void {
  if (registered) controllers.set(instanceId, controller);
  else if (controllers.get(instanceId) === controller) controllers.delete(instanceId);
  else return;
  for (const listener of [...registryListeners]) listener();
}

function subscribeRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

function useRegisteredController(instanceId: string): SleeperController | null {
  return useSyncExternalStore(subscribeRegistry, () => controllers.get(instanceId) ?? null);
}

const subscribeNothing = (): (() => void) => () => {};
const getOffSnapshot = (): SleeperSnapshot => OFF_SNAPSHOT;

// ── Presentation ─────────────────────────────────────────────────────────────

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} Std.` : `${hours} Std. ${rest} Min.`;
}

interface PhaseView {
  icon: LucideIcon;
  title: string;
  detail: string | null;
  tone: 'neutral' | 'warning' | 'error';
}

function describe(snapshot: SleeperSnapshot): PhaseView {
  const { phase, error, notice, minutesLeft, present, displayUnavailable, wakeFailed } = snapshot;
  switch (phase) {
    case 'aus':
      return { icon: CameraOff, title: 'Kamera aus', detail: 'Der Ruhemodus ist gestoppt.', tone: 'neutral' };
    case 'startet':
      return { icon: Eye, title: 'Wird gestartet …', detail: null, tone: 'neutral' };
    case 'zeitplan':
      return { icon: CalendarClock, title: 'Pausiert', detail: 'Bildschirm-Zeitplan: aus', tone: 'neutral' };
    case 'fehler':
      return { icon: AlertTriangle, title: 'Gestört', detail: error, tone: 'error' };
    case 'dimmt':
      return { icon: Moon, title: 'Wird abgedunkelt', detail: 'Der Bildschirm geht gleich aus.', tone: 'neutral' };
    case 'schlaeft':
      return {
        icon: MoonStar,
        title: 'Schläft',
        detail: displayUnavailable ? `${DISPLAY_UNAVAILABLE} – schwarz abgedeckt` : null,
        tone: displayUnavailable ? 'warning' : 'neutral',
      };
    case 'aktiv':
      return {
        icon: present ? UserRound : Eye,
        title: `Aktiv · schläft in ${formatMinutes(minutesLeft ?? 1)}`,
        detail: wakeFailed
          ? WAKE_FAILED
          : displayUnavailable
            ? DISPLAY_UNAVAILABLE
            : (notice ?? (present ? 'Person erkannt' : null)),
        tone: wakeFailed || displayUnavailable || notice ? 'warning' : 'neutral',
      };
  }
}

const VEIL_HINTS: Record<Exclude<Veil, 'none'>, string> = {
  dim: 'Niemand erkannt – der Bildschirm geht gleich aus. Berühren hält ihn wach.',
  black: 'Ruhemodus · zum Aufwecken berühren',
  clear: '',
};

// ── Widget ───────────────────────────────────────────────────────────────────

function SleeperComponent({ instanceId }: WidgetProps) {
  const [merged] = useWidgetSettings(instanceId, SLEEPER_DEFAULT_SETTINGS);
  // An instance from the old kiosk keeps its old defaults: no auto-start, 180 minutes.
  const settings = useLegacyDefaults('sleeper', instanceId, merged, SLEEPER_LEGACY_DEFAULTS);
  const config = useMemo(() => toConfig(settings), [settings]);
  const autoStart = bool(settings.autoStart, SLEEPER_DEFAULT_SETTINGS.autoStart);
  const [controller] = useState(() => new SleeperController(instanceId, config));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const editMode = useLayoutStore((s) => s.editMode);
  const videoRef = useCallback((video: HTMLVideoElement | null) => controller.setVideo(video), [controller]);

  useEffect(() => {
    controller.mount();
    setRegistered(instanceId, controller, true);
    return () => {
      setRegistered(instanceId, controller, false);
      controller.unmount();
    };
  }, [controller, instanceId]);

  useEffect(() => controller.configure(config), [controller, config]);

  // Switching auto-start on starts the Ruhemodus; switching it off leaves it running.
  useEffect(() => {
    if (autoStart) controller.autoStart();
  }, [controller, autoStart]);

  const view = describe(snapshot);
  const Icon = view.icon;
  const { phase, running, veil } = snapshot;

  return (
    <div className={`sleeper sleeper-${phase}`}>
      <video ref={videoRef} className="sleeper-video" muted playsInline autoPlay aria-hidden="true" />
      <Icon className="sleeper-icon" aria-hidden="true" />
      <div className="sleeper-title" role="status">
        {view.title}
      </div>
      {view.detail && <div className={`sleeper-detail ${view.tone}`}>{view.detail}</div>}
      {(!running || phase === 'fehler' || editMode) && (
        <div className="sleeper-actions">
          {!running && (
            <button type="button" className="sleeper-button primary" onClick={controller.start}>
              <Play size={16} aria-hidden="true" />
              Starten
            </button>
          )}
          {phase === 'fehler' && (
            <button type="button" className="sleeper-button" onClick={controller.retry}>
              <RotateCcw size={16} aria-hidden="true" />
              Erneut versuchen
            </button>
          )}
          {running && editMode && (
            <button type="button" className="sleeper-button" onClick={controller.stop}>
              <Power size={16} aria-hidden="true" />
              Stoppen
            </button>
          )}
        </div>
      )}
      {veil !== 'none' &&
        createPortal(
          <div className={`sleeper-veil ${veil}`} aria-hidden="true">
            {VEIL_HINTS[veil] && <span className="sleeper-veil-hint">{VEIL_HINTS[veil]}</span>}
          </div>,
          document.body,
        )}
    </div>
  );
}

// ── Settings extra (kiosk only) ──────────────────────────────────────────────

export function SleeperSettingsExtra({ instanceId }: { instanceId: string }) {
  const [settings, update] = useWidgetSettings(instanceId, SLEEPER_DEFAULT_SETTINGS);
  const controller = useRegisteredController(instanceId);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? subscribeNothing,
    controller?.getSnapshot ?? getOffSnapshot,
  );
  const [capabilities, setCapabilities] = useState<DisplayCapabilities | null>(null);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    displayCapabilities().then(
      (result) => {
        if (!cancelled) setCapabilities(result);
      },
      (err: unknown) => {
        if (!cancelled) setCapabilitiesError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const view = describe(snapshot);
  const status = controller ? [view.title, view.detail].filter(Boolean).join(' – ') : 'Das Widget ist nicht aktiv.';

  let displayInfo: string | null = null;
  if (capabilities?.backend) {
    const environment = [capabilities.sessionType, capabilities.desktop].filter(Boolean).join(', ');
    displayInfo = `Bildschirm-Steuerung: ${capabilities.backend}${environment ? ` (${environment})` : ''}`;
  } else if (capabilities || capabilitiesError) {
    const reason = capabilitiesError ? ` (${capabilitiesError})` : '';
    displayInfo = `${DISPLAY_UNAVAILABLE}${reason} – statt auszuschalten wird der Bildschirm schwarz abgedeckt.`;
  }

  return (
    <section className="settings-section">
      <div className="settings-section-title">Kamera und Bildschirm</div>
      <CameraDeviceSelect
        value={typeof settings.deviceId === 'string' ? settings.deviceId : ''}
        onChange={(deviceId) => update({ deviceId })}
      />
      <div className="settings-field">
        <div className="settings-status" role="status">
          <span className={`settings-status-dot sleeper-status-${controller ? snapshot.phase : 'aus'}`} />
          <span>{status}</span>
        </div>
        {displayInfo && <p className="settings-description sleeper-extra-info">{displayInfo}</p>}
      </div>
      {controller && (
        <div className="sleeper-extra-actions">
          {snapshot.running ? (
            <button type="button" className="settings-btn settings-btn-danger" onClick={controller.stop}>
              <Power size={16} aria-hidden="true" />
              Ruhemodus stoppen
            </button>
          ) : (
            <button type="button" className="settings-btn settings-btn-primary" onClick={controller.start}>
              <Play size={16} aria-hidden="true" />
              Ruhemodus starten
            </button>
          )}
          {snapshot.phase === 'aktiv' && (
            <button type="button" className="settings-btn" onClick={controller.sleepNow}>
              <MoonStar size={16} aria-hidden="true" />
              Jetzt ausschalten (Test)
            </button>
          )}
          {snapshot.phase === 'fehler' && (
            <button type="button" className="settings-btn" onClick={controller.retry}>
              <RotateCcw size={16} aria-hidden="true" />
              Erneut versuchen
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export const SleeperWidget = SleeperComponent;
